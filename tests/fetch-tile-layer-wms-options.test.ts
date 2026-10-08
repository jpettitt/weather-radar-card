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

import { FetchWmsTileLayer, INTERNAL_OPTION_KEYS, splitInternalOptions } from '../src/fetch-tile-layer';
import { RateLimiter } from '../src/rate-limiter';

// One representative, distinguishable-from-default value per
// FetchTileOptions-only field, keyed by name so tests can iterate
// INTERNAL_OPTION_KEYS instead of hand-duplicating the field list — the
// list drifting out of sync with FetchTileOptions is exactly how #275
// happened (5 fields added to the interface, never added to the strip
// list, leaking into every DWD/NOAA WMS request).
function sampleInternalValues(): Record<string, unknown> {
  return {
    rateLimiter: new RateLimiter(1),
    maxRetries: 3,
    retryDelay: 500,
    maxServerErrorRetries: 6,
    on429: vi.fn(),
    on5xx: vi.fn(),
    onTileRecovered: vi.fn(),
    onLayerNotDefined: vi.fn(),
    animationOwnsOpacity: true,
    pixelFilter: vi.fn(),
    tileCache: { persistUntil: 123 },
  };
}

describe('splitInternalOptions', () => {
  it('covers every FetchTileOptions-only field (fails if INTERNAL_OPTION_KEYS and the sample values drift apart)', () => {
    const values = sampleInternalValues();
    expect(Object.keys(values).sort()).toEqual([...INTERNAL_OPTION_KEYS].sort());
  });

  it('moves every internal field into `internal` and out of `rest`', () => {
    const values = sampleInternalValues();
    const { internal, rest } = splitInternalOptions({
      layers: 'Radar_wn-product_1x1km_ger',
      ...values,
    } as any);

    expect((rest as any).layers).toBe('Radar_wn-product_1x1km_ger');
    for (const key of INTERNAL_OPTION_KEYS) {
      expect(internal[key]).toBe(values[key]);
      expect(rest).not.toHaveProperty(key);
    }
  });

  it('omits a field from `internal` entirely when the caller never set it', () => {
    const { internal } = splitInternalOptions({ layers: 'x' } as any);
    for (const key of INTERNAL_OPTION_KEYS) {
      expect(key in internal).toBe(false);
    }
  });
});

// Regression guard for the leak fixed after on5xx/onTileRecovered
// (and maxRetries/retryDelay/maxServerErrorRetries) showed up as literal
// query params in outbound DWD WMS requests — Leaflet's TileLayer.WMS
// appends any option it doesn't recognise to the GetMap URL, including
// serializing function values via their own toString(). Every
// FetchTileOptions-only field must be stripped before the options reach
// L.TileLayer.WMS.prototype.initialize, and restored afterward for
// createTile/_updateOpacity. Exercised here at the FetchWmsTileLayer level
// (on top of splitInternalOptions' own unit tests above) to also guard the
// wiring between the two.
describe('FetchWmsTileLayer option leakage (regression guard)', () => {
  it('never passes FetchTileOptions-only fields to the WMS parent initialize', () => {
    const layer = new (FetchWmsTileLayer as any)();
    layer.initialize('https://maps.dwd.de/geoserver/dwd/wms', {
      layers: 'Radar_wn-product_1x1km_ger',
      ...sampleInternalValues(),
    } as any);

    expect(capturedWmsOptions).toBeDefined();
    expect(capturedWmsOptions!.layers).toBe('Radar_wn-product_1x1km_ger');
    for (const key of INTERNAL_OPTION_KEYS) {
      expect(capturedWmsOptions).not.toHaveProperty(key);
    }
  });

  it('restores every internal field onto this.options for createTile/_updateOpacity', () => {
    const layer = new (FetchWmsTileLayer as any)();
    const values = sampleInternalValues();
    layer.initialize('https://maps.dwd.de/geoserver/dwd/wms', {
      layers: 'Radar_wn-product_1x1km_ger',
      ...values,
    } as any);

    for (const key of INTERNAL_OPTION_KEYS) {
      expect((layer.options as any)[key]).toBe(values[key]);
    }
  });
});
