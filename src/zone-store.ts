// Persistent NWS forecast/county/fire zone-shape cache, backed by
// IndexedDB.
//
// Why IndexedDB and not localStorage: the full NWS zone set is ~11,600
// zones (2026-10-08), hundreds of MB of raw GeoJSON (a single marine zone
// can be 95 KB).
// localStorage's ~5 MB quota is *shared* across all of Home Assistant's
// frontend and every custom card, so a heavy-alerts user filled it and
// every subsequent write silently failed — the bug this module fixes.
// IndexedDB's quota is a share of free disk (hundreds of MB+), holds the
// whole set with room to spare, is natively async, and stores binary
// directly. HA itself uses IndexedDB for the same reason (icon cache).
//
// Geometry is still quantised to 4 dp (~11 m — finer than any visible
// difference at the card's zoom range) and gzip-compressed: ~4× smaller
// (stored zones average 3.5 KB), which means less disk and faster
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
// Above the ~11,600-zone full set (2026-10-08), so it only trims pathological growth.
export const MAX_ENTRIES = 12_000;
// localStorage prefixes from prior versions, purged once on first sweep.
const LEGACY_LS_PREFIXES = ['wrc-zone-v1:', 'wrc1z:'];

export interface StoredZone {
  ts: number;                    // write time (epoch ms) — TTL + LRU key
  c: 0 | 1;                      // 1 = data is gzipped JSON, 0 = plain JSON
  data: ArrayBuffer | string;    // compressed bytes (c=1) or JSON text (c=0)
  v?: number;                    // ZONE_FORMAT of the geometry; absent = older
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

// Outline tolerance for zone shapes, in degrees (~220 m). NWS zones are
// vertex-dense along coasts: with the marine categories on, 2,116 zones
// held 2.0 M coordinates and Leaflet re-projected 3 M vertices on every
// zoom, a 150-200 MB heap spike per preset switch that killed mobile
// browsers (2026-10-16). At 0.002° the same set is 318 k coordinates. The
// error is under a pixel below zoom 11 and ~6 px at zoom 12, on advisory
// areas that are not surveyed boundaries. Bump ZONE_FORMAT when this or
// simplifyRing changes, so stored zones are rewritten (readZoneEntry).
export const SIMPLIFY_TOLERANCE_DEG = 0.002;

// Version of the geometry a stored zone holds. Records without it are
// full-precision shapes from before simplification (3.x up to 4.0.0-alpha2:
// about six times the vertices, gunzipped, parsed and simplified again on
// every load until their TTL) or simplified with the old four-point floor
// (4.0.0-alpha3). The alerts layer writes such records back once.
export const ZONE_FORMAT = 2;

// Outline tolerance for drawing at a given map zoom: one CSS pixel of
// longitude at that zoom (256 px tiles), never finer than the stored
// SIMPLIFY_TOLERANCE_DEG. At zoom 3 that is ~0.18°, at zoom 5 ~0.04°; from
// zoom 10 the stored outline is used as it is. The rebuild after a zoom
// gesture was still a 200 ms to 2 s block with ~450 alerts in view at the
// zoom the snap-back of an over-zoomed pinch lands on (2026-10-16). One
// pixel instead of half halves the vertices drawn at zooms 4 to 8 (zoom 5:
// 25k -> 15k) and side-by-side renders at 3x looked the same (2026-10-17).
export function simplifyToleranceForZoom(zoom: number): number {
  const z = Math.max(0, Math.round(zoom));
  return Math.max(SIMPLIFY_TOLERANCE_DEG, 360 / (256 * 2 ** z));
}

/** Squared distance from ring[i] to the segment ring[s]..ring[e]. */
function segDist2(ring: GeoJSON.Position[], i: number, s: number, e: number): number {
  const [x1, y1] = ring[s];
  const [x2, y2] = ring[e];
  const [x, y] = ring[i];
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return (x - x1) ** 2 + (y - y1) ** 2;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len2));
  return (x - x1 - t * dx) ** 2 + (y - y1 - t * dy) ** 2;
}

/** Douglas-Peucker on one ring. The closure point stays, and at least four
 * points do: a triangle or less is not a ring. */
