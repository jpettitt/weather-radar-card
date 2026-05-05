import { describe, it, expect } from 'vitest';
import { geometryLngLatBounds, centroidLngLat, haversineKm } from '../src/geo-utils';

// A simple unit-square Polygon centred on the origin — easy to reason about
// for bounds and centroid tests.
const unitSquare: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[
    [-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1],
  ]],
};

const offCentreSquare: GeoJSON.Polygon = {
  type: 'Polygon',
  coordinates: [[
    [10, 20], [12, 20], [12, 22], [10, 22], [10, 20],
  ]],
};

const multiPoly: GeoJSON.MultiPolygon = {
  type: 'MultiPolygon',
  coordinates: [
    [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]],
    [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
  ],
};

describe('geometryLngLatBounds', () => {
  it('returns the bounds of a simple polygon', () => {
    expect(geometryLngLatBounds(unitSquare)).toEqual({
      minLng: -1, minLat: -1, maxLng: 1, maxLat: 1,
    });
  });

  it('returns the bounds of an off-centre polygon', () => {
    expect(geometryLngLatBounds(offCentreSquare)).toEqual({
      minLng: 10, minLat: 20, maxLng: 12, maxLat: 22,
    });
  });

  it('spans the union of all multipolygon coordinates', () => {
    expect(geometryLngLatBounds(multiPoly)).toEqual({
      minLng: 0, minLat: 0, maxLng: 11, maxLat: 11,
    });
  });

  it('returns null for unsupported geometry types', () => {
    const point: GeoJSON.Point = { type: 'Point', coordinates: [0, 0] };
    expect(geometryLngLatBounds(point)).toBeNull();
    const line: GeoJSON.LineString = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
    expect(geometryLngLatBounds(line)).toBeNull();
  });

  it('returns null for an empty polygon', () => {
    const empty: GeoJSON.Polygon = { type: 'Polygon', coordinates: [] };
    expect(geometryLngLatBounds(empty)).toBeNull();
  });

  it('skips coordinate pairs that aren\'t both numbers', () => {
    // Pathological input — defensive coverage. Real GeoJSON shouldn't
    // contain non-numeric coordinates, but we don't want to throw on it.
    const dirty: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[
        [0, 0],
        [null as any, 5],
        [5, 'NaN' as any],
        [10, 10],
      ]],
    };
    expect(geometryLngLatBounds(dirty)).toEqual({
      minLng: 0, minLat: 0, maxLng: 10, maxLat: 10,
    });
  });
});

describe('centroidLngLat', () => {
  it('returns the bbox-centre of a polygon', () => {
    expect(centroidLngLat(unitSquare)).toEqual([0, 0]);
    expect(centroidLngLat(offCentreSquare)).toEqual([11, 21]);
  });

  it('returns the bbox-centre of a multipolygon (union)', () => {
    expect(centroidLngLat(multiPoly)).toEqual([5.5, 5.5]);
  });

  it('returns null for unsupported geometry types', () => {
    const point: GeoJSON.Point = { type: 'Point', coordinates: [0, 0] };
    expect(centroidLngLat(point)).toBeNull();
  });
});

describe('haversineKm', () => {
  it('returns 0 for identical points', () => {
    expect(haversineKm(40, -100, 40, -100)).toBe(0);
  });

  // Reference distances from independent calculators; tolerances reflect
  // the haversine formula's ~0.5% accuracy and our 6371 km mean radius.
  it('matches a known LA → NYC great-circle distance (~3940 km)', () => {
    // LA: 34.05°N, 118.24°W ; NYC: 40.71°N, 74.01°W
    const d = haversineKm(34.05, -118.24, 40.71, -74.01);
    expect(d).toBeGreaterThan(3900);
    expect(d).toBeLessThan(3970);
  });

  it('matches a known short-distance pair (~111 km per 1° latitude at the equator)', () => {
    const d = haversineKm(0, 0, 1, 0);
    expect(d).toBeCloseTo(111.19, 0);
  });

  it('is symmetric in its argument order', () => {
    const a = haversineKm(34.05, -118.24, 40.71, -74.01);
    const b = haversineKm(40.71, -74.01, 34.05, -118.24);
    expect(a).toBeCloseTo(b, 6);
  });

  it('handles antipodal points (~half Earth\'s circumference)', () => {
    const d = haversineKm(0, 0, 0, 180);
    // πR ≈ 20015 km
    expect(d).toBeCloseTo(20015, 0);
  });
});
