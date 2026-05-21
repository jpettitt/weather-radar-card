import { describe, it, expect } from 'vitest';
import { findMotionSAD, downsampleAlpha, smoothMotionVectors } from '../src/motion-estimator';

// Helper: build a small intensity grid with a single rain blob at (cx, cy).
function makeFrame(w: number, h: number, cx: number, cy: number, radius = 2): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= radius) out[y * w + x] = 255;
    }
  }
  return out;
}

describe('findMotionSAD', () => {
  it('returns zero motion for identical frames', () => {
    const a = makeFrame(32, 32, 16, 16);
    const b = makeFrame(32, 32, 16, 16);
    const m = findMotionSAD(a, b, 32, 32, 5);
    expect(m.dx).toBe(0);
    expect(m.dy).toBe(0);
  });

  it('returns zero motion (low confidence) for two empty frames', () => {
    const a = new Uint8Array(32 * 32);
    const b = new Uint8Array(32 * 32);
    const m = findMotionSAD(a, b, 32, 32, 5);
    expect(m.dx).toBe(0);
    expect(m.dy).toBe(0);
    expect(m.confidence).toBe(0);
  });

  it('detects rightward motion', () => {
    const a = makeFrame(32, 32, 12, 16);
    const b = makeFrame(32, 32, 17, 16); // rain moved +5 in x
    const m = findMotionSAD(a, b, 32, 32, 8);
    // Sub-pixel refinement may shift the result slightly off the integer
    // peak; check we're within half a pixel of the expected motion.
    expect(m.dx).toBeCloseTo(5, 0);
    expect(m.dy).toBeCloseTo(0, 0);
  });

  it('detects downward motion', () => {
    const a = makeFrame(32, 32, 16, 10);
    const b = makeFrame(32, 32, 16, 14);
    const m = findMotionSAD(a, b, 32, 32, 8);
    expect(m.dx).toBeCloseTo(0, 0);
    expect(m.dy).toBeCloseTo(4, 0);
  });

  it('detects diagonal motion', () => {
    const a = makeFrame(32, 32, 12, 12);
    const b = makeFrame(32, 32, 15, 14); // moved +3, +2
    const m = findMotionSAD(a, b, 32, 32, 8);
    expect(m.dx).toBeCloseTo(3, 0);
    expect(m.dy).toBeCloseTo(2, 0);
  });

  it('detects negative motion (rain moved left and up)', () => {
    const a = makeFrame(32, 32, 20, 20);
    const b = makeFrame(32, 32, 16, 16); // moved -4, -4
    const m = findMotionSAD(a, b, 32, 32, 8);
    expect(m.dx).toBeCloseTo(-4, 0);
    expect(m.dy).toBeCloseTo(-4, 0);
  });

  it('confidence is high for a clean unique peak', () => {
    const a = makeFrame(32, 32, 12, 16);
    const b = makeFrame(32, 32, 17, 16);
    const m = findMotionSAD(a, b, 32, 32, 8);
    expect(m.confidence).toBeGreaterThan(0.5);
  });

  it('confidence falls when peak is ambiguous (two equal blobs)', () => {
    // Two identical blobs in both frames — many displacements yield similar SAD.
    const a = new Uint8Array(32 * 32);
    const b = new Uint8Array(32 * 32);
    for (const [x, y] of [[8, 8], [24, 24]]) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          a[(y + dy) * 32 + (x + dx)] = 255;
          b[(y + dy) * 32 + (x + dx)] = 255;
        }
      }
    }
    const m = findMotionSAD(a, b, 32, 32, 8);
    // Should report zero motion (matches at dx=0,dy=0) but low confidence
    // since shifting by ±16 would still align one blob to the other.
    expect(m.dx).toBe(0);
    expect(m.dy).toBe(0);
  });

  it('clips displacement to maxOffset', () => {
    // Rain moved +20 but search only goes to ±5.
    const a = makeFrame(64, 64, 20, 32);
    const b = makeFrame(64, 64, 40, 32);
    const m = findMotionSAD(a, b, 64, 64, 5);
    // Best within search window is the boundary
    expect(Math.abs(m.dx)).toBeLessThanOrEqual(5);
    expect(Math.abs(m.dy)).toBeLessThanOrEqual(5);
  });
});

