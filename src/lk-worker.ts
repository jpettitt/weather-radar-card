// Web Worker wrapper around the LK optical flow algorithm.
//
// Why: a single LK call is ~2 ms on a fast desktop, ~10–25 ms on a
// low-end mobile / tablet. Even 25 ms blocks the main thread enough
// to drop a render frame during the crossfade animation. Pushing the
// LK call to a worker keeps the UI smooth regardless of device speed.
//
// Why this file inlines the algorithm as a string rather than
// importing from lk.ts at runtime:
//
//   1. The card ships as a single Rollup bundle (dist/weather-radar-card.js);
//      Workers in the browser need a separate URL to load source from,
//      and adding a second Rollup output for the worker would require
//      modifying rollup.config.js, which is a hard-no per AGENTS.md
//      without explicit user approval.
//
//   2. The existing setTimeout-shim worker in radar-player.ts uses the
//      same Blob-URL pattern, so this matches established convention.
//
//   3. eval / new Function violate HA's frontend CSP, so we can't pull
//      the function bodies out of lk.ts at runtime via .toString().
//
// The duplication is real but bounded: a test in tests/lk.test.ts runs
// both the TypeScript and the inlined-worker implementations against
// the same synthetic fixtures and asserts identical output, so any
// drift is caught immediately. When updating the algorithm, modify
// BOTH src/lk.ts and the LK_ALGORITHM_SOURCE constant below.

import { lucasKanadePyramidal, type LkOptions, type LkResult } from './lk';

// ── Algorithm source (hand-translated from src/lk.ts to plain JS) ────────
//
// **MUST stay equivalent to the TypeScript implementation in lk.ts.**
// `tests/lk.test.ts` pins the two against each other; any divergence
// fails CI. The structure mirrors lk.ts exactly — same function names,
// same parameter order, same conventions (warp uses `x + vx, y + vy`,
// not `x - vx, y - vy`). The only intentional difference is the
// stripping of TypeScript types and interface declarations.

