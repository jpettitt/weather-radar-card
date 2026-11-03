// During a pinch Leaflet creates tiles for every zoom level the gesture
// crosses, for every attached frame, and prunes only when it ends: 557 tile
// images in 85 containers for 13 frames (phone viewport, 2026-10-16), and a
// crashed Safari on an iPhone. Every radar frame layer and the DWD mask
// therefore run with updateWhenZooming off. Same harness as
// low-power-mode.test.ts: the layer classes are faked to record options.

import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_opts?: unknown) { void _opts; } }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return { Layer, TileLayer, Control, DomUtil, DomEvent, default: { Layer, TileLayer, Control, DomUtil, DomEvent } };
});

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

import { RadarPlayer, ZOOM_GESTURE_OPTIONS, type RadarFrame } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePlayer(config: Partial<WeatherRadarCardConfig>): any {
  const map = {
    on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...config } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

const frame: RadarFrame = { time: Date.UTC(2026, 9, 16, 12, 0) / 1000, path: '/v2/radar/abc' };

describe('radar layers during a zoom gesture', () => {
  it('the option set is updateWhenZooming off', () => {
    expect(ZOOM_GESTURE_OPTIONS).toEqual({ updateWhenZooming: false });
  });

  it.each(['RainViewer', 'NOAA', 'DWD'] as const)('%s frame layers are built with updateWhenZooming off', (source) => {
    built.length = 0;
    makePlayer({ data_source: source })._createLayer(frame);
    expect(built).toHaveLength(1);
    expect(built[0].options.updateWhenZooming).toBe(false);
  });

  it('the DWD coverage mask is built with updateWhenZooming off', () => {
    built.length = 0;
    const p = makePlayer({ data_source: 'DWD' });
    // The mask colours come from the card's theme CSS; opaque ones here, so the mask is built.
    p._dwdDimRgba = [0, 0, 0, 255];
    p._dwdOutlineRgba = [255, 0, 255, 255];
    p._ensureDwdMaskPane = vi.fn();
    const mask = p._createDwdMaskLayer(frame, 'dwd:Niederschlagsradar');
    expect(mask).not.toBeNull();
    expect(built).toHaveLength(1);
    expect(built[0].options.updateWhenZooming).toBe(false);
  });
});