export function simplifyRing(ring: GeoJSON.Position[], tol: number): GeoJSON.Position[] {
  const n = ring.length;
  if (tol <= 0 || n < 5) return ring;
  const sq = tol * tol;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  let kept = 2;
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(ring, i, s, e);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > sq && idx > 0) {
      keep[idx] = 1;
      kept++;
      stack.push([s, idx], [idx, e]);
    }
  }
  // Under four points the ring is narrower than the tolerance along its
  // length: add the points farthest from the kept outline until it is a
  // ring again. This used to return the whole ring, so mid-sized zones kept
  // every vertex at coarse zooms and a coarser tolerance drew more: zoom 3
  // drew 23k vertices at half a pixel and 76k at two (2026-10-17).
  while (kept < 4) {
    let best = -1;
    let bestD = -1;
    let prev = 0;
    for (let i = 1; i < n; i++) {
      if (!keep[i]) continue;
      for (let j = prev + 1; j < i; j++) {
        const d = segDist2(ring, j, prev, i);
        if (d > bestD) { bestD = d; best = j; }
      }
      prev = i;
    }
    if (best < 0) break;
    keep[best] = 1;
    kept++;
  }
  const out: GeoJSON.Position[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(ring[i]);
  return out;
}

/** The drawable part of a zone's geometry as one Polygon / MultiPolygon, or
 * null. NWS publishes some zones as a GeometryCollection (Michigan's
 * forecast zones, 2026-10-16); the card used to skip those, so their
 * alerts never got shapes and the zones were requested again every
 * refresh. Members that are not polygons are dropped. */
export function normalizeZoneGeometry(geom: GeoJSON.Geometry | null | undefined): GeoJSON.Polygon | GeoJSON.MultiPolygon | null {
  if (!geom) return null;
  if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') return geom;
  if (geom.type !== 'GeometryCollection') return null;
  const polys: GeoJSON.Position[][][] = [];
  for (const member of geom.geometries) {
    const g = normalizeZoneGeometry(member);
    if (!g) continue;
    if (g.type === 'Polygon') polys.push(g.coordinates);
    else for (const p of g.coordinates) polys.push(p);
  }
  return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
}

/** A ring whose extent is below the tolerance in both directions: an
 * islet or a hole smaller than what the tolerance can show. */
function ringBelowTolerance(ring: GeoJSON.Position[], tol: number): boolean {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return maxX - minX < tol && maxY - minY < tol;
}

/** Simplify one polygon's rings; null when its outer ring is below the
 * tolerance. Holes below it are dropped: at a coarse drawing tolerance
 * the thousands of islets and holes in marine zones kept four points each
 * and were most of what was left (2026-10-16). */
function simplifyPolygon(rings: GeoJSON.Position[][], tol: number): GeoJSON.Position[][] | null {
  if (rings.length === 0 || ringBelowTolerance(rings[0], tol)) return null;
  const out = [simplifyRing(rings[0], tol)];
  for (let i = 1; i < rings.length; i++) {
    if (!ringBelowTolerance(rings[i], tol)) out.push(simplifyRing(rings[i], tol));
  }
  return out;
}

/** Simplify every ring of a Polygon / MultiPolygon and drop the parts too
 * small for the tolerance; other types pass through. A Polygon that
 * vanishes becomes an empty MultiPolygon. */
