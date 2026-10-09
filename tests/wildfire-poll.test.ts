// The wildfire refresh fetches attributes only (~8 KB); outlines (99.5% of
// the 13.7 MB feed, 2026-10-08) are fetched, simplified, when a perimeter
// date moves or fires come or go. From zoom 11, fires in view get their full
// outline.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { geoJSONCalls } = vi.hoisted(() => ({ geoJSONCalls: [] as GeoJSON.Feature[][] }));

vi.mock('leaflet', () => {
  const latLng = (lat: number, lng: number) => ({ lat, lng });
  const latLngBounds = (sw: [number, number], ne: [number, number]) => ({ sw, ne });
  const group = () => ({ addTo: vi.fn(), eachLayer: vi.fn() });
  const geoJSON = vi.fn((features: GeoJSON.Feature[]) => { geoJSONCalls.push(features); return group(); });
  const L = {
    latLng, latLngBounds, geoJSON, layerGroup: group,
    marker: () => ({ bindPopup: vi.fn(), on: vi.fn(), addTo: vi.fn() }),
    divIcon: vi.fn(), canvas: vi.fn(() => ({})),
    Layer: class {}, TileLayer: class {}, Control: class {},
  };
  return { ...L, default: L };
});
vi.mock('../src/shared-canvas-renderer', () => ({ sharedCanvasRenderer: () => ({}) }));

import { WildfireLayer } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Two fires near Leavenworth, WA. Outlines are boxes; the full outline of
// fire 1 has an extra vertex so the tests can tell which one was drawn.
const box = (lng: number, lat: number, d: number): GeoJSON.Polygon =>
  ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + d, lat], [lng + d, lat + d], [lng, lat + d], [lng, lat]]] });
const FULL_1: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[-120.9, 47.8], [-120.85, 47.79], [-120.8, 47.8], [-120.8, 47.9], [-120.9, 47.9], [-120.9, 47.8]]] };

interface Fire { id: number; date: number; contained: number; personnel: number; geometry: GeoJSON.Polygon }
let fires: Fire[];
const props = (f: Fire) => ({
  OBJECTID: f.id, poly_IncidentName: `Fire ${f.id}`, poly_GISAcres: 5000, attr_PercentContained: f.contained,
  attr_TotalIncidentPersonnel: f.personnel, poly_DateCurrent: f.date,
});

