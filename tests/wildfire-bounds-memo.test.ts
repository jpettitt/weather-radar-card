// updateHass re-renders the wildfire layer on every hass tick (several a
// second on a busy install) and each render walked every perimeter's
// vertices to find its extent: 2.3 ms a tick with 90 fires on a Mac, more on
// a tablet (2026-10-10 review). The extent of a geometry object never
// changes, so it is computed once per fetch.

import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  const layerGroup = vi.fn(() => ({ addTo: vi.fn(), remove: vi.fn(), clearLayers: vi.fn() }));
  const DomUtil = { create: vi.fn(() => ({ style: {} })), setPosition: vi.fn() };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  const geoJSON = vi.fn(() => ({ addTo: vi.fn() }));
  const canvas = vi.fn(() => ({}));
  return {
    Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent, geoJSON, canvas,
    default: { Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent, geoJSON, canvas },
  };
});

vi.mock('../src/geo-utils', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/geo-utils')>();
  return { ...mod, geometryLngLatBounds: vi.fn(mod.geometryLngLatBounds) };
});

import { geometryLngLatBounds } from '../src/geo-utils';
import { featureLngLatBounds } from '../src/wildfire-layer';

describe('featureLngLatBounds', () => {
  it('walks a geometry once and serves repeats from the memo', () => {
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[-120, 40], [-119, 40], [-119, 41], [-120, 40]]] };
    const walk = vi.mocked(geometryLngLatBounds);
    walk.mockClear();
    const a = featureLngLatBounds(geom);
    const b = featureLngLatBounds(geom);
    expect(walk).toHaveBeenCalledOnce();
    expect(b).toBe(a);
    expect(a).toEqual({ minLng: -120, minLat: 40, maxLng: -119, maxLat: 41 });
  });

  it('a new geometry object (a fresh fetch) is walked again', () => {
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[-120, 40], [-119, 40], [-119, 41], [-120, 40]]] };
    const walk = vi.mocked(geometryLngLatBounds);
    walk.mockClear();
    featureLngLatBounds(geom);
    featureLngLatBounds({ ...geom });
    expect(walk).toHaveBeenCalledTimes(2);
  });

  it('memoises a null result for an unsupported geometry too', () => {
    const geom = { type: 'Point', coordinates: [-120, 40] } as unknown as GeoJSON.Geometry;
    const walk = vi.mocked(geometryLngLatBounds);
    walk.mockClear();
    expect(featureLngLatBounds(geom)).toBeNull();
    expect(featureLngLatBounds(geom)).toBeNull();
    expect(walk).toHaveBeenCalledOnce();
  });
});