export function simplifyGeometry(geom: GeoJSON.Geometry, tol = SIMPLIFY_TOLERANCE_DEG): GeoJSON.Geometry {
  if (tol <= 0) return geom;
  if (geom.type === 'Polygon') {
    const rings = simplifyPolygon(geom.coordinates, tol);
    return rings ? { type: 'Polygon', coordinates: rings } : { type: 'MultiPolygon', coordinates: [] };
  }
  if (geom.type === 'MultiPolygon') {
    const polys: GeoJSON.Position[][][] = [];
    for (const p of geom.coordinates) {
      const rings = simplifyPolygon(p, tol);
      if (rings) polys.push(rings);
    }
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
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
    ? { ts: now, c: 1, data: await gzip(json), v: ZONE_FORMAT }
    : { ts: now, c: 0, data: json, v: ZONE_FORMAT };
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
  /** Delete several keys in one transaction (a sweep can drop thousands). */
  deleteMany(keys: string[]): Promise<void>;
  keysByAge(): Promise<{ key: string; ts: number }[]>;
}

// ── orchestration (backend-agnostic, unit-tested with an in-memory KV) ──────

/** Read + decode a cached zone, or null on miss / expiry / corruption.
 * Expired or corrupt entries are deleted as a side effect. */
export async function readZone(kv: ZoneKV, url: string, now: number): Promise<GeoJSON.Geometry | null> {
  return (await readZoneEntry(kv, url, now))?.geom ?? null;
}

/** readZone plus the record's write time and whether its geometry is the
 * current ZONE_FORMAT (false: the caller should write it back). */
export async function readZoneEntry(
  kv: ZoneKV, url: string, now: number,
): Promise<{ geom: GeoJSON.Geometry; ts: number; current: boolean } | null> {
  const key = zoneKeyFromUrl(url);
  try {
    const rec = await kv.get(key);
    if (!rec) return null;
    if (typeof rec.ts !== 'number' || now - rec.ts > TTL_MS) {
      await kv.delete(key);
      return null;
    }
    return { geom: await decodeZone(rec), ts: rec.ts, current: rec.v === ZONE_FORMAT };
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
    const isExpired = (k: { ts: number }): boolean => typeof k.ts !== 'number' || now - k.ts > TTL_MS;
    const expired = keys.filter(isExpired);
    const fresh = keys.filter((k) => !isExpired(k));
    const overflow = fresh.length > MAX_ENTRIES ? fresh.slice(0, fresh.length - MAX_ENTRIES) : [];
    // One transaction: the whole 11,600-zone set expiring together meant as
    // many sequential transactions, seconds of stall on a tablet.
    const doomed = [...expired, ...overflow].map((k) => k.key);
    await kv.deleteMany(doomed);
    removed = doomed.length;
  } catch {
    // Backend unavailable — nothing to sweep.
  }
  return removed;
}

async function evictOldest(kv: ZoneKV, fraction: number): Promise<void> {
  try {
    const keys = await kv.keysByAge();
    const n = Math.max(1, Math.floor(keys.length * fraction));
    await kv.deleteMany(keys.slice(0, n).map((k) => k.key));
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
    deleteMany: (keys) => keys.length === 0 ? Promise.resolve() : openDb().then((db) => new Promise<void>((resolve, reject) => {
      const t = db.transaction(STORE, 'readwrite');
      const s = t.objectStore(STORE);
      for (const k of keys) s.delete(k);
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    })),
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

// How long one store operation may take before the store is given up on.
// Reads take milliseconds; this only catches one that never settles.
export const KV_TIMEOUT_MS = 10_000;

/**
 * `inner` with a time limit on every operation. IndexedDB can stop
 * answering without an error (an open blocked by another tab's older
 * connection waits for it to close; Safari has stalled requests), and the
 * alerts layer awaits each zone read, so one such read held its zone
 * worker, and with it the batch, for the rest of the session. After the
 * first timeout the store counts as gone: every operation then settles at
 * once as a miss, and zones come from the network.
 */
export function guardedZoneKV(inner: ZoneKV, timeoutMs = KV_TIMEOUT_MS): ZoneKV {
  let dead = false;
  const guard = <T>(op: () => Promise<T>, miss: T): Promise<T> => {
    if (dead) return Promise.resolve(miss);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        dead = true;
        console.warn('Weather Radar Card: zone store did not answer; using the network for this session');
        resolve(miss);
      }, timeoutMs);
      op().then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); },
      );
    });
  };
  return {
    get: (key) => guard(() => inner.get(key), undefined),
    set: (key, val) => guard(() => inner.set(key, val), undefined),
    delete: (key) => guard(() => inner.delete(key), undefined),
    deleteMany: (keys) => guard(() => inner.deleteMany(keys), undefined),
    keysByAge: () => guard(() => inner.keysByAge(), []),
  };
}

// Module-level default backend so the alerts layer can call the
// orchestration without threading a backend through. Tests pass their own.
let defaultKv: ZoneKV | null = null;
export function defaultZoneKV(): ZoneKV {
  if (!defaultKv) defaultKv = guardedZoneKV(idbZoneKV());
  return defaultKv;
}
