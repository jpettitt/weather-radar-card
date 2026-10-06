// Radar tile reuse (#279). Three layers, checked in order:
//   1. memo     — recently downloaded tiles, in memory, a few minutes.
//                 Covers dashboard switches and the DWD coverage mask,
//                 which asks for the same tiles as the anchor frame.
//   2. inflight — concurrent requests for one URL share one download.
//   3. store    — IndexedDB, only for tiles whose content can no longer
//                 change (see finalUpToMs / persistUntilFor).
// IndexedDB rather than Cache Storage: Cache Storage needs a secure
// context, and many HA installs are served over plain http on the LAN.

/** DWD frames younger than this are not persisted when its newest run is
 *  unknown (run-list fetch failed) — see finalUpToMs. */
export const UNKNOWN_RUN_MIN_AGE_MS = 15 * 60_000;
/** Margin past the source's longest history window before a tile expires. */
export const PERSIST_EXPIRY_MARGIN_MS = 60 * 60_000;

/**
 * Newest frame time (epoch ms) whose tiles can no longer change, so may be
 * persisted. RainViewer frames are content-addressed and NOAA's come from
 * opengeo's list of published scans, so anything one frame interval old is
 * final. DWD answers every request against its newest nowcast run: a frame
 * that run doesn't cover yet is still forecast and changes every 5 min.
 * Measured 2026-10-04: frames the newest run covers were byte-stable across
 * runs. Runs are listed 3–8 min late, so without a known run fall back to a
 * 15-min margin.
 */
export function finalUpToMs(
  source: string,
  nowMs: number,
  strideMin: number,
  dwdLatestRunSec: number | null,
): number {
  if (source === 'DWD') {
    return dwdLatestRunSec !== null ? dwdLatestRunSec * 1000 : nowMs - UNKNOWN_RUN_MIN_AGE_MS;
  }
  return nowMs - strideMin * 60_000;
}

const MEMO_TTL_MS = 5 * 60_000;
// ~256 tiles of 10–30 KB each: a few MB at most, enough for one full loop
// at typical card sizes.
const MEMO_MAX = 256;
const PRUNE_INTERVAL_MS = 30 * 60_000;

export interface TileCachePolicy {
  /**
   * Epoch ms to keep the tile in IndexedDB until, or undefined for memory
   * only. Fixed when the layer is built, before any of its tiles are
   * requested: deciding later could judge a tile against a DWD run published
   * after the server answered it, and store a forecast as final.
   */
  persistUntil?: number;
}

/**
 * When a tile of a frame at `frameTimeMs` may be persisted until, or
 * undefined when it must not be persisted (frame newer than `finalUpTo`).
 * Expiry is the moment the frame falls outside the source's longest
 * supported history, plus a margin.
 */
export function persistUntilFor(frameTimeMs: number, finalUpTo: number, maxPastMin: number): number | undefined {
  if (frameTimeMs > finalUpTo) return undefined;
  return frameTimeMs + maxPastMin * 60_000 + PERSIST_EXPIRY_MARGIN_MS;
}

export interface TileStore {
  /** The stored tile, or null when absent, expired, or the store is unavailable. */
  get(url: string, now: number): Promise<Blob | null>;
  put(url: string, blob: Blob, expiresAt: number): Promise<void>;
  /** Delete every entry that expired at or before `now`. */
  prune(now: number): Promise<void>;
}

interface TileRecord {
  url: string;
  data: ArrayBuffer;
  type: string;
  expiresAt: number;
}

const DB_NAME = 'weather-radar-card-tiles';
const DB_STORE = 'tiles';

// Every failure (no IndexedDB, private mode, quota, cleared storage) degrades
// to a miss / no-op: the tile is simply fetched from the network.
class IdbTileStore implements TileStore {
  private _db: Promise<IDBDatabase | null> | null = null;

