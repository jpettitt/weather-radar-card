import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  return {
    TileLayer: Object.assign(TileLayer, { WMS }),
    default: { TileLayer: Object.assign(TileLayer, { WMS }) },
  };
});

import { createFetchTile, type TileWithAbort } from '../src/fetch-tile-layer';
import { RateLimiter } from '../src/rate-limiter';
import { TileStore, _resetTileCacheForTests, _setTileStoreForTests } from '../src/tile-cache';

// createFetchTile with tileCache set (#279): the DWD coverage mask and the
// anchor frame request byte-identical URLs, and remounts re-request every
// frame. These drive the real fetch path with a mocked fetch.

const URL_A = 'https://tiles.test/a.png';
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeStore implements TileStore {
  entries = new Map<string, Blob>();
  gets = 0;
  puts: Array<{ url: string; expiresAt: number }> = [];

  async get(url: string): Promise<Blob | null> {
    this.gets++;
    return this.entries.get(url) ?? null;
  }

  async put(url: string, blob: Blob, expiresAt: number): Promise<void> {
    this.puts.push({ url, expiresAt });
    this.entries.set(url, blob);
  }

  async prune(): Promise<void> { /* not exercised */ }
}

let fetchCalls: Array<{ url: string; signal: AbortSignal | undefined; resolve: (b: Blob) => void }>;
let store: FakeStore;
const realFetch = global.fetch;

beforeEach(() => {
  _resetTileCacheForTests();
  store = new FakeStore();
  _setTileStoreForTests(store);
  fetchCalls = [];
  global.fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    let resolve!: (b: Blob) => void;
    let reject!: (err: Error) => void;
    const p = new Promise<Response>((res, rej) => {
      resolve = (b: Blob) => res(new Response(b, { status: 200, headers: { 'content-type': 'image/png' } }));
      reject = rej;
    });
    const signal = init?.signal as AbortSignal | undefined;
    signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    fetchCalls.push({ url: String(url), signal, resolve });
    return p;
  }) as typeof fetch;
});

afterEach(() => {
  global.fetch = realFetch;
});

function makeLayer(options: Record<string, unknown> = {}): {
  getTileUrl: () => string;
  options: Record<string, unknown>;
  _tilePending: number;
  _tileFailed: number;
  _tileLoaded: number;
} {
  return {
    getTileUrl: () => URL_A,
    options: { maxRetries: 1, retryDelay: 0, ...options },
    _tilePending: 0,
    _tileFailed: 0,
    _tileLoaded: 0,
  };
}

function addTile(layer: ReturnType<typeof makeLayer>, done = vi.fn()): { tile: TileWithAbort; done: ReturnType<typeof vi.fn> } {
  const tile = createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done) as TileWithAbort;
  return { tile, done };
}

