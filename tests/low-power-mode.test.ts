// low_power_mode (#279): on slow tablets the DWD pixel filter, crossfades and
// motion compensation dominated load and playback cost. The mode must switch
// all of them off, and leave the default config path untouched.

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

// Records the options each radar layer is built with; the network edge is
// all that's faked — _createLayer itself runs for real.
const { built } = vi.hoisted(() => ({ built: [] as Array<{ url: string; options: any }> }));
vi.mock('../src/fetch-tile-layer', () => {
  class FakeLayer {
    constructor(url: string, options: any) { built.push({ url, options }); }
    on(): this { return this; }
    once(): this { return this; }
    addTo(): this { return this; }
    getContainer(): undefined { return undefined; }
  }
  return { FetchTileLayer: FakeLayer, FetchWmsTileLayer: FakeLayer, layerSettled: vi.fn() };
});

import { RadarPlayer, type RadarFrame } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const RUN = Date.UTC(2026, 9, 5, 16, 55) / 1000;
const CAPS = `<Dimension name="REFERENCE_TIME" units="ISO8601">2026-10-05T16:55:00.000Z</Dimension>`;

function makePlayer(getConfig: () => WeatherRadarCardConfig): any {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 7,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  const p = new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig,
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  }) as any;
  // Everything _initRadarBody touches besides layer and mask creation.
  p._ensureRadarPane = vi.fn();
  p._buildSegments = vi.fn();
  p._applyNowMarker = vi.fn();
  p._refreshDwdMaskColors = vi.fn();
  p._setSegment = vi.fn();
  p._setLayerZ = vi.fn();
  p._getTimeString = vi.fn(() => '');
  return p;
}

const cfg = (c: Partial<WeatherRadarCardConfig>): WeatherRadarCardConfig =>
  ({ type: 'custom:weather-radar-card', ...c } as WeatherRadarCardConfig);
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('low_power_mode overrides', () => {
  it('forces snap transitions and motion compensation off, whatever the config says', () => {
    const p = makePlayer(() => cfg({ low_power_mode: true, animated_transitions: true, motion_compensation: true }));
    expect(p._cfg.animated_transitions).toBe(false);
    expect(p._cfg.motion_compensation).toBe(false);
    expect(p._crossfadeTiming()).toEqual({ fadeMs: 0, delayMs: 0 });
  });

  it('passes the config through unchanged when off', () => {
    const c = cfg({ motion_compensation: true });
    const p = makePlayer(() => c);
    expect(p._cfg).toBe(c);
    expect(p._crossfadeTiming().fadeMs).toBeGreaterThan(0);
  });

  it('follows a config edit, while reusing the derived config between edits', () => {
    let c = cfg({ low_power_mode: true });
    const p = makePlayer(() => c);
    const first = p._cfg;
    expect(p._cfg).toBe(first);
    c = cfg({ low_power_mode: false });
    expect(p._cfg).toBe(c);
    expect(p._crossfadeTiming().fadeMs).toBeGreaterThan(0);
  });
});

describe('low_power_mode with DWD', () => {
  const realFetch = global.fetch;
  const frame: RadarFrame = { time: RUN, path: '' };

  beforeEach(() => {
    built.length = 0;
    global.fetch = vi.fn(async () => new Response(CAPS, { status: 200 })) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('builds DWD layers without the pixel filter', () => {
    makePlayer(() => cfg({ data_source: 'DWD', low_power_mode: true }))._createLayer(frame);
    makePlayer(() => cfg({ data_source: 'DWD' }))._createLayer(frame);
    expect(built).toHaveLength(2);
    expect(built[0].options.pixelFilter).toBeUndefined();
    expect(typeof built[1].options.pixelFilter).toBe('function');
  });

  it('creates no coverage mask, but still loads the frames', async () => {
    const p = makePlayer(() => cfg({ data_source: 'DWD', past_minutes: 10, forecast_minutes: 0, low_power_mode: true }));
    p._fetchPaths = vi.fn(async () => [RUN - 600, RUN - 300, RUN].map((time) => ({ time, path: '' })));
    p._ensureCoverageMask = vi.fn();

    void p._initRadarBody(p._frameGeneration);
    await flush();
    await flush();
    expect(p._ensureCoverageMask).not.toHaveBeenCalled();
    expect(p._refreshDwdMaskColors).not.toHaveBeenCalled();
    expect(built.length).toBeGreaterThan(0);
    expect(built.every((b) => b.options.pixelFilter === undefined)).toBe(true);
  });

  it('keeps the coverage mask when off', async () => {
    const p = makePlayer(() => cfg({ data_source: 'DWD', past_minutes: 10, forecast_minutes: 0 }));
    p._fetchPaths = vi.fn(async () => [RUN - 600, RUN - 300, RUN].map((time) => ({ time, path: '' })));
    p._ensureCoverageMask = vi.fn();

    void p._initRadarBody(p._frameGeneration);
    await flush();
    await flush();
    expect(p._ensureCoverageMask).toHaveBeenCalledOnce();
  });
});