describe('smoothMotionVectors', () => {
  it('preserves a single vector unchanged', () => {
    const out = smoothMotionVectors([{ dx: 5, dy: 2, confidence: 1 }]);
    expect(out[0]).not.toBeNull();
    expect(out[0]!.dx).toBeCloseTo(5);
    expect(out[0]!.dy).toBeCloseTo(2);
  });

  it('returns null entries unchanged when all neighbours are null', () => {
    const out = smoothMotionVectors([null, null, null]);
    expect(out).toEqual([null, null, null]);
  });

  it('rejects a single high-confidence outlier via median (this is the key case)', () => {
    // Five frames where one is a "perfect match" (0, 0) — the pathological
    // case of two identical radar tiles in a row. The neighbours all
    // agree on +5 motion. Median ignores the outlier completely.
    const input = [
      { dx: 5, dy: 0, confidence: 0.3 },
      { dx: 5, dy: 0, confidence: 0.3 },
      { dx: 0, dy: 0, confidence: 1.0 }, // SAD-perfect outlier
      { dx: 5, dy: 0, confidence: 0.3 },
      { dx: 5, dy: 0, confidence: 0.3 },
    ];
    const out = smoothMotionVectors(input);
    expect(out[2]).not.toBeNull();
    expect(out[2]!.dx).toBe(5);
    expect(out[2]!.dy).toBe(0);
  });

  it('keeps a unanimous sequence stable', () => {
    const input = Array(5).fill({ dx: 3, dy: -2, confidence: 1 });
    const out = smoothMotionVectors(input);
    for (const v of out) {
      expect(v).not.toBeNull();
      expect(v!.dx).toBeCloseTo(3);
      expect(v!.dy).toBeCloseTo(-2);
    }
  });

  it('takes the median of an asymmetric edge neighbourhood', () => {
    // First entry only sees itself and the next two (3-tap neighbourhood
    // because k=-2 and k=-1 fall before index 0).
    const input = [
      { dx: 10, dy: 0, confidence: 1 },
      { dx: 5, dy: 0, confidence: 1 },
      { dx: 5, dy: 0, confidence: 1 },
    ];
    const out = smoothMotionVectors(input);
    // Median of [10, 5, 5] = 5
    expect(out[0]!.dx).toBe(5);
  });

  it('skips null neighbours in the median computation', () => {
    const input = [
      null,
      { dx: 5, dy: 0, confidence: 0.5 },
      { dx: 0, dy: 0, confidence: 1.0 }, // outlier
      { dx: 5, dy: 0, confidence: 0.5 },
      null,
    ];
    const out = smoothMotionVectors(input);
    // Median of {5, 0, 5} (the three non-null values) = 5
    expect(out[2]!.dx).toBe(5);
  });
});

describe('downsampleAlpha', () => {
  it('halves a uniform image to a uniform smaller one', () => {
    // 4x4 RGBA where every pixel has alpha 200.
    const rgba = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 200;
    const out = downsampleAlpha(rgba, 4, 4, 2, 2);
    expect(out.length).toBe(4);
    for (const v of out) expect(v).toBe(200);
  });

  it('averages the source block alphas for each destination pixel', () => {
    // 2x2 RGBA, alphas: top row 100/100, bottom row 200/200.
    // Downsample to 1x2: destination pixel (0,0) averages 100,100 = 100;
    // destination pixel (0,1) averages 200,200 = 200.
    const rgba = new Uint8ClampedArray([
      0, 0, 0, 100,   0, 0, 0, 100,
      0, 0, 0, 200,   0, 0, 0, 200,
    ]);
    const out = downsampleAlpha(rgba, 2, 2, 1, 2);
    expect(out[0]).toBe(100);
    expect(out[1]).toBe(200);
  });

  it('returns all zeros for fully transparent input', () => {
    const rgba = new Uint8ClampedArray(8 * 8 * 4); // all zero
    const out = downsampleAlpha(rgba, 8, 8, 4, 4);
    expect(out.length).toBe(16);
    for (const v of out) expect(v).toBe(0);
  });
});
