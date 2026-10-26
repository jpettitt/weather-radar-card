// Wildfire refresh and render paths fixed in the pre-4.0 review
// (2026-10-25). Leaflet is stubbed; the layer's real fetch, filter and
// render code runs against a fake WFIGS feed shaped like ArcGIS's answers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { geoJSONCalls, divIconCalls, layerGroupCalls } = vi.hoisted(() => ({
  geoJSONCalls: [] as GeoJSON.Feature[][],
  divIconCalls: [] as { html: string }[],
  layerGroupCalls: [] as number[],
}));

vi.mock('leaflet', () => {
  const latLng = (lat: number, lng: number) => ({ lat, lng });
  const latLngBounds = (sw: [number, number], ne: [number, number]) => ({ sw, ne });
  const group = () => { layerGroupCalls.push(1); return { addTo: vi.fn(), eachLayer: vi.fn() }; };
  const geoJSON = vi.fn((features: GeoJSON.Feature[]) => { geoJSONCalls.push(features); return { addTo: vi.fn(), eachLayer: vi.fn() }; });
  const L = {
    latLng, latLngBounds, geoJSON, layerGroup: group,
    marker: () => ({ bindPopup: vi.fn(), on: vi.fn(), addTo: vi.fn() }),
    divIcon: vi.fn((opts: { html: string }) => { divIconCalls.push(opts); return opts; }),
    canvas: vi.fn(() => ({})),
    Layer: class {}, TileLayer: class {}, Control: class {},
  };
  return { ...L, default: L };
});
vi.mock('../src/shared-canvas-renderer', () => ({ sharedCanvasRenderer: () => ({}) }));
vi.mock('../src/hazard-marker-pane', () => ({ hazardMarkerPane: () => 'hazard' }));

import { WildfireLayer } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const box = (lng: number, lat: number, d: number): GeoJSON.Polygon =>
  ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]] });

interface Fire { id: number; date: number; contained: number; acres: number; geometry: GeoJSON.Polygon | null }
let fires: Fire[];
const props = (f: Fire) => ({
  OBJECTID: f.id, poly_IncidentName: `Fire ${f.id}`, poly_GISAcres: f.acres, attr_PercentContained: f.contained,
  poly_DateCurrent: f.date,
});

