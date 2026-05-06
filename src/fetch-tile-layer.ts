/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-this-alias */
import * as L from 'leaflet';
import { RateLimiter } from './rate-limiter';

const TRANSPARENT = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export interface FetchTileOptions extends L.TileLayerOptions {
  rateLimiter?: RateLimiter;
  maxRetries?: number;
  retryDelay?: number;
  on429?: () => void;
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

function createFetchTile(
  this: FetchTileLayer | FetchWmsTileLayer,
  coords: Coords,
  done: L.DoneCallback,
): HTMLElement {
  const layer = this;
  const tile = document.createElement('img');
  tile.setAttribute('role', 'presentation');

  const url = layer.getTileUrl(coords);
  const opts = layer.options as FetchTileOptions;
  const maxRetries = opts.maxRetries ?? 3;
  const retryDelay = opts.retryDelay ?? 500;
  const limiter = opts.rateLimiter;
        const on429 = opts.on429;
  let attempt = 0;

  layer._tilePending++;

  const fail = (): void => {
    tile.src = TRANSPARENT;
    layer._tilePending--;
    layer._tileFailed++;
    done(undefined, tile);
  };

  const tryFetch = (): void => {
    if (limiter && !limiter.canFetch(url)) {
      setTimeout(tryFetch, limiter.msUntilSlot());
      return;
    }
    limiter?.record(url);

    fetch(url, { referrer: window.location.href, referrerPolicy: 'no-referrer-when-downgrade' })
      .then((r) => {
        if (r.status === 404) { const e: any = new Error('404'); e.status = 404; throw e; }
        if (r.status === 429) { const e: any = new Error('429'); e.status = 429; throw e; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        const filter = (layer.options as FetchTileOptions).pixelFilter;
        return filter ? applyPixelFilter(blob, filter) : blob;
      })
      .then((blob) => {
        const objUrl = URL.createObjectURL(blob);
        tile.onload = () => URL.revokeObjectURL(objUrl);
        tile.src = objUrl;
        limiter?.recordSuccess(url);
        layer._tilePending--;
        layer._tileLoaded++;
        done(undefined, tile);
      })
      .catch((err: any) => {
        if (err.status === 404) {
          fail();
        } else if (err.status === 429 || (limiter && !err.status)) {
          // 429 with CORS headers sets err.status; without CORS headers the browser
          // blocks the response entirely, leaving err.status undefined. If we have a
          // rate limiter on this source, treat any statusless error as rate-limited.
          on429?.();
          const wait = limiter ? Math.max(limiter.msUntilSlot(), 1000) : 5000;
          setTimeout(tryFetch, wait);
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
