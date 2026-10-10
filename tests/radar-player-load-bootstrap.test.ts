// Tests for _afterFrameInserted / _markRemainingFailed — the init-loop
// bootstrap logic extracted while fixing issue #246 (radar init loaded the
// farthest-future forecast frame before "now" for forecast-heavy configs).
//
// Frames no longer always load in strict newest-to-oldest order (see
// buildLoadOrder), so a newly-loaded frame can land at any position in
// _loadedSlots, not just the front — these tests exercise the real
// position-aware bootstrap/shift logic directly, rather than hand-copying
// it into the test (the anti-pattern this repo hit in PR #216).
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

import { RadarPlayer, buildLoadOrder, resumeIndexAfterFailure } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePlayer(): RadarPlayer {
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
    getConfig: () => ({ type: 'custom:weather-radar-card' } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

describe('_afterFrameInserted', () => {
  it('does nothing until 2 frames are loaded', () => {
    const p = makePlayer() as any;
    p._startLoop = vi.fn();
    p._loadedSlots = [3];
    p._afterFrameInserted(0);
    expect(p._radarReady).toBe(false);
    expect(p._startLoop).not.toHaveBeenCalled();
  });

  it('starts the loop at "now"\'s position the first time 2 frames are ready', () => {
    const p = makePlayer() as any;
    p._startLoop = vi.fn();
    p._loadedSlots = [2, 3]; // second frame (index 2) just inserted ahead of the first (3)
    p._nowFrameIndex = 3;
    p._afterFrameInserted(0); // insertPos=0; _loadedSlots.length-1 (1) < 2 -> "first time reaching 2" branch
    expect(p._startLoop).toHaveBeenCalledWith(1); // position of nowFrameIndex(3) in [2, 3]
    expect(p._radarReady).toBe(true);
  });

  it('shifts _currentSlot/_prev1Slot when the new frame inserts at or before their position', () => {
    const p = makePlayer() as any;
    p._loadedSlots = [1, 2, 4]; // a frame was just inserted at position 1 (value 2)
    // _currentSlot/_prev1Slot are always equal outside _afterFrameInserted's
    // own execution (_showSlot keeps them in sync) — before this insert,
    // position 1 (value 4) was current.
    p._currentSlot = 1;
    p._prev1Slot = 1;
    p._afterFrameInserted(1); // insertPos=1; _loadedSlots.length-1 (2) >= 2 -> shift branch
    expect(p._currentSlot).toBe(2); // 1 <= 1 -> shifted
    expect(p._prev1Slot).toBe(2);  // 1 <= 1 -> shifted
  });

  it('does not shift _currentSlot/_prev1Slot when the new frame inserts after their position', () => {
    const p = makePlayer() as any;
    p._loadedSlots = [0, 1, 3]; // a frame was just inserted at the tail, position 2 (value 3)
    p._currentSlot = 0;
    p._prev1Slot = 0;
    p._afterFrameInserted(2);
    expect(p._currentSlot).toBe(0);
    expect(p._prev1Slot).toBe(0);
  });
});

describe('_markRemainingFailed', () => {
  it('marks only the not-yet-attempted frames (order[fromIdx..]) as failed', () => {
    const p = makePlayer() as any;
    const order = [2, 3, 4, 1, 0]; // e.g. nowIndex=2 in a 5-frame mixed config
    p._segEls = [0, 1, 2, 3, 4].map(() => ({ style: {} as Record<string, string> }));
    // Raw indices 2 and 3 are order[0]/order[1] — already attempted and
    // loaded before the failure. The rest (4, 1, 0) haven't been attempted.
    p._frameStatuses = ['empty', 'empty', 'loaded', 'loaded', 'empty'];

    p._markRemainingFailed(order, 2); // order[2..] = [4, 1, 0] — everything after the failure

    expect(p._frameStatuses[4]).toBe('failed');
    expect(p._frameStatuses[1]).toBe('failed');
    expect(p._frameStatuses[0]).toBe('failed');
    // Already-attempted frames (order[0], order[1] = 2, 3) are untouched.
    expect(p._frameStatuses[2]).toBe('loaded');
    expect(p._frameStatuses[3]).toBe('loaded');
  });
});

// ── Failure mid-load (2026-10-10 review, F6) ───────────────────────────
//
// The load order is now → past (backward) → forecast (forward). One
// `break` covered both legs, so a past frame beyond the archive boundary
// marked every forecast frame failed without attempting it.

describe('resumeIndexAfterFailure', () => {
  const order = buildLoadOrder(7, 3);   // [3, 2, 1, 0, 4, 5, 6]

  it('a failed past frame skips to the forecast leg', () => {
    expect(resumeIndexAfterFailure(order, 1)).toBe(4);
    expect(resumeIndexAfterFailure(order, 3)).toBe(4);   // the oldest past frame
  });

  it('a failed "now" frame stops the load', () => {
    expect(resumeIndexAfterFailure(order, 0)).toBe(-1);
  });

  it('a failed forecast frame stops the load', () => {
    expect(resumeIndexAfterFailure(order, 4)).toBe(-1);
    expect(resumeIndexAfterFailure(order, 6)).toBe(-1);
  });

  it('with no forecast leg a failed past frame stops the load', () => {
    expect(resumeIndexAfterFailure(buildLoadOrder(4, 3), 1)).toBe(-1);   // [3, 2, 1, 0]
  });
});

describe('_markRemainingFailed with an upper bound', () => {
  it('marks only the skipped past frames, leaving the forecast leg to be attempted', () => {
    const p = makePlayer() as any;
    const order = buildLoadOrder(7, 3);   // [3, 2, 1, 0, 4, 5, 6]
    p._segEls = order.map(() => ({ style: {} as Record<string, string> }));
    p._frameStatuses = ['empty', 'empty', 'empty', 'loaded', 'empty', 'empty', 'empty'];
    p._markRemainingFailed(order, 2, 4);   // frame 2 failed: skip 1 and 0
    expect(p._frameStatuses[1]).toBe('failed');
    expect(p._frameStatuses[0]).toBe('failed');
    expect(p._frameStatuses[4]).toBe('empty');
    expect(p._frameStatuses[6]).toBe('empty');
  });
});

// ── Init that ends with no frames (F3) ─────────────────────────────────
//
// Nothing was armed after a failed listing fetch, an empty listing or a
// load with no frames, and the visibility handler needs _radarReady, so the
// card stayed blank until a pan or a reload.

describe('_scheduleInitRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a failed listing fetch arms a retry that re-runs the init, backing off', async () => {
    const p = makePlayer() as any;
    p._fetchPaths = vi.fn().mockRejectedValue(new Error('offline'));
    await p._initRadar();
    expect(p._fetchPaths).toHaveBeenCalledOnce();
    expect(p._initRetryTimer).not.toBeNull();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(p._fetchPaths).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(p._fetchPaths).toHaveBeenCalledTimes(2);     // after 30 s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(p._fetchPaths).toHaveBeenCalledTimes(3);     // then 60 s
    p.clear();
  });

  it('clear() cancels the retry', async () => {
    const p = makePlayer() as any;
    p._fetchPaths = vi.fn().mockRejectedValue(new Error('offline'));
    await p._initRadar();
    p.clear();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(p._fetchPaths).toHaveBeenCalledOnce();
  });

  it('an empty listing arms the retry too', async () => {
    const p = makePlayer() as any;
    p._fetchPaths = vi.fn().mockResolvedValue([]);
    await p._initRadar();
    expect(p._initRetryTimer).not.toBeNull();
    p.clear();
  });
});
