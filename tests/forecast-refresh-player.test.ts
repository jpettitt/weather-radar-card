// Forecast refresh driven through RadarPlayer itself (#279 follow-ups from
// the 3.11.0 review). forecast-refresh.test.ts covers the pure planning
// helpers; these cover the player's bookkeeping around them.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control {
    constructor(_opts?: unknown) { void _opts; }
  }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, DomUtil, DomEvent },
  };
});

import { RadarPlayer, type RadarFrame } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN = Date.UTC(2026, 9, 7, 18, 0) / 1000;
const caps = (runSec: number): string =>
  `<Dimension name="REFERENCE_TIME" units="ISO8601">${new Date(runSec * 1000).toISOString()}</Dimension>`;

const REFRESH: Partial<WeatherRadarCardConfig> = {
  data_source: 'DWD', past_minutes: 30, forecast_minutes: 60, forecast_refresh_minutes: 5,
};

function makePlayer(cfg: Partial<WeatherRadarCardConfig>, zoom = 7): any {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => zoom,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  const p = new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  }) as any;
  p._ensureRadarPane = vi.fn();
  p._buildSegments = vi.fn();
  p._applyNowMarker = vi.fn();
  p._refreshDwdMaskColors = vi.fn();
  p._ensureCoverageMask = vi.fn();
  p._setSegment = vi.fn();
  p._setLayerZ = vi.fn();
  p._getTimeString = vi.fn(() => '');
  p._scheduleUpdate = vi.fn();
  return p;
}

