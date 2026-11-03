// Stored zones of an older format (full precision from 3.x and the 4.0
// alphas, or simplified with the old four-point floor) are written back
// once with the current geometry, a few at a time in idle time after a
// zone batch, never while the map moves, and with their original write time
// so the 30-day TTL is unchanged. Real timers: the zone codec gzips through
// CompressionStream, real I/O that fake timers do not advance.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  return { Layer, TileLayer, Control, default: { Layer, TileLayer, Control } };
});

import { NwsAlertsLayer } from '../src/nws-alerts-layer';
import { encodeZone, decodeZone, zoneKeyFromUrl, ZONE_FORMAT, type StoredZone, type ZoneKV } from '../src/zone-store';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZONE = (id: string): string => `https://api.weather.gov/zones/forecast/${id}`;

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

/** A 2-degree circle with 2000 points: simplification cuts it hard. */
function denseZone(): GeoJSON.Polygon {
  const ring: GeoJSON.Position[] = [];
  for (let i = 0; i < 2000; i++) ring.push([-95 + 2 * Math.cos((2 * Math.PI * i) / 2000), 35 + 2 * Math.sin((2 * Math.PI * i) / 2000)]);
  ring.push(ring[0]);
  return { type: 'Polygon', coordinates: [ring] };
}

async function store(kv: ReturnType<typeof memKV>, url: string, ts: number, current: boolean): Promise<void> {
  const rec = await encodeZone(denseZone(), ts);
  if (!current) delete rec.v;
  kv.map.set(zoneKeyFromUrl(url), rec);
}

// Written a minute ago: well inside the TTL.
const TS = Date.now() - 60_000;

const idleQueue: Array<() => void> = [];
const fireIdle = (): void => { for (const cb of idleQueue.splice(0)) cb(); };

function makeLayer(kv: ZoneKV, zones: string[]): any {
  const map = { on: vi.fn(), off: vi.fn(), getSize: () => ({ x: 0, y: 0 }), getBounds: () => ({ pad: () => null }), removeLayer: vi.fn() };
  const layer = new NwsAlertsLayer(map as any, () => ({ type: 'custom:weather-radar-card' } as any)) as any;
  layer._render = vi.fn();
  layer._kv = kv;
  layer._features = [{ type: 'Feature', id: 'a', geometry: null, properties: { event: 'Wind Advisory', severity: 'Moderate', affectedZones: zones } }];
  return layer;
}

describe('write-back of older-format stored zones', () => {
  const layers: any[] = [];
  beforeEach(() => {
    idleQueue.length = 0;
    vi.stubGlobal('requestIdleCallback', (cb: () => void) => { idleQueue.push(cb); return 0; });
    global.fetch = vi.fn(() => Promise.reject(new Error('no network in this test'))) as any;
  });
  afterEach(() => {
    for (const l of layers.splice(0)) l.clear();
    vi.unstubAllGlobals();
  });

  it('rewrites an older record once, simplified, with its original time and the current format', async () => {
    const kv = memKV();
    await store(kv, ZONE('OLD'), TS, false);
    const before = (await decodeZone(kv.map.get(zoneKeyFromUrl(ZONE('OLD')))!) as GeoJSON.Polygon).coordinates[0].length;
    const layer = makeLayer(kv, [ZONE('OLD')]); layers.push(layer);
    await layer._resolveZones();
    expect(layer._zoneCache.has(ZONE('OLD'))).toBe(true);
    expect(kv.sets).toBe(0);            // nothing written before an idle slice
    fireIdle();
    await vi.waitFor(() => expect(kv.sets).toBe(1));
    const rec = kv.map.get(zoneKeyFromUrl(ZONE('OLD')))!;
    expect(rec.v).toBe(ZONE_FORMAT);
    expect(rec.ts).toBe(TS);
    const after = (await decodeZone(rec) as GeoJSON.Polygon).coordinates[0].length;
    expect(after).toBeLessThan(before / 5);
    // A second batch (nothing to fetch) writes nothing more.
    await layer._resolveZones();
    fireIdle();
    await new Promise((r) => setTimeout(r, 20));
    expect(kv.sets).toBe(1);
  });

  it('leaves a current record alone', async () => {
    const kv = memKV();
    await store(kv, ZONE('NEW'), TS, true);
    const layer = makeLayer(kv, [ZONE('NEW')]); layers.push(layer);
    await layer._resolveZones();
    fireIdle();
    await new Promise((r) => setTimeout(r, 20));
    expect(layer._zoneCache.has(ZONE('NEW'))).toBe(true);
    expect(kv.sets).toBe(0);
  });

  it('waits while the map moves, and clear() drops what is pending', async () => {
    const kv = memKV();
    await store(kv, ZONE('M1'), TS, false);
    await store(kv, ZONE('M2'), TS, false);
    const layer = makeLayer(kv, [ZONE('M1')]); layers.push(layer);
    await layer._resolveZones();
    layer._onMapBusy();
    fireIdle();
    await new Promise((r) => setTimeout(r, 20));
    expect(kv.sets).toBe(0);
    layer._onMapQuiet();
    await vi.waitFor(() => expect(kv.sets).toBe(1));

    const layer2 = makeLayer(kv, [ZONE('M2')]); layers.push(layer2);
    await layer2._resolveZones();
    expect(layer2._writeBack).toHaveLength(1);
    layer2.clear();
    fireIdle();
    await new Promise((r) => setTimeout(r, 20));
    expect(kv.sets).toBe(1);
  });
});
