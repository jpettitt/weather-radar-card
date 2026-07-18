/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-this-alias */
import * as L from 'leaflet';
import { RateLimiter } from './rate-limiter';

const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface FetchTileOptions extends L.TileLayerOptions {
  rateLimiter?: RateLimiter;
  maxRetries?: number;
  retryDelay?: number;
  /** Cap on retries for a 5xx (server error) response — see on5xx. */
  maxServerErrorRetries?: number;
  on429?: () => void;
  /**
   * Called when a tile fetch resolves with a 5xx status (502/503/504…).
   * Distinct from on429: the server IS responding, just can't serve
   * right now, so this gets its own longer, capped-exponential-backoff
   * retry instead of either the rate-limit pacing or the short generic
   * maxRetries window.
   */
  on5xx?: () => void;
  /**
   * Called on any successful tile load — the signal that a prior on429 /
   * on5xx condition has cleared. Fires unconditionally (harmless if
   * neither was ever triggered); the caller decides what "recovered"
   * means for its own banner/timer state.
   */
  onTileRecovered?: () => void;
  /** When true, Leaflet's _updateOpacity is suppressed so CSS animations own opacity. */
  animationOwnsOpacity?: boolean;
  /**
   * Optional pixel-level rewrite applied to each fetched tile before it
   * is assigned to the <img>. The function mutates the RGBA byte array
   * in place. Use to drop server-rendered pixels that shouldn't be in
   * the animation stack — e.g. the grey "no-data" mask + magenta
   * coverage outline that DWD's WMS bakes into every tile, which would
   * otherwise pulse during a crossfade because two stacked layers
   * compound the dim.
   */
  pixelFilter?: (data: Uint8ClampedArray) => void;
}

// Decode `blob` to a canvas, run `filter` over its RGBA bytes in place,
// re-encode back to a PNG blob. Returns a fresh blob; the caller owns
// it. Falls back to the original blob on any failure (a tile is more
// useful than no tile, even if the mask leaks through).
async function applyPixelFilter(
  blob: Blob,
  filter: (data: Uint8ClampedArray) => void,
): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) { bitmap.close?.(); return blob; }
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    filter(imgData.data);
    ctx.putImageData(imgData, 0, 0);
    return await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b ?? blob), 'image/png');
    });
  } catch {
    return blob;
  }
}

// Augment Leaflet's Coords type (it's missing `z` in some @types versions)
interface Coords extends L.Point {
  z: number;
}

// Each in-flight tile fetch gets an AbortController so a tile that
// Leaflet decides to unload (pan-out-of-view, zoom-change, layer remove)
// can have its underlying HTTP request cancelled rather than letting the
// browser download bytes we'll immediately discard. The controller is
// stored on the tile element itself (`__wrcAbort`) so the tileunload
// handler can find it without a separate map. On success/failure the
// pointer is cleared so we don't try to abort a settled fetch.
//
// On a busy mobile connection this cuts wire bandwidth substantially:
// a low-zoom continental pan can trigger dozens of tile fetches that
// would otherwise complete after the user has already moved past them.
//
// Exported (with TileWithAbort) so the abort-integration tests can
// exercise wireAbortLifecycle and createFetchTile against minimal layer
// stubs without needing a full L.TileLayer instance.
export interface TileWithAbort extends HTMLImageElement {
  __wrcAbort?: AbortController | null;
}

