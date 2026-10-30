// Frame visibility and lifetime across init, dedup and the periodic shift
// (pre-4.0 review). "Stub Leaflet, test the helpers": the real RadarPlayer
// runs; only Leaflet, the tile layers, tile settling and the canvas
// snapshot (the pixel edge) are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ settle: new Map<unknown, (s: 'loaded' | 'failed') => void>() }));

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
// Tile settling is the network edge: each test settles each layer by hand.
vi.mock('../src/fetch-tile-layer', async (orig) => {
  const real = await orig<typeof import('../src/fetch-tile-layer')>();
  return { ...real, layerSettled: (layer: unknown) => new Promise((resolve) => { h.settle.set(layer, resolve); }) };
});

import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const GRID = 96 * 96;

function makePlayer(config: Partial<WeatherRadarCardConfig> = {}): any {
  const map = {
    on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(() => ({ style: {} })), createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    getCenter: () => ({ lat: 0, lng: 0 }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...config } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any, noaaLimiter: {} as any, dwdLimiter: {} as any,
  });
}

// A fresh Leaflet layer: its container has no inline style (CSS: visible, opacity 1).
function fakeLayer(): any {
  const el = { style: {} as Record<string, string>, offsetHeight: 0 };
  const listeners: Record<string, (() => void)[]> = {};
  const l: any = {
    el, removed: false, _tilePending: 0, _tileFailed: 0,
    addTo: vi.fn(), remove: vi.fn(() => { l.removed = true; }), on: vi.fn(), off: vi.fn(),
    once: vi.fn((ev: string, cb: () => void) => { (listeners[ev] ??= []).push(cb); }),
    getContainer: () => el, holdTiles: vi.fn(), releaseTiles: vi.fn(),
    fireLoad: () => listeners.load?.forEach((cb) => cb()),
  };
  return l;
}

function trackLayers(p: any): any[] {
  const made: any[] = [];
  p._createLayer = () => { const l = fakeLayer(); made.push(l); return l; };
  return made;
}

const onScreen = (l: any): boolean =>
  !l.removed && l.el.style.opacity !== '0' && l.el.style.visibility !== 'hidden';

const flush = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

