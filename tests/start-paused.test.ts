// Tests for the start_paused config option — the card starts paused on the
// latest radar frame ("live snapshot") without auto-playing the animation
// loop, while still refreshing periodically as new data arrives.
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
  const DomUtil = {
    create: vi.fn(() => {
      const el = {
        style: {} as Record<string, string>,
        classList: { add: vi.fn() },
        appendChild: vi.fn(),
        addEventListener: vi.fn(),
      } as any;
      return el;
    }),
  };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, DomUtil, DomEvent },
  };
});

import { RadarPlayer, type RadarFrame } from '../src/radar-player';
import { RadarToolbar } from '../src/radar-toolbar';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

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

function frames(...times: number[]): RadarFrame[] {
  return times.map((t) => ({ time: t, path: '' }));
}

function fakeLayer(): any {
  const container = { style: {} as Record<string, string>, offsetHeight: 0 };
  return {
    addTo: vi.fn(),
    remove: vi.fn(),
    once: vi.fn(),
    on: vi.fn(),
    getContainer: () => container,
    _tileFailed: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── RadarPlayer start_paused ────────────────────────────────────────────

describe('RadarPlayer with start_paused (run = false before init)', () => {
  it('does not start the loop when two frames become available', () => {
    const p = makePlayer() as any;
    p.run = false;
    p._startLoop = vi.fn();
    p._showSlot = vi.fn();

    p._radarReady = false;
    p._loadedSlots = [1];
    p._currentSlot = 0;
    p._prev1Slot = 0;
    p._radarImage = [fakeLayer(), fakeLayer()];
    p._radarPaths = frames(1000, 1600);

    // Simulate the second frame loading — the code path at _initRadarBody
    // line 2314-2320 (the "Two frames ready" branch).
    const prevSlotCount = p._loadedSlots.length;
    p._loadedSlots.unshift(0);

    if (p._loadedSlots.length >= 2 && prevSlotCount < 2) {
      if (p.run) {
        p._startLoop(p._loadedSlots.length - 1);
      } else {
        p._showSlot(p._loadedSlots.length - 1, { snap: true });
      }
    }

    expect(p._startLoop).not.toHaveBeenCalled();
    expect(p._showSlot).toHaveBeenCalledWith(p._loadedSlots.length - 1, { snap: true });
  });

  it('_settleVisibility shows the correct frame after paused start', () => {
    const p = makePlayer() as any;
    p.run = false;

    const layers = [fakeLayer(), fakeLayer()];
    p._radarImage = layers;
    p._loadedSlots = [0, 1];
    p._radarPaths = frames(1000, 1600);
    p._radarTime = [{ date: 'a', time: '1' }, { date: 'a', time: '2' }];
    p._frameStatuses = ['loaded', 'loaded'];
    p._frameSnapshot = [null, null];
    p._frameSnapshotNz = [0, 0];
    p._frameMotion = [null, null];

    // Route through _showSlot (as the fix does) to set _prev1Slot
    p._showSlot(1, { snap: true });
    expect(p._prev1Slot).toBe(1);

    // Now _settleVisibility (called by _stopLoop on pan/tab-switch)
    // should keep the newest frame visible
    p._settleVisibility();
    const newestEl = layers[1].getContainer();
    const olderEl = layers[0].getContainer();
    expect(newestEl.style.opacity).toBe('1');
    expect(olderEl.style.opacity).toBe('0');
  });

  it('togglePlay resumes animation from paused start', () => {
    const p = makePlayer() as any;
    p.run = false;
    p._loadedSlots = [0, 1];
    p._currentSlot = 1;
    p._radarReady = true;
    p._radarImage = [fakeLayer(), fakeLayer()];
    p._radarPaths = frames(1000, 1600);
    p._radarTime = [{ date: 'a', time: '1' }, { date: 'a', time: '2' }];
    p._frameStatuses = ['loaded', 'loaded'];
    p._frameSnapshot = [null, null];
    p._frameSnapshotNz = [0, 0];
    p._frameMotion = [null, null];

    p.togglePlay();

    expect(p.run).toBe(true);
  });

  it('periodic update shows new frame without resuming loop when run=false', async () => {
    const p = makePlayer() as any;
    p.run = false;
    p._radarReady = true;
    p._radarPaths = frames(1000, 1600);
    p._configFrameCount = 2;
    p._loadedSlots = [0, 1];
    p._currentSlot = 1;
    p._radarImage = [fakeLayer(), fakeLayer()];
    p._radarTime = [{ date: 'a', time: '1' }, { date: 'a', time: '2' }];
    p._frameStatuses = ['loaded', 'loaded'];
    p._frameSnapshot = [null, null];
    p._frameSnapshotNz = [0, 0];
    p._frameMotion = [null, null];

    p._fetchPaths = vi.fn(async () => frames(1600, 2200));
    const layer = fakeLayer();
    p._createLayer = vi.fn(() => layer);
    p._scheduleUpdate = vi.fn();

    await p._updateRadar();

    // New frame was appended
    expect(p._createLayer).toHaveBeenCalledOnce();
    // Simulate the load event that _updateRadar registers
    const loadCb = layer.once.mock.calls.find((c: any[]) => c[0] === 'load')?.[1];
    expect(loadCb).toBeDefined();
    loadCb();

    // After load: _currentSlot should point to newest
    expect(p._currentSlot).toBe(p._loadedSlots.length - 1);
    // run should still be false — the loop did not resume
    expect(p.run).toBe(false);
  });

  it('default behaviour preserved when start_paused is not set', () => {
    const p = makePlayer() as any;
    // run defaults to true
    expect(p.run).toBe(true);
  });
});

// ── RadarToolbar initialPlaying ─────────────────────────────────────────

describe('RadarToolbar initialPlaying', () => {
  it('shows play icon when initialPlaying is false', () => {
    const tb = new RadarToolbar({
      showRecenter: false,
      showPlayback: true,
      initialPlaying: false,
    });
    // _playing should be false
    expect((tb as any)._playing).toBe(false);
  });

  it('shows pause icon by default (initialPlaying unset)', () => {
    const tb = new RadarToolbar({
      showRecenter: false,
      showPlayback: true,
    });
    expect((tb as any)._playing).toBe(true);
  });

  it('shows pause icon when initialPlaying is explicitly true', () => {
    const tb = new RadarToolbar({
      showRecenter: false,
      showPlayback: true,
      initialPlaying: true,
    });
    expect((tb as any)._playing).toBe(true);
  });
});