/** @internal — exported for tests/fetch-abort.test.ts integration coverage. */
export function createFetchTile(
  this: FetchTileLayer | FetchWmsTileLayer,
  coords: Coords,
  done: L.DoneCallback,
): HTMLElement {
  const layer = this;
  const tile = document.createElement('img') as TileWithAbort;
  tile.setAttribute('role', 'presentation');

  const url = layer.getTileUrl(coords);
  const opts = layer.options as FetchTileOptions;
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelay = opts.retryDelay ?? 500;
  const maxServerErrorRetries = opts.maxServerErrorRetries ?? 6;
  const limiter = opts.rateLimiter;
  const on429 = opts.on429;
  const on5xx = opts.on5xx;
  const onTileRecovered = opts.onTileRecovered;
  let attempt = 0;

  layer._tilePending++;

  const fail = (): void => {
    tile.src = TRANSPARENT;
    layer._tilePending--;
    layer._tileFailed++;
    tile.__wrcAbort = null;
    done(undefined, tile);
  };

  const tryFetch = (): void => {
    if (limiter && !limiter.canFetch(url)) {
      setTimeout(tryFetch, limiter.msUntilSlot());
      return;
    }
    limiter?.record(url);

    // Fresh controller for each attempt — retries get their own so
    // aborting one in-flight retry doesn't poison the next.
    const ctrl = new AbortController();
    tile.__wrcAbort = ctrl;

    fetch(url, {
      referrer: window.location.href,
      referrerPolicy: 'no-referrer-when-downgrade',
      signal: ctrl.signal,
    })
      .then((r) => {
        if (r.status === 404) { const e: any = new Error('404'); e.status = 404; throw e; }
        if (r.status === 429) { const e: any = new Error('429'); e.status = 429; throw e; }
        if (!r.ok) { const e: any = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
        // Soft-error tiles: NOAA's WMS sometimes answers 200 OK with a
        // small text/xml error document instead of a PNG (observed
        // ~240 bytes; likely a rate-limit the server doesn't surface
        // as 429). Assigning that blob to the <img> just fails decode
        // silently — the tile rendered blank, done() reported success,
        // and nothing ever retried. Detect by content-type and route
        // through the bounded retry path: `e.status = 200` is honest
        // (it WAS a 200) and deliberately keeps the error out of both
        // the 404-fail branch and the statusless-rate-limit branch in
        // the catch below, landing it on the attempt-capped retry. A
        // missing content-type header is left alone (assumed image) so
        // sources that omit the header keep working.
        const ctype = r.headers.get('content-type') ?? '';
        if (ctype.includes('xml') || ctype.includes('html') || ctype.startsWith('text/')) {
          const e: any = new Error(`non-image tile response (${ctype})`);
          e.status = 200;
          throw e;
        }
        return r.blob();
      })
      .then((blob) => {
        const filter = (layer.options as FetchTileOptions).pixelFilter;
        return filter ? applyPixelFilter(blob, filter) : blob;
      })
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        tile.onload = () => URL.revokeObjectURL(objUrl);
        // Decode failures never fire onload — without this, the blob
        // URL (and its buffer) lived until document unload.
        tile.onerror = () => URL.revokeObjectURL(objUrl);
        tile.src = objUrl;
        limiter?.recordSuccess(url);
        onTileRecovered?.();
        layer._tilePending--;
        layer._tileLoaded++;
        tile.__wrcAbort = null;
        done(undefined, tile);
      })
      .catch((err: any) => {
        // Deliberately-cancelled fetch (tile unloaded / layer removed).
        // Decrement pending so the loading-spinner / segment counter
        // stays accurate, but don't count as a failure and don't retry.
        // Don't call done() — Leaflet has already moved on from this tile.
        if (err.name === 'AbortError') {
          layer._tilePending--;
          tile.__wrcAbort = null;
          return;
        }
        if (err.status === 404) {
          fail();
        } else if (err.status === 429 || (limiter && !err.status)) {
          // 429 with CORS headers sets err.status; without CORS headers the browser
          // blocks the response entirely, leaving err.status undefined. If we have a
          // rate limiter on this source, treat any statusless error as rate-limited.
          on429?.();
          const wait = limiter ? Math.max(limiter.msUntilSlot(), 1000) : 5000;
          setTimeout(tryFetch, wait);
        } else if (err.status && err.status >= 500 && err.status < 600) {
          // Genuine server error (502/503/504…) — the server IS responding,
          // just can't serve right now. Distinct from on429 (self-imposed
          // rate-limiting) and the generic path below (a handful of quick
          // retries): capped exponential backoff, more patient since an
          // outage like this is often transient but can outlast maxRetries.
          on5xx?.();
          if (++attempt < maxServerErrorRetries) {
            setTimeout(tryFetch, Math.min(1000 * 2 ** (attempt - 1), 30_000));
          } else {
            fail();
          }
        } else if (++attempt < maxRetries) {
          setTimeout(tryFetch, retryDelay * attempt);
        } else {
          fail();
        }
      });
  };

  tryFetch();
  return tile;
}

