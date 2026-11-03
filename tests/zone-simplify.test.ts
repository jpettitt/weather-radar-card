// Zone outline simplification (Douglas-Peucker) before caching and
// rendering. With marine categories on, raw NWS zones held 2.0 M
// coordinates and Leaflet re-projected 3 M vertices per zoom; at the
// 0.002° tolerance the same set is 318 k (measured 2026-10-16).

import { describe, it, expect } from 'vitest';
import { simplifyRing, simplifyGeometry, normalizeZoneGeometry, simplifyToleranceForZoom, SIMPLIFY_TOLERANCE_DEG } from '../src/zone-store';

describe('simplifyToleranceForZoom', () => {
  it('is one pixel of longitude at the zoom, coarser at low zooms', () => {
    expect(simplifyToleranceForZoom(3)).toBeCloseTo(0.1758, 4);
    expect(simplifyToleranceForZoom(5)).toBeCloseTo(0.0439, 4);
    expect(simplifyToleranceForZoom(7)).toBeCloseTo(0.0110, 4);
    expect(simplifyToleranceForZoom(9)).toBeCloseTo(0.0027, 4);
  });

  it('never goes finer than the stored outline', () => {
    expect(simplifyToleranceForZoom(10)).toBe(SIMPLIFY_TOLERANCE_DEG);
    expect(simplifyToleranceForZoom(16)).toBe(SIMPLIFY_TOLERANCE_DEG);
  });

  it('rounds fractional zooms and clamps below zero', () => {
    expect(simplifyToleranceForZoom(4.6)).toBe(simplifyToleranceForZoom(5));
    expect(simplifyToleranceForZoom(-2)).toBe(simplifyToleranceForZoom(0));
  });
});

describe('normalizeZoneGeometry', () => {
  const poly: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const multi: GeoJSON.MultiPolygon = { type: 'MultiPolygon', coordinates: [[[[2, 2], [3, 2], [3, 3], [2, 2]]]] };

  it('passes a Polygon or MultiPolygon through', () => {
    expect(normalizeZoneGeometry(poly)).toBe(poly);
    expect(normalizeZoneGeometry(multi)).toBe(multi);
  });

  it('flattens a GeometryCollection into one MultiPolygon, dropping non-polygon members', () => {
    const gc: GeoJSON.GeometryCollection = { type: 'GeometryCollection', geometries: [poly, { type: 'Point', coordinates: [5, 5] }, multi] };
    expect(normalizeZoneGeometry(gc)).toEqual({ type: 'MultiPolygon', coordinates: [poly.coordinates, multi.coordinates[0]] });
  });

  it('returns null for nothing drawable', () => {
    expect(normalizeZoneGeometry(null)).toBeNull();
    expect(normalizeZoneGeometry(undefined)).toBeNull();
    expect(normalizeZoneGeometry({ type: 'Point', coordinates: [1, 1] })).toBeNull();
    expect(normalizeZoneGeometry({ type: 'GeometryCollection', geometries: [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }] })).toBeNull();
  });
});

const square: GeoJSON.Position[] = [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]];

