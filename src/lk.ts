// Pyramidal Lucas-Kanade optical flow for radar tile pairs.
//
// Given two consecutive radar frame snapshots (Float32 intensity grids)
// of equal dimensions, returns the single global displacement (dx, dy)
// that best aligns the pair. Used by radar-player.ts during the
// crossfade to translate each layer in the direction of motion so the
// rain appears to drift between frames instead of teleport.
//
// Pure: no DOM, no Leaflet, no module-level state. Browser-safe and
// safe to run inside a Web Worker via lk-worker.ts (which inlines the
// algorithm as a JS string — see the doc-block in that file for the
// duplication rationale).
//
// Algorithm: Lucas-Kanade least-squares optical flow run over a 3-level
// Gaussian-like pyramid (256 → 128 → 64 by default). Each level
// iteratively refines a single (vx, vy) by solving the over-determined
// system A^T A v = -A^T b where A is the spatial gradient and b the
// temporal gradient, summed over all pixels. Coarsest level starts at
// (0, 0); each finer level inherits the previous level's estimate
// scaled up by 2. Pyramidal coverage means motion much larger than the
// per-level convergence radius is still recovered cleanly (the
// coarsest level sees 30 px of motion as ~7 px).
//
// Why a single global vector rather than dense per-cell flow: a
// rendering pipeline that can show different translations per region
// needs WebGL or a sub-layer mesh, which is a separate, larger
// project. Validation against synthetic test scenarios in the
// prototype (.dev/lk-prototype/) showed that a single global vector
// approximates differential storm-cell motion to within sub-pixel
// residual, so dense flow isn't warranted for v1.

export interface LkOptions {
  /** Pyramid levels (1..5). Level 0 = original resolution. Default 3. */
  levels?: number;
  /** Per-level LK refinement iterations (1..20). Default 5. */
  iterations?: number;
}

export interface LkPerLevelResult {
  level: number;
  width: number;
  height: number;
  vx: number;
  vy: number;
  confidence: number;
  iterationsUsed: number;
}

export interface LkResult {
  /** Global x displacement in pixels. Positive = source content moved right. */
  dx: number;
  /** Global y displacement in pixels. Positive = source content moved down. */
  dy: number;
  /**
   * Shi-Tomasi gradient-tensor confidence at the finest level, normalised
   * by pixel count. Empirical bands (see prototype README):
   *   > 50  strong   — clear texture, trustworthy
   *   5–50 borderline — direction probably right, magnitude uncertain
   *   < 5  low signal — image too flat for LK to find structure
   * The radar-player gates motion-compensation on this threshold.
   */
  confidence: number;
  /** Hypot of (dx, dy). */
  magnitude: number;
  /** atan2(dy, dx) in degrees, 0..360 (mathematical convention, +x = 0°). */
  angleDeg: number;
  /** Per-level breakdown for diagnosis — useful in the prototype harness. */
  perLevel: LkPerLevelResult[];
}

// ── Pyramid construction ──────────────────────────────────────────────────

interface PyramidLevel { data: Float32Array; width: number; height: number; }

/**
 * Build a Gaussian-like pyramid. Each level halves the previous
 * level's width and height; each output pixel is the 2×2 average of
 * the corresponding source block. Not a true Gaussian (no σ-tuned
 * kernel), but sufficient as a low-pass step before LK — coarsely
 * suppressing high-frequency detail is enough for the iterative
 * refinement to converge.
 *
 * Stops adding levels once a halved level would fall below 4 px in
 * either dimension — the LK gradient window can't operate below that
 * and finer-level estimates would dominate anyway.
 */
export function buildPyramid(
  img: Float32Array, width: number, height: number, levels: number,
): PyramidLevel[] {
  const pyramid: PyramidLevel[] = [{ data: img, width, height }];
  for (let i = 1; i < levels; i++) {
    const prev = pyramid[i - 1];
    const w = prev.width >> 1;
    const h = prev.height >> 1;
    if (w < 4 || h < 4) break;
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = x << 1;
        const sy = y << 1;
        const a = prev.data[sy * prev.width + sx];
        const b = prev.data[sy * prev.width + sx + 1];
        const c = prev.data[(sy + 1) * prev.width + sx];
        const d = prev.data[(sy + 1) * prev.width + sx + 1];
        out[y * w + x] = (a + b + c + d) * 0.25;
      }
    }
    pyramid.push({ data: out, width: w, height: h });
  }
  return pyramid;
}

// ── Spatial gradients (Sobel) ─────────────────────────────────────────────

interface Gradients { Ix: Float32Array; Iy: Float32Array; }

/**
 * 3×3 Sobel gradient in one pass. Border pixels are zero — they
 * contribute zero to every LK accumulator naturally, so no special
 * border handling is needed downstream.
 */
