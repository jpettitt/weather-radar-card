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
  lkSingleLevel,
  buildPyramid,
  sobel,
  extractChannel,
  ChannelMode,
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

  it('recovers a coherent (-5, +3) motion (leftward / downward sign combination)', () => {
    // The (+5, -3) test above never samples left of x=0 or below the last
    // row, so the opposite signs need their own coverage.
    const { I0, I1 } = makeCoherent(-5, 3);
    const result = lucasKanadePyramidal(I0, I1, SIZE, SIZE);
    expect(result.dx).toBeCloseTo(-5, 2);
    expect(result.dy).toBeCloseTo(3, 2);
  });

  it('reports angleDeg in 0..360 (+x = 0°, +y = 90°) and magnitude as the vector length', () => {
    // Down-left (-10, +10): 135°. Up-right (+10, -10): atan2 is -45°, must wrap to 315°.
    const dl = makeCoherent(-10, 10);
    const downLeft = lucasKanadePyramidal(dl.I0, dl.I1, SIZE, SIZE);
    expect(downLeft.angleDeg).toBeCloseTo(135, 1);
    expect(downLeft.magnitude).toBeCloseTo(Math.hypot(10, 10), 2);

    const ur = makeCoherent(10, -10);
    const upRight = lucasKanadePyramidal(ur.I0, ur.I1, SIZE, SIZE);
    expect(upRight.angleDeg).toBeCloseTo(315, 1);
    expect(upRight.magnitude).toBeCloseTo(Math.hypot(10, 10), 2);
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
    // Asking for 5 levels — 8 → 4 is allowed, but 4 → 2 falls below 4 and is refused.
    const pyramid = buildPyramid(img, w, h, 5);
    expect(pyramid.map(l => [l.width, l.height])).toEqual([[8, 8], [4, 4]]);
  });

  it('stops when only the width would fall below 4 (narrow image)', () => {
    // 6 → 3 wide is refused even though 16 → 8 tall would be fine.
    const pyramid = buildPyramid(new Float32Array(6 * 16).fill(50), 6, 16, 3);
    expect(pyramid.map(l => [l.width, l.height])).toEqual([[6, 16]]);
  });

  it('stops when only the height would fall below 4 (short image)', () => {
    const pyramid = buildPyramid(new Float32Array(16 * 6).fill(50), 16, 6, 3);
    expect(pyramid.map(l => [l.width, l.height])).toEqual([[16, 6]]);
  });
});

// ── lkSingleLevel ────────────────────────────────────────────────────────

