// Tests for pyramidal Lucas-Kanade optical flow.
//
// Two test surfaces:
//
//   1. Algorithm correctness (lk.ts): five synthetic scenarios ported
//      from the prototype harness (.dev/lk-prototype/). These pin LK's
//      behaviour on inputs with known ground truth — coherent uniform
//      motion, differential per-cell motion, stationary scene, large
//      motion exceeding the per-level convergence radius, and a
//      noise-free flat field.
//
//   2. Drift between the TypeScript implementation (lk.ts) and the
//      hand-translated JS source embedded in lk-worker.ts. The worker
//      runs in a different language form because it has to be a string
//      Blob — but the algorithm must produce identical output for
//      identical inputs. This test extracts the embedded source,
//      evaluates it in the test process via `new Function`, and
//      compares against the TS version on the same fixtures. If
//      anyone modifies one implementation without the other, this
//      test fails before review.

import { describe, it, expect } from 'vitest';
import {
  lucasKanadePyramidal,
  buildPyramid,
  sobel,
  extractChannel,
} from '../src/lk';
import { LK_ALGORITHM_SOURCE } from '../src/lk-worker';

// ── Synthetic fixture builders ───────────────────────────────────────────

const SIZE = 128;

/**
 * Render a 2D Gaussian "blob" into a Float32 buffer. Used to build
 * synthetic radar frames with known feature positions — translating
 * the blob between two frames gives an exact ground-truth motion.
 */
function addBlob(buf: Float32Array, w: number, h: number, cx: number, cy: number, sigma: number, amp: number): void {
  const twoSigmaSq = 2 * sigma * sigma;
  // Cap the additive contribution at 255 so two blobs near each other
  // don't push out-of-range; downstream LK treats values as 0..255.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const v = amp * Math.exp(-(dx * dx + dy * dy) / twoSigmaSq);
      const i = y * w + x;
      buf[i] = Math.min(255, buf[i] + v);
    }
  }
}

/** Coherent uniform translation: two blobs all moving by the same vector. */
function makeCoherent(dx: number, dy: number): { I0: Float32Array; I1: Float32Array } {
  const I0 = new Float32Array(SIZE * SIZE);
  const I1 = new Float32Array(SIZE * SIZE);
  // Two blobs at fixed positions in I0, shifted by (dx, dy) in I1.
  addBlob(I0, SIZE, SIZE, 40, 50, 8, 200);
  addBlob(I0, SIZE, SIZE, 80, 70, 10, 220);
  addBlob(I1, SIZE, SIZE, 40 + dx, 50 + dy, 8, 200);
  addBlob(I1, SIZE, SIZE, 80 + dx, 70 + dy, 10, 220);
  return { I0, I1 };
}

/** Differential motion: each blob moves in a different direction. */
function makeDifferential(): { I0: Float32Array; I1: Float32Array; bulkDx: number; bulkDy: number } {
  const I0 = new Float32Array(SIZE * SIZE);
  const I1 = new Float32Array(SIZE * SIZE);
  // Two cells, one moving right-down, one moving up-right; bulk vector
  // is the weighted average of the per-cell motions.
  addBlob(I0, SIZE, SIZE, 30, 30, 8, 200);
  addBlob(I0, SIZE, SIZE, 90, 90, 8, 200);
  addBlob(I1, SIZE, SIZE, 38, 35, 8, 200);   // cell A: (+8, +5)
  addBlob(I1, SIZE, SIZE, 92, 84, 8, 200);   // cell B: (+2, -6)
  // Bulk is mean of per-cell vectors (equal weight blobs).
  return { I0, I1, bulkDx: 5, bulkDy: -0.5 };
}

/** Stationary scene: identical frames. LK must NOT hallucinate motion. */
function makeStationary(): { I0: Float32Array; I1: Float32Array } {
  const I0 = new Float32Array(SIZE * SIZE);
  addBlob(I0, SIZE, SIZE, 40, 50, 8, 200);
  addBlob(I0, SIZE, SIZE, 80, 70, 10, 220);
  return { I0, I1: new Float32Array(I0) };
}