// Never settles, so init parks after its first layer.
const fakeLayer = (): any => {
  const container = { style: {} as Record<string, string> };
  return {
    options: {},
    addTo: vi.fn(), remove: vi.fn(), once: vi.fn(), on: vi.fn(), off: vi.fn(),
    getContainer: () => container,
  };
};
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('forecast refresh in the player', () => {
  const realFetch = global.fetch;
  let capsRun: number | null;

  beforeEach(() => {
    capsRun = RUN;
    global.fetch = vi.fn(async () => (capsRun === null
      ? new Response('maintenance', { status: 503 })
      : new Response(caps(capsRun), { status: 200 }))) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('never steps back to an older run when one update lists one', async () => {
    const p = makePlayer(REFRESH);
    const frames: RadarFrame[] = [{ time: RUN - 300, path: '' }, { time: RUN + 300, path: '', run: RUN }];
    p._radarPaths = frames;
    p._dwdLatestRun = RUN;
    p._fetchPaths = vi.fn(async () => frames.map((f) => ({ time: f.time, path: '' })));
    p._refreshForecast = vi.fn();
    capsRun = RUN - 300; // a lagging server node

    await p._updateRadar();
    expect(p._dwdLatestRun).toBe(RUN);
    expect(p._refreshForecast).toHaveBeenCalledWith(RUN);
  });

  it('marks frames that load before the run is known, so the first refresh replaces them', async () => {
    capsRun = null;
    const now = Date.now() / 1000;
    const p = makePlayer(REFRESH);
    p._fetchPaths = vi.fn(async () => [now - 1800, now - 600, now + 600].map((time) => ({ time, path: '' })));
    const built: RadarFrame[] = [];
    p._createLayer = vi.fn((f: RadarFrame) => { built.push(f); return fakeLayer(); });

    void p._initRadarBody(p._frameGeneration);
    await flush();
    await flush();
    expect(p._radarPaths.map((f: RadarFrame) => f.unverified)).toEqual([undefined, true, true]);
    expect(built.length).toBeGreaterThan(0);
  });

  it('refetches unverified frames without the flag: observed if the run covers them, else pinned', () => {
    const p = makePlayer(REFRESH);
    p._radarPaths = [
      { time: RUN - 300, path: '', unverified: true },
      { time: RUN + 300, path: '', unverified: true },
    ];
    p._lastForecastRefreshAt = 0;
    const built: RadarFrame[] = [];
    p._createLayer = vi.fn((f: RadarFrame) => { built.push(f); return fakeLayer(); });

    p._refreshForecast(RUN);
    expect(built).toEqual([
      { time: RUN - 300, path: '', run: undefined, unverified: undefined },
      { time: RUN + 300, path: '', run: RUN, unverified: undefined },
    ]);
  });

  it("lets a failed frame's replacement play once it loads", () => {
    const p = makePlayer(REFRESH);
    p._onLayerLoaded = vi.fn(async () => {});
    const old = [fakeLayer(), fakeLayer(), fakeLayer()];
    p._radarImage = old;
    p._radarPaths = [RUN - 600, RUN - 300, RUN].map((time) => ({ time, path: '' }));
    p._loadedSlots = [0, 2]; // frame 1 failed to load
    p._frameSnapshot = [null, null, null];
    p._frameSnapshotNz = [0, 0, 0];
    p._frameMotion = [null, null, null];
    p._currentSlot = 1; // showing frame 2
    p._prev1Slot = 1;
    p.run = false;
    const replacement = fakeLayer();
    p._stagedForecast.set(RUN - 300, { frame: { time: RUN - 300, path: '' }, layer: replacement });

    p._swapStagedFrames();
    expect(p._radarImage[1]).toBe(replacement);
    expect(p._loadedSlots).toEqual([0, 1, 2]);
    expect(p._loadedSlots[p._currentSlot]).toBe(2); // still on the same frame
    expect(p._setSegment).toHaveBeenCalledWith(1, 'loaded');
  });
});

// Forecast tiles that survive a reload (#279, 3.12): forecast frames are
// pinned to a run whenever one is known, a reload reuses the last run used
// (cached) if it's at most 30 min old, then catches up to the newest.
describe('forecast cache in the player', () => {
  const realFetch = global.fetch;
  const LAYER = 'Radar_wn-product_1x1km_ger';
  // Run times near the real clock: chooseStartRun judges age against now.
  const latest = Math.floor(Date.now() / 300_000) * 300 - 300;
  const NO_REFRESH: Partial<WeatherRadarCardConfig> = { data_source: 'DWD', past_minutes: 30, forecast_minutes: 60 };
  // Fires 'load' on the next turn, so init runs to the end.
  const settlingLayer = (): any => {
    const l = fakeLayer();
    l._tileFailed = 0;
    l.once = vi.fn((ev: string, cb: () => void) => { if (ev === 'load') setTimeout(cb, 0); });
    return l;
  };
  const frameTimes = (): RadarFrame[] => [-1200, -600, 0, 600, 1200].map((d) => ({ time: latest + d, path: '' }));
  const runOf = (p: any): Array<number | undefined> => p._radarPaths.map((f: RadarFrame) => f.run);

  beforeEach(() => {
    localStorage.clear();
    global.fetch = vi.fn(async () => new Response(caps(latest), { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    localStorage.clear();
  });

  it('pins forecast frames to the run with forecast refresh off too', async () => {
    const p = makePlayer(NO_REFRESH);
    p._fetchPaths = vi.fn(async () => frameTimes());
    p._createLayer = vi.fn(() => fakeLayer());

    void p._initRadarBody(p._frameGeneration);
    await flush();
    await flush();
    expect(runOf(p)).toEqual([undefined, undefined, undefined, latest, latest]);
    expect(localStorage.getItem(`weather-radar-card:dwd-forecast-run:${LAYER}`)).toBe(String(latest));
  });

  it('starts from a remembered run up to 30 min old, then catches up to the newest', async () => {
    const remembered = latest - 600;
    localStorage.setItem(`weather-radar-card:dwd-forecast-run:${LAYER}`, String(remembered));
    const p = makePlayer(NO_REFRESH);
    p._fetchPaths = vi.fn(async () => frameTimes());
    p._createLayer = vi.fn(() => settlingLayer());
    p._startLoop = vi.fn();
    p._refreshForecast = vi.fn(() => true);

    await p._initRadarBody(p._frameGeneration);
    // Cached run first: every frame after it, including the one now observed.
    expect(runOf(p)).toEqual([undefined, undefined, remembered, remembered, remembered]);
    expect(p._refreshForecast).toHaveBeenCalledWith(latest);
    expect(p._catchUpPending).toBe(true);
  });

  it('ignores a remembered run more than 30 min old', async () => {
    localStorage.setItem(`weather-radar-card:dwd-forecast-run:${LAYER}`, String(latest - 2400));
    const p = makePlayer(NO_REFRESH);
    p._fetchPaths = vi.fn(async () => frameTimes());
    p._createLayer = vi.fn(() => settlingLayer());
    p._startLoop = vi.fn();
    p._refreshForecast = vi.fn(() => true);

    await p._initRadarBody(p._frameGeneration);
    expect(runOf(p)).toEqual([undefined, undefined, undefined, latest, latest]);
    expect(p._refreshForecast).not.toHaveBeenCalled();
  });

  it('ends the catch-up once nothing is left to swap, even if every replacement failed', () => {
    const p = makePlayer(NO_REFRESH);
    p._catchUpPending = true;
    p._swapStagedFrames();
    expect(p._catchUpPending).toBe(false);
  });

  it('caches a pinned frame under the pinned-forecast policy, others as before', () => {
    const p = makePlayer(NO_REFRESH);
    p._dwdLatestRun = latest;
    expect(p._tileCachePolicy({ time: latest + 1800, path: '', run: latest })).toEqual({
      persistUntil: (latest + 35 * 60) * 1000,
      finalBefore: (latest + 1800 - 300) * 1000,
    });
    expect(p._tileCachePolicy({ time: latest - 600, path: '' }).finalBefore).toBeUndefined();
  });

  it('with refresh off, an update pins its new frames to the newest run without refreshing the rest', async () => {
    const p = makePlayer(NO_REFRESH);
    p._radarPaths = frameTimes().map((f) => (f.time > latest - 300 ? { ...f, run: latest - 300 } : f));
    p._dwdLatestRun = latest - 300;
    p._fetchPaths = vi.fn(async () => [...frameTimes(), { time: latest + 1800, path: '' }]);
    p._stopLoop = vi.fn();
    const shifted: RadarFrame[] = [];
    p._shiftInFrame = vi.fn((f: RadarFrame) => { shifted.push(f); });
    p._refreshForecast = vi.fn();

    await p._updateRadar();
    expect(shifted).toEqual([{ time: latest + 1800, path: '', run: latest }]);
    expect(p._refreshForecast).not.toHaveBeenCalled();
  });
});

describe('forecast reuse window follows forecast_refresh_minutes (#279)', () => {
  it('a 60-minute refresh keeps pinned tiles 75 minutes (60 + 10 grace + 5 margin)', () => {
    const p = makePlayer({ ...REFRESH, forecast_refresh_minutes: 60 });
    expect(p._tileCachePolicy({ time: RUN + 1800, path: '', run: RUN }).persistUntil).toBe((RUN + 75 * 60) * 1000);
  });

  it('a 5-minute refresh keeps the 30-minute floor (35 with the margin)', () => {
    const p = makePlayer(REFRESH);
    expect(p._tileCachePolicy({ time: RUN + 1800, path: '', run: RUN }).persistUntil).toBe((RUN + 35 * 60) * 1000);
  });
});