describe('lkSingleLevel', () => {
  const W = 16;
  const H = 16;
  const BLOCK = 5;

  /** A BLOCK×BLOCK square of 200 with its top-left at (x0, y0), zero elsewhere. */
  function block(x0: number, y0: number): Float32Array {
    const img = new Float32Array(W * H);
    for (let y = y0; y < y0 + BLOCK; y++) {
      for (let x = x0; x < x0 + BLOCK; x++) img[y * W + x] = 200;
    }
    return img;
  }

  // I1 is I0 shifted by an exact integer (d, d), and the initial guess is
  // that same shift, so the warp is a pure pixel copy and the estimate must
  // not move. Chosen so the shifted block touches the image edge: the warp
  // then samples exactly on x=0 / y=0 (or x=W-1 / y=H-1), which must be
  // treated as in-bounds. Samples left of / above the edge must read as 0,
  // not wrap into the previous row.
  it.each([
    { edge: 'top-left', i0: [3, 3], i1: [0, 0], d: -3 },
    { edge: 'bottom-right', i0: [8, 8], i1: [11, 11], d: 3 },
  ])('an exact integer shift at the $edge edge is a fixed point (v stays at $d)', ({ i0, i1, d }) => {
    const r = lkSingleLevel(block(i0[0], i0[1]), block(i1[0], i1[1]), W, H, d, d, 5);
    expect(r.vx).toBe(d);
    expect(r.vy).toBe(d);
    expect(r.confidence).toBeGreaterThan(0);
    // Zero residual on the first pass → converged immediately.
    expect(r.iterations).toBe(1);
  });

  // One centred blob is symmetric about its axes, so a pure x (or y) shift
  // gives an update on the other axis of ~0 (1e-16), unlike the two-blob
  // fixtures whose cross-axis residual (~0.006) sits right at the threshold.
  function singleBlob(dx: number, dy: number): { I0: Float32Array; I1: Float32Array } {
    const I0 = new Float32Array(SIZE * SIZE);
    const I1 = new Float32Array(SIZE * SIZE);
    addBlob(I0, SIZE, SIZE, 64, 64, 8, 200);
    addBlob(I1, SIZE, SIZE, 64 + dx, 64 + dy, 8, 200);
    return { I0, I1 };
  }

  it('does not stop early when only one axis has converged (pure x and pure y motion)', () => {
    // The other axis's update is ~0 on the first pass while this axis is
    // still ~0.2 px short (4 px from a zero guess), so it must keep going.
    for (const [dx, dy] of [[4, 0], [0, 4]]) {
      const { I0, I1 } = singleBlob(dx, dy);
      const r = lkSingleLevel(I0, I1, SIZE, SIZE, 0, 0, 5);
      expect(r.vx).toBeCloseTo(dx, 2);
      expect(r.vy).toBeCloseTo(dy, 2);
      expect(r.iterations).toBeGreaterThan(1);
    }
  });

  it('reports the iteration cap when it has not converged', () => {
    // 4 px from a zero guess cannot reach the 0.005 px threshold in 2 passes.
    const { I0, I1 } = singleBlob(4, 0);
    const r = lkSingleLevel(I0, I1, SIZE, SIZE, 0, 0, 2);
    expect(r.iterations).toBe(2);
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

  it('reads every pixel of a 2-D image, RGBA-strided (distance-from-white)', () => {
    // 2×2 so width×height ≠ width/height, and pixels 1..3 use distinct
    // R, G, B so a mis-strided channel read shows up. Single-pixel images
    // above only ever read indices 0..3.
    const img = {
      data: new Uint8ClampedArray([
        150, 200, 255, 255, // 255 - min(150,200,255) = 105
        255, 50, 60, 255,   // 255 - 50 = 205
        70, 255, 255, 255,  // 255 - 70 = 185
        0, 0, 0, 0,         // transparent → 0
      ]),
      width: 2,
      height: 2,
    };
    expect(Array.from(extractChannel(img, 'distance-from-white'))).toEqual([105, 205, 185, 0]);
  });

  it('luminance uses BT.601 weights and is 0 for transparent pixels', () => {
    // 0.299·100 + 0.587·150 + 0.114·200 = 29.9 + 88.05 + 22.8 = 140.75
    const img = fakeImageData([100, 150, 200, 255, 100, 150, 200, 0, 0, 0, 255, 255]);
    const out = extractChannel(img, 'luminance');
    expect(out[0]).toBeCloseTo(140.75, 3);
    expect(out[1]).toBe(0);
    // Pure blue: 0.114·255 = 29.07 — isolates the B weight.
    expect(out[2]).toBeCloseTo(29.07, 3);
  });

  it('saturation is max(R,G,B) - min(R,G,B) and 0 for transparent pixels', () => {
    const img = fakeImageData([200, 100, 50, 255, 200, 100, 50, 0]);
    const out = extractChannel(img, 'saturation');
    expect(out[0]).toBe(150);
    expect(out[1]).toBe(0);
  });

  it('an unrecognised mode falls back to the alpha channel', () => {
    const img = fakeImageData([255, 0, 0, 100, 0, 255, 0, 200]);
    const out = extractChannel(img, 'bogus' as unknown as ChannelMode);
    expect(Array.from(out)).toEqual([100, 200]);
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
