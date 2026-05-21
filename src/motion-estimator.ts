// Block matching motion estimator for radar precipitation frames.
//
// Standard meteorological technique: take two consecutive radar frames,
// search for the integer pixel displacement (dx, dy) that minimises the
// sum of absolute differences (SAD) between the older frame and the
// newer frame shifted by (dx, dy). That displacement is the bulk motion
// of the rain field, used by the radar player to translate layers
// during crossfade so the rain appears to drift rather than show two
// stacked positions.
//
// Why SAD rather than full normalised cross correlation: SAD is one
// subtraction and one absolute per pixel, no multiplies, and the
// resulting peak is essentially indistinguishable for our use case
// (binary-ish alpha maps from a colourised radar tile, low dynamic
// range). Phase correlation via FFT would handle multi cell motion
// fields better but requires a fast Fourier transform implementation
// the codebase doesn't currently carry; SAD is the right pragmatic
// first cut.
//
// Pure: no DOM, no Leaflet, no class state. Inputs are plain typed
// arrays plus dimensions. Unit testable in isolation.

export interface MotionVector {
  dx: number;
  dy: number;
  /** Quality score 0 to 1. 1 means a clean unique peak; close to 0 means
   * the SAD surface was flat (no rain or moved out of search window). */
  confidence: number;
}

/**
 * Find the integer pixel displacement that best aligns frame B with frame
 * A by minimising sum of absolute differences. Returns (dx, dy) in low
 * resolution grid pixels where the convention is: B's content at
 * (x + dx, y + dy) matches A's content at (x, y), i.e. the rain moved
 * by (dx, dy) between A and B.
 *
 * Border pixels that the shifted comparison would read out of bounds
 * are skipped, so the SAD is computed only over the overlapping
 * window. The overlap area is normalised out by dividing the raw SAD
 * by the number of pairs compared, so displacements with smaller
 * overlap (large dx / dy near the search window edge) aren't unfairly
 * preferred.
 *
 * Pixels where BOTH A and B are zero contribute nothing useful (no
 * rain anywhere) and are skipped to keep the inner loop fast on the
 * typical sparse radar frame.
 *
 * @param a Frame A intensity (older). Length must equal w * h.
 * @param b Frame B intensity (newer). Same dimensions as A.
 * @param w Grid width in pixels.
 * @param h Grid height in pixels.
 * @param maxOffset Search radius. Total candidates: (2 * maxOffset + 1)^2.
 */
export function findMotionSAD(
  a: Uint8Array | Uint8ClampedArray,
  b: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
  maxOffset: number,
): MotionVector {
  // Empty grid or no rain at all: motion is undefined.
  let aSum = 0;
  let bSum = 0;
  for (let i = 0; i < a.length; i++) { aSum += a[i]; bSum += b[i]; }
  if (aSum === 0 && bSum === 0) return { dx: 0, dy: 0, confidence: 0 };

  // Stride 1 keeps a copy of the full SAD surface so we can refine the
  // integer peak to sub-pixel resolution via parabolic fit afterwards.
  // 2*maxOffset+1 squared bytes (~961 for maxOffset=15) is trivial.
  const side = 2 * maxOffset + 1;
  const sadGrid = new Float32Array(side * side);

  let bestDx = 0;
  let bestDy = 0;
  let bestSAD = Infinity;
  let secondBestSAD = Infinity;

  for (let dy = -maxOffset; dy <= maxOffset; dy++) {
    for (let dx = -maxOffset; dx <= maxOffset; dx++) {
      // Iteration bounds clip to the overlapping window.
      const yStart = Math.max(0, -dy);
      const yEnd = Math.min(h, h - dy);
      const xStart = Math.max(0, -dx);
      const xEnd = Math.min(w, w - dx);
      let sumAbs = 0;
      let pairs = 0;
      for (let y = yStart; y < yEnd; y++) {
        const aRow = y * w;
        const bRow = (y + dy) * w;
        for (let x = xStart; x < xEnd; x++) {
          const av = a[aRow + x];
          const bv = b[bRow + x + dx];
          if (av === 0 && bv === 0) continue;
          sumAbs += av > bv ? av - bv : bv - av;
          pairs++;
        }
      }
      // Normalise so smaller overlap windows don't artificially win.
      // pairs==0 means no rain in this overlap; treat as worst case.
      const sad = pairs > 0 ? sumAbs / pairs : Infinity;
      sadGrid[(dy + maxOffset) * side + (dx + maxOffset)] = sad;
      if (sad < bestSAD) {
        secondBestSAD = bestSAD;
        bestSAD = sad;
        bestDx = dx;
        bestDy = dy;
      } else if (sad < secondBestSAD) {
        secondBestSAD = sad;
      }
    }
  }

  // Sub-pixel refinement via parabolic fit on the SAD surface around the
  // integer peak. For a function sampled at -1, 0, +1, the sub-pixel
  // offset of the minimum is (left - right) / (2 * (left - 2*centre +
  // right)). Skips if the peak is at the search-window border (we can't
  // see one side of the curve) or if the denominator is degenerate.
  let subDx = 0;
  let subDy = 0;
  if (bestDx > -maxOffset && bestDx < maxOffset && bestDy > -maxOffset && bestDy < maxOffset) {
    const cy = bestDy + maxOffset;
    const cx = bestDx + maxOffset;
    const centre = sadGrid[cy * side + cx];
    const left = sadGrid[cy * side + cx - 1];
    const right = sadGrid[cy * side + cx + 1];
    const up = sadGrid[(cy - 1) * side + cx];
    const down = sadGrid[(cy + 1) * side + cx];
    const denomX = left - 2 * centre + right;
    const denomY = up - 2 * centre + down;
    if (denomX !== 0 && Number.isFinite(denomX)) {
      subDx = (left - right) / (2 * denomX);
      // Clamp to ±0.5 — anything beyond means the parabola isn't a good
      // local model and the integer peak is more trustworthy.
      if (subDx > 0.5 || subDx < -0.5) subDx = 0;
    }
    if (denomY !== 0 && Number.isFinite(denomY)) {
      subDy = (up - down) / (2 * denomY);
      if (subDy > 0.5 || subDy < -0.5) subDy = 0;
    }
  }

  // Confidence: how much better the winner is than the runner up. Flat
  // SAD surfaces (no clear peak) get low confidence.
  const confidence = !Number.isFinite(bestSAD) || secondBestSAD === 0
    ? 0
    : Math.max(0, Math.min(1, (secondBestSAD - bestSAD) / secondBestSAD));
  return { dx: bestDx + subDx, dy: bestDy + subDy, confidence };
}

