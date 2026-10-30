// Blob workers that fail after construction. Chrome 156 under CSP
// `worker-src 'self'` does not throw from new Worker(blobUrl): it fires a
// plain 'error' Event later (probed 2026-10-26), and the worker never
// answers. Both the LK worker and the update-timer worker must then fall
// back as they do for a throw.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_opts?: unknown) { void _opts; } }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return { Layer, TileLayer, Control, DomUtil, DomEvent, default: { Layer, TileLayer, Control, DomUtil, DomEvent } };
});

import { RadarPlayer } from '../src/radar-player';
import { createLkWorker, LkWorkerClient, estimateMotionLk } from '../src/lk-worker';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// A worker whose script never ran: messages go nowhere; the test fires the
// 'error' the browser would (an Event, not an ErrorEvent: no message).
class DeadWorker extends EventTarget {
  static last: DeadWorker | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { super(); DeadWorker.last = this; }
  fail(): void {
    const ev = new Event('error');
    this.dispatchEvent(ev);
    this.onerror?.(ev);
  }
}

function makePlayer(cfg: Partial<WeatherRadarCardConfig> = {}): any {
  const map = {
    on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 96, y: 96 }),
    getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any, noaaLimiter: {} as any, dwdLimiter: {} as any,
  });
}

// A 96×96 rain field of soft blobs, moved by (sx, sy) grid px.
function rainField(sx: number, sy: number): Float32Array {
  const g = 96;
  const out = new Float32Array(g * g);
  const blobs = [[30, 40, 10], [60, 25, 8], [55, 65, 12], [20, 75, 7]];
  for (let y = 0; y < g; y++) {
    for (let x = 0; x < g; x++) {
      let v = 0;
      for (const [bx, by, r] of blobs) {
        const dx = x - sx - bx, dy = y - sy - by;
        v += 220 * Math.exp(-(dx * dx + dy * dy) / (2 * r * r));
      }
      out[y * g + x] = Math.min(255, v);
    }
  }
  return out;
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('LK worker that fails after construction', () => {
  it('a request after the error does not hang: it runs on the main thread', async () => {
    const w = new DeadWorker();
    const client = new LkWorkerClient(w as unknown as Worker, 'blob:lk');
    w.fail();
    const a = rainField(0, 0);
    const b = rainField(2, 1);
    const settled = await Promise.race([
      estimateMotionLk(a, b, 96, 96, {}, client).then((r) => r, () => 'rejected'),
      new Promise((r) => setTimeout(() => r('hung'), 200)),
    ]);
    expect(settled).not.toBe('hung');
    expect(settled).not.toBe('rejected');
    expect(w.postMessage).not.toHaveBeenCalled();
    expect((client as any)._pending.size).toBe(0);
  });

  it('the client rejects a direct request at once instead of queueing it', async () => {
    const w = new DeadWorker();
    const client = new LkWorkerClient(w as unknown as Worker, 'blob:lk');
    w.fail();
    await expect(client.estimate(new Float32Array(16), new Float32Array(16), 4, 4)).rejects.toThrow();
    expect((client as any)._pending.size).toBe(0);
  });

  it('the player drops the dead client, logs the fallback and computes motion on the main thread', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const p = makePlayer({ motion_compensation: true });
    const w = new DeadWorker();
    const client = new LkWorkerClient(w as unknown as Worker, 'blob:lk');
    const dispose = vi.spyOn(client, 'dispose');
    p._lkClient = client;
    p._lkWorkerInitTried = true;
    w.fail();
    const prev = rainField(0, 0);
    const cur = rainField(3, 0);
    const nz = (s: Float32Array): number => s.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);
    p._radarImage = [{}, {}];
    p._frameSnapshot = [prev, cur];
    p._frameSnapshotNz = [nz(prev), nz(cur)];
    p._frameMotion = [null, null];
    p._computeMotionForFrame(1);
    for (let k = 0; k < 5; k++) await Promise.resolve();
    expect(dispose).toHaveBeenCalled();
    expect(p._lkClient).toBeNull();
    expect(info).toHaveBeenCalledWith(expect.stringContaining('LK worker unavailable'));
    expect(p._frameMotion[1]?.dx).toBeGreaterThan(1);
  });
});

describe('createLkWorker when the Worker constructor throws', () => {
  it('revokes the blob URL it created', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:lk-test');
    vi.stubGlobal('Worker', class { constructor() { throw new Error('SecurityError'); } });
    expect(createLkWorker()).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:lk-test');
  });
});

describe('update-timer worker that fails after construction', () => {
  it('a timer armed before the error still fires, at its time', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', DeadWorker);
    const p = makePlayer();
    expect(p._worker).toBe(DeadWorker.last);
    const cb = vi.fn();
    p._workerTimeout(cb, 60_000);
    await vi.advanceTimersByTimeAsync(20_000);
    DeadWorker.last!.fail();
    await vi.advanceTimersByTimeAsync(39_000);
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a timer armed after the error fires through setTimeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', DeadWorker);
    const p = makePlayer();
    DeadWorker.last!.fail();
    const cb = vi.fn();
    p._workerTimeout(cb, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a timer cancelled after the error does not fire', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', DeadWorker);
    const p = makePlayer();
    const cb = vi.fn();
    const cancel = p._workerTimeout(cb, 1_000);
    DeadWorker.last!.fail();
    cancel();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cb).not.toHaveBeenCalled();
  });
});
