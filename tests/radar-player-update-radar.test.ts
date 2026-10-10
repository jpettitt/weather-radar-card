// Tests for _updateRadar (the periodic ~5-min background data refresh) —
// issue #249: "timeline drifts backward on every loop" / skip-back jumps
// to the wrong frame.
//
// Root cause: _updateRadar synchronously renumbers every frame index and
// shrinks _loadedSlots by one (dropping the oldest frame) before the new
// frame's tiles have settled, but never cancelled the already-running
// animation-loop timer first. A tick from that stale timer could fire
// mid-shift, computing (_currentSlot + 1) % _loadedSlots.length against a
// now-stale _currentSlot and a temporarily-shrunk array — landing on an
// arbitrary wrapped position instead of continuing smoothly. Confirmed by
// reproducing it against the real (pre-fix) _updateRadar before fixing:
// _currentSlot was left at its pre-shift value (out of range for the
// shrunk array) until the new frame's load event eventually reset it.
//
// Fix: _stopLoop() before the shift (cancels/regenerations the pending
// timer), plus synchronously decrementing _currentSlot/_prev1Slot when
// the oldest frame is actually dropped — mirroring the position-aware
// shift already used by _afterFrameInserted for the init loop. The
// recovery listener stays a raw `layer.once('load', ...)` (unchanged) —
// _updateRadar's synchronous portion still returns without waiting for
// the new frame to settle, matching every existing test's assumptions.
//
// Follows the "stub Leaflet, test the helpers" convention.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control {
    constructor(_opts?: unknown) { void _opts; }
  }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, DomUtil, DomEvent },
  };
});

import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function fakeLayer(label: string): any {
  const container = { style: {} as Record<string, string>, offsetHeight: 0 };
  const listeners: Record<string, (() => void)[]> = {};
  return {
    addTo: vi.fn(),
    remove: vi.fn(),
    once: vi.fn((ev: string, cb: () => void) => {
      (listeners[ev] ??= []).push(cb);
    }),
    off: vi.fn((ev: string, cb: () => void) => {
      listeners[ev] = (listeners[ev] ?? []).filter(f => f !== cb);
    }),
    on: vi.fn(),
    getContainer: () => container,
    _tileFailed: 0,
    _label: label,
    _fireLoad: () => { listeners['load']?.forEach(cb => cb()); },
  };
}