/**
 * Smooth a sequence of per-pair motion vectors by replacing each with
 * the component-wise median of its 5-tap neighbourhood. Reduces frame
 * to frame jitter and is robust to single outliers — including the
 * pathological case of a SAD-perfect (0, 0) match when DWD republishes
 * an identical radar frame, which a confidence-weighted average would
 * trust completely and let dominate the local consensus.
 *
 * Component-wise median (dx and dy computed independently) is the
 * standard meteorological choice here: it preserves the dominant
 * direction of motion while rejecting any single frame that disagrees
 * with its neighbours, regardless of how confident that frame's SAD
 * peak happened to be.
 *
 * Null entries contribute nothing. Indices at the edges of the sequence
 * use the asymmetric neighbourhood that fits. Output confidence is the
 * mean of the input confidences in the neighbourhood — a coarse
 * signal of how trustworthy the smoothed result is.
 *
 * Pure: in -> out, no DOM.
 */
export function smoothMotionVectors(
  vectors: ReadonlyArray<MotionVector | null>,
): (MotionVector | null)[] {
  const out: (MotionVector | null)[] = new Array(vectors.length).fill(null);
  for (let i = 0; i < vectors.length; i++) {
    const dxs: number[] = [];
    const dys: number[] = [];
    const confs: number[] = [];
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j < 0 || j >= vectors.length) continue;
      const v = vectors[j];
      if (!v) continue;
      dxs.push(v.dx);
      dys.push(v.dy);
      confs.push(v.confidence);
    }
    if (dxs.length === 0) { out[i] = null; continue; }
    out[i] = {
      dx: median(dxs),
      dy: median(dys),
      confidence: confs.reduce((acc, x) => acc + x, 0) / confs.length,
    };
  }
  return out;
}

function median(values: number[]): number {
  // Copy and sort to avoid mutating the caller's array. For 5 entries
  // this is trivial; if the smoothing window grows substantially a
  // quickselect would be the right move.
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Downsample an RGBA image's alpha channel into a smaller intensity grid.
 * Each destination pixel averages the alphas of the (srcW/dstW) by
 * (srcH/dstH) source pixels covering it. Used to convert a full-size
 * snapshot canvas into the ~128 by 128 grid the SAD search works on,
 * which keeps the cross correlation cost bounded regardless of the
 * source resolution.
 *
 * Pure: rgba in, alpha grid out, no DOM. Unit testable.
 */
export function downsampleAlpha(
  rgba: Uint8ClampedArray | Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8Array {
  const out = new Uint8Array(dstW * dstH);
  const xScale = srcW / dstW;
  const yScale = srcH / dstH;
  for (let dy = 0; dy < dstH; dy++) {
    const yStart = Math.floor(dy * yScale);
    const yEnd = Math.max(yStart + 1, Math.floor((dy + 1) * yScale));
    for (let dx = 0; dx < dstW; dx++) {
      const xStart = Math.floor(dx * xScale);
      const xEnd = Math.max(xStart + 1, Math.floor((dx + 1) * xScale));
      let sum = 0;
      let count = 0;
      for (let y = yStart; y < yEnd; y++) {
        for (let x = xStart; x < xEnd; x++) {
          sum += rgba[(y * srcW + x) * 4 + 3];
          count++;
        }
      }
      out[dy * dstW + dx] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
  return out;
}
