// Zone-batch and refresh paths of the alerts layer that left the map or the
// status wrong (pre-4.0 review, 2026-10-25): hidden alerts never queued
// last, an empty refresh during a gesture or a failed refresh left stale
// state, a re-plan with nothing left to fetch skipped its render, the radius
// filter missed zone alerts, the popup's expiry time disagreed with the map,
// and a store read that never settles stalled zone loading for the session.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { built } = vi.hoisted(() => ({
  built: [] as Array<{ features: GeoJSON.Feature[]; layer: any }>,
}));

vi.mock('leaflet', () => {
  const geoJSON = vi.fn((features: GeoJSON.Feature[]) => {
    const layer = {
      features,
      addTo: vi.fn(),
      on: vi.fn(),
      getLayers: () => features.map(() => ({ isPopupOpen: () => false })),
    };
    built.push({ features, layer });
    return layer;
  });
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  const canvas = vi.fn(() => ({}));
  return { Layer, TileLayer, Control, geoJSON, canvas, default: { Layer, TileLayer, Control, geoJSON, canvas } };
});

import { NwsAlertsLayer, buildPopupHtml, formatDateTime } from '../src/nws-alerts-layer';
import { encodeZone, guardedZoneKV, zoneKeyFromUrl, type StoredZone, type ZoneKV } from '../src/zone-store';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZONE = (id: string): string => `https://api.weather.gov/zones/forecast/${id}`;
const sq = (lng: number, lat = 34): GeoJSON.Polygon =>
  ({ type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.5, lat], [lng + 0.5, lat + 0.5], [lng, lat + 0.5], [lng, lat]]] });
const shapeResponse = (g: GeoJSON.Geometry): Response => new Response(JSON.stringify({ geometry: g }));

const view = (west: number, south: number, east: number, north: number): any =>
  ({ getWest: () => west, getSouth: () => south, getEast: () => east, getNorth: () => north });

/** A map whose padded view is `box` (null: no size yet, everything in view). */
function fakeMap(box: [number, number, number, number] | null, zoom = 9): any {
  return {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => zoom,
    getCenter: () => ({ lat: 35, lng: -95 }),
    getSize: () => (box ? { x: 600, y: 400 } : { x: 0, y: 0 }),
    getBounds: () => ({ pad: () => (box ? view(...box) : null) }),
    removeLayer: vi.fn(),
  };
}

function memKV(): ZoneKV & { map: Map<string, StoredZone>; sets: number } {
  const map = new Map<string, StoredZone>();
  const kv = {
    map, sets: 0,
    get: (k: string) => Promise.resolve(map.get(k)),
    set: (k: string, v: StoredZone) => { kv.sets++; map.set(k, v); return Promise.resolve(); },
    delete: (k: string) => { map.delete(k); return Promise.resolve(); },
    deleteMany: (ks: string[]) => { for (const k of ks) map.delete(k); return Promise.resolve(); },
    keysByAge: () => Promise.resolve([...map.entries()].map(([key, v]) => ({ key, ts: v.ts }))),
  };
  return kv;
}

const zoneAlert = (id: string, event: string, severity: string, zones: string[]): GeoJSON.Feature =>
  ({ type: 'Feature', id, properties: { event, severity, headline: id, affectedZones: zones }, geometry: null } as unknown as GeoJSON.Feature);

const polygonAt = (lng: number, lat: number, id: string): GeoJSON.Feature => ({
  type: 'Feature', id,
  properties: { event: 'Tornado Warning', severity: 'Extreme' },
  geometry: { type: 'Polygon', coordinates: [[[lng, lat], [lng + 0.1, lat], [lng + 0.1, lat + 0.1], [lng, lat + 0.1], [lng, lat]]] },
});

const layers: any[] = [];
function makeLayer(map: any, cfg: Record<string, unknown> = {}, onStatus?: (s: any) => void): any {
  const layer = new NwsAlertsLayer(map, () => ({ type: 'custom:weather-radar-card', ...cfg } as any), undefined, onStatus) as any;
  layer._kv = memKV();
  layers.push(layer);
  return layer;
}