export const LK_ALGORITHM_SOURCE = `
function buildPyramid(img, width, height, levels) {
  var pyramid = [{ data: img, width: width, height: height }];
  for (var i = 1; i < levels; i++) {
    var prev = pyramid[i - 1];
    var w = prev.width >> 1;
    var h = prev.height >> 1;
    if (w < 4 || h < 4) break;
    var out = new Float32Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var sx = x << 1;
        var sy = y << 1;
        var a = prev.data[sy * prev.width + sx];
        var b = prev.data[sy * prev.width + sx + 1];
        var c = prev.data[(sy + 1) * prev.width + sx];
        var d = prev.data[(sy + 1) * prev.width + sx + 1];
        out[y * w + x] = (a + b + c + d) * 0.25;
      }
    }
    pyramid.push({ data: out, width: w, height: h });
  }
  return pyramid;
}

function sobel(img, width, height) {
  var Ix = new Float32Array(width * height);
  var Iy = new Float32Array(width * height);
  for (var y = 1; y < height - 1; y++) {
    for (var x = 1; x < width - 1; x++) {
      var i = y * width + x;
      var tl = img[i - width - 1]; var tc = img[i - width]; var tr = img[i - width + 1];
      var ml = img[i - 1]; var mr = img[i + 1];
      var bl = img[i + width - 1]; var bc = img[i + width]; var br = img[i + width + 1];
      Ix[i] = ((tr + 2 * mr + br) - (tl + 2 * ml + bl)) * 0.125;
      Iy[i] = ((bl + 2 * bc + br) - (tl + 2 * tc + tr)) * 0.125;
    }
  }
  return { Ix: Ix, Iy: Iy };
}

function sampleBilinear(img, width, height, x, y) {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;
  var x0 = Math.floor(x);
  var y0 = Math.floor(y);
  var x1 = Math.min(x0 + 1, width - 1);
  var y1 = Math.min(y0 + 1, height - 1);
  var fx = x - x0;
  var fy = y - y0;
  var a = img[y0 * width + x0];
  var b = img[y0 * width + x1];
  var c = img[y1 * width + x0];
  var d = img[y1 * width + x1];
  return a * (1 - fx) * (1 - fy)
       + b * fx * (1 - fy)
       + c * (1 - fx) * fy
       + d * fx * fy;
}

function warp(img, width, height, vx, vy) {
  var out = new Float32Array(width * height);
  for (var y = 0; y < height; y++) {
    for (var x = 0; x < width; x++) {
      out[y * width + x] = sampleBilinear(img, width, height, x + vx, y + vy);
    }
  }
  return out;
}

function lkSingleLevel(I0, I1, width, height, vx0, vy0, iterations) {
  var vx = vx0;
  var vy = vy0;
  var grads = sobel(I0, width, height);
  var Ix = grads.Ix;
  var Iy = grads.Iy;

  var sIxIx = 0; var sIxIy = 0; var sIyIy = 0;
  for (var i = 0; i < I0.length; i++) {
    sIxIx += Ix[i] * Ix[i];
    sIxIy += Ix[i] * Iy[i];
    sIyIy += Iy[i] * Iy[i];
  }
  var det = sIxIx * sIyIy - sIxIy * sIxIy;

  var trace = sIxIx + sIyIy;
  var sqrtDisc = Math.sqrt(Math.max(0, trace * trace * 0.25 - det));
  var minEig = trace * 0.5 - sqrtDisc;
  var confidence = minEig / I0.length;

  if (det < 1e-6) {
    return { vx: vx, vy: vy, confidence: 0, iterations: 0 };
  }

  var actualIters = 0;
  for (var iter = 0; iter < iterations; iter++) {
    actualIters++;
    var I1w = warp(I1, width, height, vx, vy);
    var sIxIt = 0; var sIyIt = 0;
    for (var j = 0; j < I0.length; j++) {
      var it = I1w[j] - I0[j];
      sIxIt += Ix[j] * it;
      sIyIt += Iy[j] * it;
    }
    var dvx = (sIyIy * (-sIxIt) - sIxIy * (-sIyIt)) / det;
    var dvy = (sIxIx * (-sIyIt) - sIxIy * (-sIxIt)) / det;
    vx += dvx;
    vy += dvy;
    if (Math.abs(dvx) < 0.005 && Math.abs(dvy) < 0.005) break;
  }
  return { vx: vx, vy: vy, confidence: confidence, iterations: actualIters };
}

function lucasKanadePyramidal(I0, I1, width, height, opts) {
  opts = opts || {};
  var levels = Math.max(1, Math.min(opts.levels !== undefined ? opts.levels : 3, 5));
  var iterations = Math.max(1, Math.min(opts.iterations !== undefined ? opts.iterations : 5, 20));

  var pyr0 = buildPyramid(I0, width, height, levels);
  var pyr1 = buildPyramid(I1, width, height, levels);
  var actualLevels = Math.min(pyr0.length, pyr1.length);

  var vx = 0;
  var vy = 0;
  var confidence = 0;
  var perLevel = [];

  for (var level = actualLevels - 1; level >= 0; level--) {
    if (level < actualLevels - 1) {
      vx *= 2;
      vy *= 2;
    }
    var result = lkSingleLevel(
      pyr0[level].data, pyr1[level].data,
      pyr0[level].width, pyr0[level].height,
      vx, vy, iterations
    );
    vx = result.vx;
    vy = result.vy;
    confidence = result.confidence;
    perLevel.push({
      level: level,
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
    confidence: confidence,
    magnitude: Math.hypot(vx, vy),
    angleDeg: (Math.atan2(vy, vx) * 180 / Math.PI + 360) % 360,
    perLevel: perLevel,
  };
}
`;

// ── Message-handler boilerplate ──────────────────────────────────────────
//
// Wire protocol:
//   main → worker: { id, I0: ArrayBuffer, I1: ArrayBuffer, width, height, opts }
//   worker → main: { id, ...LkResult, elapsedMs }
//
// Buffers are sent as Transferable Objects (zero-copy) — the main
// thread loses access to its Float32Array after posting, but the
// channel-extracted snapshots are throwaway anyway.

const MESSAGE_HANDLER_SOURCE = `
self.addEventListener('message', function (e) {
  var id = e.data.id;
  var t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  var I0 = new Float32Array(e.data.I0);
  var I1 = new Float32Array(e.data.I1);
  var result = lucasKanadePyramidal(I0, I1, e.data.width, e.data.height, e.data.opts);
  var t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  result.id = id;
  result.elapsedMs = t1 - t0;
  self.postMessage(result);
});
`;

// ── Worker factory ───────────────────────────────────────────────────────

