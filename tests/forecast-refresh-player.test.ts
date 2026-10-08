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

  it('moves refresh layers to the new native zoom with the frames, so a swap keeps the grid', () => {
    const p = makePlayer(REFRESH, 10);
    p._invalidateSnapshots = vi.fn();
    p._scheduleViewRefresh = vi.fn();
    p._pinnedNativeZoom = 6;
    const frame = fakeLayer();
    const loading = fakeLayer();
    const staged = fakeLayer();
    p._radarImage = [frame];
    p._forecastLoading = [loading];
    p._stagedForecast.set(RUN, { frame: { time: RUN, path: '' }, layer: staged });

    p._onZoomEnd();
    expect([frame, loading, staged].map((l) => l.options.minNativeZoom)).toEqual([8, 8, 8]);
  });
});