const realFetch = global.fetch;
beforeEach(() => {
  built.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  for (const l of layers.splice(0)) l.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('zone queue order', () => {
  it('queues the missing zones of alerts in view before those of a hidden, more severe alert', () => {
    const layer = makeLayer(fakeMap([-100, 30, -90, 40]));
    layer._cacheZone(ZONE('IN'), sq(-95));    // in the view
    layer._cacheZone(ZONE('OUT'), sq(-60));   // far east of it
    // Paint order is severity-ascending: the hidden alert is the more severe.
    layer._features = [
      zoneAlert('visible', 'Wind Advisory', 'Minor', [ZONE('IN'), ZONE('IN-MISSING')]),
      zoneAlert('hidden', 'Gale Warning', 'Severe', [ZONE('OUT'), ZONE('OUT-MISSING')]),
    ];
    layer._render();
    expect(layer._renderDecisions.get('hidden')).toMatch(/\|z9$/);   // the format that broke the old check
    expect(layer._zoneQueue()).toEqual([ZONE('IN-MISSING'), ZONE('OUT-MISSING')]);
  });
});

describe('an empty refresh during a gesture', () => {
  it('removes the stale polygons once the map is quiet', () => {
    const map = fakeMap([-100, 30, -90, 40]);
    const layer = makeLayer(map);
    layer._features = [polygonAt(-95, 35, 'tornado')];
    layer._render();
    expect(layer._polygonLayer).toBe(built[0].layer);

    layer._onMapBusy();
    layer._features = [];                                    // the refresh's list filtered to nothing
    layer._render({ skipIfDecisionsUnchanged: true });       // deferred while the map moves
    expect(layer._polygonLayer).toBe(built[0].layer);

    layer._onMapQuiet();
    expect(map.removeLayer).toHaveBeenCalledWith(built[0].layer);
    expect(layer._polygonLayer).toBeNull();
  });

  it('a hass tick removes them too', () => {
    const map = fakeMap([-100, 30, -90, 40]);
    const layer = makeLayer(map);
    layer._features = [polygonAt(-95, 35, 'tornado')];
    layer._render();
    layer._features = [];
    layer.updateHass({} as any);
    expect(layer._polygonLayer).toBeNull();
  });
});

describe('a failed alerts refresh', () => {
  it('a 503 on the list does not stop the zone shapes of the alerts still shown', async () => {
    vi.useFakeTimers();
    const zoneCalls: string[] = [];
    global.fetch = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (url.startsWith('https://api.weather.gov/alerts/active')) return Promise.resolve(new Response('down', { status: 503 }));
      zoneCalls.push(url);
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => resolve(shapeResponse(sq(0))), 10);
        init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
      });
    }) as any;
    const layer = makeLayer(fakeMap(null));
    layer._render = vi.fn();
    layer._features = [zoneAlert('a', 'Wind Advisory', 'Moderate', [ZONE('Z0'), ZONE('Z1'), ZONE('Z2'), ZONE('Z3')])];
    layer._zonePool = 1;   // one shape per 10 ms
    void layer._resolveZones();
    for (let i = 0; i < 100 && layer._zoneCache.size < 1; i++) await vi.advanceTimersByTimeAsync(10);
    expect(layer._zoneCache.size).toBe(1);

    await layer._fetch();   // the 60 s refresh, answered 503
    expect(layer._failureCount).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(layer._zoneCache.size).toBe(4);
  });
});

describe('zone status', () => {
  it('clears "zone shapes did not load" when the alerts with failed zones leave the list', async () => {
    const statuses: any[] = [];
    global.fetch = vi.fn(async () => new Response('gone', { status: 404 })) as any;
    const layer = makeLayer(fakeMap(null), {}, (s) => statuses.push(s));
    layer._render = vi.fn();
    layer._features = [zoneAlert('a', 'Wind Advisory', 'Moderate', [ZONE('RETIRED')])];
    await layer._resolveZones();
    expect(statuses).toEqual([{ kind: 'zones', failures: 1, total: 1 }]);

    layer._features = [];   // next refresh: that alert is gone
    await layer._resolveZones();
    expect(statuses[statuses.length - 1]).toBeNull();
  });
});

describe('a re-planned batch with nothing left to fetch', () => {
  it('renders the shapes the batch brought and writes back the older records', async () => {
    const idleQueue: Array<() => void> = [];
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => { idleQueue.push(cb); return 0; });
    global.fetch = vi.fn(() => Promise.reject(new Error('no network in this test'))) as any;
    const kv = memKV();
    const rec = await encodeZone(sq(0), Date.now() - 60_000);
    delete rec.v;   // an older-format record: written back once
    kv.map.set(zoneKeyFromUrl(ZONE('OLD')), rec);

    const layer = makeLayer(fakeMap(null));
    layer._kv = kv;
    layer._render = vi.fn();
    layer._features = [zoneAlert('a', 'Wind Advisory', 'Moderate', [ZONE('OLD')])];

    const first = layer._resolveZones();   // running: awaiting the store read
    await layer._resolveZones();           // a refresh asks for a re-plan
    expect(layer._zoneReplan).toBe(true);
    await first;
    await new Promise((r) => setTimeout(r, 20));
    expect(layer._zoneCache.has(ZONE('OLD'))).toBe(true);
    expect(layer._render).toHaveBeenCalled();

    for (const cb of idleQueue.splice(0)) cb();
    await new Promise((r) => setTimeout(r, 50));
    expect(kv.sets).toBe(1);
  });
});

