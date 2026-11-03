// Frames outside the current crossfade are `visibility: hidden`, not only
// opacity 0: WebKit paints an opacity-0 layer into a device-resolution
// buffer anyway (37.75 MB per frame container on a 3x phone, 2026-10-16),
// but paints nothing for a hidden subtree. Same harness as the fetch
// window tests: Leaflet stubbed, fake frame layers with a container.

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

import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePlayer(config: Partial<WeatherRadarCardConfig> = {}): any {
  const map = {
    on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...config } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  });
}

/** Three loaded frames, containers hidden as _initRadarBody leaves them. */
function withFrames(p: any, n = 3): any[] {
  const els = Array.from({ length: n }, () => ({ style: { opacity: '0', visibility: 'hidden' } as any, offsetHeight: 0 }));
  p._radarImage = els.map((el) => ({ _tilePending: 0, getContainer: () => el, holdTiles: vi.fn(), releaseTiles: vi.fn() }));
  p._loadedSlots = els.map((_, i) => i);
  p._radarPaths = els.map((_, i) => ({ time: 1_000 + i * 600, path: `/f${i}` }));
  p._radarTime = els.map(() => ({ date: '', time: '' }));
  p._segEls = [];
  return els;
}

describe('frame visibility', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('_settleVisibility leaves only the current frame visible', () => {
    const p = makePlayer();
    const els = withFrames(p);
    p._prev1Slot = 1;
    p._settleVisibility();
    expect(els.map((e) => e.style.visibility)).toEqual(['hidden', '', 'hidden']);
    expect(els.map((e) => e.style.opacity)).toEqual(['0', '1', '0']);
  });

  it('with crossfades, the new frame is visible at once and the previous one hides after its fade-out', () => {
    const p = makePlayer({ animated_transitions: true });
    const els = withFrames(p);
    p._prev1Slot = 0;
    els[0].style.opacity = '1';
    els[0].style.visibility = '';
    const { fadeMs, delayMs } = p._crossfadeTiming();
    expect(fadeMs).toBeGreaterThan(0);
    p._showSlot(1);
    expect(els[1].style.visibility).toBe('');
    expect(els[0].style.visibility).toBe('');          // still fading out
    expect(els[2].style.visibility).toBe('hidden');
    vi.advanceTimersByTime(fadeMs + delayMs + 49);
    expect(els[0].style.visibility).toBe('');
    vi.advanceTimersByTime(1);
    expect(els[0].style.visibility).toBe('hidden');
  });

  it('a frame shown again before its fade-out ends cancels the pending hide', () => {
    const p = makePlayer({ animated_transitions: true });
    const els = withFrames(p);
    p._prev1Slot = 0;
    p._showSlot(1);
    p._showSlot(0);                                    // back to frame 0 right away
    vi.advanceTimersByTime(60_000);
    expect(els[0].style.visibility).toBe('');
    expect(els[1].style.visibility).toBe('hidden');
  });

  it('without crossfades, every other frame hides immediately', () => {
    const p = makePlayer({ animated_transitions: false });
    const els = withFrames(p);
    p._prev1Slot = 0;
    els[0].style.visibility = '';
    p._showSlot(2);
    expect(els.map((e) => e.style.visibility)).toEqual(['hidden', 'hidden', '']);
  });

  it('_clearLayers drops pending hide timers', () => {
    const p = makePlayer({ animated_transitions: true });
    const els = withFrames(p);
    p._prev1Slot = 0;
    els[0].style.opacity = '1';
    els[0].style.visibility = '';
    p._showSlot(1);
    expect(p._hideTimers.size).toBe(1);
    p._radarImage.forEach((l: any) => { l.remove = vi.fn(); });
    p._clearCoverageMask = vi.fn();
    p._clearLayers();
    expect(p._hideTimers.size).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(els[0].style.visibility).toBe('');          // nothing fired after teardown
  });
});