describe('wildfire refresh', () => {
  const realFetch = global.fetch;
  let calls: { attributes: number; outlines: string[]; detail: string[] };
  let zoom: number;
  let view: { minLat: number; minLng: number; maxLat: number; maxLng: number };
  let onceHandlers: Record<string, () => void>;

  function makeLayer(): any {
    const map = {
      on: vi.fn(), off: vi.fn(), removeLayer: vi.fn(),
      once: vi.fn((ev: string, fn: () => void) => { onceHandlers[ev] = fn; }),
      getZoom: () => zoom,
      getSize: () => ({ x: 600, y: 400 }),
      getCenter: () => ({ lat: 47.8, lng: -120.8 }),
      // 1° = 1000 px: every fire is drawn as an outline, not an icon.
      latLngToLayerPoint: (ll: { lat: number; lng: number }) => ({ x: ll.lng * 1000, y: -ll.lat * 1000 }),
      getBounds: () => ({
        intersects: (b: { sw: [number, number]; ne: [number, number] }) =>
          b.sw[0] <= view.maxLat && b.ne[0] >= view.minLat && b.sw[1] <= view.maxLng && b.ne[1] >= view.minLng,
      }),
    };
    return new WildfireLayer(map as any, () => ({ type: 'custom:weather-radar-card', wildfire_min_acres: 10 } as any));
  }

  beforeEach(() => {
    geoJSONCalls.length = 0;
    onceHandlers = {};
    calls = { attributes: 0, outlines: [], detail: [] };
    zoom = 8;
    view = { minLat: 47, minLng: -122, maxLat: 49, maxLng: -119 };
    fires = [
      { id: 1, date: 100, contained: 50, personnel: 40, geometry: box(-120.9, 47.8, 0.1) },
      { id: 2, date: 100, contained: 80, personnel: 10, geometry: box(-121.5, 48.2, 0.1) },
    ];
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url);
      // Like ArcGIS: the GeoJSON id is there only when OBJECTID is requested.
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
        features = fires.filter((f) => ids.includes(f.id)).map((f) => feature(f, f.id === 1 ? FULL_1 : f.geometry));
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

  it('first refresh fetches attributes and outlines simplified to ~100 m, uncached', async () => {
    const l = makeLayer();
    await l._fetch();
    expect(calls.attributes).toBe(1);
    expect(calls.outlines).toHaveLength(1);
    expect(calls.outlines[0]).toContain('maxAllowableOffset=0.001');
    expect((global.fetch as any).mock.calls[0][1]).toMatchObject({ cache: 'no-cache' });
    expect(geoJSONCalls).toHaveLength(1);
  });

  it('an attribute edit updates the fire in place without refetching outlines or redrawing', async () => {
    const l = makeLayer();
    await l._fetch();
    const shown = l._features[0].properties;
    fires[0].personnel = 292;
    await l._fetch();
    expect(calls.attributes).toBe(2);
    expect(calls.outlines).toHaveLength(1);
    expect(shown.attr_TotalIncidentPersonnel).toBe(292); // the object popups read when opened
    expect(geoJSONCalls).toHaveLength(1);
  });

  it('redraws when an edit changes what the map shows (contained turns the fire grey)', async () => {
    const l = makeLayer();
    await l._fetch();
    fires[1].contained = 100;
    await l._fetch();
    expect(calls.outlines).toHaveLength(1);
    expect(geoJSONCalls).toHaveLength(2);
  });

  it('refetches outlines when a perimeter date moves', async () => {
    const l = makeLayer();
    await l._fetch();
    fires[0].date = 200;
    fires[0].geometry = box(-120.9, 47.8, 0.2);
    await l._fetch();
    expect(calls.outlines).toHaveLength(2);
    expect(geoJSONCalls[1][0].geometry).toEqual(box(-120.9, 47.8, 0.2));
  });

  it('refetches outlines when a fire comes or goes', async () => {
    const l = makeLayer();
    await l._fetch();
    fires.push({ id: 3, date: 100, contained: 0, personnel: 5, geometry: box(-120, 48, 0.1) });
    await l._fetch();
    fires.splice(0, 1);
    await l._fetch();
    expect(calls.outlines).toHaveLength(3);
  });

  it('refetches outlines after 3 hours even without a change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const l = makeLayer();
    await l._fetch();
    vi.setSystemTime(Date.now() + 2.9 * 3600_000);
    await l._fetch();
    expect(calls.outlines).toHaveLength(1);
    vi.setSystemTime(Date.now() + 0.2 * 3600_000);
    await l._fetch();
    expect(calls.outlines).toHaveLength(2);
  });

  describe('zoomed in', () => {
    it('draws simplified outlines below zoom 11 without fetching detail', async () => {
      const l = makeLayer();
      zoom = 10;
      await l._fetch();
      expect(calls.detail).toEqual([]);
    });

    it('from zoom 11, fetches the full outline of each fire in view, once, and draws it', async () => {
      const l = makeLayer();
      await l._fetch();
      zoom = 11;
      view = { minLat: 47.7, minLng: -121, maxLat: 48, maxLng: -120.7 }; // fire 1 only
      l._showDetail();
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.detail).toHaveLength(1);
      expect(new URL(calls.detail[0]).searchParams.get('objectIds')).toBe('1');
      expect(geoJSONCalls.at(-1)!.find((f) => f.id === 1)!.geometry).toEqual(FULL_1);

      l._showDetail(); // another move over the same fire
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.detail).toHaveLength(1);
    });

    it('fetches a new full outline when the perimeter changes', async () => {
      const l = makeLayer();
      zoom = 11;
      view = { minLat: 47.7, minLng: -121, maxLat: 48, maxLng: -120.7 };
      await l._fetch();
      await new Promise((r) => setTimeout(r, 0));
      fires[0].date = 200;
      await l._fetch();
      await new Promise((r) => setTimeout(r, 0));
      expect(calls.detail).toHaveLength(2);
    });

    it('waits for an open popup to close before redrawing with the detail', async () => {
      const l = makeLayer();
      await l._fetch();
      l._polygonLayer = { eachLayer: (fn: (x: any) => void) => fn({ isPopupOpen: () => true }), addTo: vi.fn() };
      const draws = geoJSONCalls.length;
      zoom = 11;
      view = { minLat: 47.7, minLng: -121, maxLat: 48, maxLng: -120.7 };
      l._showDetail();
      await new Promise((r) => setTimeout(r, 0));
      expect(geoJSONCalls).toHaveLength(draws);
      onceHandlers.popupclose();
      expect(geoJSONCalls).toHaveLength(draws + 1);
      expect(geoJSONCalls.at(-1)!.find((f) => f.id === 1)!.geometry).toEqual(FULL_1);
    });
  });
});
