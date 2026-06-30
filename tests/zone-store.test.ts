import { describe, it, expect, beforeEach } from 'vitest';
import {
  zoneKeyFromUrl,
  quantizeGeometry,
  encodeZone,
  decodeZone,
  readZone,
  writeZone,
  sweepZones,
  TTL_MS,
  MAX_ENTRIES,
  type ZoneKV,
  type StoredZone,
} from '../src/zone-store';

// In-memory ZoneKV — happy-dom has no IndexedDB, so the cache
// orchestration is tested against this Map-backed backend. The real
// IndexedDB backend (idbZoneKV) is thin boilerplate, smoke-tested on the
// HA testbed.
function memKV(): ZoneKV & { map: Map<string, StoredZone> } {
  const map = new Map<string, StoredZone>();
  return {
    map,
    get: (k) => Promise.resolve(map.get(k)),
    set: (k, v) => { map.set(k, v); return Promise.resolve(); },
    delete: (k) => { map.delete(k); return Promise.resolve(); },
    keysByAge: () => Promise.resolve(
      [...map.entries()]
        .map(([key, v]) => ({ key, ts: v.ts }))
        .sort((a, b) => a.ts - b.ts),
    ),
  };
}

const FC = 'https://api.weather.gov/zones/forecast/MNZ073';
const sampleGeom: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
};

describe('zoneKeyFromUrl', () => {
  it('derives a short, type-preserving key', () => {
    expect(zoneKeyFromUrl(FC)).toBe('forecast/MNZ073');
    expect(zoneKeyFromUrl('https://api.weather.gov/zones/county/MNC053')).toBe('county/MNC053');
    expect(zoneKeyFromUrl('https://api.weather.gov/zones/fire/MNZ073')).toBe('fire/MNZ073');
  });
  it('keeps the type segment so same-id zones of different types do not collide', () => {
    expect(zoneKeyFromUrl('https://api.weather.gov/zones/forecast/TXZ211'))
      .not.toBe(zoneKeyFromUrl('https://api.weather.gov/zones/fire/TXZ211'));
  });
  it('falls back to the raw url when the shape is unexpected', () => {
    expect(zoneKeyFromUrl('weird')).toBe('weird');
  });
});

describe('quantizeGeometry', () => {
  it('rounds coordinates to 4 dp and leaves structure intact', () => {
    const g: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[-72.9074461, 41.3059971], [-72.9069451, 41.3054971]]],
    };
    const q = quantizeGeometry(g) as GeoJSON.Polygon;
    expect(q.coordinates[0]).toEqual([[-72.9074, 41.306], [-72.9069, 41.3055]]);
  });
});

describe('encodeZone / decodeZone round-trip', () => {
  it('round-trips a geometry through (quantise → gzip → un-gzip)', async () => {
    const rec = await encodeZone(sampleGeom, 1000);
    expect(rec.ts).toBe(1000);
    // In Node/browser CompressionStream is present → compressed (c===1),
    // and the payload is binary (ArrayBuffer), never a base64 string.
    if (rec.c === 1) expect(rec.data).toBeInstanceOf(ArrayBuffer);
    expect(await decodeZone(rec)).toEqual(sampleGeom);
  });

  it('quantises during encode', async () => {
    const precise: GeoJSON.Polygon = {
      type: 'Polygon', coordinates: [[[-72.9074461, 41.3059971], [-72.9069451, 41.3054971], [-72.9074461, 41.3059971]]],
    };
    const got = await decodeZone(await encodeZone(precise, 0)) as GeoJSON.Polygon;
    expect(got.coordinates[0][0]).toEqual([-72.9074, 41.306]);
  });
});

describe('readZone / writeZone', () => {
  let kv: ReturnType<typeof memKV>;
  beforeEach(() => { kv = memKV(); });

  it('returns null for a never-cached URL', async () => {
    expect(await readZone(kv, FC, Date.now())).toBeNull();
  });

  it('round-trips write → read', async () => {
    await writeZone(kv, FC, sampleGeom, Date.now());
    expect(await readZone(kv, FC, Date.now())).toEqual(sampleGeom);
  });

  it('stores under the short type/id key', async () => {
    await writeZone(kv, FC, sampleGeom, Date.now());
    expect(kv.map.has('forecast/MNZ073')).toBe(true);
  });

  it('treats an entry past the TTL as a miss and deletes it', async () => {
    const now = Date.now();
    await writeZone(kv, FC, sampleGeom, now - TTL_MS - 1000);
    expect(await readZone(kv, FC, now)).toBeNull();
    expect(kv.map.has('forecast/MNZ073')).toBe(false);   // evicted on read
  });

  it('returns null and deletes a corrupt record', async () => {
    kv.map.set('forecast/MNZ073', { ts: Date.now(), c: 0, data: '{not json' });
    expect(await readZone(kv, FC, Date.now())).toBeNull();
    expect(kv.map.has('forecast/MNZ073')).toBe(false);
  });
});

describe('sweepZones', () => {
  let kv: ReturnType<typeof memKV>;
  beforeEach(() => { kv = memKV(); localStorage.clear(); });

  it('drops TTL-expired entries, keeps fresh ones', async () => {
    const now = Date.now();
    kv.map.set('fresh', { ts: now, c: 0, data: '{}' });
    kv.map.set('stale', { ts: now - TTL_MS - 1, c: 0, data: '{}' });
    const removed = await sweepZones(kv, now);
    expect(removed).toBe(1);
    expect(kv.map.has('fresh')).toBe(true);
    expect(kv.map.has('stale')).toBe(false);
  });

  it('trims oldest-first when over MAX_ENTRIES', async () => {
    const now = Date.now();
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      kv.map.set(`z${i}`, { ts: now + i, c: 0, data: '{}' });   // z0 oldest
    }
    const removed = await sweepZones(kv, now);
    expect(removed).toBe(5);
    expect(kv.map.size).toBe(MAX_ENTRIES);
    expect(kv.map.has('z0')).toBe(false);   // five oldest gone
    expect(kv.map.has('z4')).toBe(false);
    expect(kv.map.has('z5')).toBe(true);
  });

  it('purges legacy localStorage zone caches (the format that filled the quota)', async () => {
    localStorage.setItem('wrc-zone-v1:https://api.weather.gov/zones/forecast/OLD', '{"geometry":{},"ts":1}');
    localStorage.setItem('wrc1z:forecast/INTERIM', '{"ts":1,"c":0,"z":"{}"}');
    localStorage.setItem('some-other-app-key', 'keep me');
    await sweepZones(kv, Date.now());
    expect(localStorage.getItem('wrc-zone-v1:https://api.weather.gov/zones/forecast/OLD')).toBeNull();
    expect(localStorage.getItem('wrc1z:forecast/INTERIM')).toBeNull();
    expect(localStorage.getItem('some-other-app-key')).toBe('keep me');
  });
});