// Frames `stepSec` apart, the newest at wall-clock now (load order: newest first).
function listing(n: number, stepSec = 600): { time: number; path: string }[] {
  const now = Date.now() / 1000;
  return Array.from({ length: n }, (_, i) => ({ time: now - (n - 1 - i) * stepSec, path: `/f${i}` }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-26T12:00:00Z'));
  h.settle.clear();
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('init preview', () => {
  it('the first loaded frame is on screen while the rest load', async () => {
    const p = makePlayer();
    const layers = trackLayers(p);
    p._fetchPaths = vi.fn().mockResolvedValue(listing(3));
    void p._initRadar();
    await flush();
    h.settle.get(layers[0])!('loaded');
    await flush();
    expect(layers.filter(onScreen)).toEqual([layers[0]]);
    p.clear();
  });

  it('a single-frame loop (past_minutes: 0) shows its frame', async () => {
    const p = makePlayer({ past_minutes: 0 });
    const layers = trackLayers(p);
    p._fetchPaths = vi.fn().mockResolvedValue(listing(1));
    const done = p._initRadar();
    await flush();
    h.settle.get(layers[0])!('loaded');
    await done;
    expect(p._loadedSlots).toEqual([0]);
    expect(layers.filter(onScreen)).toEqual([layers[0]]);
    p.clear();
  });
});

describe('a frame that fails during init', () => {
  it('is taken off the map, so a pan cannot fetch its tiles', async () => {
    const p = makePlayer();
    const layers = trackLayers(p);
    p._fetchPaths = vi.fn().mockResolvedValue(listing(4));
    const done = p._initRadar();
    // Load order 3 (now), 2, 1, 0: frame 2 fails, which ends the past leg.
    await flush(); h.settle.get(layers[0])!('loaded');
    await flush(); h.settle.get(layers[1])!('failed');
    await done;
    expect(layers[1].removed).toBe(true);
    // Every layer still tracked belongs to a frame in the loop.
    p._radarImage.forEach((l: any, fi: number) => { if (l) expect(p._loadedSlots).toContain(fi); });
    for (const l of layers) l._tilePending = 4;     // a pan: new tiles for every layer
    p._applyFetchWindow();
    expect(layers[1].releaseTiles).not.toHaveBeenCalled();
    p.clear();
  });

  it('leaves a slot that a forecast refresh replacement can still fill', () => {
    const p = makePlayer();
    const kept = fakeLayer();
    kept.el.style.opacity = '1';
    p._radarImage = [kept, undefined];
    p._radarPaths = listing(2);
    p._radarTime = [{ date: '', time: '' }, { date: '', time: '' }];
    p._loadedSlots = [0];
    p._prev1Slot = 0;
    p._frameSnapshot = [null, null];
    p._frameSnapshotNz = [0, 0];
    p._frameMotion = [null, null];
    const replacement = fakeLayer();
    p._stagedForecast.set(p._radarPaths[1].time, { frame: p._radarPaths[1], layer: replacement });
    p._swapStagedFrames(0, false);
    expect(p._radarImage[1]).toBe(replacement);
    expect(p._loadedSlots).toEqual([0, 1]);
    p.clear();
  });
});

describe('dedup at the end of init', () => {
  // Frames 1 and 2 carry the same pixels (legacy NOAA snapping); frame 2 is
  // "now", the frame on screen, and the one the dedup drops.
  async function initWithDuplicateOnScreen(run: boolean, nzs: number[], same: boolean[]): Promise<{ p: any; layers: any[] }> {
    const p = makePlayer({ motion_compensation: true });
    p.run = run;
    const layers = trackLayers(p);
    const base = new Float32Array(GRID).fill(0.5);
    p._captureFrameSnapshot = async (fi: number) => {
      const snap = same[fi] ? base : new Float32Array(GRID).fill(0.1 * (fi + 1));
      p._frameSnapshot[fi] = snap;
      p._frameSnapshotNz[fi] = nzs[fi];
    };
    p._computeMotionForFrame = vi.fn();   // the LK worker edge
    p._fetchPaths = vi.fn().mockResolvedValue(listing(nzs.length));
    const done = p._initRadar();
    for (let k = 0; k < nzs.length; k++) { await flush(); h.settle.get(layers[k])!('loaded'); }
    await done;
    return { p, layers };
  }

  it('a paused card still shows the frame it remapped to', async () => {
    const { p, layers } = await initWithDuplicateOnScreen(false, [1000, 2000, 2000], [false, true, true]);
    expect(p._loadedSlots.length).toBe(2);
    const shown = layers.filter(onScreen);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBe(p._radarImage[p._loadedSlots[p._currentSlot]]);
    p.clear();
  });

  it('a running loop that collapses to one frame still shows it', async () => {
    const { p, layers } = await initWithDuplicateOnScreen(true, [2000, 2000], [true, true]);
    expect(p._loadedSlots.length).toBe(1);
    const shown = layers.filter(onScreen);
    expect(shown).toHaveLength(1);
    expect(shown[0]).toBe(p._radarImage[0]);
    p.clear();
  });
});

describe('_dedupFrames duplicate test', () => {
  function seed(p: any, snaps: Float32Array[]): void {
    const n = snaps.length;
    p._radarImage = snaps.map(() => fakeLayer());
    p._radarPaths = listing(n, 300);
    p._radarTime = snaps.map(() => ({ date: '', time: '' }));
    p._loadedSlots = snaps.map((_, i) => i);
    p._configFrameCount = n;
    p._currentSlot = n - 1;
    p._prev1Slot = n - 1;
    p._frameSnapshot = snaps;
    p._frameSnapshotNz = snaps.map((s) => s.filter((v) => v !== 0).length);
    p._frameMotion = snaps.map(() => null);
  }

  it('keeps distinct frames whose snapshots rain fills completely', () => {
    for (let trial = 0; trial < 20; trial++) {
      const p = makePlayer();
      // Every pixel non-zero, so every frame has nz = GRID; the contents differ.
      seed(p, Array.from({ length: 5 }, () => Float32Array.from({ length: GRID }, () => 1 + Math.random() * 254)));
      p._dedupFrames();
      expect(p._loadedSlots).toHaveLength(5);
      p.clear();
    }
  });

  it('still drops a run of identical frames, full coverage or not', () => {
    for (const fill of [GRID, GRID / 3]) {
      const p = makePlayer();
      const a = Float32Array.from({ length: GRID }, (_, i) => (i < fill ? 1 + (i % 200) : 0));
      const b = Float32Array.from({ length: GRID }, (_, i) => (i < fill ? 2 + (i % 150) : 0));
      seed(p, [a, a.slice(), a.slice(), b]);
      p._dedupFrames();
      expect(p._loadedSlots).toHaveLength(2);
      p.clear();
    }
  });
});

describe('periodic shift-in (_shiftInFrame)', () => {
  // A stopped loop of n loaded frames with `shown` on screen, as _updateRadar
  // leaves it right before the shift.
  function stoppedLoop(p: any, n: number, shown: number): any[] {
    const layers = Array.from({ length: n }, () => fakeLayer());
    p._radarImage = layers.slice();
    p._loadedSlots = layers.map((_, i) => i);
    p._radarPaths = listing(n);
    p._radarTime = layers.map(() => ({ date: '', time: '' }));
    p._frameStatuses = layers.map(() => 'loaded');
    p._frameSnapshot = layers.map(() => null);
    p._frameSnapshotNz = layers.map(() => 0);
    p._frameMotion = layers.map(() => null);
    p._configFrameCount = n;
    p._radarReady = true;
    p._currentSlot = shown;
    p._prev1Slot = shown;
    p._stopLoop();
    return layers;
  }
  const next = (p: any) => ({ time: p._radarPaths[p._radarPaths.length - 1].time + 600, path: '/new' });

  it('shows exactly one loaded frame until the new one loads, whichever frame was on screen', () => {
    for (let shown = 0; shown < 4; shown++) {
      const p = makePlayer();
      p.run = false;
      const layers = stoppedLoop(p, 4, shown);
      const incoming = fakeLayer();
      p._createLayer = () => incoming;
      p._shiftInFrame(next(p), p._frameGeneration);
      const visible = [...layers, incoming].filter(onScreen);
      expect(visible).toHaveLength(1);
      expect(visible[0]).not.toBe(incoming);
      expect(p._radarImage[p._loadedSlots[p._prev1Slot]]).toBe(visible[0]);
      p.clear();
    }
  });

  it('a new frame that fails is taken off the map and never shows under the loop', () => {
    const p = makePlayer();
    const layers = stoppedLoop(p, 4, 1);
    const incoming = fakeLayer();
    p._createLayer = () => incoming;
    p._shiftInFrame(next(p), p._frameGeneration);
    incoming._tileFailed = 1;
    incoming.fireLoad();
    expect(incoming.removed).toBe(true);
    expect(p._radarImage).not.toContain(incoming);
    for (let k = 0; k < 6; k++) p._showSlot(k % p._loadedSlots.length);
    p._stopLoop();
    expect(onScreen(incoming)).toBe(false);
    expect(layers.filter(onScreen)).toHaveLength(1);
    p.clear();
  });

  it('a single-frame loop lets the new frame fill in rather than go blank', () => {
    const p = makePlayer({ past_minutes: 0 });
    const [only] = stoppedLoop(p, 1, 0);
    const incoming = fakeLayer();
    p._createLayer = () => incoming;
    p._shiftInFrame(next(p), p._frameGeneration);
    expect(only.removed).toBe(true);
    expect(onScreen(incoming)).toBe(true);
    p.clear();
  });
});
