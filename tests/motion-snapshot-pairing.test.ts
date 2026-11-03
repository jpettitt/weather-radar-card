// Motion-compensation bookkeeping the async LK reply and the snapshot
// capture depend on: the reply must land on the frame pair it measured
// after the frame arrays are renumbered, and a capture must not include the
// slide translate playback leaves on a layer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

import { RadarPlayer, layerTranslate } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GRID = 96;
const NOW_SEC = 1_800_000_000;
const STRIDE = 300;
const N = 5;

function makePlayer(): any {
  const map = {
    on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: GRID, y: GRID }),
    getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', motion_compensation: true } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any, noaaLimiter: {} as any, dwdLimiter: {} as any,
  });
}

function fakeLayer(): any {
  return {
    addTo: vi.fn(), remove: vi.fn(), once: vi.fn(), off: vi.fn(), on: vi.fn(),
    getContainer: () => ({ style: {}, offsetHeight: 0 }), _tileFailed: 0,
  };
}

// Frame i has 1000 + 100·i rain pixels of value i + 1, except that frame 1
// is an exact copy of frame 0 (a source duplicate).
function snapshots(): Float32Array[] {
  const out = Array.from({ length: N }, (_, i) => {
    const s = new Float32Array(GRID * GRID);
    s.fill(i + 1, 0, 1000 + 100 * i);
    return s;
  });
  out[1] = new Float32Array(out[0]);
  return out;
}

function seed(p: any, motion: any[]): (endSec: number) => { time: number; path: string }[] {
  const frames = (end: number): { time: number; path: string }[] =>
    Array.from({ length: N }, (_, i) => ({ time: end + (i - (N - 1)) * STRIDE, path: '' }));
  const snaps = snapshots();
  p._radarPaths = frames(NOW_SEC);
  p._radarImage = Array.from({ length: N }, () => fakeLayer());
  p._radarTime = Array.from({ length: N }, () => ({ date: 'd', time: 't' }));
  p._frameStatuses = Array.from({ length: N }, () => 'loaded');
  p._loadedSlots = Array.from({ length: N }, (_, i) => i);
  p._configFrameCount = N;
  p._radarReady = true;
  p._currentSlot = N - 1;
  p._prev1Slot = N - 1;
  p._frameSnapshot = snaps;
  p._frameSnapshotNz = snaps.map((s) => s.reduce((n, v) => n + (v > 0 ? 1 : 0), 0));
  p._frameMotion = motion.slice();
  // DOM-only progress-bar helpers.
  p._buildSegments = vi.fn(); p._setSegment = vi.fn(); p._applyNowMarker = vi.fn();
  p._highlightSegment = vi.fn(); p._paintSegment = vi.fn(); p._computeNowFrameIndex = vi.fn();
  p._setLayerZ = vi.fn();
  return frames;
}

// A worker client whose replies the test releases, like a worker answering
// a few ms after the post.
function deferredClient(): any {
  const pending: ((r: unknown) => void)[] = [];
  return {
    pending,
    failed: false,
    estimate: vi.fn(() => new Promise((resolve) => { pending.push(resolve); })),
    dispose: vi.fn(),
  };
}

const reply = (dx: number): unknown => ({ dx, dy: 0, confidence: 100, magnitude: Math.abs(dx), angleDeg: 0, perLevel: [] });
const flush = async (): Promise<void> => { for (let k = 0; k < 10; k++) await Promise.resolve(); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_SEC * 1000);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('LK reply after the frame arrays are renumbered', () => {
  it('_dedupFrames: a reply for a pair that dedup removed is dropped', async () => {
    const p = makePlayer();
    const real = { dx: 10, dy: 0, confidence: 100 };
    seed(p, [null, { dx: 0, dy: 0, confidence: 100 }, real, real, real]);
    const client = deferredClient();
    p._lkClient = client;
    p._lkWorkerInitTried = true;
    // In flight for old pair (0, 1) when init's dedup runs.
    p._computeMotionForFrame(1);
    expect(client.estimate).toHaveBeenCalledTimes(1);
    p._dedupFrames();
    expect(p._radarImage).toHaveLength(N - 1);
    expect(p._frameMotion[1]).toEqual(real);
    client.pending[0](reply(0.01));
    await flush();
    expect(p._frameMotion[1]).toEqual(real);
  });

  it('_dedupFrames: a reply for a pair that survived lands on its new index', async () => {
    const p = makePlayer();
    seed(p, [null, null, null, null, null]);
    const client = deferredClient();
    p._lkClient = client;
    p._lkWorkerInitTried = true;
    p._computeMotionForFrame(4);           // pair (3, 4) becomes (2, 3)
    p._dedupFrames();
    expect(p._radarImage).toHaveLength(N - 1);
    client.pending[0](reply(7));
    await flush();
    expect(p._frameMotion[3]).toMatchObject({ dx: 7 });
  });

  it('_updateRadar shift: the reply lands on the shifted pair, not on the new frame', async () => {
    const p = makePlayer();
    const frames = seed(p, [null, null, null, null, null]);
    p.run = false;
    const client = deferredClient();
    p._lkClient = client;
    p._lkWorkerInitTried = true;
    p._computeMotionForFrame(N - 1);       // pair (3, 4) in flight
    p._fetchPaths = vi.fn().mockResolvedValue(frames(NOW_SEC + STRIDE));
    p._createLayer = vi.fn(() => fakeLayer());
    p._scheduleUpdate = vi.fn();
    await p._updateRadar();
    expect(p._frameSnapshot[N - 1]).toBeNull();
    client.pending[0](reply(7));
    await flush();
    expect(p._frameMotion[N - 1]).toBeNull();
    expect(p._frameMotion[N - 2]).toMatchObject({ dx: 7 });
  });
});

