import { describe, it, expect, vi } from 'vitest';

// Same Leaflet stub as tests/nearest-frame-index.test.ts: the helpers under
// test are pure, but their host modules import leaflet eagerly.
vi.mock('leaflet', () => {
  class Layer {}
  class LayerGroup {}
  class TileLayer {}
  class WMS {}
  (TileLayer as any).WMS = WMS;
  const DomUtil = { create: vi.fn() };
  const point = vi.fn((x: number, y: number) => ({ x, y }));
  const divIcon = vi.fn((opts: any) => ({ ...opts }));
  return {
    Layer, LayerGroup, TileLayer, DomUtil, point, divIcon,
    default: { Layer, LayerGroup, TileLayer, DomUtil, point, divIcon },
  };
});

import { speedColour, decomposeBarbKnots } from '../src/wind-overlay';

// ── speedColour ────────────────────────────────────────────────────────────
//
// 6 Beaufort-ish bands. The exact hex strings matter — the visual contract
// on the editor is "colour-coded by speed". Locking the boundaries here
// prevents an off-by-one regression where e.g. 8 m/s drifts from "fresh"
// to "moderate".

describe('speedColour', () => {
  it('returns calm grey-blue below 1.5 m/s', () => {
    expect(speedColour(0)).toBe('#88a');
    expect(speedColour(1.49)).toBe('#88a');
  });

  it('returns light green at 1.5–3.5 m/s', () => {
    expect(speedColour(1.5)).toBe('#3a7');
    expect(speedColour(2)).toBe('#3a7');
    expect(speedColour(3.49)).toBe('#3a7');
  });

  it('returns moderate teal at 3.5–5.5 m/s', () => {
    expect(speedColour(3.5)).toBe('#1a8');
    expect(speedColour(5.49)).toBe('#1a8');
  });

  it('returns fresh orange at 5.5–8 m/s', () => {
    expect(speedColour(5.5)).toBe('#d80');
    expect(speedColour(7.99)).toBe('#d80');
  });

  it('returns strong red-orange at 8–11 m/s', () => {
    expect(speedColour(8)).toBe('#c40');
    expect(speedColour(10.99)).toBe('#c40');
  });

  it('returns gale red at and above 11 m/s', () => {
    expect(speedColour(11)).toBe('#a00');
    expect(speedColour(40)).toBe('#a00');
  });

  it('handles zero and tiny values without throwing', () => {
    expect(speedColour(0)).toBe('#88a');
    expect(speedColour(0.0001)).toBe('#88a');
  });
});

// ── decomposeBarbKnots ─────────────────────────────────────────────────────
//
// WMO meteorological wind-barb convention: pennant = 50 kt, full feather =
// 10 kt, half feather = 5 kt. Speed is rounded to the nearest 5 kt before
// decomposing, so 7-knot input renders as 5 (one half), 8-knot as 10 (one
// full feather), and so on. These cases lock the rounding and the
// decomposition order — the latter is easy to typo into "half before full".

describe('decomposeBarbKnots', () => {
  it('rounds to the nearest 5 kt before decomposing', () => {
    expect(decomposeBarbKnots(7).k5).toBe(5);   // 7 → 5
    expect(decomposeBarbKnots(8).k5).toBe(10);  // 8 → 10
    expect(decomposeBarbKnots(12).k5).toBe(10); // 12 → 10
    expect(decomposeBarbKnots(13).k5).toBe(15); // 13 → 15
    expect(decomposeBarbKnots(0).k5).toBe(0);
  });

  it('represents 5 kt as one half feather, no full, no pennant', () => {
    expect(decomposeBarbKnots(5)).toEqual({
      k5: 5, pennants: 0, fullFeathers: 0, halfFeather: 1,
    });
  });

  it('represents 10 kt as one full feather, no half, no pennant', () => {
    expect(decomposeBarbKnots(10)).toEqual({
      k5: 10, pennants: 0, fullFeathers: 1, halfFeather: 0,
    });
  });

  it('represents 15 kt as one full + one half', () => {
    expect(decomposeBarbKnots(15)).toEqual({
      k5: 15, pennants: 0, fullFeathers: 1, halfFeather: 1,
    });
  });

  it('represents 50 kt as exactly one pennant, no feathers', () => {
    expect(decomposeBarbKnots(50)).toEqual({
      k5: 50, pennants: 1, fullFeathers: 0, halfFeather: 0,
    });
  });

  it('represents 55 kt as one pennant + one half feather', () => {
    expect(decomposeBarbKnots(55)).toEqual({
      k5: 55, pennants: 1, fullFeathers: 0, halfFeather: 1,
    });
  });

  it('represents 65 kt as one pennant + one full + one half', () => {
    expect(decomposeBarbKnots(65)).toEqual({
      k5: 65, pennants: 1, fullFeathers: 1, halfFeather: 1,
    });
  });

  it('represents 100 kt as two pennants, no feathers', () => {
    expect(decomposeBarbKnots(100)).toEqual({
      k5: 100, pennants: 2, fullFeathers: 0, halfFeather: 0,
    });
  });

  it('decomposes in pennant → full → half order', () => {
    // 105 = 50 + 50 + 5. NOT 50 + 10·5 + 5, NOT 10·10 + 5.
    expect(decomposeBarbKnots(105)).toEqual({
      k5: 105, pennants: 2, fullFeathers: 0, halfFeather: 1,
    });
    // 145 = 50 + 50 + 10·4 + 5.
    expect(decomposeBarbKnots(145)).toEqual({
      k5: 145, pennants: 2, fullFeathers: 4, halfFeather: 1,
    });
  });
});

// (bilinearUV's standalone tests were dropped when the streamline overlay
// migrated to sampleWindGridBilinear from wind-grid-fetcher. The two had
// subtly different anchor conventions — bilinearUV treated values as
// node-anchored, sampleWindGridBilinear as cell-centre-anchored — and
// the WCS data is cell-centre. Equivalent coverage of the bilinear
// path lives in tests/wind-grid-fetcher.test.ts under
// "sampleWindGridBilinear".)
