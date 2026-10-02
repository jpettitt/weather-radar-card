import { describe, it, expect, vi } from 'vitest';

// Capture whatever options FetchWmsTileLayer hands to the (stubbed)
// Leaflet WMS parent initialize, so we can assert our internal
// FetchTileOptions fields never reach it — that's the surface Leaflet's
// real L.TileLayer.WMS turns into GetMap query params.
let capturedWmsOptions: Record<string, unknown> | undefined;

vi.mock('leaflet', () => {
  class TileLayer {
    on(): void {}
  }
  class WMS extends TileLayer {
    initialize(_url: string, options: Record<string, unknown>): void {
      // Snapshot rather than alias: real Leaflet's setOptions merges into
      // a fresh object, so this.options is never the same reference the
      // caller passed in. Aliasing here would let the subsequent
      // Object.assign(this.options, ...) in FetchWmsTileLayer (which puts
      // the internal fields back for createTile/_updateOpacity) leak back
      // into what we captured, masking the exact leak this test guards.
      capturedWmsOptions = { ...options };
      (this as any).options = { ...options };
    }
  }
  return {
    TileLayer: Object.assign(TileLayer, { WMS }),
    default: { TileLayer: Object.assign(TileLayer, { WMS }) },
  };
});

import { FetchWmsTileLayer } from '../src/fetch-tile-layer';
import { RateLimiter } from '../src/rate-limiter';

// Regression guard for the leak fixed after on5xx/onTileRecovered
// (and maxRetries/retryDelay/maxServerErrorRetries) showed up as literal
// query params in outbound DWD WMS requests — Leaflet's TileLayer.WMS
// appends any option it doesn't recognise to the GetMap URL, including
// serializing function values via their own toString(). Every
// FetchTileOptions-only field must be stripped before the options reach
// L.TileLayer.WMS.prototype.initialize.
describe('FetchWmsTileLayer option leakage (regression guard)', () => {
  it('never passes FetchTileOptions-only fields to the WMS parent initialize', () => {
    const layer = new (FetchWmsTileLayer as any)();
    layer.initialize('https://maps.dwd.de/geoserver/dwd/wms', {
      layers: 'Radar_wn-product_1x1km_ger',
      rateLimiter: new RateLimiter(1),
      maxRetries: 3,
      retryDelay: 500,
      maxServerErrorRetries: 6,
      on429: () => {},
      on5xx: () => {},
      onTileRecovered: () => {},
      animationOwnsOpacity: true,
      pixelFilter: () => {},
    } as any);

    expect(capturedWmsOptions).toBeDefined();
    expect(capturedWmsOptions!.layers).toBe('Radar_wn-product_1x1km_ger');
    for (const key of [
      'rateLimiter',
      'maxRetries',
      'retryDelay',
      'maxServerErrorRetries',
      'on429',
      'on5xx',
      'onTileRecovered',
      'animationOwnsOpacity',
      'pixelFilter',
    ]) {
      expect(capturedWmsOptions).not.toHaveProperty(key);
    }
  });

  it('still exposes the internal fields on this.options for createTile/_updateOpacity', () => {
    const layer = new (FetchWmsTileLayer as any)();
    const on5xx = vi.fn();
    const onTileRecovered = vi.fn();
    layer.initialize('https://maps.dwd.de/geoserver/dwd/wms', {
      layers: 'Radar_wn-product_1x1km_ger',
      on5xx,
      onTileRecovered,
    } as any);

    expect((layer.options as any).on5xx).toBe(on5xx);
    expect((layer.options as any).onTileRecovered).toBe(onTileRecovered);
  });
});