export function sobel(img: Float32Array, width: number, height: number): Gradients {
  const Ix = new Float32Array(width * height);
  const Iy = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const tl = img[i - width - 1]; const tc = img[i - width]; const tr = img[i - width + 1];
      const ml = img[i - 1]; const mr = img[i + 1];
      const bl = img[i + width - 1]; const bc = img[i + width]; const br = img[i + width + 1];
      Ix[i] = ((tr + 2 * mr + br) - (tl + 2 * ml + bl)) * 0.125;
      Iy[i] = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) * 0.125;
    }
  }
  return { Ix, Iy };
}

// ── Bilinear sampler + warp ──────────────────────────────────────────────

function sampleBilinear(
  img: Float32Array, width: number, height: number, x: number, y: number,
): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = img[y0 * width + x0];
  const b = img[y0 * width + x1];
  const c = img[y1 * width + x0];
  const d = img[y1 * width + x1];
  return a * (1 - fx) * (1 - fy)
       + b * fx * (1 - fy)
       + c * (1 - fx) * fy
       + d * fx * fy;
}

/**
 * Warp img by displacement (vx, vy): output pixel at (x, y) samples
 * img at (x + vx, y + vy). Convention: (vx, vy) is the displacement of
 * source content from I0 to I1. If rain moved from I0(p) to
 * I1(p + d), then warp(I1, +d) brings the rain back to position p —
 * aligning I1 with I0. This matches the textbook LK formulation
 * `I1(x + v) ≈ I0(x)` that the update equation in lkSingleLevel
 * derives from. Inverting the sign here was the bug that produced
 * "double paint at 1x" in the prototype before the fix.
 */
function warp(
  img: Float32Array, width: number, height: number, vx: number, vy: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[y * width + x] = sampleBilinear(img, width, height, x + vx, y + vy);
    }
  }
  return out;
}

// ── Single-level Lucas-Kanade ────────────────────────────────────────────

export interface LkSingleLevelResult {
  vx: number;
  vy: number;
  confidence: number;
  iterations: number;
}

/**
 * Iterative LK at one pyramid level. Returns refined (vx, vy) plus
 * Shi-Tomasi confidence (min eigenvalue of the gradient tensor,
 * normalised by pixel count) and the number of refinement iterations
 * actually used (may be less than the cap if convergence kicked in).
 *
 * Inputs are already at this level's resolution. Initial guess
 * (vx0, vy0) comes from the coarser level scaled up by 2; coarsest
 * level passes (0, 0).
 *
 * The gradient tensor is computed once from I0 and reused across
 * iterations — it doesn't change as v changes. The per-iteration cost
 * is the warp + temporal-gradient accumulation.
 */
export function lkSingleLevel(
  I0: Float32Array, I1: Float32Array, width: number, height: number,
  vx0: number, vy0: number, iterations: number,
): LkSingleLevelResult {
  let vx = vx0;
  let vy = vy0;
  const { Ix, Iy } = sobel(I0, width, height);

  let sIxIx = 0; let sIxIy = 0; let sIyIy = 0;
  for (let i = 0; i < I0.length; i++) {
    sIxIx += Ix[i] * Ix[i];
    sIxIy += Ix[i] * Iy[i];
    sIyIy += Iy[i] * Iy[i];
  }
  const det = sIxIx * sIyIy - sIxIy * sIxIy;

  // Shi-Tomasi confidence: min eigenvalue of the symmetric tensor
  // [[sIxIx, sIxIy], [sIxIy, sIyIy]]. Normalised by pixel count so the
  // scale is roughly comparable across pyramid resolutions.
  const trace = sIxIx + sIyIy;
  const sqrtDisc = Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
  const minEig = trace * 0.5 - sqrtDisc;
  const confidence = minEig / I0.length;

  if (det < 1e-6) {
    return { vx, vy, confidence: 0, iterations: 0 };
  }

  let actualIters = 0;
  for (let iter = 0; iter < iterations; iter++) {
    actualIters++;
    const I1w = warp(I1, width, height, vx, vy);
    let sIxIt = 0; let sIyIt = 0;
    for (let i = 0; i < I0.length; i++) {
      const it = I1w[i] - I0[i];
      sIxIt += Ix[i] * it;
      sIyIt += Iy[i] * it;
    }
    const dvx = (sIyIy * (-sIxIt) - sIxIy * (-sIyIt)) / det;
    const dvy = (sIxIx * (-sIyIt) - sIxIy * (-sIxIt)) / det;
    vx += dvx;
    vy += dvy;
    // Convergence threshold of 0.005 px tracks the prototype's tuning
    // — finer than radar can plausibly resolve, but cheap enough that
    // tightening doesn't cost much when iterations are already capped.
    if (Math.abs(dvx) < 0.005 && Math.abs(dvy) < 0.005) break;
  }
  return { vx, vy, confidence, iterations: actualIters };
}

// ── Pyramidal LK (public entry point) ────────────────────────────────────