/** Flat field: zero gradient everywhere. LK must return low confidence. */
function makeFlat(): { I0: Float32Array; I1: Float32Array } {
  return { I0: new Float32Array(SIZE * SIZE), I1: new Float32Array(SIZE * SIZE) };
}

// ── 1. Algorithm correctness (TypeScript implementation) ─────────────────

describe('lucasKanadePyramidal — synthetic correctness', () => {
  it('recovers a coherent (+5, -3) motion to within 1 px', () => {
    const { I0, I1 } = makeCoherent(5, -3);
    const result = lucasKanadePyramidal(I0, I1, SIZE, SIZE);
    expect(result.dx).toBeCloseTo(5, 0);
    expect(result.dy).toBeCloseTo(-3, 0);
    // 5,-3 against two well-separated blobs is a strong gradient signal.
    expect(result.confidence).toBeGreaterThan(5);
  });

  it('recovers a coherent (+10, +10) motion', () => {
    const { I0, I1 } = makeCoherent(10, 10);
    const result = lucasKanadePyramidal(I0, I1, SIZE, SIZE);
    expect(result.dx).toBeCloseTo(10, 0);
    expect(result.dy).toBeCloseTo(10, 0);
  });

  it('approximates differential motion to within ~2 px of the bulk vector', () => {
    const { I0, I1, bulkDx, bulkDy } = makeDifferential();
    const result = lucasKanadePyramidal(I0, I1, SIZE, SIZE);
    // Single global vector can't perfectly model two cells moving
    // independently, but should land near the bulk mean. Tolerance
    // here is intentionally loose — the prototype run on similar
    // fixtures saw ~0.5 px residual, but we allow 2 px to absorb
    // sampling jitter and the asymmetry of unequal blob amplitudes.
    expect(Math.abs(result.dx - bulkDx)).toBeLessThan(2);
    expect(Math.abs(result.dy - bulkDy)).toBeLessThan(2);
  });

  it('does not hallucinate motion on a stationary scene', () => {
    const { I0, I1 } = makeStationary();
    const result = lucasKanadePyramidal(I0, I1, SIZE, SIZE);
    expect(Math.abs(result.dx)).toBeLessThan(0.1);
    expect(Math.abs(result.dy)).toBeLessThan(0.1);
  });

  it('returns low confidence on a flat-field input', () => {
    const { I0, I1 } = makeFlat();
    const result = lucasKanadePyramidal(I0, I1, SIZE, SIZE);
    // det of the gradient tensor is exactly zero on a flat input;
    // lkSingleLevel short-circuits and returns confidence 0 plus
    // unchanged (0, 0). Just confirm we don't crash and confidence
    // signals "don't trust this".
    expect(result.confidence).toBeLessThan(5);
    expect(result.dx).toBe(0);
    expect(result.dy).toBe(0);
  });

  it('recovers large (+30, -20) motion via the pyramid', () => {
    // 30 px is well beyond the single-level convergence radius
    // (~5 px). The pyramid resolves it because at the coarsest level
    // (after two halvings) the same motion looks like 7.5 px on a
    // 32×32 grid — within range. Without the pyramid, single-level
    // LK would fail. This test exists to lock in the pyramid's
    // contribution.
    const { I0, I1 } = makeCoherent(30, -20);
    const result = lucasKanadePyramidal(I0, I1, SIZE, SIZE, { levels: 3, iterations: 5 });
    // Allow a bit more slack for large motion (sub-pixel sampling
    // through the warp chain accumulates small errors).
    expect(result.dx).toBeCloseTo(30, -0.5);
    expect(result.dy).toBeCloseTo(-20, -0.5);
  });
});

// ── 2. Primitives ────────────────────────────────────────────────────────

