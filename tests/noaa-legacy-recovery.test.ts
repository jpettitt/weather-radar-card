// NOAA's legacy fallback: when opengeo's frame listing can't be fetched, the
// card uses the legacy server's fixed 10-min grid. Once the listing is back,
// the loop must be rebuilt at the configured stride — shifting in new frames
// kept the 10-min ones until they aged out, and a loop that started in
// fallback kept its frame count (reproduced: a 60-min, 2-min-stride loop
// ended up as 7 frames covering 12 minutes).

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

import { RadarPlayer, type RadarFrame } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const CFG: Partial<WeatherRadarCardConfig> = { data_source: 'NOAA', past_minutes: 60, frame_stride_minutes: 2 };

function makePlayer(): any {
  const p = new RadarPlayer({
    map: {
      on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
      getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
      getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
    } as any,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...CFG } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any,
    noaaLimiter: {} as any,
    dwdLimiter: {} as any,
  }) as any;
  p._scheduleUpdate = vi.fn();
  p._stopLoop = vi.fn();
  p._clearLayers = vi.fn();
  p._initRadar = vi.fn(async () => {});
  p._shiftInFrame = vi.fn();
  return p;
}

const NOW = Math.floor(Date.now() / 1000);
const listing = (): RadarFrame[] => [-4, -2, 0].map((m) => ({ time: NOW + m * 60, path: '' }));
const legacyLoop = (): RadarFrame[] => [-40, -30, -20].map((m) => ({ time: NOW + m * 60, path: '', legacy: true }));

describe('NOAA legacy fallback', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('marks the frames it builds when the listing fails', async () => {
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    const p = makePlayer();
    const frames: RadarFrame[] = await p._fetchPaths();
    expect(p._noaaLegacyMode).toBe(true);
    expect(frames.every((f) => f.legacy)).toBe(true);
    expect(frames[1].time - frames[0].time).toBe(600);
  });

  it('rebuilds the loop once the listing is back', async () => {
    const p = makePlayer();
    p._radarPaths = legacyLoop();
    p._fetchPaths = vi.fn(async () => { p._noaaLegacyMode = false; return listing(); });

    await p._updateRadar();
    expect(p._clearLayers).toHaveBeenCalledOnce();
    expect(p._initRadar).toHaveBeenCalledOnce();
    expect(p._shiftInFrame).not.toHaveBeenCalled();
  });

  it('keeps the fallback loop while the listing is still down', async () => {
    const p = makePlayer();
    p._radarPaths = legacyLoop();
    p._fetchPaths = vi.fn(async () => { p._noaaLegacyMode = true; return legacyLoop(); });

    await p._updateRadar();
    expect(p._initRadar).not.toHaveBeenCalled();
  });

  it('never rebuilds a loop that came from the listing, even after a failed update', async () => {
    const p = makePlayer();
    p._radarPaths = listing();
    p._noaaLegacyMode = true; // the previous update's listing fetch failed
    p._fetchPaths = vi.fn(async () => { p._noaaLegacyMode = false; return [...listing(), { time: NOW + 120, path: '' }]; });

    await p._updateRadar();
    expect(p._initRadar).not.toHaveBeenCalled();
    expect(p._shiftInFrame).toHaveBeenCalledOnce();
  });
});