  private _open(): Promise<IDBDatabase | null> {
    if (this._db) return this._db;
    this._db = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') { resolve(null); return; }
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(DB_STORE, { keyPath: 'url' }).createIndex('expiresAt', 'expiresAt');
        };
        req.onsuccess = () => {
          const db = req.result;
          // Reopen on next use if the browser closes the connection
          // (storage cleared, another tab upgrading the schema).
          db.onclose = () => { this._db = null; };
          db.onversionchange = () => { db.close(); this._db = null; };
          resolve(db);
        };
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return this._db;
  }

  async get(url: string, now: number): Promise<Blob | null> {
    const db = await this._open();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(url);
        req.onsuccess = () => {
          const rec = req.result as TileRecord | undefined;
          resolve(rec && rec.expiresAt > now ? new Blob([rec.data], { type: rec.type }) : null);
        };
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async put(url: string, blob: Blob, expiresAt: number): Promise<void> {
    const db = await this._open();
    if (!db) return;
    // Read the bytes before opening the transaction: an IndexedDB transaction
    // auto-commits when the event loop goes idle, so awaiting inside one would
    // close it. ArrayBuffer rather than Blob because older WebKit builds
    // failed to store Blobs.
    let data: ArrayBuffer;
    try { data = await blob.arrayBuffer(); } catch { return; }
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const rec: TileRecord = { url, data, type: blob.type, expiresAt };
        tx.objectStore(DB_STORE).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve(); // quota exceeded lands here
      } catch {
        resolve();
      }
    });
  }

  async prune(now: number): Promise<void> {
    const db = await this._open();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const tx = db.transaction(DB_STORE, 'readwrite');
        const req = tx.objectStore(DB_STORE).index('expiresAt').openCursor(IDBKeyRange.upperBound(now));
        req.onsuccess = () => {
          const cursor = req.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
        tx.onabort = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

let store: TileStore = new IdbTileStore();
let lastPruneAt = 0;
const memo = new Map<string, { blob: Blob; at: number }>();
const lookups = new Map<string, Promise<Blob | null>>();

interface Inflight {
  promise: Promise<Blob>;
  ctrl: AbortController;
  waiters: number;
}
const inflight = new Map<string, Inflight>();

function memoSet(url: string, blob: Blob): void {
  memo.delete(url);
  memo.set(url, { blob, at: Date.now() });
  if (memo.size > MEMO_MAX) {
    const oldest = memo.keys().next().value;
    if (oldest !== undefined) memo.delete(oldest);
  }
}

/** A tile downloaded within the last few minutes, or null. */
export function memoGet(url: string): Blob | null {
  const hit = memo.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > MEMO_TTL_MS) {
    memo.delete(url);
    return null;
  }
  // Refresh recency so the LRU evicts tiles nobody is asking for.
  memo.delete(url);
  memo.set(url, hit);
  return hit.blob;
}

/** IndexedDB lookup; concurrent callers for one URL share a single read. */
export function persistedGet(url: string): Promise<Blob | null> {
  const pending = lookups.get(url);
  if (pending) return pending;
  const p = store.get(url, Date.now())
    .catch(() => null)
    .then((blob) => {
      if (blob) memoSet(url, blob);
      return blob;
    })
    .finally(() => lookups.delete(url));
  lookups.set(url, p);
  return p;
}

/** Record a freshly downloaded tile: always in memory, in IndexedDB when policy allows. */
export function storeTile(url: string, blob: Blob, policy: TileCachePolicy): void {
  memoSet(url, blob);
  const now = Date.now();
  const until = policy.persistUntil;
  if (until === undefined || until <= now) return;
  void store.put(url, blob, until);
  if (now - lastPruneAt > PRUNE_INTERVAL_MS) {
    lastPruneAt = now;
    void store.prune(now);
  }
}

/** True while a download of `url` is in progress — join it instead of starting another. */
export function hasInflight(url: string): boolean {
  return inflight.has(url);
}

/**
 * Download `url` once for every concurrent caller. `start` runs only for the
 * first caller. Each caller's `signal` detaches just that caller; the
 * download itself is cancelled only when every caller has gone, so the
 * coverage mask unloading a tile never cancels the frame layer's copy.
 */
export function sharedFetch(
  url: string,
  signal: AbortSignal,
  start: (signal: AbortSignal) => Promise<Blob>,
): Promise<Blob> {
  const abortError = (): Error => Object.assign(new Error('aborted'), { name: 'AbortError' });
  if (signal.aborted) return Promise.reject(abortError());
  let entry = inflight.get(url);
  if (!entry) {
    const ctrl = new AbortController();
    const created: Inflight = { promise: start(ctrl.signal), ctrl, waiters: 0 };
    created.promise.then(
      () => { if (inflight.get(url) === created) inflight.delete(url); },
      () => { if (inflight.get(url) === created) inflight.delete(url); },
    );
    inflight.set(url, created);
    entry = created;
  }
  const shared = entry;
  shared.waiters++;
  return new Promise<Blob>((resolve, reject) => {
    let settled = false;
    const detach = (): void => {
      if (settled) return;
      settled = true;
      if (--shared.waiters === 0) {
        shared.ctrl.abort();
        if (inflight.get(url) === shared) inflight.delete(url);
      }
      reject(abortError());
    };
    signal.addEventListener('abort', detach, { once: true });
    shared.promise.then(
      (blob) => {
        if (settled) return;
        settled = true;
        shared.waiters--;
        signal.removeEventListener('abort', detach);
        resolve(blob);
      },
      (err) => {
        if (settled) return;
        settled = true;
        shared.waiters--;
        signal.removeEventListener('abort', detach);
        reject(err);
      },
    );
  });
}

/** @internal — tests swap in an in-memory store and reset module state. */
export function _setTileStoreForTests(s: TileStore): void {
  store = s;
}

/** @internal */
export function _resetTileCacheForTests(): void {
  memo.clear();
  lookups.clear();
  inflight.clear();
  lastPruneAt = 0;
  store = new IdbTileStore();
}
