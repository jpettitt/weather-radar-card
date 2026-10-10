import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PERSIST_EXPIRY_MARGIN_MS,
  UNKNOWN_RUN_MIN_AGE_MS,
  TileStore,
  finalUpToMs,
  _resetTileCacheForTests,
  _setTileStoreForTests,
  hasInflight,
  memoGet,
  isCacheableTile,
  isFinalRequest,
  persistUntilFor,
  pinnedForecastPolicy,
  forecastReuseMaxAgeMs,
  persistedGet,
  sharedFetch,
  storeTile,
} from '../src/tile-cache';

class FakeStore implements TileStore {
  entries = new Map<string, { blob: Blob; expiresAt: number }>();
  gets = 0;
  puts: Array<{ url: string; expiresAt: number }> = [];
  prunes = 0;
  failGets = false;

  async get(url: string, now: number): Promise<Blob | null> {
    this.gets++;
    if (this.failGets) throw new Error('idb broken');
    const e = this.entries.get(url);
    return e && e.expiresAt > now ? e.blob : null;
  }

  async put(url: string, blob: Blob, expiresAt: number): Promise<void> {
    this.puts.push({ url, expiresAt });
    this.entries.set(url, { blob, expiresAt });
  }

  async prune(now: number): Promise<void> {
    this.prunes++;
    for (const [url, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(url);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: Error) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const MIN = 60_000;
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

let store: FakeStore;

beforeEach(() => {
  _resetTileCacheForTests();
  store = new FakeStore();
  _setTileStoreForTests(store);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('persistUntilFor', () => {
  const finalUpTo = Date.UTC(2026, 9, 4, 12, 0);

  it('does not persist frames newer than the final cutoff (forecast or still settling)', () => {
    expect(persistUntilFor(finalUpTo + 30 * MIN, finalUpTo, 120)).toBeUndefined();
    expect(persistUntilFor(finalUpTo + 1, finalUpTo, 120)).toBeUndefined();
  });

  it('persists a frame exactly at the cutoff', () => {
    expect(persistUntilFor(finalUpTo, finalUpTo, 120)).toBeDefined();
  });

  it("expires 30 minutes after the frame leaves the card's own history window", () => {
    const frame = finalUpTo - 60 * MIN;
    expect(PERSIST_EXPIRY_MARGIN_MS).toBe(30 * MIN);
    // A 2 h loop keeps a frame 2.5 h, not for the source's 84 h maximum.
    expect(persistUntilFor(frame, finalUpTo, 120)).toBe(frame + 150 * MIN);
    expect(persistUntilFor(frame, finalUpTo, 720)).toBe(frame + 750 * MIN);
  });
});

describe('finalUpToMs', () => {
  const now = Date.UTC(2026, 10, 5, 17, 0);

  it('treats RainViewer and NOAA frames as final one frame interval after their time', () => {
    expect(finalUpToMs('RainViewer', now, 10, null)).toBe(now - 10 * MIN);
    expect(finalUpToMs('NOAA', now, 5, null)).toBe(now - 5 * MIN);
    // A DWD run is irrelevant to them.
    expect(finalUpToMs('NOAA', now, 2, now / 1000)).toBe(now - 2 * MIN);
  });

  it("treats DWD frames as final up to the newest run, however recent", () => {
    const run = (now - 3 * MIN) / 1000;
    expect(finalUpToMs('DWD', now, 5, run)).toBe(now - 3 * MIN);
  });

  it('falls back to a 15-minute margin for DWD when the run is unknown', () => {
    expect(finalUpToMs('DWD', now, 5, null)).toBe(now - UNKNOWN_RUN_MIN_AGE_MS);
    expect(UNKNOWN_RUN_MIN_AGE_MS).toBe(15 * MIN);
  });
});

describe('storeTile + memoGet', () => {
  it('serves a stored tile from memory', () => {
    const blob = new Blob(['a']);
    storeTile('u1', blob, {});
    expect(memoGet('u1')).toBe(blob);
    expect(memoGet('other')).toBeNull();
  });

  it('forgets memory entries after the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 4, 12, 0));
    storeTile('u1', new Blob(['a']), {});
    vi.setSystemTime(Date.UTC(2026, 9, 4, 12, 4));
    expect(memoGet('u1')).not.toBeNull();
    vi.setSystemTime(Date.UTC(2026, 9, 4, 12, 10));
    expect(memoGet('u1')).toBeNull();
  });

  it('evicts the least recently used entry beyond the memory cap', () => {
    storeTile('first', new Blob(['0']), {});
    storeTile('second', new Blob(['1']), {});
    // Touch "first" so "second" becomes the oldest.
    expect(memoGet('first')).not.toBeNull();
    for (let i = 0; i < 255; i++) storeTile(`fill-${i}`, new Blob([String(i)]), {});
    expect(memoGet('first')).not.toBeNull();
    expect(memoGet('second')).toBeNull();
  });

  it('never caches an empty or non-image response', () => {
    const until = Date.now() + 60 * MIN;
    storeTile('empty', new Blob([]), { persistUntil: until });
    storeTile('json', new Blob(['{"error":1}'], { type: 'application/json' }), { persistUntil: until });
    storeTile('png', new Blob(['p'], { type: 'image/png' }), { persistUntil: until });
    storeTile('untyped', new Blob(['p']), { persistUntil: until });
    expect(memoGet('empty')).toBeNull();
    expect(memoGet('json')).toBeNull();
    expect(store.puts.map((p) => p.url)).toEqual(['png', 'untyped']);
    expect(isCacheableTile(new Blob(['p'], { type: 'image/webp' }))).toBe(true);
    expect(isCacheableTile(new Blob(['x'], { type: 'application/octet-stream' }))).toBe(false);
  });

  it('hands a non-final memory copy only to callers that accept one', () => {
    const provisional = new Blob(['forecast']);
    storeTile('dwd-unpinned', provisional, {});
    expect(memoGet('dwd-unpinned')).toBe(provisional);
    expect(memoGet('dwd-unpinned', true)).toBeNull();
    const final = new Blob(['observed']);
    storeTile('dwd-unpinned', final, { persistUntil: Date.now() + 60 * MIN });
    expect(memoGet('dwd-unpinned', true)).toBe(final);
  });

  it('persists only when persistUntil is in the future', () => {
    const now = Date.now();
    storeTile('none', new Blob(['a']), {});
    storeTile('past', new Blob(['b']), { persistUntil: now - 1 });
    storeTile('future', new Blob(['c']), { persistUntil: now + 60 * MIN });
    expect(store.puts.map((p) => p.url)).toEqual(['future']);
    expect(store.puts[0].expiresAt).toBe(now + 60 * MIN);
  });

  it('prunes expired entries when persisting, at most every 30 minutes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 4, 12, 0));
    const until = Date.now() + 600 * MIN;
    storeTile('a', new Blob(['a']), { persistUntil: until });
    storeTile('b', new Blob(['b']), { persistUntil: until });
    expect(store.prunes).toBe(1);
    vi.setSystemTime(Date.UTC(2026, 9, 4, 12, 31));
    storeTile('c', new Blob(['c']), { persistUntil: until });
    expect(store.prunes).toBe(2);
  });
});

describe('persistedGet', () => {
  it('shares one store read between concurrent lookups and fills memory on a hit', async () => {
    const blob = new Blob(['x']);
    store.entries.set('u', { blob, expiresAt: Date.now() + MIN });
    const [a, b] = await Promise.all([persistedGet('u'), persistedGet('u')]);
    expect(store.gets).toBe(1);
    expect(a).toBe(blob);
    expect(b).toBe(blob);
    expect(memoGet('u')).toBe(blob);
  });

  it('treats a store failure as a miss', async () => {
    store.failGets = true;
    await expect(persistedGet('u')).resolves.toBeNull();
  });

  it('counts a stored tile as final in memory', async () => {
    const blob = new Blob(['x']);
    store.entries.set('u', { blob, expiresAt: Date.now() + MIN });
    await persistedGet('u');
    expect(memoGet('u', true)).toBe(blob);
  });

  it('gives up on a read that never answers, so the network can take over', async () => {
    vi.useFakeTimers();
    store.get = () => new Promise<Blob | null>(() => { /* a stuck IndexedDB */ });
    let result: Blob | null | undefined;
    void persistedGet('u').then((b) => { result = b; });
    await vi.advanceTimersByTimeAsync(4_900);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(result).toBeNull();
  });
});

describe('sharedFetch', () => {
  it('runs one download for concurrent callers and resolves them all', async () => {
    const d = deferred<Blob>();
    const start = vi.fn(() => d.promise);
    const p1 = sharedFetch('u', new AbortController().signal, start);
    const p2 = sharedFetch('u', new AbortController().signal, start);
    expect(start).toHaveBeenCalledTimes(1);
    expect(hasInflight('u')).toBe(true);
    const blob = new Blob(['x']);
    d.resolve(blob);
    await expect(p1).resolves.toBe(blob);
    await expect(p2).resolves.toBe(blob);
    expect(hasInflight('u')).toBe(false);
  });

  it('one caller cancelling does not cancel the download for the others', async () => {
    const d = deferred<Blob>();
    let downloadSignal!: AbortSignal;
    const start = (signal: AbortSignal): Promise<Blob> => { downloadSignal = signal; return d.promise; };
    const c1 = new AbortController();
    const p1 = sharedFetch('u', c1.signal, start);
    const p2 = sharedFetch('u', new AbortController().signal, start);
    c1.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(downloadSignal.aborted).toBe(false);
    const blob = new Blob(['x']);
    d.resolve(blob);
    await expect(p2).resolves.toBe(blob);
  });

  it('cancels the download once every caller has cancelled, and the next caller starts afresh', async () => {
    const d = deferred<Blob>();
    let downloadSignal!: AbortSignal;
    const start = vi.fn((signal: AbortSignal): Promise<Blob> => { downloadSignal = signal; return d.promise; });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = sharedFetch('u', c1.signal, start);
    const p2 = sharedFetch('u', c2.signal, start);
    c1.abort();
    c2.abort();
    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    await expect(p2).rejects.toMatchObject({ name: 'AbortError' });
    expect(downloadSignal.aborted).toBe(true);
    expect(hasInflight('u')).toBe(false);
    d.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await flush();
    const restart = vi.fn(() => new Promise<Blob>(() => {}));
    void sharedFetch('u', new AbortController().signal, restart);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('a caller whose signal is already aborted is rejected without starting a download', async () => {
    const start = vi.fn(() => new Promise<Blob>(() => {}));
    const c = new AbortController();
    c.abort();
    await expect(sharedFetch('u', c.signal, start)).rejects.toMatchObject({ name: 'AbortError' });
    expect(start).not.toHaveBeenCalled();
    expect(hasInflight('u')).toBe(false);
  });

  it('passes a download failure to every caller', async () => {
    const d = deferred<Blob>();
    const start = (): Promise<Blob> => d.promise;
    const p1 = sharedFetch('u', new AbortController().signal, start);
    const p2 = sharedFetch('u', new AbortController().signal, start);
    d.reject(Object.assign(new Error('429'), { status: 429 }));
    await expect(p1).rejects.toMatchObject({ status: 429 });
    await expect(p2).rejects.toMatchObject({ status: 429 });
    expect(hasInflight('u')).toBe(false);
  });
});

describe('pinnedForecastPolicy / isFinalRequest', () => {
  const run = Date.UTC(2026, 9, 8, 16, 35);
  const frame = run + 60 * MIN;

  it('keeps a run-pinned forecast tile only as long as a reload could reuse the run', () => {
    expect(pinnedForecastPolicy(frame, run)).toEqual({
      persistUntil: run + 35 * MIN,
      finalBefore: frame - 5 * MIN,
    });
  });

  it('counts a pinned request as final only while its frame is still 5+ min ahead', () => {
    // Once the frame time passes, DWD answers the same URL with observations.
    const policy = pinnedForecastPolicy(frame, run);
    expect(isFinalRequest(policy, frame - 6 * MIN)).toBe(true);
    expect(isFinalRequest(policy, frame - 5 * MIN)).toBe(false);
    expect(isFinalRequest(policy, frame + MIN)).toBe(false);
  });

  it('treats other policies as before: final exactly when they persist', () => {
    expect(isFinalRequest(undefined, 0)).toBe(false);
    expect(isFinalRequest({}, 0)).toBe(false);
    expect(isFinalRequest({ persistUntil: 1 }, Date.now())).toBe(true);
  });
});

describe('forecastReuseMaxAgeMs (#279)', () => {
  it('is the refresh interval plus 10 minutes, never less than 30', () => {
    expect(forecastReuseMaxAgeMs(0)).toBe(30 * MIN);     // refresh off
    expect(forecastReuseMaxAgeMs(5)).toBe(30 * MIN);     // a short refresh keeps the floor
    expect(forecastReuseMaxAgeMs(15)).toBe(30 * MIN);
    expect(forecastReuseMaxAgeMs(30)).toBe(40 * MIN);
    expect(forecastReuseMaxAgeMs(60)).toBe(70 * MIN);
  });

  it('pinnedForecastPolicy keeps tiles for the same window, plus the final margin', () => {
    const run = Date.UTC(2026, 9, 8, 16, 35);
    expect(pinnedForecastPolicy(run + 60 * MIN, run, forecastReuseMaxAgeMs(60)).persistUntil).toBe(run + 75 * MIN);
  });
});
