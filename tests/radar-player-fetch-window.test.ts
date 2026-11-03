// The frame fetch window: after a view change at most FRAME_FETCH_WINDOW
// frames fetch tiles at a time, in playback order from the shown frame, and
// the progress bar shows a frame as loading while its tiles are outstanding.
// Follows the "stub Leaflet, test the helpers" convention.

import { describe, it, expect, vi } from 'vitest';

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

import { RadarPlayer, FRAME_FETCH_WINDOW, fetchWindowOrder, planFetchWindow } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePlayer(config: Partial<WeatherRadarCardConfig> = {}): any {
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
    getConfig: () => ({ type: 'custom:weather-radar-card', ...config } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

function fakeLayer(pending: number): any {
  return { _tilePending: pending, holdTiles: vi.fn(), releaseTiles: vi.fn() };
}

describe('fetchWindowOrder', () => {
  it('walks the loaded slots from the shown one, wrapping, then frames not loaded yet', () => {
    expect(fetchWindowOrder([2, 3, 4, 5], 2, 6)).toEqual([4, 5, 2, 3, 0, 1]);
  });

  it('with nothing loaded yet, the frames come in index order', () => {
    expect(fetchWindowOrder([], 0, 3)).toEqual([0, 1, 2]);
  });

  it('tolerates a slot index past the end', () => {
    expect(fetchWindowOrder([0, 1, 2], 5, 3)).toEqual([2, 0, 1]);
  });
});

describe('planFetchWindow', () => {
  it('releases the first `limit` frames with tiles outstanding, in order', () => {
    const pending: Record<number, number> = { 4: 0, 5: 2, 2: 1, 3: 0, 0: 3, 1: 1 };
    const released = planFetchWindow([4, 5, 2, 3, 0, 1], (fi) => pending[fi], 3);
    expect([...released]).toEqual([5, 2, 0]);
  });

  it('releases nothing when no frame has tiles outstanding', () => {
    expect(planFetchWindow([0, 1, 2], () => 0, 3).size).toBe(0);
  });
});

describe('RadarPlayer fetch window', () => {
  it(`releases ${FRAME_FETCH_WINDOW} frames from the shown slot and holds the rest`, () => {
    const p = makePlayer();
    p._radarImage = [0, 1, 2, 3, 4, 5].map(() => fakeLayer(4));
    p._loadedSlots = [0, 1, 2, 3, 4, 5];
    p._currentSlot = 4;
    p._applyFetchWindow();
    const released = p._radarImage.map((l: any) => l.releaseTiles.mock.calls.length > 0);
    expect(released).toEqual([true, false, false, false, true, true]);
    const held = p._radarImage.map((l: any) => l.holdTiles.mock.calls.length > 0);
    expect(held).toEqual([false, true, true, true, false, false]);
  });

  it('skips complete frames so the window runs ahead of playback', () => {
    const p = makePlayer();
    p._radarImage = [fakeLayer(0), fakeLayer(0), fakeLayer(2), fakeLayer(2), fakeLayer(2), fakeLayer(2)];
    p._loadedSlots = [0, 1, 2, 3, 4, 5];
    p._currentSlot = 0;
    p._applyFetchWindow();
    const released = p._radarImage.map((l: any) => l.releaseTiles.mock.calls.length > 0);
    expect(released).toEqual([false, false, true, true, true, false]);
  });

  it('a frame still initialising (not in _loadedSlots) is released after the loaded ones', () => {
    const p = makePlayer();
    p._radarImage = [fakeLayer(1), fakeLayer(1), fakeLayer(1), fakeLayer(1)];
    p._loadedSlots = [1, 2, 3];
    p._currentSlot = 0;
    p._applyFetchWindow();
    const released = p._radarImage.map((l: any) => l.releaseTiles.mock.calls.length > 0);
    expect(released).toEqual([false, true, true, true]);
  });

  it('_queueFetchWindow coalesces a burst into one plan and one bar repaint on the next microtask', async () => {
    const p = makePlayer();
    const apply = vi.spyOn(p, '_applyFetchWindow');
    const repaint = vi.spyOn(p, '_repaintSegments');
    p._queueFetchWindow();
    p._queueFetchWindow();
    p._queueFetchWindow();
    expect(apply).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(repaint).toHaveBeenCalledTimes(1);
    p._queueFetchWindow();
    await Promise.resolve();
    expect(apply).toHaveBeenCalledTimes(2);
  });

  it('the queued repaint paints every segment from the current tile counts', async () => {
    const p = makePlayer();
    p._segEls = [{ style: {} }, { style: {} }];
    p._frameStatuses = ['loaded', 'loaded'];
    p._radarImage = [{ _tilePending: 0 }, { _tilePending: 4 }];
    p._loadedSlots = [0, 1];
    p._queueFetchWindow();
    await Promise.resolve();
    expect(p._segEls[0].style.backgroundColor).toBe(p._segColor('loaded', false));
    expect(p._segEls[1].style.backgroundColor).toBe(p._segColor('loading', false));
  });

  it('ignores layers without hold/release (test fakes, foreign layers)', () => {
    const p = makePlayer();
    p._radarImage = [{ _tilePending: 1 }, undefined, { _tilePending: 1 }];
    p._loadedSlots = [0, 2];
    p._currentSlot = 0;
    expect(() => p._applyFetchWindow()).not.toThrow();
  });
});

describe('progress bar shows outstanding tiles', () => {
  function withSegments(p: any, statuses: string[], pending: number[]): any[] {
    p._segEls = statuses.map(() => ({ style: {} }));
    p._frameStatuses = statuses;
    p._radarImage = pending.map((n) => ({ _tilePending: n }));
    return p._segEls;
  }

  it('a loaded frame with tiles outstanding is painted as loading', () => {
    const p = makePlayer();
    const segs = withSegments(p, ['loaded', 'loaded'], [0, 3]);
    p._paintSegment(0, false);
    p._paintSegment(1, false);
    expect(segs[0].style.backgroundColor).toBe(p._segColor('loaded', false));
    expect(segs[1].style.backgroundColor).toBe(p._segColor('loading', false));
  });

  it('the current frame keeps its highlight while loading', () => {
    const p = makePlayer();
    const segs = withSegments(p, ['loaded'], [2]);
    p._paintSegment(0, true);
    expect(segs[0].style.backgroundColor).toBe(p._segColor('loading', true));
  });

  it('a failed or empty frame is painted as such regardless of tile counts', () => {
    const p = makePlayer();
    const segs = withSegments(p, ['failed', 'empty'], [1, 1]);
    p._paintSegment(0, false);
    p._paintSegment(1, false);
    expect(segs[0].style.backgroundColor).toBe(p._segColor('failed', false));
    expect(segs[1].style.backgroundColor).toBe(p._segColor('empty', false));
  });

  it('_repaintSegmentFor finds the layer\'s frame and repaints it', () => {
    const p = makePlayer();
    const segs = withSegments(p, ['loaded', 'loaded'], [0, 0]);
    p._radarImage[1]._tilePending = 1;
    p._repaintSegmentFor(p._radarImage[1]);
    expect(segs[1].style.backgroundColor).toBe(p._segColor('loading', false));
    expect(segs[0].style.backgroundColor).toBeUndefined();
  });
});
