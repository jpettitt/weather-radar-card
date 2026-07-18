import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Stub Leaflet — fetch-tile-layer.ts imports from 'leaflet' but the
// internal helpers we exercise don't touch any real L.* class. Provide
// just enough so the import resolves; the helpers operate on plain
// objects we pass in.
vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  return {
    TileLayer: Object.assign(TileLayer, { WMS }),
    default: { TileLayer: Object.assign(TileLayer, { WMS }) },
  };
});

import { wireAbortLifecycle, createFetchTile, type TileWithAbort } from '../src/fetch-tile-layer';
import { RateLimiter } from '../src/rate-limiter';

// Regression guards for the AbortController pattern the fetcher code
// relies on. The actual layer integration (FetchTileLayer, WildfireLayer,
// NwsAlertsLayer, RadarPlayer) isn't exercised here — those need full
// Leaflet/DOM mocking that the existing test suite avoids on principle.
// Instead these tests lock in the contract our error-handler branches
// depend on, so a future "simplification" that drops the
// `.name === 'AbortError'` check or assumes a different exception type
// breaks loud rather than silently.

describe('AbortController + AbortSignal contract (regression guard)', () => {
  it('AbortError thrown by signal.throwIfAborted has name "AbortError"', () => {
    // Our layer error handlers all branch on `(err as Error)?.name ===
    // 'AbortError'` to distinguish user-initiated cancellation from
    // network failure. If the runtime ever switched to a different name
    // (DOMException codes, custom errors, etc.) every layer's error
    // path would silently mis-classify the cancellation as a real error.
    const ctrl = new AbortController();
    ctrl.abort();
    try {
      ctrl.signal.throwIfAborted();
      throw new Error('throwIfAborted should have thrown');
    } catch (err) {
      expect((err as Error).name).toBe('AbortError');
    }
  });

  it('aborting after settlement is a no-op (does not throw)', () => {
    // After a fetch resolves, we null out the stored controller. If the
    // layer is torn down later, ctrl?.abort() may target a controller
    // whose fetch already settled. The spec guarantees that's safe;
    // pin against any runtime change to that.
    const ctrl = new AbortController();
    expect(() => ctrl.abort()).not.toThrow();
    expect(() => ctrl.abort()).not.toThrow();
  });

  it('aborted signal reports aborted=true and reason="AbortError"', () => {
    const ctrl = new AbortController();
    expect(ctrl.signal.aborted).toBe(false);
    ctrl.abort();
    expect(ctrl.signal.aborted).toBe(true);
    expect((ctrl.signal.reason as Error)?.name).toBe('AbortError');
  });
});

// Replicate the pattern used in wildfire-layer / nws-alerts-layer /
// radar-player so we can test it without Leaflet. If this helper's
// behaviour drifts from the real code, we should refactor to share —
// for now the simplicity wins. Both layers call:
//   this._ctrl?.abort();
//   const ctrl = new AbortController();
//   this._ctrl = ctrl;
//   try { ... } catch (err) { if (err.name === 'AbortError') return; }
//   finally { if (this._ctrl === ctrl) this._ctrl = null; }
class Fetcher {
  private _ctrl: AbortController | null = null;
  abortedCount = 0;
  succeededCount = 0;
  erroredCount = 0;

  async fetchUrl(url: string): Promise<string | null> {
    this._ctrl?.abort();
    const ctrl = new AbortController();
    this._ctrl = ctrl;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      const text = await res.text();
      this.succeededCount++;
      return text;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        this.abortedCount++;
        return null;
      }
      this.erroredCount++;
      throw err;
    } finally {
      if (this._ctrl === ctrl) this._ctrl = null;
    }
  }

  teardown(): void {
    this._ctrl?.abort();
    this._ctrl = null;
  }
}