// Hook Leaflet's tileunload event so we abort the underlying fetch when
// a tile leaves the DOM. Also hook the layer's `remove` event for the
// bulk teardown case (layer removed from the map, card teardown).
//
// @internal — exported for tests/fetch-abort.test.ts integration coverage.
export function wireAbortLifecycle(layer: FetchTileLayer | FetchWmsTileLayer): void {
  layer.on('tileunload', (e: L.TileEvent) => {
    const tile = e.tile as TileWithAbort;
    tile.__wrcAbort?.abort();
    tile.__wrcAbort = null;
  });
  layer.on('remove', () => {
    // Walk Leaflet's internal _tiles map for any still-pending fetches.
    // tileunload generally fires for each before remove, but the
    // contract is fuzzy under fast tear-downs; this is belt-and-braces.
    const tiles = (layer as any)._tiles as Record<string, { el: HTMLElement }> | undefined;
    if (!tiles) return;
    for (const key in tiles) {
      const tile = tiles[key]?.el as TileWithAbort | undefined;
      if (tile?.__wrcAbort) {
        tile.__wrcAbort.abort();
        tile.__wrcAbort = null;
      }
    }
  });
}

// _updateOpacity body shared by FetchTileLayer and FetchWmsTileLayer when
// animationOwnsOpacity is set. Forces each loaded tile to opacity 1 (skipping
// Leaflet's 200ms fade) and marks them active. Without active, _pruneTiles
// treats current-but-not-active tiles as still loading and retains their
// ancestor levels indefinitely.
function applyOwnedOpacity(layer: FetchTileLayer | FetchWmsTileLayer): void {
  const tiles = (layer as any)._tiles as Record<string, { el: HTMLElement; loaded?: number; active?: boolean }> | undefined;
  if (tiles) {
    for (const key in tiles) {
      const tile = tiles[key];
      if (!tile?.el) continue;
      tile.el.style.opacity = '1';
      if (tile.loaded) tile.active = true;
    }
  }
  // .leaflet-fade-anim starts tile-container divs at opacity:0; force to 1.
  const container = (layer as any)._container as HTMLElement | undefined;
  if (container) {
    container.querySelectorAll<HTMLElement>('.leaflet-tile-container').forEach(
      (el) => { el.style.opacity = '1'; },
    );
  }
}

export class FetchTileLayer extends L.TileLayer {
  _tilePending = 0;
  _tileFailed = 0;
  _tileLoaded = 0;

  initialize(url: string, options: FetchTileOptions): void {
    this._tilePending = 0;
    this._tileFailed = 0;
    this._tileLoaded = 0;
    (L.TileLayer.prototype as any).initialize.call(this, url, options);
    wireAbortLifecycle(this);
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    return createFetchTile.call(this, coords as Coords, done);
  }

  _updateOpacity(): void {
    if (!(this.options as FetchTileOptions).animationOwnsOpacity) {
      (L.TileLayer.prototype as any)._updateOpacity?.call(this);
      return;
    }
    applyOwnedOpacity(this);
  }
}

export class FetchWmsTileLayer extends L.TileLayer.WMS {
  _tilePending = 0;
  _tileFailed = 0;
  _tileLoaded = 0;

  initialize(url: string, options: L.WMSOptions & FetchTileOptions): void {
    this._tilePending = 0;
    this._tileFailed = 0;
    this._tileLoaded = 0;
    // Leaflet's L.TileLayer.WMS appends ANY option that isn't a recognised
    // Leaflet/WMS field to the GetMap URL as a query parameter — that
    // would leak our internal options (rateLimiter, on429,
    // animationOwnsOpacity, pixelFilter) into the request, producing URL
    // fragments like `&rateLimiter=[object%20Object]`. Split them off,
    // hand only the WMS-relevant subset to the parent initialize, then
    // put ours back onto this.options so createTile / _updateOpacity can
    // read them.
    const { rateLimiter, on429, animationOwnsOpacity, pixelFilter, ...wmsOptions } = options;
    (L.TileLayer.WMS.prototype as any).initialize.call(this, url, wmsOptions);
    Object.assign(this.options, { rateLimiter, on429, animationOwnsOpacity, pixelFilter });
    wireAbortLifecycle(this);
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    return createFetchTile.call(this as any, coords as Coords, done);
  }

  _updateOpacity(): void {
    if (!(this.options as FetchTileOptions).animationOwnsOpacity) {
      (L.TileLayer.WMS.prototype as any)._updateOpacity?.call(this);
      return;
    }
    applyOwnedOpacity(this);
  }
}

export function layerSettled(layer: FetchTileLayer | FetchWmsTileLayer): Promise<'loaded' | 'failed'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      layer.off('load', onLoad);
      resolve('failed');
    }, 90_000);

    const onLoad = () => {
      clearTimeout(timer);
      resolve(layer._tileFailed > 0 ? 'failed' : 'loaded');
    };

    layer.once('load', onLoad);
  });
}