/** Distance from p to the segment ab, in degrees. */
function segDist(p: GeoJSON.Position, a: GeoJSON.Position, b: GeoJSON.Position): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function circle(points: number, radius: number): GeoJSON.Position[] {
  const ring: GeoJSON.Position[] = [];
  for (let i = 0; i < points; i++) {
    const a = (2 * Math.PI * i) / points;
    ring.push([radius * Math.cos(a), radius * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

describe('simplifyRing', () => {
  it('drops points that lie within the tolerance of the surrounding segment', () => {
    const ring: GeoJSON.Position[] = [[0, 0], [0.5, 0.0005], [1, 0], [1, 1], [0, 1], [0, 0]];
    expect(simplifyRing(ring, 0.002)).toEqual(square);
  });

  it('keeps a point that deviates more than the tolerance', () => {
    const ring: GeoJSON.Position[] = [[0, 0], [0.5, 0.01], [1, 0], [1, 1], [0, 1], [0, 0]];
    expect(simplifyRing(ring, 0.002)).toEqual(ring);
  });

  it('tolerance 0 returns the ring unchanged (same reference)', () => {
    const ring: GeoJSON.Position[] = [[0, 0], [0.5, 0.0005], [1, 0], [1, 1], [0, 1], [0, 0]];
    expect(simplifyRing(ring, 0)).toBe(ring);
  });

  it('keeps the closure point', () => {
    const out = simplifyRing(circle(500, 1), 0.01);
    expect(out[0]).toEqual(out[out.length - 1]);
  });

  it('keeps four points when simplification would leave fewer, not the whole ring', () => {
    // A sliver thinner than the tolerance would collapse to its two ends.
    const sliver: GeoJSON.Position[] = [[0, 0], [1, 0.0001], [2, 0], [1, -0.0001], [0, 0]];
    expect(simplifyRing(sliver, 0.002)).toEqual([[0, 0], [1, 0.0001], [2, 0], [0, 0]]);
    // A long, narrow ring of 1000 points: four survive, the far end among them.
    const long: GeoJSON.Position[] = [];
    for (let i = 0; i <= 500; i++) long.push([i / 100, 0.0005 * Math.sin(i)]);
    for (let i = 499; i >= 0; i--) long.push([i / 100, 0.001 + 0.0005 * Math.sin(i)]);
    long.push(long[0]);
    const out = simplifyRing(long, 0.01);
    expect(out).toHaveLength(4);
    expect(out[0]).toEqual(out[3]);
    expect(Math.max(...out.map((p) => p[0]))).toBeCloseTo(5, 6);
  });

  it('a coarser tolerance never keeps more points', () => {
    // A jagged coastline-like ring: 3000 points with noise at several scales.
    const ring: GeoJSON.Position[] = [];
    for (let i = 0; i < 3000; i++) {
      const a = (2 * Math.PI * i) / 3000;
      const r = 1 + 0.05 * Math.sin(37 * a) + 0.01 * Math.sin(301 * a) + 0.002 * Math.sin(1999 * a);
      ring.push([r * Math.cos(a), 0.3 * r * Math.sin(a)]);
    }
    ring.push(ring[0]);
    let prev = Infinity;
    for (const tol of [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5]) {
      const n = simplifyRing(ring, tol).length;
      expect(n).toBeLessThanOrEqual(prev);
      expect(n).toBeGreaterThanOrEqual(4);
      prev = n;
    }
  });

  it('every original point stays within the tolerance of the simplified outline', () => {
    const ring = circle(2000, 1);
    const out = simplifyRing(ring, SIMPLIFY_TOLERANCE_DEG);
    expect(out.length).toBeLessThan(ring.length / 10);
    let worst = 0;
    for (const p of ring) {
      let best = Infinity;
      for (let i = 1; i < out.length; i++) best = Math.min(best, segDist(p, out[i - 1], out[i]));
      worst = Math.max(worst, best);
    }
    expect(worst).toBeLessThanOrEqual(SIMPLIFY_TOLERANCE_DEG + 1e-12);
  });
});

describe('simplifyGeometry', () => {
  it('simplifies outer rings and holes of a Polygon', () => {
    const hole: GeoJSON.Position[] = [[0.2, 0.2], [0.5, 0.2005], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]];
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [0.5, 0.0005], [1, 0], [1, 1], [0, 1], [0, 0]], hole] };
    const out = simplifyGeometry(geom, 0.002) as GeoJSON.Polygon;
    expect(out.type).toBe('Polygon');
    expect(out.coordinates[0]).toEqual(square);
    expect(out.coordinates[1]).toEqual([[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8], [0.2, 0.2]]);
  });

  it('keeps the MultiPolygon structure', () => {
    const geom: GeoJSON.MultiPolygon = {
      type: 'MultiPolygon',
      coordinates: [[[[0, 0], [0.5, 0.0005], [1, 0], [1, 1], [0, 1], [0, 0]]], [circle(200, 0.5)]],
    };
    const out = simplifyGeometry(geom, 0.002) as GeoJSON.MultiPolygon;
    expect(out.type).toBe('MultiPolygon');
    expect(out.coordinates).toHaveLength(2);
    expect(out.coordinates[0][0]).toEqual(square);
    expect(out.coordinates[1][0].length).toBeLessThan(200);
  });

  it('drops holes and islets smaller than the tolerance, and a polygon whose outer ring is', () => {
    const islet: GeoJSON.Position[] = [[5, 5], [5.01, 5], [5.01, 5.01], [5, 5.01], [5, 5]];
    const hole: GeoJSON.Position[] = [[0.4, 0.4], [0.41, 0.4], [0.41, 0.41], [0.4, 0.41], [0.4, 0.4]];
    const geom: GeoJSON.MultiPolygon = { type: 'MultiPolygon', coordinates: [[square, hole], [islet]] };
    const out = simplifyGeometry(geom, 0.05) as GeoJSON.MultiPolygon;
    expect(out.coordinates).toEqual([[square]]);
    // At the stored tolerance both are far larger than 0.002 degrees and stay.
    expect((simplifyGeometry(geom, 0.002) as GeoJSON.MultiPolygon).coordinates).toEqual([[square, hole], [islet]]);
  });

  it('a ring that is thin in one direction only is kept, as four points spanning its length', () => {
    const strip: GeoJSON.Position[] = [[0, 0], [1, 0], [1, 0.001], [0, 0.001], [0, 0]];
    const kept = (simplifyGeometry({ type: 'Polygon', coordinates: [strip] }, 0.05) as GeoJSON.Polygon).coordinates[0];
    expect(kept).toEqual([[0, 0], [1, 0], [1, 0.001], [0, 0]]);
  });

  it('a Polygon that vanishes becomes an empty MultiPolygon', () => {
    const islet: GeoJSON.Position[] = [[5, 5], [5.01, 5], [5.01, 5.01], [5, 5.01], [5, 5]];
    expect(simplifyGeometry({ type: 'Polygon', coordinates: [islet] }, 0.05)).toEqual({ type: 'MultiPolygon', coordinates: [] });
  });

  it('passes other geometry types and tolerance 0 through untouched', () => {
    const point: GeoJSON.Point = { type: 'Point', coordinates: [1, 2] };
    expect(simplifyGeometry(point, 0.002)).toBe(point);
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [square] };
    expect(simplifyGeometry(geom, 0)).toBe(geom);
  });

  it('defaults to the rendering tolerance', () => {
    const geom: GeoJSON.Polygon = { type: 'Polygon', coordinates: [[[0, 0], [0.5, 0.0005], [1, 0], [1, 1], [0, 1], [0, 0]]] };
    expect((simplifyGeometry(geom) as GeoJSON.Polygon).coordinates[0]).toEqual(square);
  });
});