function makePlayer(cfg: Partial<WeatherRadarCardConfig> = {}): RadarPlayer {
  const map = {
    on: vi.fn(),
    off: vi.fn(),
    getZoom: () => 7,
    getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(),
    createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  const shadowRoot = { getElementById: () => null, host: {} } as any;
  return new RadarPlayer({
    map,
    shadowRoot,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

const NOW_SEC = 1_800_000_000;
const FRAME_COUNT = 13;
const STRIDE_SEC = 5 * 60;

function seedSteadyState(p: any, frameCount: number = FRAME_COUNT) {
  const mkFrames = (endSec: number) => Array.from({ length: frameCount }, (_, i) => ({
    time: endSec + (i - (frameCount - 1)) * STRIDE_SEC,
    path: '',
  }));
  p._radarPaths = mkFrames(NOW_SEC);
  p._radarImage = Array.from({ length: frameCount }, (_, i) => fakeLayer(`init-${i}`));
  p._radarTime = Array.from({ length: frameCount }, (_, i) => ({ date: 'd', time: `frame-${i}` }));
  p._frameStatuses = Array.from({ length: frameCount }, () => 'loaded');
  p._loadedSlots = Array.from({ length: frameCount }, (_, i) => i);
  p._configFrameCount = frameCount;
  p._radarReady = true;
  p._nowFrameIndex = frameCount - 1;
  p._currentSlot = frameCount - 1;
  p._prev1Slot = frameCount - 1;
  p._frameSnapshot = new Array(frameCount).fill(null);
  p._frameSnapshotNz = new Array(frameCount).fill(0);
  p._frameMotion = new Array(frameCount).fill(null);
  p.navPaused = false;
  p.viewPaused = false;
  return mkFrames;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('_updateRadar — animation-loop race (issue #249)', () => {
  it('a stale in-flight tick from before the refresh cannot corrupt _currentSlot mid-shift', async () => {
    const p = makePlayer({ frame_delay: 100, restart_delay: 200 }) as any;
    const mkFrames = seedSteadyState(p);
    p.run = true;
    p._startLoop(p._currentSlot); // arms a real _scheduleNext timer

    p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC + STRIDE_SEC));
    let capturedNewLayer: any = null;
    p._createLayer = vi.fn(() => { capturedNewLayer = fakeLayer('refresh-new'); return capturedNewLayer; });
    p._setLayerZ = vi.fn();

    const updatePromise = p._updateRadar();
    await vi.advanceTimersByTimeAsync(0); // let _fetchPaths resolve and the sync shift run

    // Right after the shift, _currentSlot must already be a valid
    // position in the (temporarily shrunk) _loadedSlots.
    expect(p._currentSlot).toBeLessThan(p._loadedSlots.length);
    expect(p._currentSlot).toBeGreaterThanOrEqual(0);

    // Advance past where the old (pre-refresh) tick would have fired —
    // it must be a no-op now (stale generation), not a corrupting jump.
    await vi.advanceTimersByTimeAsync(350);
    expect(p._currentSlot).toBeLessThan(p._loadedSlots.length);
    expect(p._loadedSlots.length).toBe(FRAME_COUNT - 1); // still mid-refresh

    capturedNewLayer._fireLoad();
    await updatePromise;

    expect(p._loadedSlots).toEqual(Array.from({ length: FRAME_COUNT }, (_, i) => i));
    expect(p._currentSlot).toBe(FRAME_COUNT - 1); // back on "now"
  });

  it('_currentSlot/_prev1Slot decrement in step with the dropped oldest frame even while paused', async () => {
    const p = makePlayer() as any;
    const mkFrames = seedSteadyState(p);
    p.run = false; // start_paused-style: no animation timer to race

    p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC + STRIDE_SEC));
    let capturedNewLayer: any = null;
    p._createLayer = vi.fn(() => { capturedNewLayer = fakeLayer('refresh-new'); return capturedNewLayer; });
    p._setLayerZ = vi.fn();

    const updatePromise = p._updateRadar();
    await vi.advanceTimersByTimeAsync(0);

    // Paused, mid-refresh: _currentSlot must still track "now" at its
    // new (shifted) position, not the stale pre-shift value.
    expect(p._currentSlot).toBe(FRAME_COUNT - 2);
    expect(p._prev1Slot).toBe(FRAME_COUNT - 2);

    capturedNewLayer._fireLoad();
    await updatePromise;

    expect(p._currentSlot).toBe(FRAME_COUNT - 1);
  });

  it('skipBack from "Latest" mid-refresh steps to the previous frame, not back to "Latest" itself', async () => {
    // Covers the report's second symptom: paused on "Latest", skip-back
    // appeared to jump to the end (i.e. no visible change) instead of
    // stepping back. Reproducible whenever skipBack runs while
    // _currentSlot is stale — before this fix, a press landing in the
    // mid-shift window would see _currentSlot still at its pre-shift
    // value (frameCount - 1, out of range for the shrunk array), so
    // (currentSlot - 1 + n) % n wrapped to n - 1 — "Latest" again.
    const p = makePlayer() as any;
    const mkFrames = seedSteadyState(p);
    p.run = false;

    p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC + STRIDE_SEC));
    p._createLayer = vi.fn(() => fakeLayer('refresh-new'));
    p._setLayerZ = vi.fn();

    void p._updateRadar();
    await vi.advanceTimersByTimeAsync(0); // mid-refresh: _loadedSlots shrunk, not yet recovered

    p.skipBack();

    // Previous frame relative to the shifted "now" position, never a
    // no-op wrap back to the last position.
    expect(p._currentSlot).toBe(FRAME_COUNT - 3);
  });

  it('never sets _currentSlot to -1 even if the newest frame fails to load for several consecutive cycles', async () => {
    // Every cycle drops the oldest frame regardless of whether the new
    // one succeeds (droppedOldest doesn't know in advance) — if the
    // newest frame specifically keeps failing while nothing is ever
    // pushed back, _loadedSlots can drain to empty. The load-recovery
    // callback must not then compute _currentSlot = length - 1 = -1.
    const SMALL_COUNT = 3;
    const p = makePlayer() as any;
    const mkFrames = seedSteadyState(p, SMALL_COUNT);
    p.run = false;

    for (let cycle = 1; cycle <= SMALL_COUNT; cycle++) {
      p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC + cycle * STRIDE_SEC));
      let layer: any = null;
      p._createLayer = vi.fn(() => { layer = fakeLayer(`fail-${cycle}`); layer._tileFailed = 1; return layer; });
      p._setLayerZ = vi.fn();

      const updatePromise = p._updateRadar();
      await vi.advanceTimersByTimeAsync(0);
      layer._fireLoad(); // tiles "load" but are marked failed
      await updatePromise;
    }

    expect(p._loadedSlots.length).toBe(0);
    expect(p._currentSlot).toBeGreaterThanOrEqual(0);
  });
});

