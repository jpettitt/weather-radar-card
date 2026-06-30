// Persistent NWS forecast/county/fire zone-shape cache, backed by
// IndexedDB.
//
// Why IndexedDB and not localStorage: the full NWS zone set is ~8,400
// zones, ~170 MB of raw GeoJSON (a single marine zone can be 95 KB).
// localStorage's ~5 MB quota is *shared* across all of Home Assistant's
// frontend and every custom card, so a heavy-alerts user filled it and
// every subsequent write silently failed — the bug this module fixes.
// IndexedDB's quota is a share of free disk (hundreds of MB+), holds the
// whole set with room to spare, is natively async, and stores binary
// directly. HA itself uses IndexedDB for the same reason (icon cache).
//
// Geometry is still quantised to 4 dp (~11 m — finer than any visible
// difference at the card's zoom range) and gzip-compressed: ~4× smaller
// (~170 MB → ~31 MB for the full set), which means less disk and faster
// reads. Because IndexedDB stores binary, the compressed bytes go in as
// an ArrayBuffer — no base64 (which would re-add ~33%).
//
// Bounds: a 30-day TTL for staleness, plus a generous entry-count cap as
// a citizenship safety belt, plus an evict-and-retry on the rare genuine
// QuotaExceededError. The cap sits above the full zone count so it
// effectively never evicts in normal use — it exists only to stop
// pathological unbounded growth.
//
// Testability: all the transformation logic (key derivation, quantise,
// gzip envelope) is pure and unit-tested. The cache orchestration takes
// an injectable `ZoneKV` backend so tests run against an in-memory map
// (happy-dom has no IndexedDB); the IndexedDB backend itself is thin
// standard boilerplate, smoke-tested on the HA testbed.

const DB_NAME = 'weather-radar-card';
const STORE = 'nws-zones';
export const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COORD_DP = 4;
// Above the ~8,400-zone full set, so it only trims pathological growth.
export const MAX_ENTRIES = 12_000;
// localStorage prefixes from prior versions, purged once on first sweep.
const LEGACY_LS_PREFIXES = ['wrc-zone-v1:', 'wrc1z:'];

export interface StoredZone {
  ts: number;                    // write time (epoch ms) — TTL + LRU key
  c: 0 | 1;                      // 1 = data is gzipped JSON, 0 = plain JSON
  data: ArrayBuffer | string;    // compressed bytes (c=1) or JSON text (c=0)
}

// ── pure helpers ──────────────────────────────────────────────────────────

/** Short, collision-safe key from a zone URL. NWS URLs are
 * `…/zones/<type>/<id>`; the type segment stays because the same id can
 * exist under different types (a forecast and a fire zone can share an
 * id). Falls back to the raw url if the shape is unexpected. */
export function zoneKeyFromUrl(url: string): string {
  const m = url.match(/\/zones\/(.+)$/);
  return m ? m[1] : url;
}

function quantizeCoords(c: unknown, dp: number): unknown {
  if (typeof c === 'number') {
    const f = 10 ** dp;
    return Math.round(c * f) / f;
  }
  return (c as unknown[]).map((x) => quantizeCoords(x, dp));
}

/** Round every coordinate to `dp` decimals (recurses Polygon /
 * MultiPolygon coordinate nesting), returning a new geometry. */
export function quantizeGeometry(geom: GeoJSON.Geometry, dp = COORD_DP): GeoJSON.Geometry {
  const g = geom as { type: string; coordinates: unknown };
  return { ...geom, coordinates: quantizeCoords(g.coordinates, dp) } as GeoJSON.Geometry;
}

