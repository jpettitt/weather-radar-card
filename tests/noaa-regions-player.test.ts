// NOAA beyond the continental US (data-source audit, 2026-10-08): the CONUS
// mosaic alone left Alaska, Hawaii, Puerto Rico and Guam blank. Tiles now
// draw every regional mosaic in one request, and the loop's frame times come
// from the listing of the region the map is centred on.

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

const { built } = vi.hoisted(() => ({ built: [] as Array<{ url: string; options: any }> }));
vi.mock('../src/fetch-tile-layer', () => {
  class FakeLayer {
    constructor(url: string, options: any) { built.push({ url, options }); }
    on(): this { return this; }
  }
  return { FetchTileLayer: FakeLayer, FetchWmsTileLayer: FakeLayer, layerSettled: vi.fn() };
});

import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CAPS = '<Dimension name="time" units="ISO8601">2026-10-08T20:26:02.000Z,2026-10-08T20:28:08.000Z</Dimension>';

describe('NOAA regions in the player', () => {
  const realFetch = global.fetch;
  let fetched: string[];
  let centre: { lat: number; lng: number };

  function makePlayer(): any {
    return new RadarPlayer({
      map: {
        on: vi.fn(), off: vi.fn(), getZoom: () => 6, getSize: () => ({ x: 600, y: 400 }),
        getCenter: () => centre,
        getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
        getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      } as any,
      shadowRoot: { getElementById: () => null, host: {} } as any,
      getConfig: () => ({ type: 'custom:weather-radar-card', data_source: 'NOAA', past_minutes: 10 } as WeatherRadarCardConfig),
      rainviewerLimiter: {} as any,
      noaaLimiter: {} as any,
      dwdLimiter: {} as any,
    }) as any;
  }

  beforeEach(() => {
    built.length = 0;
    fetched = [];
    global.fetch = vi.fn(async (url: string) => { fetched.push(String(url)); return new Response(CAPS); }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it("takes frame times from the listing of the region the map is centred on, until the loop is rebuilt", async () => {
    centre = { lat: 21.31, lng: -157.86 }; // Honolulu
    const p = makePlayer();
    await p._fetchPaths();
    expect(fetched[0]).toContain('/geoserver/hawaii/hawaii_bref_qcd/ows');

    centre = { lat: 39.1, lng: -94.58 }; // panned to Kansas City: same loop, same clock
    await p._fetchPaths();
    expect(fetched[1]).toContain('/geoserver/hawaii/');

    p._clearLayers();
    await p._fetchPaths();
    expect(fetched[2]).toContain('/geoserver/conus/conus_bref_qcd/ows');
  });

  it('requests every regional mosaic in each tile', () => {
    centre = { lat: 39.1, lng: -94.58 };
    makePlayer()._createLayer({ time: Date.UTC(2026, 9, 8, 20, 28, 8) / 1000, path: '' });
    expect(built[0].url).toBe('https://opengeo.ncep.noaa.gov/geoserver/ows');
    expect(built[0].options.layers.split(',')).toEqual([
      'hawaii:hawaii_bref_qcd', 'alaska:alaska_bref_qcd', 'carib:carib_bref_qcd', 'guam:guam_bref_qcd', 'conus:conus_bref_qcd',
    ]);
  });
});