describe('alerts_radius_km on zone alerts', () => {
  it('drops a zone alert outside the radius once its zone arrives, and keeps one inside', async () => {
    global.fetch = vi.fn(async (url: string) =>
      shapeResponse(url === ZONE('FAR') ? sq(-80) : sq(-95.2, 34.8))) as any;   // FAR: ~1,400 km east of the centre
    // A wide view, so view culling does not hide the far zone.
    const layer = makeLayer(fakeMap([-110, 20, -70, 50], 5), { alerts_radius_km: 50 });
    const far = zoneAlert('far', 'Wind Advisory', 'Moderate', [ZONE('FAR')]);
    const near = zoneAlert('near', 'Wind Advisory', 'Moderate', [ZONE('NEAR')]);
    layer._features = layer._filter([far, near]);
    expect(layer._features.map((f: GeoJSON.Feature) => f.id)).toEqual(['far', 'near']);   // no shapes yet: kept

    await layer._resolveZones();
    expect(layer._features.map((f: GeoJSON.Feature) => f.id)).toEqual(['near']);
    const drawn = built.flatMap((b) => b.features.map((f) => f.id));
    expect(drawn).toContain('near');
    expect(drawn).not.toContain('far');
  });
});

describe('popup expiry', () => {
  const locale = { language: 'en', number_format: 'language', time_format: '24' } as any;

  it('shows ends when it is earlier than expires: when the map drops the alert', () => {
    const html = buildPopupHtml({ event: 'Flood Warning', expires: '2026-10-17T23:00:00Z', ends: '2026-10-17T21:00:00Z' } as any, locale);
    expect(html).toContain(formatDateTime('2026-10-17T21:00:00Z', locale));
    expect(html).not.toContain(formatDateTime('2026-10-17T23:00:00Z', locale));
  });

  it('shows expires when it is the earlier, and whichever one is given', () => {
    const both = buildPopupHtml({ event: 'Flood Warning', expires: '2026-10-17T20:00:00Z', ends: '2026-10-17T22:00:00Z' } as any, locale);
    expect(both).toContain(formatDateTime('2026-10-17T20:00:00Z', locale));
    const endsOnly = buildPopupHtml({ event: 'Flood Warning', ends: '2026-10-17T22:00:00Z' } as any, locale);
    expect(endsOnly).toContain(formatDateTime('2026-10-17T22:00:00Z', locale));
  });
});

describe('a zone store that never answers', () => {
  it('does not stall zone loading: shapes come from the network', async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => shapeResponse(sq(0))) as any;
    const layer = makeLayer(fakeMap(null));
    layer._render = vi.fn();
    const never = (): Promise<never> => new Promise<never>(() => {});
    layer._kv = guardedZoneKV({ get: never, set: never, delete: never, deleteMany: never, keysByAge: never });
    layer._features = [zoneAlert('a', 'Wind Advisory', 'Moderate', [ZONE('A'), ZONE('B')])];
    void layer._resolveZones();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(layer._zoneCache.size).toBe(2);
    expect(layer._zoneBatchRunning).toBe(false);
  });
});

describe('guardedZoneKV', () => {
  it('passes values and errors through', async () => {
    const kv = memKV();
    const g = guardedZoneKV(kv, 1_000);
    const rec = await encodeZone(sq(0), 1);
    await g.set('k', rec);
    expect(await g.get('k')).toBe(rec);
    const failing = guardedZoneKV({ ...kv, get: () => Promise.reject(new Error('quota')) }, 1_000);
    await expect(failing.get('k')).rejects.toThrow('quota');
  });

  it('after one timeout, every operation settles at once as a miss', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const never = (): Promise<never> => { calls++; return new Promise<never>(() => {}); };
    const g = guardedZoneKV({ get: never, set: never, delete: never, deleteMany: never, keysByAge: never }, 1_000);
    const first = g.get('a');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBeUndefined();
    expect(await g.get('b')).toBeUndefined();
    expect(await g.keysByAge()).toEqual([]);
    expect(calls).toBe(1);   // the dead store is not asked again
  });
});