describe('Fetcher pattern: abort-previous on supersession + abort on teardown', () => {
  // Mock fetch with controllable promises so the tests don't depend on
  // network or happy-dom's quirky AbortError handling.
  let fetchCalls: Array<{ url: string; signal: AbortSignal; resolve: (text: string) => void; reject: (err: Error) => void }>;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = vi.fn((url: string | URL, init?: RequestInit) => {
      let resolve!: (text: string) => void;
      let reject!: (err: Error) => void;
      const responsePromise = new Promise<Response>((res, rej) => {
        resolve = (text: string) => res(new Response(text));
        reject = (err: Error) => rej(err);
      });
      const signal = init?.signal as AbortSignal;
      // Wire abort → reject(AbortError) so the mock matches browser
      // fetch's behaviour. happy-dom's fetch doesn't do this reliably.
      if (signal) {
        const onAbort = (): void => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      fetchCalls.push({ url: String(url), signal, resolve, reject });
      return responsePromise;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('a fresh fetch aborts the in-flight previous one and is counted as AbortError', async () => {
    const f = new Fetcher();
    const first = f.fetchUrl('https://a.test/1');
    // Second call should abort the first before issuing its own request.
    const second = f.fetchUrl('https://a.test/2');
    // Resolve the second so the test doesn't hang on its unresolved promise.
    expect(fetchCalls.length).toBe(2);
    fetchCalls[1].resolve('second-body');
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBeNull();      // first caught AbortError → returned null
    expect(secondResult).toBe('second-body');
    expect(f.abortedCount).toBe(1);
    expect(f.succeededCount).toBe(1);
    expect(f.erroredCount).toBe(0);
    // The first call's signal should report aborted; the second's should not.
    expect(fetchCalls[0].signal.aborted).toBe(true);
    expect(fetchCalls[1].signal.aborted).toBe(false);
  });

  it('teardown aborts the in-flight fetch', async () => {
    const f = new Fetcher();
    const inflight = f.fetchUrl('https://a.test/3');
    expect(fetchCalls.length).toBe(1);
    f.teardown();
    const result = await inflight;
    expect(result).toBeNull();
    expect(f.abortedCount).toBe(1);
    expect(fetchCalls[0].signal.aborted).toBe(true);
  });

  it('non-AbortError exceptions propagate (do not get swallowed as cancellations)', async () => {
    const f = new Fetcher();
    const p = f.fetchUrl('https://a.test/4');
    fetchCalls[0].reject(new Error('network blew up'));
    await expect(p).rejects.toThrow('network blew up');
    expect(f.erroredCount).toBe(1);
    expect(f.abortedCount).toBe(0);
  });

  it('a successful fetch clears the stored controller so teardown does not double-abort', async () => {
    const f = new Fetcher();
    const p = f.fetchUrl('https://a.test/5');
    fetchCalls[0].resolve('ok');
    expect(await p).toBe('ok');
    // After success, teardown should be a no-op for an already-settled fetch.
    expect(() => f.teardown()).not.toThrow();
    expect(f.abortedCount).toBe(0);
  });
});

// ── wireAbortLifecycle integration ────────────────────────────────────────
// Exercises the actual fetch-tile-layer helper that hooks Leaflet's
// tileunload + remove events. Uses a minimal layer stub so we don't
// need a real L.TileLayer instance (consistent with the project's
// "stub leaflet, test the helpers" convention from wind-helpers.test.ts).

describe('wireAbortLifecycle (fetch-tile-layer)', () => {
  // Minimal mock that quacks like a Leaflet TileLayer for the bits the
  // helper touches: .on() to register listeners, ._tiles record of
  // mounted tiles. Layers from FetchTileLayer / FetchWmsTileLayer
  // would supply the same shape with real Leaflet plumbing behind it.
  function makeMockLayer(): {
    listeners: Map<string, (e: { tile?: HTMLElement }) => void>;
    on: ReturnType<typeof vi.fn>;
    _tiles: Record<string, { el: HTMLElement }>;
  } {
    const listeners = new Map<string, (e: { tile?: HTMLElement }) => void>();
    return {
      listeners,
      on: vi.fn((event: string, fn: (e: { tile?: HTMLElement }) => void) => {
        listeners.set(event, fn);
      }),
      _tiles: {},
    };
  }

  function makeTileWithAbort(): { tile: TileWithAbort; ctrl: AbortController } {
    const tile = document.createElement('img') as TileWithAbort;
    const ctrl = new AbortController();
    tile.__wrcAbort = ctrl;
    return { tile, ctrl };
  }

  it('registers tileunload and remove handlers on the layer', () => {
    const layer = makeMockLayer();
    wireAbortLifecycle(layer as never);
    expect(layer.on).toHaveBeenCalledWith('tileunload', expect.any(Function));
    expect(layer.on).toHaveBeenCalledWith('remove', expect.any(Function));
  });

  it('tileunload aborts the unloading tile\'s controller and clears the pointer', () => {
    const layer = makeMockLayer();
    wireAbortLifecycle(layer as never);
    const { tile, ctrl } = makeTileWithAbort();
    const unloadHandler = layer.listeners.get('tileunload')!;
    unloadHandler({ tile });
    expect(ctrl.signal.aborted).toBe(true);
    expect(tile.__wrcAbort).toBeNull();
  });

  it('tileunload on a tile without __wrcAbort is a safe no-op (settled fetch)', () => {
    const layer = makeMockLayer();
    wireAbortLifecycle(layer as never);
    const tile = document.createElement('img') as TileWithAbort;
    // Either undefined (never set) or null (cleared by success/failure).
    const unloadHandler = layer.listeners.get('tileunload')!;
    expect(() => unloadHandler({ tile })).not.toThrow();
  });

  it('remove aborts every still-pending tile in the layer\'s _tiles map', () => {
    const layer = makeMockLayer();
    wireAbortLifecycle(layer as never);
    const a = makeTileWithAbort();
    const b = makeTileWithAbort();
    const c = makeTileWithAbort();
    layer._tiles = {
      '0:0:0': { el: a.tile },
      '0:0:1': { el: b.tile },
      '0:0:2': { el: c.tile },
    };
    const removeHandler = layer.listeners.get('remove')!;
    removeHandler({});
    expect(a.ctrl.signal.aborted).toBe(true);
    expect(b.ctrl.signal.aborted).toBe(true);
    expect(c.ctrl.signal.aborted).toBe(true);
    expect(a.tile.__wrcAbort).toBeNull();
    expect(b.tile.__wrcAbort).toBeNull();
    expect(c.tile.__wrcAbort).toBeNull();
  });

  it('remove skips already-settled tiles (no double-abort, no throw)', () => {
    const layer = makeMockLayer();
    wireAbortLifecycle(layer as never);
    const settled = document.createElement('img') as TileWithAbort;
    // settled.__wrcAbort already null — typical of a tile whose fetch
    // succeeded earlier. remove must not crash on it.
    const inflight = makeTileWithAbort();
    layer._tiles = {
      '0:0:0': { el: settled },
      '0:0:1': { el: inflight.tile },
    };
    const removeHandler = layer.listeners.get('remove')!;
    expect(() => removeHandler({})).not.toThrow();
    expect(inflight.ctrl.signal.aborted).toBe(true);
  });
});

// ── createFetchTile integration ───────────────────────────────────────────

describe('createFetchTile (fetch-tile-layer)', () => {
  let fetchCalls: Array<{ url: string; signal: AbortSignal | undefined; resolve: (b: Blob, init2?: ResponseInit) => void; reject: (err: Error) => void }>;
  const realFetch = global.fetch;

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = vi.fn((url: string | URL, init?: RequestInit) => {
      let resolve!: (b: Blob) => void;
      let reject!: (err: Error) => void;
      const responsePromise = new Promise<Response>((res, rej) => {
        resolve = (b: Blob, init2?: ResponseInit) => res(new Response(b, init2 ?? { status: 200 }));
        reject = (err: Error) => rej(err);
      });
      const signal = init?.signal as AbortSignal | undefined;
      if (signal) {
        const onAbort = (): void => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      fetchCalls.push({ url: String(url), signal, resolve, reject });
      return responsePromise;
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  // Minimal layer stub with the surface createFetchTile reads:
  //   getTileUrl(coords) → string
  //   options (FetchTileOptions — rateLimiter etc.)
  //   _tilePending / _tileFailed / _tileLoaded counters
  function makeFetchLayerStub(): {
    getTileUrl: ReturnType<typeof vi.fn>;
    options: Record<string, unknown>;
    _tilePending: number;
    _tileFailed: number;
    _tileLoaded: number;
  } {
    return {
      getTileUrl: vi.fn(() => 'https://tiles.test/0/0/0.png'),
      options: { maxRetries: 1, retryDelay: 0 },
      _tilePending: 0,
      _tileFailed: 0,
      _tileLoaded: 0,
    };
  }

  it('passes an AbortSignal to fetch and stores the controller on the tile', () => {
    const layer = makeFetchLayerStub();
    const done = vi.fn();
    const tile = createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done) as TileWithAbort;
    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0].signal).toBeInstanceOf(AbortSignal);
    expect(tile.__wrcAbort).toBeInstanceOf(AbortController);
    // Both should reference the same underlying controller.
    expect(fetchCalls[0].signal).toBe(tile.__wrcAbort!.signal);
    expect(layer._tilePending).toBe(1);
  });

  it('aborting the tile\'s controller decrements pending without counting as failure', async () => {
    const layer = makeFetchLayerStub();
    const done = vi.fn();
    const tile = createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done) as TileWithAbort;
    expect(layer._tilePending).toBe(1);
    tile.__wrcAbort!.abort();
    // Settle microtasks so the fetch rejection's .catch handler runs.
    await new Promise((r) => setTimeout(r, 0));
    expect(layer._tilePending).toBe(0);
    expect(layer._tileFailed).toBe(0);          // aborts are not failures
    expect(layer._tileLoaded).toBe(0);
    expect(done).not.toHaveBeenCalled();        // tile is already off the map
    expect(tile.__wrcAbort).toBeNull();
  });

  it('a real HTTP failure still increments tileFailed and calls done', async () => {
    const layer = makeFetchLayerStub();
    const done = vi.fn();
    createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);
    fetchCalls[0].reject(new Error('boom'));
    // Wait for the retry-then-fail chain (maxRetries: 1, retryDelay: 0).
    await new Promise((r) => setTimeout(r, 5));
    expect(layer._tilePending).toBe(0);
    expect(layer._tileFailed).toBe(1);
    expect(done).toHaveBeenCalled();
  });

  // ── Soft-error tiles (200 OK + text/xml body) ─────────────────────────
  //
  // NOAA's WMS sometimes answers 200 with a small XML error document
  // instead of a PNG (observed ~240 bytes — likely a rate-limit the
  // server doesn't surface as 429). These used to be treated as valid
  // tiles: the blob failed <img> decode silently, the tile rendered
  // blank, done() reported success, and nothing retried.

  it('retries a 200-with-XML-body tile and succeeds when the retry returns an image', async () => {
    const layer = makeFetchLayerStub();
    layer.options = { maxRetries: 2, retryDelay: 0 };
    const done = vi.fn();
    createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

    // First response: 200 OK but an XML error document.
    fetchCalls[0].resolve(
      new Blob(['<ServiceExceptionReport/>'], { type: 'text/xml' }),
      { status: 200, headers: { 'content-type': 'text/xml' } },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(fetchCalls.length).toBe(2);          // it retried

    // Retry returns a real image — tile loads normally.
    fetchCalls[1].resolve(
      new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
      { status: 200, headers: { 'content-type': 'image/png' } },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(layer._tileLoaded).toBe(1);
    expect(layer._tileFailed).toBe(0);
    expect(done).toHaveBeenCalled();
  });

  it('a persistent XML-body tile exhausts retries and counts as failed (not silent success)', async () => {
    const layer = makeFetchLayerStub();   // maxRetries: 1 — fail after first soft error
    const done = vi.fn();
    createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

    fetchCalls[0].resolve(
      new Blob(['<ServiceExceptionReport/>'], { type: 'text/xml' }),
      { status: 200, headers: { 'content-type': 'text/xml' } },
    );
    await new Promise((r) => setTimeout(r, 5));
    expect(layer._tileFailed).toBe(1);
    expect(layer._tileLoaded).toBe(0);
    expect(done).toHaveBeenCalled();
  });

  it('a missing content-type header is still treated as an image (no false soft-error)', async () => {
    const layer = makeFetchLayerStub();
    const done = vi.fn();
    createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

    // Blob with empty type → Response carries no meaningful content-type.
    fetchCalls[0].resolve(new Blob([new Uint8Array([0x89, 0x50])]));
    await new Promise((r) => setTimeout(r, 5));
    expect(layer._tileLoaded).toBe(1);
    expect(layer._tileFailed).toBe(0);
  });

  // ── 5xx server errors vs 429 rate-limiting (issue #223) ─────────────
  //
  // A generic `!r.ok` throw didn't tag `.status`, so 502/503/504
  // responses fell into the same "statusless -> treat as rate-limited"
  // branch as CORS-opaque 429s: wrong banner, wrong retry pacing for
  // what's actually a struggling-but-responding server. These lock in
  // the fix: 5xx gets its own callback and its own capped-backoff retry,
  // and genuine 429 / CORS-opaque statusless errors are unaffected.

  describe('5xx server errors are distinct from 429 rate-limiting', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it('a 502 calls on5xx (not on429) and retries with backoff', async () => {
      const layer = makeFetchLayerStub();
      const on429 = vi.fn();
      const on5xx = vi.fn();
      layer.options = { maxRetries: 1, retryDelay: 0, maxServerErrorRetries: 3, on429, on5xx };
      const done = vi.fn();
      createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

      fetchCalls[0].resolve(new Blob(['bad gateway']), { status: 502 });
      await vi.advanceTimersByTimeAsync(0);

      expect(on5xx).toHaveBeenCalledOnce();
      expect(on429).not.toHaveBeenCalled();
      expect(fetchCalls.length).toBe(1); // retry scheduled (1s backoff), not yet fired

      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchCalls.length).toBe(2);

      fetchCalls[1].resolve(
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(layer._tileLoaded).toBe(1);
      expect(layer._tileFailed).toBe(0);
    });

    it('onTileRecovered fires once the tile succeeds after a 5xx', async () => {
      const layer = makeFetchLayerStub();
      const onTileRecovered = vi.fn();
      layer.options = { maxRetries: 1, retryDelay: 0, maxServerErrorRetries: 3, onTileRecovered };
      const done = vi.fn();
      createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

      fetchCalls[0].resolve(new Blob(['service unavailable']), { status: 503 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchCalls.length).toBe(2);

      fetchCalls[1].resolve(
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(onTileRecovered).toHaveBeenCalledOnce();
    });

    it('onTileRecovered fires on every successful tile load, not just after an error', async () => {
      const layer = makeFetchLayerStub();
      const onTileRecovered = vi.fn();
      layer.options = { maxRetries: 1, retryDelay: 0, onTileRecovered };
      const done = vi.fn();
      createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

      fetchCalls[0].resolve(
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }),
        { status: 200, headers: { 'content-type': 'image/png' } },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(onTileRecovered).toHaveBeenCalledOnce();
    });

    it('exhausts retries and fails after maxServerErrorRetries consecutive 5xx responses', async () => {
      const layer = makeFetchLayerStub();
      const on5xx = vi.fn();
      layer.options = { maxRetries: 1, retryDelay: 0, maxServerErrorRetries: 2, on5xx };
      const done = vi.fn();
      createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

      fetchCalls[0].resolve(new Blob(['gateway timeout']), { status: 504 });
      await vi.advanceTimersByTimeAsync(1000); // first retry fires
      expect(fetchCalls.length).toBe(2);

      fetchCalls[1].resolve(new Blob(['gateway timeout']), { status: 504 });
      await vi.advanceTimersByTimeAsync(0); // maxServerErrorRetries: 2 -> gives up, no more scheduling

      expect(on5xx).toHaveBeenCalledTimes(2);
      expect(layer._tileFailed).toBe(1);
      expect(layer._tileLoaded).toBe(0);
      expect(done).toHaveBeenCalled();
    });

    it('a genuine 429 still calls on429, not on5xx', async () => {
      const layer = makeFetchLayerStub();
      const on429 = vi.fn();
      const on5xx = vi.fn();
      layer.options = { maxRetries: 1, retryDelay: 0, on429, on5xx };
      const done = vi.fn();
      createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

      fetchCalls[0].resolve(new Blob(['too many requests']), { status: 429 });
      await vi.advanceTimersByTimeAsync(0);

      expect(on429).toHaveBeenCalledOnce();
      expect(on5xx).not.toHaveBeenCalled();
    });

    it('a CORS-opaque statusless error with a rate limiter still calls on429, not on5xx', async () => {
      const layer = makeFetchLayerStub();
      const on429 = vi.fn();
      const on5xx = vi.fn();
      layer.options = {
        maxRetries: 1, retryDelay: 0,
        rateLimiter: new RateLimiter(500),
        on429, on5xx,
      };
      const done = vi.fn();
      createFetchTile.call(layer as never, { x: 0, y: 0, z: 0 } as never, done);

      // No status set — mirrors a CORS-opaque response the browser blocked.
      fetchCalls[0].reject(new Error('Failed to fetch'));
      await vi.advanceTimersByTimeAsync(0);

      expect(on429).toHaveBeenCalledOnce();
      expect(on5xx).not.toHaveBeenCalled();
    });
  });
});