/**
 * Pyramidal Lucas-Kanade. Walks coarsest level → finest, scaling the
 * estimate up by 2 between levels. Returns the global motion vector,
 * a confidence score, and a per-level breakdown that's mostly useful
 * for debugging (the prototype harness uses it).
 *
 * Defaults: 3 pyramid levels, 5 refinement iterations per level.
 * Empirically (.dev/lk-prototype/) these defaults converge cleanly on
 * synthetic test scenarios at all motion magnitudes up to ~30 px.
 *
 * @param I0  First frame (intensity, typically distance-from-white values 0..255)
 * @param I1  Second frame (same dims as I0)
 */
export function lucasKanadePyramidal(
  I0: Float32Array, I1: Float32Array, width: number, height: number,
  opts: LkOptions = {},
): LkResult {
  const levels = Math.max(1, Math.min(opts.levels ?? 3, 5));
  const iterations = Math.max(1, Math.min(opts.iterations ?? 5, 20));

  const pyr0 = buildPyramid(I0, width, height, levels);
  const pyr1 = buildPyramid(I1, width, height, levels);
  const actualLevels = Math.min(pyr0.length, pyr1.length);

  let vx = 0;
  let vy = 0;
  let confidence = 0;
  const perLevel: LkPerLevelResult[] = [];

  for (let level = actualLevels - 1; level >= 0; level--) {
    if (level < actualLevels - 1) {
      vx *= 2;
      vy *= 2;
    }
    const result = lkSingleLevel(
      pyr0[level].data, pyr1[level].data,
      pyr0[level].width, pyr0[level].height,
      vx, vy, iterations,
    );
    vx = result.vx;
    vy = result.vy;
    confidence = result.confidence;
    perLevel.push({
      level,
      width: pyr0[level].width,
      height: pyr0[level].height,
      vx: result.vx,
      vy: result.vy,
      confidence: result.confidence,
      iterationsUsed: result.iterations,
    });
  }

  return {
    dx: vx,
    dy: vy,
    confidence,
    magnitude: Math.hypot(vx, vy),
    angleDeg: (Math.atan2(vy, vx) * 180 / Math.PI + 360) % 360,
    perLevel,
  };
}

// ── ImageData / channel extraction utilities ─────────────────────────────

export type ChannelMode = 'alpha' | 'luminance' | 'distance-from-white' | 'saturation';

/**
 * Extract a single intensity channel from canvas ImageData into a
 * Float32Array suitable for lucasKanadePyramidal.
 *
 * Four modes, each suited to different radar palettes:
 *   - 'alpha':                DWD banded palette — alpha gradients at
 *                             intensity boundaries carry the signal
 *   - 'luminance':            ITU-R BT.601 perceptual brightness, neutral
 *                             baseline that works for any palette
 *   - 'distance-from-white':  255 - min(R, G, B), gated and weighted by
 *                             alpha. **Default and recommended** —
 *                             captures both greyscale and coloured rain
 *                             on one scale; works for all three radar
 *                             sources (DWD, RainViewer, NOAA)
 *   - 'saturation':           max - min of RGB. Fails for greyscale rain
 *                             (RainViewer/NOAA low-intensity); included
 *                             only for completeness with the prototype
 *
 * radar-player.ts uses 'distance-from-white' unconditionally. The
 * other modes are kept exported so the prototype harness keeps working
 * and so future per-source dispatch (if ever needed) has somewhere to
 * land.
 */
export function extractChannel(
  imgData: { data: Uint8ClampedArray; width: number; height: number },
  mode: ChannelMode = 'distance-from-white',
): Float32Array {
  const out = new Float32Array(imgData.width * imgData.height);
  const data = imgData.data;
  for (let i = 0; i < out.length; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const a = data[i * 4 + 3];
    switch (mode) {
      case 'alpha':
        out[i] = a;
        break;
      case 'luminance':
        out[i] = a === 0 ? 0 : 0.299 * r + 0.587 * g + 0.114 * b;
        break;
      case 'distance-from-white':
        // Gating on a === 0 (the "no rain" check) AND weighting by
        // alpha means transparent pixels contribute zero, and
        // semi-transparent rain contributes proportionally to its
        // visible intensity.
        //
        // Tried squaring this (intensity² / 255) to re-bias LK's
        // gradient signal toward saturated red/yellow core pixels in
        // hopes of reducing the visible "core jumps" while outlines
        // drift smoothly artifact. Empirically no visible improvement
        // — the residual core motion appears to be storm-evolution
        // (cell rotation / decay / reorganisation) rather than
        // translation that LK could chase. Reverted to linear; dense
        // per-region flow is the real fix and that's a v2 project.
        // See docs/motion-compensation-feature-design.md.
        out[i] = a === 0 ? 0 : ((255 - Math.min(r, g, b)) * a) / 255;
        break;
      case 'saturation':
        out[i] = a === 0 ? 0 : Math.max(r, g, b) - Math.min(r, g, b);
        break;
      default:
        out[i] = a;
    }
  }
  return out;
}
