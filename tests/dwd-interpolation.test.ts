// dwd_interpolation (#326): bilinear adds GeoServer's `interpolations` vendor
// param to every DWD GetMap. The frame and coverage-mask layers must send the
// same value, or the mask stops sharing its download with the anchor frame,
// and anything else must send nothing, so the default URLs stay as before.

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

// Records the options each radar layer is built with; _createLayer and
// _createDwdMaskLayer run for real.
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

const NOW = Date.UTC(2026, 9, 21, 23, 15) / 1000;

function makePlayer(config: Partial<WeatherRadarCardConfig>): any {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 9,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
  } as any;
  const cfg = { type: 'custom:weather-radar-card', data_source: 'DWD', ...config } as WeatherRadarCardConfig;
  const p = new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => cfg,
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  }) as any;
  p._dwdDimRgba = [0, 0, 0, 255];
  p._dwdOutlineRgba = [255, 0, 255, 255];
  return p;
}

// The frame layer and the coverage mask for the same frame.
function buildBoth(config: Partial<WeatherRadarCardConfig>, frame: RadarFrame): { layer: any; mask: any } {
  built.length = 0;
  const p = makePlayer(config);
  p._createLayer(frame);
  p._createDwdMaskLayer(frame, p._dwdLayerName());
  expect(built).toHaveLength(2);
  return { layer: built[0].options, mask: built[1].options };
}

describe('dwd_interpolation', () => {
  const observed: RadarFrame = { time: NOW, path: '' };
  const forecast: RadarFrame = { time: NOW + 3600, path: '', run: NOW };

  beforeEach(() => {
    built.length = 0;
  });

  it('sends interpolations=bilinear on the frame and its coverage mask', () => {
    const { layer, mask } = buildBoth({ dwd_interpolation: 'bilinear' }, observed);
    expect(layer.interpolations).toBe('bilinear');
    expect(mask.interpolations).toBe('bilinear');
  });

  it('keeps it on forecast frames, next to the run pin', () => {
    const { layer, mask } = buildBoth({ dwd_interpolation: 'bilinear', forecast_minutes: 120 }, forecast);
    for (const o of [layer, mask]) {
      expect(o.interpolations).toBe('bilinear');
      expect(o.DIM_REFERENCE_TIME).toBe('2026-10-21T23:15:00Z');
    }
  });

  // DWD answers a bare 'nearest' with a ServiceException, and bicubic draws
  // false rain at the coverage edge: neither may reach the URL.
  it.each([undefined, 'nearest', 'nearest neighbor', 'bicubic', 'Bilinear'])('sends nothing for %s', (value) => {
    const { layer, mask } = buildBoth({ dwd_interpolation: value }, observed);
    expect(layer).not.toHaveProperty('interpolations');
    expect(mask).not.toHaveProperty('interpolations');
  });

  it('leaves NOAA alone', () => {
    const p = makePlayer({ data_source: 'NOAA', dwd_interpolation: 'bilinear' });
    p._noaaLegacyMode = true;
    p._createLayer(observed);
    expect(built[0].options).not.toHaveProperty('interpolations');
  });
});