const hasCompression = typeof CompressionStream !== 'undefined'
  && typeof DecompressionStream !== 'undefined';

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}
async function gunzip(buf: ArrayBuffer): Promise<string> {
  // Cast: an ArrayBuffer is a valid BlobPart at runtime, but TS 5.7's
  // ArrayBufferLike generic doesn't structurally match the DOM union.
  const stream = new Blob([buf as unknown as BlobPart]).stream()
    .pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** Quantise + (optionally) gzip a geometry into a StoredZone record. */
export async function encodeZone(geom: GeoJSON.Geometry, now: number): Promise<StoredZone> {
  const json = JSON.stringify(quantizeGeometry(geom));
  return hasCompression
    ? { ts: now, c: 1, data: await gzip(json) }
    : { ts: now, c: 0, data: json };
}

/** Inverse of encodeZone. Throws on corrupt data (caller treats as miss). */
export async function decodeZone(rec: StoredZone): Promise<GeoJSON.Geometry> {
  const json = rec.c === 1 ? await gunzip(rec.data as ArrayBuffer) : (rec.data as string);
  return JSON.parse(json) as GeoJSON.Geometry;
}

// ── backend interface ─────────────────────────────────────────────────────
//
// Minimal async key/value contract the orchestration needs. `keysByAge`
// returns keys oldest-first (by stored ts) WITHOUT loading the geometry
// payloads, so TTL/cap eviction is cheap; the IndexedDB implementation
// backs it with an index on `ts`.

export interface ZoneKV {
  get(key: string): Promise<StoredZone | undefined>;
  set(key: string, val: StoredZone): Promise<void>;
  delete(key: string): Promise<void>;
  keysByAge(): Promise<{ key: string; ts: number }[]>;
}

// ── orchestration (backend-agnostic, unit-tested with an in-memory KV) ──────

/** Read + decode a cached zone, or null on miss / expiry / corruption.
 * Expired or corrupt entries are deleted as a side effect. */
export async function readZone(kv: ZoneKV, url: string, now: number): Promise<GeoJSON.Geometry | null> {
  const key = zoneKeyFromUrl(url);
  try {
    const rec = await kv.get(key);
    if (!rec) return null;
    if (typeof rec.ts !== 'number' || now - rec.ts > TTL_MS) {
      await kv.delete(key);
      return null;
    }
    return await decodeZone(rec);
  } catch {
    try { await kv.delete(key); } catch { /* backend gone */ }
    return null;
  }
}

/** Encode + store a zone. On a genuine quota error, evict the oldest
 * quarter and retry once. Best-effort — failures leave the in-memory
 * cache as the session's source of truth. */
export async function writeZone(kv: ZoneKV, url: string, geom: GeoJSON.Geometry, now: number): Promise<void> {
  try {
    const rec = await encodeZone(geom, now);
    const key = zoneKeyFromUrl(url);
    try {
      await kv.set(key, rec);
    } catch (e) {
      if (!isQuotaError(e)) return;
      await evictOldest(kv, 0.25);
      try { await kv.set(key, rec); } catch { /* give up; memory cache covers the session */ }
    }
  } catch {
    // Compression / encoding failure — skip persistence.
  }
}

/** Sweep on layer start: purge legacy localStorage entries (the old
 * full-precision format that filled the quota), drop entries past the
 * TTL, and trim to MAX_ENTRIES oldest-first. Returns the number of
 * IndexedDB entries removed. */
export async function sweepZones(kv: ZoneKV, now: number): Promise<number> {
  purgeLegacyLocalStorage();
  let removed = 0;
  try {
    const keys = await kv.keysByAge();   // oldest first
    const expired = keys.filter((k) => typeof k.ts !== 'number' || now - k.ts > TTL_MS);
    const fresh = keys.filter((k) => !expired.includes(k));
    const overflow = fresh.length > MAX_ENTRIES ? fresh.slice(0, fresh.length - MAX_ENTRIES) : [];
    for (const k of [...expired, ...overflow]) {
      await kv.delete(k.key);
      removed++;
    }
  } catch {
    // Backend unavailable — nothing to sweep.
  }
  return removed;
}

async function evictOldest(kv: ZoneKV, fraction: number): Promise<void> {
  try {
    const keys = await kv.keysByAge();
    const n = Math.max(1, Math.floor(keys.length * fraction));
    for (const k of keys.slice(0, n)) await kv.delete(k.key);
  } catch { /* best-effort */ }
}

function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: string })?.name ?? '';
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

/** One-time removal of pre-IndexedDB zone caches from localStorage. Best
 * effort; the bloated `wrc-zone-v1:` entries are exactly what filled the
 * shared quota, so reclaiming them immediately is part of the fix. */
function purgeLegacyLocalStorage(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && LEGACY_LS_PREFIXES.some((p) => key.startsWith(p))) doomed.push(key);
    }
    for (const key of doomed) localStorage.removeItem(key);
  } catch { /* storage disabled */ }
}

// ── IndexedDB backend (thin; smoke-tested on the HA testbed) ────────────────

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE);
        store.createIndex('ts', 'ts');   // ordered eviction without loading payloads
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

/** Production IndexedDB-backed ZoneKV. Lazily opens the database on first
 * use; every method rejects (caught by the orchestration) if IndexedDB is
 * unavailable or the open fails. */
export function idbZoneKV(): ZoneKV {
  return {
    get: (key) => tx<StoredZone | undefined>('readonly', (s) => s.get(key) as IDBRequest<StoredZone | undefined>),
    set: (key, val) => tx('readwrite', (s) => s.put(val, key)).then(() => undefined),
    delete: (key) => tx('readwrite', (s) => s.delete(key)).then(() => undefined),
    keysByAge: () => openDb().then((db) => new Promise<{ key: string; ts: number }[]>((resolve, reject) => {
      const out: { key: string; ts: number }[] = [];
      const t = db.transaction(STORE, 'readonly');
      // Walk the ts index ascending → oldest first, keys + ts only (the
      // payload isn't loaded into the cursor's key/primaryKey).
      const cursorReq = t.objectStore(STORE).index('ts').openKeyCursor();
      cursorReq.onsuccess = () => {
        const cur = cursorReq.result;
        if (!cur) { resolve(out); return; }
        out.push({ key: String(cur.primaryKey), ts: Number(cur.key) });
        cur.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    })),
  };
}

// Module-level default backend so the alerts layer can call the
// orchestration without threading a backend through. Tests pass their own.
let defaultKv: ZoneKV | null = null;
export function defaultZoneKV(): ZoneKV {
  if (!defaultKv) defaultKv = idbZoneKV();
  return defaultKv;
}