describe('snapshot of a layer left at a slide translate', () => {
  it('layerTranslate reads the translate of the computed transform', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    expect(layerTranslate(el)).toEqual({ x: 0, y: 0 });
    el.style.transform = 'translate(30px, -20px)';
    expect(layerTranslate(el)).toEqual({ x: 30, y: -20 });
    el.remove();
  });

  it('draws each tile where the frame data is, without the layer translate', async () => {
    const p = makePlayer();
    const container = document.createElement('div');
    document.body.appendChild(container);
    // Playback left this layer at the end of its outgoing slide.
    container.style.transform = 'translate(30px, -20px)';
    const tile = document.createElement('img');
    tile.className = 'leaflet-tile';
    container.appendChild(tile);
    Object.defineProperty(tile, 'complete', { value: true });
    Object.defineProperty(tile, 'naturalWidth', { value: 256 });
    // The tile sits at (10, 12) in the layer; its rect includes the
    // translate, as Chrome's getBoundingClientRect does (probed 2026-10-26).
    tile.getBoundingClientRect = () => ({ left: 10 + 30, top: 12 - 20, width: 256, height: 256 }) as DOMRect;
    const drawImage = vi.fn();
    const realCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return realCreate(tag);
      return {
        width: 0, height: 0,
        getContext: () => ({
          drawImage,
          getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
        }),
      };
    }) as typeof document.createElement);
    p._radarImage = [{ getContainer: () => container }];
    p._frameSnapshot = [null];
    p._frameSnapshotNz = [0];
    await p._captureFrameSnapshot(0);
    expect(drawImage).toHaveBeenCalledTimes(1);
    const [, sx, sy] = drawImage.mock.calls[0];
    expect([sx, sy]).toEqual([10, 12]);
    container.remove();
  });
});

describe('LK vector plausibility', () => {
  // The snapshots are GRID px square: a shift of GRID or more on an axis
  // leaves no overlap, so no real motion is that large.
  const replyXY = (dx: number, dy: number): unknown => ({ dx, dy, confidence: 100, magnitude: Math.hypot(dx, dy), angleDeg: 0, perLevel: [] });

  it.each([
    [GRID, 0], [-GRID, 0], [0, GRID], [0, -GRID], [194, 30], [NaN, 0], [0, Infinity],
  ])('drops a confident (%s, %s) grid-px vector', async (dx, dy) => {
    const p = makePlayer();
    seed(p, [null, null, null, null, null]);
    const client = deferredClient();
    p._lkClient = client;
    p._lkWorkerInitTried = true;
    p._computeMotionForFrame(4);
    client.pending[0](replyXY(dx, dy));
    await flush();
    expect(p._frameMotion[4]).toBeNull();
  });

  it('keeps a confident vector just inside the grid', async () => {
    const p = makePlayer();
    seed(p, [null, null, null, null, null]);
    const client = deferredClient();
    p._lkClient = client;
    p._lkWorkerInitTried = true;
    p._computeMotionForFrame(4);
    client.pending[0](replyXY(GRID - 1, -(GRID - 1)));
    await flush();
    expect(p._frameMotion[4]).toMatchObject({ dx: GRID - 1, dy: -(GRID - 1) });
  });
});