/**
 * Create a Worker running the LK algorithm. Returns null when the
 * Worker constructor is unavailable (rare — happens under some CSPs
 * and in tests). Caller is responsible for cleaning up the returned
 * Worker (call `terminate()` and revoke the blob URL — see usage in
 * radar-player.ts).
 *
 * The returned object includes the blob URL so the caller can revoke
 * it during teardown.
 */
export function createLkWorker(): { worker: Worker; blobUrl: string } | null {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined') {
    return null;
  }
  try {
    const source = LK_ALGORITHM_SOURCE + MESSAGE_HANDLER_SOURCE;
    const blob = new Blob([source], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    const worker = new Worker(blobUrl);
    return { worker, blobUrl };
  } catch {
    // Some CSP setups block blob: workers. Caller falls back to
    // synchronous main-thread execution.
    return null;
  }
}

// ── Pending-request bookkeeping ──────────────────────────────────────────

interface PendingLkRequest {
  resolve: (result: LkResult & { elapsedMs: number }) => void;
  reject: (err: Error) => void;
}

/**
 * Wraps a Worker with promise-based async API. Use {@link estimateMotionLk}
 * directly when possible; the underlying primitives are exported for
 * tests and for callers that need explicit lifecycle control.
 */
export class LkWorkerClient {
  private _worker: Worker;
  private _blobUrl: string;
  private _pending = new Map<number, PendingLkRequest>();
  private _nextId = 0;

  constructor(worker: Worker, blobUrl: string) {
    this._worker = worker;
    this._blobUrl = blobUrl;
    this._worker.addEventListener('message', this._onMessage);
    this._worker.addEventListener('error', this._onError);
  }

  /**
   * Submit a frame pair for LK estimation. Returns a promise that
   * resolves with the LK result + elapsed wall-clock time inside the
   * worker. Buffers are transferred zero-copy — caller's Float32Array
   * is detached after this call.
   */
  estimate(
    I0: Float32Array, I1: Float32Array, width: number, height: number,
    opts: LkOptions = {},
  ): Promise<LkResult & { elapsedMs: number }> {
    return new Promise((resolve, reject) => {
      const id = this._nextId++;
      this._pending.set(id, { resolve, reject });
      this._worker.postMessage(
        { id, I0: I0.buffer, I1: I1.buffer, width, height, opts },
        [I0.buffer, I1.buffer],
      );
    });
  }

  /** Terminate the worker and revoke its blob URL. */
  dispose(): void {
    this._worker.removeEventListener('message', this._onMessage);
    this._worker.removeEventListener('error', this._onError);
    this._worker.terminate();
    URL.revokeObjectURL(this._blobUrl);
    // Reject any still-pending requests so callers don't hang.
    for (const pending of this._pending.values()) {
      pending.reject(new Error('LkWorkerClient disposed'));
    }
    this._pending.clear();
  }

  private _onMessage = (e: MessageEvent): void => {
    const { id, ...result } = e.data as LkResult & { id: number; elapsedMs: number };
    const pending = this._pending.get(id);
    if (!pending) return;
    this._pending.delete(id);
    pending.resolve(result as LkResult & { elapsedMs: number });
  };

  private _onError = (e: ErrorEvent): void => {
    // A worker-level error fails ALL pending requests — the worker
    // process is dead, no in-flight request will ever resolve.
    const err = new Error(`LK worker error: ${e.message}`);
    for (const pending of this._pending.values()) pending.reject(err);
    this._pending.clear();
  };
}

// ── Top-level estimation helper (with sync fallback) ─────────────────────

/**
 * Estimate motion between two frames. Uses the supplied worker client
 * when available; otherwise runs the LK algorithm synchronously on
 * the calling thread. Always returns a promise so call-sites don't
 * need to branch.
 *
 * Note: the buffers are NOT transferred when running synchronously
 * (so callers can keep reading them); they ARE transferred when
 * routed through a worker (caller's Float32Array becomes detached).
 * If caller behaviour depends on this, copy before calling.
 */
export async function estimateMotionLk(
  I0: Float32Array, I1: Float32Array, width: number, height: number,
  opts: LkOptions = {},
  client: LkWorkerClient | null = null,
): Promise<LkResult> {
  if (client) {
    return client.estimate(I0, I1, width, height, opts);
  }
  // Synchronous fallback — wrap in a microtask so the API surface is
  // uniformly async.
  return Promise.resolve(lucasKanadePyramidal(I0, I1, width, height, opts));
}
