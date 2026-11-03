import { describe, it, expect } from 'vitest';
import { webMercatorPixelToLatLng } from '../src/mercator-pixel';

// Known points of the Web Mercator world square (0..1 on each axis).
describe('webMercatorPixelToLatLng', () => {
  const out = { lat: 0, lng: 0 };

  it('maps the centre to 0,0 and the right edge to 180° E', () => {
    expect(webMercatorPixelToLatLng(0.5, 0.5, out)).toEqual({ lat: 0, lng: 0 });
    expect(webMercatorPixelToLatLng(1, 0.5, out).lng).toBe(180);
    expect(webMercatorPixelToLatLng(0, 0.5, out).lng).toBe(-180);
  });

  it('maps the top edge to the Mercator limit and the quarter line to 66.51° N', () => {
    expect(webMercatorPixelToLatLng(0.5, 0, out).lat).toBeCloseTo(85.0511, 3);
    expect(webMercatorPixelToLatLng(0.5, 1, out).lat).toBeCloseTo(-85.0511, 3);
    expect(webMercatorPixelToLatLng(0.75, 0.25, out)).toEqual({ lat: expect.closeTo(66.5132, 3), lng: 90 });
  });

  it('writes into and returns the given object', () => {
    const o = { lat: 1, lng: 1 };
    expect(webMercatorPixelToLatLng(0.5, 0.5, o)).toBe(o);
  });
});

import { sampleWindGridBilinear, sampleWindGridBilinearInto, type WindGrid } from '../src/wind-grid-fetcher';

describe('sampleWindGridBilinearInto', () => {
  const grid: WindGrid = {
    rows: 2, cols: 2, latMin: 40, lonMin: -100, step: 1,
    cells: [[{ u: 1, v: 2 }, { u: 3, v: 4 }], [{ u: 5, v: 6 }, { u: 7, v: 8 }]],
  } as WindGrid;

  it('writes the same sample as the allocating form, into the given object', () => {
    const out = { u: 9, v: 9 };
    sampleWindGridBilinearInto(grid, 40.5, -99.5, out);
    expect(out).toEqual(sampleWindGridBilinear(grid, 40.5, -99.5));
    expect(out).toEqual({ u: 1, v: 2 });                   // the SW cell centre
    sampleWindGridBilinearInto(grid, 41, -99, out);
    expect(out).toEqual(sampleWindGridBilinear(grid, 41, -99));
    expect(out.u).toBeCloseTo(4, 6);                       // midway between all four cells
  });

  it('zeroes the object outside the grid and for an empty grid', () => {
    const out = { u: 9, v: 9 };
    sampleWindGridBilinearInto(grid, 10, 10, out);
    expect(out).toEqual({ u: 0, v: 0 });
    out.u = 9;
    sampleWindGridBilinearInto({ ...grid, rows: 0, cells: [] } as WindGrid, 40.5, -99.5, out);
    expect(out).toEqual({ u: 0, v: 0 });
  });
});
