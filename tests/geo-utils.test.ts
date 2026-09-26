import { describe, it, expect } from 'vitest';
import { geometryLngLatBounds, centroidLngLat, haversineKm, formatDistance, formatArea } from '../src/geo-utils';

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

  it('drops a pair when either coordinate is non-numeric, so it cannot stretch the bbox', () => {
    // Each bad pair carries an out-of-range value in its *valid* half
    // (lat 50 / lng -50), so a check that only inspects one coordinate
    // or requires both to be bad lets it leak into the bbox.
    const dirty: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[
        [0, 0],
        [null as any, 50],
        [-50, 'north' as any],
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

describe('formatDistance — display in HA preferred length unit', () => {
  it('formats km when unit is "km"', () => {
    expect(formatDistance(45.4, 'km')).toBe('45 km');
    expect(formatDistance(99.6, 'km')).toBe('100 km');
  });

  it('formats miles when unit is "mi"', () => {
    // 45 km × 0.621371 ≈ 27.96 → 28
    expect(formatDistance(45, 'mi')).toBe('28 mi');
    // 100 km × 0.621371 ≈ 62.14 → 62
    expect(formatDistance(100, 'mi')).toBe('62 mi');
  });

  it('defaults to km when unit is undefined or unknown', () => {
    expect(formatDistance(12, undefined)).toBe('12 km');
    expect(formatDistance(12, '')).toBe('12 km');
    // Future-proof: HA could theoretically introduce a new unit code; we
    // default to metric rather than guessing.
    expect(formatDistance(12, 'lightyears')).toBe('12 km');
  });

  it('rounds sub-1-unit distances to 0 (pinned behaviour from the original popup logic)', () => {
    expect(formatDistance(0.3, 'km')).toBe('0 km');
    // 0.5 km × 0.621371 ≈ 0.31 mi → 0
    expect(formatDistance(0.5, 'mi')).toBe('0 mi');
  });

  it('handles exactly zero distance', () => {
    expect(formatDistance(0, 'km')).toBe('0 km');
    expect(formatDistance(0, 'mi')).toBe('0 mi');
  });
});

// ── formatArea (wildfire acreage → HA preferred unit system) ────────────
//
// NIFC's WFIGS feed always reports area in acres. Metric users get
// hectares, not km² — hectares is the international convention for
// wildfire/land area (see the doc comment on formatArea for the
// rationale). "mi" is the imperial signal (matches formatDistance's
// convention); anything else defaults to metric.

describe('formatArea — wildfire acreage in HA preferred unit system', () => {
  it('converts to hectares when unit is "km" (metric)', () => {
    // 1000 acres × 0.404686 = 404.686 -> 405
    expect(formatArea(1000, 'km', undefined)).toBe('405 ha');
  });

  it('stays in acres when unit is "mi" (imperial) — no conversion', () => {
    expect(formatArea(2500, 'mi', undefined)).toBe('2,500 ac');
  });

  it('defaults to metric (hectares) when unit is undefined or unknown', () => {
    // 100 acres × 0.404686 = 40.4686 -> 40
    expect(formatArea(100, undefined, undefined)).toBe('40 ha');
    expect(formatArea(100, 'lightyears', undefined)).toBe('40 ha');
  });

  it('handles exactly zero acreage', () => {
    expect(formatArea(0, 'km', undefined)).toBe('0 ha');
    expect(formatArea(0, 'mi', undefined)).toBe('0 ac');
  });

  it('formats large fires with a thousands separator via formatNumber', () => {
    // 50,000 acres x 0.404686 = 20,234.3 -> 20,234
    expect(formatArea(50_000, 'km', undefined)).toBe('20,234 ha');
  });
});

// ── Antimeridian handling (2026-06 review backlog) ───────────────────────
//
// A geometry genuinely crossing 180°E/W (Aleutian fires, NWS Alaska
// marine zones) used to produce a naive min/max bbox spanning ~360° of
// longitude with its centre near lon 0 (mid-Atlantic) — radius filters
// then dropped/kept those features wrongly.

describe('geometryLngLatBounds — antimeridian', () => {
  const datelinePoly: GeoJSON.Polygon = {
    type: 'Polygon',
    coordinates: [[
      [178, 51], [179.5, 51], [-179, 52], [-178.5, 51.5], [178, 51],
    ]],
  };

  it('uses a continuous >180 window instead of a planet-wide bbox', () => {
    const b = geometryLngLatBounds(datelinePoly)!;
    expect(b.minLng).toBe(178);
    expect(b.maxLng).toBeCloseTo(181.5, 5);   // -178.5 + 360
    expect(b.maxLng - b.minLng).toBeLessThan(10);
  });

  it('centroid lands near the dateline, wrapped into [-180, 180]', () => {
    const [lng, lat] = centroidLngLat(datelinePoly)!;
    expect(Math.abs(Math.abs(lng) - 180)).toBeLessThan(2);  // ~±180
    expect(lng).toBeGreaterThanOrEqual(-180);
    expect(lng).toBeLessThanOrEqual(180);
    expect(lat).toBeCloseTo(51.5, 1);
  });

  it('non-crossing geometries keep ordinary bounds', () => {
    const b = geometryLngLatBounds(unitSquare)!;
    expect(b).toEqual({ minLng: -1, minLat: -1, maxLng: 1, maxLat: 1 });
  });

  it('leaves an all-negative (western hemisphere) polygon in native coordinates', () => {
    // Without the >180 span guard, +360 rounding makes the shifted span
    // a hair smaller than the naive one for these values and the bbox
    // jumps to ~272 deg.
    const chicago: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[-87.7298, 41.8], [-87.5298, 41.8], [-87.5798, 41.9], [-87.6798, 41.9], [-87.7298, 41.8]]],
    };
    expect(geometryLngLatBounds(chicago)).toEqual({
      minLng: -87.7298, minLat: 41.8, maxLng: -87.5298, maxLat: 41.9,
    });
  });

  it('keeps the naive bbox when the shifted window is wider (degenerate >180 span)', () => {
    // Naive span 270; shifting negatives by 360 gives 1..359 = 358, so
    // the shift must not be adopted.
    const wide: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[-170, 10], [-1, 11], [1, 12], [100, 13], [-170, 10]]],
    };
    expect(geometryLngLatBounds(wide)).toEqual({
      minLng: -170, minLat: 10, maxLng: 100, maxLat: 13,
    });
  });

  it('keeps the naive bbox when the shifted window is exactly as wide (only adopt if tighter)', () => {
    // Naive -100..100 = 200; shifted 80..280 = 200 — a tie stays naive.
    const tie: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[-100, 0], [-80, 1], [80, 2], [100, 3], [-100, 0]]],
    };
    expect(geometryLngLatBounds(tie)).toEqual({
      minLng: -100, minLat: 0, maxLng: 100, maxLat: 3,
    });
  });

  it('treats lng 0 as non-negative when renormalising across the dateline', () => {
    // 0 stays 0: shifted 0..185 (185 wide) beats 170..360 (190 wide),
    // which is what you'd get if 0 were bumped to 360.
    const touchesZero: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[0, 60], [170, 61], [-175, 62], [0, 60]]],
    };
    expect(geometryLngLatBounds(touchesZero)).toEqual({
      minLng: 0, minLat: 60, maxLng: 185, maxLat: 62,
    });
  });

  it('centroid of a crossing geometry whose window centre is past 180 wraps to the western hemisphere', () => {
    // Window 179..190 -> centre 184.5 -> -175.5.
    const poly: GeoJSON.Polygon = {
      type: 'Polygon',
      coordinates: [[[179, 50], [-170, 52], [-175, 51], [-178, 50], [179, 50]]],
    };
    expect(centroidLngLat(poly)).toEqual([-175.5, 51]);
  });
});