describe('wildfire layer', () => {
  const realFetch = global.fetch;
  let calls: { attributes: number; outlines: string[]; detail: string[] };
  let zoom: number;
  let pxPerDeg: number;
  let center: { lat: number; lng: number };
  let view: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  let failNext: boolean;
  let removed: number;

  function makeLayer(cfg: Record<string, unknown> = {}): any {
    const map = {
      on: vi.fn(), off: vi.fn(), removeLayer: vi.fn(() => { removed++; }),
      once: vi.fn(),
      getZoom: () => zoom,
      getSize: () => ({ x: 600, y: 400 }),
      getCenter: () => center,
      latLngToLayerPoint: (ll: { lat: number; lng: number }) => ({ x: ll.lng * pxPerDeg, y: -ll.lat * pxPerDeg }),
      getBounds: () => ({
        intersects: (b: { sw: [number, number]; ne: [number, number] }) =>
          b.sw[0] <= view.maxLat && b.ne[0] >= view.minLat && b.sw[1] <= view.maxLng && b.ne[1] >= view.minLng,
      }),
    };
    return new WildfireLayer(map as any, () => ({ type: 'custom:weather-radar-card', wildfire_min_acres: 10, ...cfg } as any));
  }

  beforeEach(() => {
    geoJSONCalls.length = 0;
    divIconCalls.length = 0;
    layerGroupCalls.length = 0;
    removed = 0;
    failNext = false;
    calls = { attributes: 0, outlines: [], detail: [] };
    zoom = 8;
    pxPerDeg = 1000;
    center = { lat: 47.85, lng: -120.85 };
    view = { minLat: 47, minLng: -122, maxLat: 49, maxLng: -119 };
    fires = [
      { id: 1, date: 100, contained: 50, acres: 5000, geometry: box(-120.9, 47.8, 0.1) },
      { id: 2, date: 100, contained: 80, acres: 5000, geometry: box(-121.5, 48.2, 0.1) },
    ];
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      if (failNext) return new Response('', { status: 503 });
      const withId = (new URL(u).searchParams.get('outFields') ?? '').split(',').includes('OBJECTID');
      const feature = (f: Fire, geometry: GeoJSON.Geometry | null) =>
        ({ type: 'Feature', ...(withId ? { id: f.id } : {}), geometry, properties: props(f) });
      let features: unknown[];
      if (u.includes('returnGeometry=false')) {
        calls.attributes++;
        features = fires.map((f) => feature(f, null));
      } else if (u.includes('objectIds=')) {
        calls.detail.push(u);
        const ids = new URL(u).searchParams.get('objectIds')!.split(',').map(Number);
        features = fires.filter((f) => ids.includes(f.id)).map((f) => feature(f, f.geometry));
      } else {
        calls.outlines.push(u);
        features = fires.map((f) => feature(f, f.geometry));
      }
      return new Response(JSON.stringify({ type: 'FeatureCollection', features }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
  });

  it('escapes wildfire_color and wildfire_contained_color in the icon html', async () => {
    pxPerDeg = 10;   // a 0.1 deg fire is 1 px: drawn as an icon
    fires[1].contained = 100;
    const bad = '"/><img src=x onerror=alert(1)><path d="';
    const l = makeLayer({ wildfire_color: bad, wildfire_contained_color: bad });
    await l._fetch();
    expect(divIconCalls).toHaveLength(2);   // one active, one contained
    for (const { html } of divIconCalls) {
      expect(html).not.toContain('<img');
      expect(html).toContain('&lt;img');
    }
    l.clear();
  });

  it('a failed refresh keeps the unchanged layers, so an open popup stays open', async () => {
    const l = makeLayer();
    await l._fetch();
    expect(geoJSONCalls).toHaveLength(1);
    const removedBefore = removed;
    failNext = true;
    await l._fetch();
    expect(l._failureCount).toBe(1);
    expect(geoJSONCalls).toHaveLength(1);
    expect(removed).toBe(removedBefore);
    l.clear();
  });

  it('wildfire_radius_km follows the map centre on a hass update', async () => {
    const l = makeLayer({ wildfire_radius_km: 50 });
    await l._fetch();
    expect(l._features.map((f: any) => f.id)).toEqual([1]);   // fire 2 is ~63 km away
    center = { lat: 48.25, lng: -121.45 };                      // a tracked marker moved the map onto fire 2
    l.updateHass({ states: {} } as any);
    expect(l._features.map((f: any) => f.id)).toEqual([2]);
    expect(geoJSONCalls[geoJSONCalls.length - 1].map((f: any) => f.id)).toEqual([2]);
    l.clear();
  });

  it('removes the drawn fires when the radius now keeps none', async () => {
    const l = makeLayer({ wildfire_radius_km: 50 });
    await l._fetch();
    const removedBefore = removed;
    center = { lat: 30, lng: -100 };   // far from both fires
    l.updateHass({ states: {} } as any);
    expect(l._features).toEqual([]);
    expect(removed).toBeGreaterThan(removedBefore);
    l.clear();
  });

  it('a small fire drawn as an icon at zoom 11 does not rebuild on every map-quiet callback', async () => {
    fires = [{ id: 1, date: 100, contained: 50, acres: 50, geometry: box(-120.9, 47.8, 0.01) }];   // 10 px: an icon
    zoom = 11;
    view = { minLat: 47.7, minLng: -121, maxLat: 48, maxLng: -120.7 };
    const l = makeLayer();
    await l._fetch();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.detail).toHaveLength(1);
    const builds = layerGroupCalls.length;
    l._showDetail();
    await new Promise((r) => setTimeout(r, 0));
    l._showDetail();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.detail).toHaveLength(1);
    expect(layerGroupCalls.length).toBe(builds);
    l.clear();
  });

  it('a large fire at zoom 11 still redraws once with its fetched outline', async () => {
    zoom = 11;
    const l = makeLayer();
    await l._fetch();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.detail).toHaveLength(1);
    expect(l._detailDrawn.size).toBeGreaterThan(0);
    const builds = geoJSONCalls.length;
    l._showDetail();
    await new Promise((r) => setTimeout(r, 0));
    expect(geoJSONCalls.length).toBe(builds);   // drawn with the outline: nothing more to do
    l.clear();
  });

  it('a fire without a geometry in the feed does not refetch the outlines on every refresh', async () => {
    fires.push({ id: 3, date: 100, contained: 0, acres: 5000, geometry: null });
    const l = makeLayer();
    await l._fetch(); await l._fetch(); await l._fetch();
    expect(calls.attributes).toBe(3);
    expect(calls.outlines).toHaveLength(1);
    l.clear();
  });
});

describe('wildfire popup height cap', () => {
  it('follows the map height when the popup opens, not when the layer was built', () => {
    const size = { x: 0, y: 0 };
    const layer = Object.create(WildfireLayer.prototype) as any;
    layer._map = { getSize: () => size };
    let content: () => string = () => '';
    const popup = { options: {} as any };
    layer._bindPopup({
      bindPopup: (fn: () => string, o?: any) => { content = fn; Object.assign(popup.options, o); },
      on: vi.fn(),
      getPopup: () => popup,
    }, { poly_IncidentName: 'Test' });
    size.x = 800; size.y = 600;
    content();   // Leaflet runs the content function before it lays the popup out
    expect(popup.options.maxHeight).toBe(480);
  });
});
