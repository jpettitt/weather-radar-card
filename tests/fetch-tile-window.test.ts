// Deferred tile fetches (the player's fetch window) and the zoom-animation
// guard. Follows fetch-abort.test.ts: Leaflet is stubbed, the helpers run
// against minimal layer stubs, and the network edge is a fake fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class TileLayer {}
  class WMS {}
  // Leaflet 1.9.4's GridLayer._animateZoom, minus everything the guard skips.
  class GridLayer {
    _animateZoom(this: { _setView: (...a: unknown[]) => void }, e: { center: unknown; zoom: number; noUpdate?: boolean }): void {
      this._setView(e.center, e.zoom, true, e.noUpdate);
    }
  }
  return {
    TileLayer: Object.assign(TileLayer, { WMS }),
    GridLayer,
    default: { TileLayer: Object.assign(TileLayer, { WMS }), GridLayer },
  };
});

import {
  createFetchTile, wireAbortLifecycle, holdLayerTiles, releaseLayerTiles, FetchTileLayer,
  type TileWithAbort,
} from '../src/fetch-tile-layer';
import { RateLimiter } from '../src/rate-limiter';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Listener = (e: { tile?: HTMLElement }) => void;

function makeLayerStub(): any {
  const listeners = new Map<string, Listener>();
  return {
    listeners,
    on: vi.fn((event: string, fn: Listener) => { listeners.set(event, fn); }),
    getTileUrl: vi.fn(() => 'https://tiles.test/0/0/0.png'),
    options: { maxRetries: 1, retryDelay: 0 },
    _tilePending: 0,
    _tileFailed: 0,
    _tileLoaded: 0,
    _holdTiles: false,
    _tiles: {} as Record<string, { el: HTMLElement }>,
  };
}

describe('held layers defer tile fetches', () => {
  const realFetch = global.fetch;
  let fetchCalls: string[];

  beforeEach(() => {
    fetchCalls = [];
    global.fetch = vi.fn((url: string | URL) => {
      fetchCalls.push(String(url));
      return new Promise<Response>(() => { /* never settles */ });
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('a tile created on a held layer is counted as pending but not requested', () => {
    const layer = makeLayerStub();
    holdLayerTiles(layer);
    const tile = createFetchTile.call(layer, { x: 0, y: 0, z: 0 } as never, vi.fn()) as TileWithAbort;
    expect(fetchCalls.length).toBe(0);
    expect(layer._tilePending).toBe(1);
    expect(typeof tile.__wrcDeferred).toBe('function');
    expect(layer._deferredTiles.has(tile)).toBe(true);
  });

  it('a held tile does not touch the rate limiter until released', () => {
    const layer = makeLayerStub();
    const limiter = new RateLimiter(10);
    layer.options.rateLimiter = limiter;
    holdLayerTiles(layer);
    createFetchTile.call(layer, { x: 0, y: 0, z: 0 } as never, vi.fn());
    expect((limiter as any)._window.length).toBe(0);
    releaseLayerTiles(layer);
    expect((limiter as any)._window.length).toBe(1);
    expect(fetchCalls.length).toBe(1);
  });

  it('release starts every deferred tile once and clears the hold', () => {
    const layer = makeLayerStub();
    holdLayerTiles(layer);
    const a = createFetchTile.call(layer, { x: 0, y: 0, z: 0 } as never, vi.fn()) as TileWithAbort;
    const b = createFetchTile.call(layer, { x: 1, y: 0, z: 0 } as never, vi.fn()) as TileWithAbort;
    releaseLayerTiles(layer);
    expect(fetchCalls.length).toBe(2);
    expect(layer._holdTiles).toBe(false);
    expect(layer._deferredTiles.size).toBe(0);
    expect(a.__wrcDeferred).toBeNull();
    expect(b.__wrcDeferred).toBeNull();
    expect(a.__wrcAbort).toBeInstanceOf(AbortController);
    // A second release has nothing to start.
    releaseLayerTiles(layer);
    expect(fetchCalls.length).toBe(2);
    // New tiles fetch at once while the layer is released.
    createFetchTile.call(layer, { x: 2, y: 0, z: 0 } as never, vi.fn());
    expect(fetchCalls.length).toBe(3);
  });

  it('a deferred tile that Leaflet unloads is settled without a request', () => {
    const layer = makeLayerStub();
    wireAbortLifecycle(layer);
    holdLayerTiles(layer);
    const tile = createFetchTile.call(layer, { x: 0, y: 0, z: 0 } as never, vi.fn()) as TileWithAbort;
    layer.listeners.get('tileunload')!({ tile });
    expect(layer._tilePending).toBe(0);
    expect(layer._deferredTiles.size).toBe(0);
    expect(tile.__wrcDeferred).toBeNull();
    releaseLayerTiles(layer);
    expect(fetchCalls.length).toBe(0);
  });

  it('removing the layer settles its deferred tiles', () => {
    const layer = makeLayerStub();
    wireAbortLifecycle(layer);
    holdLayerTiles(layer);
    const tile = createFetchTile.call(layer, { x: 0, y: 0, z: 0 } as never, vi.fn()) as TileWithAbort;
    layer._tiles = { '0:0:0': { el: tile } };
    layer.listeners.get('remove')!({});
    expect(layer._tilePending).toBe(0);
    expect(layer._deferredTiles.size).toBe(0);
    releaseLayerTiles(layer);
    expect(fetchCalls.length).toBe(0);
  });

  it('the layer classes expose holdTiles / releaseTiles', () => {
    const layer = new FetchTileLayer('https://tiles.test/{z}/{x}/{y}.png', {} as never) as any;
    // The Leaflet stub's constructor doesn't run initialize, so no options.
    layer.options = {};
    layer.getTileUrl = () => 'https://tiles.test/0/0/0.png';
    layer.holdTiles();
    createFetchTile.call(layer, { x: 0, y: 0, z: 0 } as never, vi.fn());
    expect(fetchCalls.length).toBe(0);
    layer.releaseTiles();
    expect(fetchCalls.length).toBe(1);
  });
});

describe('_animateZoom skips tiles at the stale zoom', () => {
  function makeLayer(mapZoom: number): any {
    const layer = new FetchTileLayer('https://tiles.test/{z}/{x}/{y}.png', {} as never) as any;
    layer._map = { getZoom: () => mapZoom };
    layer._setView = vi.fn();
    layer._setZoomTransforms = vi.fn();
    return layer;
  }

  it('a jump of more than one level only applies the transform', () => {
    const layer = makeLayer(9);
    const center = { lat: 20, lng: -75 };
    layer._animateZoom({ center, zoom: 5 });
    expect(layer._setView).not.toHaveBeenCalled();
    expect(layer._setZoomTransforms).toHaveBeenCalledWith(center, 5);
  });

  it('a one-level zoom keeps loading tiles during the animation', () => {
    const layer = makeLayer(9);
    const center = { lat: 20, lng: -75 };
    layer._animateZoom({ center, zoom: 8 });
    expect(layer._setView).toHaveBeenCalledWith(center, 8, true, undefined);
  });

  it('a layer not on a map defers to Leaflet', () => {
    const layer = makeLayer(9);
    layer._map = undefined;
    layer._animateZoom({ center: { lat: 0, lng: 0 }, zoom: 2 });
    expect(layer._setView).toHaveBeenCalled();
  });
});
