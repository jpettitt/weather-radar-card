import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  PERSIST_EXPIRY_MARGIN_MS,
  PERSIST_MIN_AGE_MS,
  TileStore,
  _resetTileCacheForTests,
  _setTileStoreForTests,
  hasInflight,
  memoGet,
  persistUntilFor,
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
  const now = Date.UTC(2026, 9, 4, 12, 0);

  it('does not persist frames younger than the minimum age (forecast or still settling)', () => {
    expect(persistUntilFor(now + 30 * MIN, now, 120)).toBeUndefined();
    expect(persistUntilFor(now, now, 120)).toBeUndefined();
    expect(persistUntilFor(now - PERSIST_MIN_AGE_MS + 1, now, 120)).toBeUndefined();
  });

  it('persists a frame exactly at the minimum age', () => {
    expect(persistUntilFor(now - PERSIST_MIN_AGE_MS, now, 120)).toBeDefined();
  });

  it("expires when the frame leaves the source's longest history window, plus the margin", () => {
    const frame = now - 60 * MIN;
    // RainViewer / NOAA: 2 h of history.
    expect(persistUntilFor(frame, now, 120)).toBe(frame + 120 * MIN + PERSIST_EXPIRY_MARGIN_MS);
    // DWD: 84 h of history.
    expect(persistUntilFor(frame, now, 5040)).toBe(frame + 5040 * MIN + PERSIST_EXPIRY_MARGIN_MS);
    expect(PERSIST_EXPIRY_MARGIN_MS).toBe(60 * MIN);
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