describe('createFetchTile with tileCache', () => {
  it('two layers asking for the same URL at once share one download', async () => {
    const frame = makeLayer({ tileCache: {} });
    const mask = makeLayer({ tileCache: {} });
    const a = addTile(frame);
    const b = addTile(mask);
    await flush(); // store lookup (shared) misses, then one download starts
    expect(fetchCalls.length).toBe(1);
    fetchCalls[0].resolve(new Blob(['png']));
    await flush();
    expect(a.done).toHaveBeenCalledTimes(1);
    expect(b.done).toHaveBeenCalledTimes(1);
    expect(frame._tileLoaded).toBe(1);
    expect(mask._tileLoaded).toBe(1);
    expect(frame._tilePending + mask._tilePending).toBe(0);
  });

  it('without tileCache, identical URLs are still fetched separately (basemaps unchanged)', () => {
    addTile(makeLayer());
    addTile(makeLayer());
    expect(fetchCalls.length).toBe(2);
  });

  it('joining a download in flight does not take a rate-limiter slot', async () => {
    // One slot per minute: if the second tile went through the limiter it
    // would be parked for a minute instead of loading with the first.
    const limiter = new RateLimiter(1);
    const first = makeLayer({ tileCache: {}, rateLimiter: limiter });
    const second = makeLayer({ tileCache: {}, rateLimiter: limiter });
    addTile(first);
    const b = addTile(second);
    await flush();
    fetchCalls[0].resolve(new Blob(['png']));
    await flush();
    expect(b.done).toHaveBeenCalledTimes(1);
  });

  it('a tile requested shortly after a download is served from memory', async () => {
    const layer = makeLayer({ tileCache: {} });
    addTile(layer);
    await flush();
    fetchCalls[0].resolve(new Blob(['png']));
    await flush();
    const later = addTile(makeLayer({ tileCache: {} }));
    await flush();
    expect(fetchCalls.length).toBe(1);
    expect(later.done).toHaveBeenCalledTimes(1);
  });

  it('unloading one tile leaves the shared download running for the other', async () => {
    const a = addTile(makeLayer({ tileCache: {} }));
    const bLayer = makeLayer({ tileCache: {} });
    const b = addTile(bLayer);
    await flush(); // both past the store lookup and sharing the download
    const aLayerPending = (a.tile.__wrcAbort as AbortController);
    aLayerPending.abort();
    await flush();
    expect(fetchCalls[0].signal?.aborted).toBe(false);
    expect(a.done).not.toHaveBeenCalled();
    fetchCalls[0].resolve(new Blob(['png']));
    await flush();
    expect(b.done).toHaveBeenCalledTimes(1);
    expect(bLayer._tileLoaded).toBe(1);
  });

  it('a persisted tile loads without a network request', async () => {
    store.entries.set(URL_A, new Blob(['cached']));
    const onTileRecovered = vi.fn();
    const layer = makeLayer({ tileCache: { persistUntil: Date.now() + 60_000 }, onTileRecovered });
    const { done } = addTile(layer);
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(done).toHaveBeenCalledTimes(1);
    expect(layer._tileLoaded).toBe(1);
    // A cache hit says nothing about the server recovering from 429/5xx.
    expect(onTileRecovered).not.toHaveBeenCalled();
  });

  it('serves a stored tile even to a layer that would not persist it', async () => {
    // The store only ever holds tiles that were final when stored, so a layer
    // that can't tell this time (DWD's run list unavailable) may still reuse it.
    store.entries.set(URL_A, new Blob(['final']));
    const { done } = addTile(makeLayer({ tileCache: {} }));
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(done).toHaveBeenCalledTimes(1);
  });


  it('persists a downloaded tile only when the layer allows it', async () => {
    const until = Date.now() + 60_000;
    addTile(makeLayer({ tileCache: { persistUntil: until } }));
    await flush(); // persistent lookup misses, then the download starts
    fetchCalls[0].resolve(new Blob(['png']));
    await flush();
    expect(store.puts).toEqual([{ url: URL_A, expiresAt: until }]);

    _resetTileCacheForTests();
    store = new FakeStore();
    _setTileStoreForTests(store);
    fetchCalls = [];
    addTile(makeLayer({ tileCache: {} }));
    await flush();
    fetchCalls[0].resolve(new Blob(['png']));
    await flush();
    expect(store.puts).toEqual([]);
  });

  it('a layer that persists does not take a memory copy a non-persisting layer fetched', async () => {
    // DWD: an unpinned URL served a forecast while the frame was still
    // ahead of the run; once the run covers it, the same URL is observed.
    addTile(makeLayer({ tileCache: {} }));
    await flush();
    fetchCalls[0].resolve(new Blob(['forecast']));
    await flush();
    const until = Date.now() + 60_000;
    addTile(makeLayer({ tileCache: { persistUntil: until } }));
    await flush();
    expect(fetchCalls.length).toBe(2);
    fetchCalls[1].resolve(new Blob(['observed']));
    await flush();
    expect(store.puts).toEqual([{ url: URL_A, expiresAt: until }]);
  });

  it('a layer that persists does not join a download a non-persisting layer started', async () => {
    addTile(makeLayer({ tileCache: {} }));
    await flush();
    addTile(makeLayer({ tileCache: { persistUntil: Date.now() + 60_000 } }));
    await flush();
    expect(fetchCalls.length).toBe(2);
  });

  it('a non-persisting layer still reuses a final copy', async () => {
    addTile(makeLayer({ tileCache: { persistUntil: Date.now() + 60_000 } }));
    await flush();
    fetchCalls[0].resolve(new Blob(['observed']));
    await flush();
    const later = addTile(makeLayer({ tileCache: {} }));
    await flush();
    expect(fetchCalls.length).toBe(1);
    expect(later.done).toHaveBeenCalledTimes(1);
  });

  it('a tile unloaded during the persistent lookup is not counted as loaded or failed', async () => {
    const layer = makeLayer({ tileCache: { persistUntil: Date.now() + 60_000 } });
    const { tile, done } = addTile(layer);
    tile.__wrcAbort!.abort();
    await flush();
    expect(fetchCalls.length).toBe(0);
    expect(done).not.toHaveBeenCalled();
    expect(layer._tilePending).toBe(0);
    expect(layer._tileFailed).toBe(0);
  });
});
