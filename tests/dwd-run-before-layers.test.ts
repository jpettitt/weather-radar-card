// A DWD tile may only be judged final against a run that was published
// before the tile was requested — otherwise a tile the server answered from
// the previous run's forecast could be stored as history. _initRadarBody
// therefore waits for DWD's run list before it creates any layer.

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

const RUN = Date.UTC(2026, 9, 5, 16, 55) / 1000;
const CAPS = `<Dimension name="REFERENCE_TIME" units="ISO8601">2026-10-05T16:50:00.000Z,2026-10-05T16:55:00.000Z</Dimension>`;

function makePlayer(cfg: Partial<WeatherRadarCardConfig>): any {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 7,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  const shadowRoot = { getElementById: () => null, host: {} } as any;
  const p = new RadarPlayer({
    map,
    shadowRoot,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  }) as any;
  // Everything _initRadarBody touches besides layer creation.
  p._ensureRadarPane = vi.fn();
  p._buildSegments = vi.fn();
  p._applyNowMarker = vi.fn();
  p._refreshDwdMaskColors = vi.fn();
  p._setSegment = vi.fn();
  p._setLayerZ = vi.fn();
  p._getTimeString = vi.fn(() => '');
  return p;
}

const frames = (...times: number[]): RadarFrame[] => times.map((t) => ({ time: t, path: '' }));
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// Never settles: init stays parked after creating its first layer.
const fakeLayer = (): any => ({ addTo: vi.fn(), once: vi.fn(), on: vi.fn(), getContainer: () => undefined });

describe('DWD init waits for the run list before creating layers', () => {
  const realFetch = global.fetch;
  let resolveRunList: (body: string) => void;

  beforeEach(() => {
    global.fetch = vi.fn((url: string | URL) => {
      if (!String(url).includes('GetCapabilities')) throw new Error(`unexpected fetch ${String(url)}`);
      return new Promise<Response>((res) => { resolveRunList = (body) => res(new Response(body, { status: 200 })); });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('creates no layer or coverage mask until the run is known, then uses it', async () => {
    const p = makePlayer({ data_source: 'DWD', past_minutes: 10, forecast_minutes: 0 });
    p._fetchPaths = vi.fn(async () => frames(RUN - 600, RUN - 300, RUN));
    const runSeenByLayer: Array<number | null> = [];
    p._createLayer = vi.fn(() => { runSeenByLayer.push(p._dwdLatestRun); return fakeLayer(); });
    p._ensureCoverageMask = vi.fn(() => { runSeenByLayer.push(p._dwdLatestRun); });

    void p._initRadarBody(p._frameGeneration);
    await flush();
    expect(p._ensureCoverageMask).not.toHaveBeenCalled();
    expect(p._createLayer).not.toHaveBeenCalled();

    resolveRunList(CAPS);
    await flush();
    expect(p._ensureCoverageMask).toHaveBeenCalledOnce();
    expect(p._createLayer).toHaveBeenCalled();
    expect(runSeenByLayer.every((r) => r === RUN)).toBe(true);
  });

  it('still loads, with the 15-min fallback, when the run list fails', async () => {
    const p = makePlayer({ data_source: 'DWD', past_minutes: 10, forecast_minutes: 0 });
    p._fetchPaths = vi.fn(async () => frames(RUN - 600, RUN - 300, RUN));
    p._createLayer = vi.fn(fakeLayer);
    p._ensureCoverageMask = vi.fn();

    void p._initRadarBody(p._frameGeneration);
    await flush();
    resolveRunList('<html>maintenance</html>');
    await flush();
    expect(p._createLayer).toHaveBeenCalled();
    expect(p._dwdLatestRun).toBeNull();
  });

  it('does not ask for a run list for other sources', async () => {
    const p = makePlayer({ data_source: 'NOAA', past_minutes: 10 });
    p._fetchPaths = vi.fn(async () => frames(RUN - 600, RUN - 300, RUN));
    p._createLayer = vi.fn(fakeLayer);

    void p._initRadarBody(p._frameGeneration);
    await flush();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(p._createLayer).toHaveBeenCalled();
  });
});