// DWD frame times come from the clock on a 5-min grid while the update runs
// every 6 min, so about every fifth update finds two new frames. Shifting in
// only the newest left a 10-min gap for the whole window (reproduced live).
describe('_updateRadar — several new frames in one update', () => {
  it('shifts in every new frame, oldest first, so the loop keeps its spacing', async () => {
    const p = makePlayer() as any;
    const mkFrames = seedSteadyState(p);
    p.run = false;
    p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC + 2 * STRIDE_SEC));
    const created: any[] = [];
    p._createLayer = vi.fn(() => { const l = fakeLayer(`new-${created.length}`); created.push(l); return l; });
    p._setLayerZ = vi.fn();

    const updatePromise = p._updateRadar();
    await vi.advanceTimersByTimeAsync(0);
    await updatePromise;

    const times = p._radarPaths.map((f: any) => f.time);
    expect(times[FRAME_COUNT - 1]).toBe(NOW_SEC + 2 * STRIDE_SEC);
    expect(times.slice(1).map((tm: number, i: number) => tm - times[i])).toEqual(new Array(FRAME_COUNT - 1).fill(STRIDE_SEC));
    expect(created.length).toBe(2);
    expect(p._radarImage[FRAME_COUNT - 2]).toBe(created[0]);
    expect(p._radarImage[FRAME_COUNT - 1]).toBe(created[1]);
  });

  it('each new layer joins the loop at the slot it ended up in, whichever loads first', async () => {
    const p = makePlayer() as any;
    const mkFrames = seedSteadyState(p);
    p.run = false;
    p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC + 2 * STRIDE_SEC));
    const created: any[] = [];
    p._createLayer = vi.fn(() => { const l = fakeLayer(`new-${created.length}`); created.push(l); return l; });
    p._setLayerZ = vi.fn();

    const updatePromise = p._updateRadar();
    await vi.advanceTimersByTimeAsync(0);
    await updatePromise;
    expect(p._loadedSlots).toEqual(Array.from({ length: FRAME_COUNT - 2 }, (_, i) => i));

    created[1]._fireLoad(); // the newest arrives first
    expect(p._loadedSlots.at(-1)).toBe(FRAME_COUNT - 1);
    created[0]._fireLoad();
    expect(p._loadedSlots).toEqual(Array.from({ length: FRAME_COUNT }, (_, i) => i));
    expect(p._currentSlot).toBe(FRAME_COUNT - 1);
  });
});

// ── Resume with nothing new (2026-10-10 review, F1) ────────────────────
//
// onVisibilityHidden / onNavPaused stop the loop and relied on _updateRadar
// to restart it, but _updateRadar restarts the loop only when it shifts a
// new frame in. A refresh that found nothing newer (about every other tick)
// left the loop stopped: one frame on screen, toolbar showing "playing".

describe('resume after a refresh that finds nothing new', () => {
  it('onVisibilityVisible restarts the loop before the owed refresh', async () => {
    const p: any = makePlayer();
    const mkFrames = seedSteadyState(p);
    p.run = true;
    p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC));   // nothing newer
    p.onVisibilityHidden();
    p._doRadarUpdate = true;                                           // a tick fired while hidden
    const scheduleNext = vi.spyOn(p, '_scheduleNext');
    p.onVisibilityVisible();
    await vi.advanceTimersByTimeAsync(0);
    expect(p._fetchPaths).toHaveBeenCalledOnce();
    expect(scheduleNext).toHaveBeenCalledWith(p._loopGen);
  });

  it('onNavSettled restarts the loop before the owed refresh', async () => {
    const p: any = makePlayer();
    const mkFrames = seedSteadyState(p);
    p.run = true;
    p._requestedFrameCount = FRAME_COUNT;
    p._fetchPaths = vi.fn().mockResolvedValue(mkFrames(NOW_SEC));
    p.onNavPaused();
    p._doRadarUpdate = true;
    const scheduleNext = vi.spyOn(p, '_scheduleNext');
    await p.onNavSettled(FRAME_COUNT);
    await vi.advanceTimersByTimeAsync(0);
    expect(p._fetchPaths).toHaveBeenCalledOnce();
    expect(scheduleNext).toHaveBeenCalledWith(p._loopGen);
  });
});

// ── Teardown mid-fetch (F13) ───────────────────────────────────────────

describe('_updateRadar after a teardown mid-fetch', () => {
  it('does not re-arm the update chain when the fetch fails for a stale generation', async () => {
    const p: any = makePlayer();
    seedSteadyState(p);
    p._fetchPaths = vi.fn(() => { p._frameGeneration++; return Promise.reject(new Error('aborted by clear()')); });
    const schedule = vi.spyOn(p, '_scheduleUpdate');
    await p._updateRadar();
    expect(schedule).not.toHaveBeenCalled();
  });
});