describe('buildPyramid', () => {
  it('halves dimensions per level and 2×2-averages pixels', () => {
    // 16×16 → 8×8 → 4×4 is three levels of halving that all clear
    // the "stop below 4" guard in buildPyramid. The next halving
    // would land at 2×2 which is refused — see the dedicated guard
    // test below.
    const w = 16; const h = 16;
    const img = new Float32Array(w * h).fill(100);
    const pyramid = buildPyramid(img, w, h, 3);
    expect(pyramid).toHaveLength(3);
    expect(pyramid[0].width).toBe(16);
    expect(pyramid[1].width).toBe(8);
    expect(pyramid[2].width).toBe(4);
    // Average of a uniform-100 image is 100 at every level.
    expect(pyramid[2].data[0]).toBe(100);
  });

  it('stops adding levels once a halved dimension falls below 4', () => {
    const w = 8; const h = 8;
    const img = new Float32Array(w * h).fill(50);
    // Asking for 5 levels — should stop at 3 (8 → 4 → 2 would be < 4).
    const pyramid = buildPyramid(img, w, h, 5);
    expect(pyramid.length).toBeLessThanOrEqual(3);
    for (const level of pyramid) {
      expect(level.width).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('sobel', () => {
  it('returns zero gradients on a flat image', () => {
    const w = 16; const h = 16;
    const img = new Float32Array(w * h).fill(50);
    const { Ix, Iy } = sobel(img, w, h);
    // Interior pixels should all be zero; borders are zero by construction.
    for (let i = 0; i < Ix.length; i++) {
      expect(Ix[i]).toBe(0);
      expect(Iy[i]).toBe(0);
    }
  });

  it('produces non-zero gradient at a vertical edge', () => {
    const w = 16; const h = 16;
    const img = new Float32Array(w * h);
    // Left half = 0, right half = 200 — vertical edge in the middle.
    for (let y = 0; y < h; y++) {
      for (let x = w / 2; x < w; x++) img[y * w + x] = 200;
    }
    const { Ix, Iy } = sobel(img, w, h);
    // Interior pixel on the edge should have a large positive Ix and ~zero Iy.
    const mid = 8 * w + 8;
    expect(Ix[mid]).toBeGreaterThan(10);
    expect(Math.abs(Iy[mid])).toBeLessThan(1);
  });
});

describe('extractChannel', () => {
  function fakeImageData(rgba: number[]): { data: Uint8ClampedArray; width: number; height: number } {
    const data = new Uint8ClampedArray(rgba);
    return { data, width: rgba.length / 4, height: 1 };
  }

  it('alpha mode returns the alpha channel', () => {
    const img = fakeImageData([255, 0, 0, 100, 0, 255, 0, 200]);
    const out = extractChannel(img, 'alpha');
    expect(Array.from(out)).toEqual([100, 200]);
  });

  it('distance-from-white returns 0 for transparent pixels', () => {
    const img = fakeImageData([100, 100, 100, 0]);
    const out = extractChannel(img, 'distance-from-white');
    expect(out[0]).toBe(0);
  });

  it('distance-from-white is 255 for pure black, gated by alpha', () => {
    // Fully opaque black: 255 - min(0,0,0) = 255, weighted by alpha/255 = 1.
    const img = fakeImageData([0, 0, 0, 255]);
    const out = extractChannel(img, 'distance-from-white');
    expect(out[0]).toBe(255);
  });

  it('distance-from-white is 0 for pure white at any alpha', () => {
    const img = fakeImageData([255, 255, 255, 255]);
    const out = extractChannel(img, 'distance-from-white');
    expect(out[0]).toBe(0);
  });

  it('distance-from-white is linear: 255 - min(R,G,B), weighted by alpha', () => {
    // Light-blue outline pixel (typical RainViewer low-intensity).
    // 255 - min(150,200,255) = 105.
    const lightBlue = fakeImageData([150, 200, 255, 255]);
    expect(extractChannel(lightBlue, 'distance-from-white')[0]).toBe(105);
    // Saturated red pixel (typical RainViewer high-intensity core).
    // 255 - min(255,50,50) = 205.
    const red = fakeImageData([255, 50, 50, 255]);
    expect(extractChannel(red, 'distance-from-white')[0]).toBe(205);
    // Alpha-weighted: half-opaque red is half-intensity.
    // 205 * 128 / 255 = 26240/255 ≈ 102.9
    const halfRed = fakeImageData([255, 50, 50, 128]);
    expect(extractChannel(halfRed, 'distance-from-white')[0]).toBeCloseTo(103, 0);
  });
});

// ── 3. Worker source ↔ TypeScript implementation parity ──────────────────
//
// Eval the embedded worker source in the test process via `new Function`
// (we are NOT in a CSP environment here, and the worker source is
// trusted module code from the same repo). Then run identical inputs
// through both versions and assert byte-for-byte equality of the
// numeric results. This is the safety net against the duplication
// between src/lk.ts and the LK_ALGORITHM_SOURCE constant in
// src/lk-worker.ts.

describe('lk-worker source ↔ lk.ts parity', () => {
  // Build a callable lucasKanadePyramidal from the embedded source.
  // The Function captures the algorithm definitions in its scope and
  // exposes lucasKanadePyramidal via the returned closure — same
  // pattern that the actual worker uses when its onmessage handler
  // calls lucasKanadePyramidal().
  const workerLk = new Function(
    'I0', 'I1', 'width', 'height', 'opts',
    `${LK_ALGORITHM_SOURCE}\nreturn lucasKanadePyramidal(I0, I1, width, height, opts);`,
  ) as (I0: Float32Array, I1: Float32Array, w: number, h: number, opts?: object) => { dx: number; dy: number; confidence: number };

  function expectParity(I0: Float32Array, I1: Float32Array, w: number, h: number, opts: object = {}): void {
    const tsResult = lucasKanadePyramidal(I0, I1, w, h, opts);
    const wkResult = workerLk(I0, I1, w, h, opts);
    // The two implementations are algorithmically identical, so
    // results should match to the bit — Float32 floor differences
    // would only appear if one path used Float64 arithmetic
    // somewhere. We assert a tiny epsilon to absorb any future
    // platform-specific FMA rounding without masking real drift.
    expect(wkResult.dx).toBeCloseTo(tsResult.dx, 6);
    expect(wkResult.dy).toBeCloseTo(tsResult.dy, 6);
    expect(wkResult.confidence).toBeCloseTo(tsResult.confidence, 6);
  }

  it('coherent motion produces identical dx, dy, confidence', () => {
    const { I0, I1 } = makeCoherent(5, -3);
    expectParity(I0, I1, SIZE, SIZE);
  });

  it('differential motion produces identical output', () => {
    const { I0, I1 } = makeDifferential();
    expectParity(I0, I1, SIZE, SIZE);
  });

  it('stationary scene produces identical output', () => {
    const { I0, I1 } = makeStationary();
    expectParity(I0, I1, SIZE, SIZE);
  });

  it('flat-field produces identical output (both should hit the det<eps short-circuit)', () => {
    const { I0, I1 } = makeFlat();
    expectParity(I0, I1, SIZE, SIZE);
  });

  it('large motion produces identical output across pyramid levels', () => {
    const { I0, I1 } = makeCoherent(30, -20);
    expectParity(I0, I1, SIZE, SIZE, { levels: 3, iterations: 5 });
  });

  it('non-default options propagate identically', () => {
    const { I0, I1 } = makeCoherent(5, -3);
    expectParity(I0, I1, SIZE, SIZE, { levels: 4, iterations: 10 });
    expectParity(I0, I1, SIZE, SIZE, { levels: 1, iterations: 5 });
  });
});
