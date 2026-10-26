// RainViewer's list holds 13 frames over 120 min and rolls by one frame each
// 10 min. At past_minutes 120 with a stride over 10 min, the window's oldest
// slot is in the list only on every other publication, so the picked count
// alternates (stride 20: 7/6). That is not a gap and must not rebuild the
// loop; a slot missing inside the list still must.

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

import { RadarPlayer, pickRainViewerFrames, rainViewerNeedsRebuild, type RadarFrame } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

// On a 20- and a 30-min grid.
const T0 = 1_800_000_000 - (1_800_000_000 % 3600);

// The list RainViewer publishes with newest frame `newest`: 13 frames, 10 min
// apart, minus any `skip` times.
function list(newest: number, skip: number[] = []): { time: number; path: string }[] {
  const out: { time: number; path: string }[] = [];
  for (let i = 12; i >= 0; i--) {
    const time = newest - i * 600;
    if (!skip.includes(time)) out.push({ time, path: `/v2/radar/${time}` });
  }
  return out;
}

function makePlayer(cfg: Partial<WeatherRadarCardConfig>): any {
  const map = {
    on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
    getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', data_source: 'RainViewer', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any, noaaLimiter: {} as any, dwdLimiter: {} as any,
  });
}

describe('rainViewerNeedsRebuild', () => {
  // Rolls the list through `pubs` publications from a loop picked at T0 and
  // returns the publications that would rebuild it.
  function rebuilds(strideMin: number, pubs: number, skip: number[] = []): number[] {
    const phase = T0;
    const held = pickRainViewerFrames(list(T0, skip), 120, strideMin, phase).length;
    const out: number[] = [];
    for (let k = 1; k <= pubs; k++) {
      const l = list(T0 + k * 600, skip);
      const picked = pickRainViewerFrames(l, 120, strideMin, phase);
      if (rainViewerNeedsRebuild(held, picked, l[0].time, 120, strideMin)) out.push(k);
    }
    return out;
  }

  it('stride 20 or 30 at past 120: the rolling list rebuilds nothing', () => {
    expect(rebuilds(20, 12)).toEqual([]);
    expect(rebuilds(30, 12)).toEqual([]);
  });

  it('stride 10: a slot missing inside the list rebuilds, a late newest frame does not', () => {
    // T0 + 30 min is never published. While it would be the newest (k = 3)
    // nothing is new yet; from k = 4 the list has a gap the loop can't follow.
    expect(rebuilds(10, 4, [T0 + 1800])).toEqual([4]);
  });

  it('a list that reaches a slot the loop has no frame for rebuilds', () => {
    // Loop built from a 6-frame pick; the next list picks 7.
    const l = list(T0 + 1200);
    const picked = pickRainViewerFrames(l, 120, 20, T0);
    expect(picked).toHaveLength(7);
    expect(rainViewerNeedsRebuild(6, picked, l[0].time, 120, 20)).toBe(true);
  });

  it('an unchanged count never rebuilds', () => {
    const l = list(T0);
    expect(rainViewerNeedsRebuild(13, pickRainViewerFrames(l, 120, 10, T0), l[0].time, 120, 10)).toBe(false);
  });
});

describe('RainViewer update at past 120, stride 20', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* storage blocked */ } });
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  it('a normal publication does not tear the loop down', async () => {
    vi.useFakeTimers();
    vi.setSystemTime((T0 + 60) * 1000);
    let json: unknown = { host: 'https://tilecache.rainviewer.com', radar: { past: list(T0) } };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => json })));
    const p = makePlayer({ past_minutes: 120, frame_stride_minutes: 20 });
    const initFrames: RadarFrame[] = await p._fetchPaths();   // real listing, fixes the phase
    p._radarPaths = initFrames;
    p._listedFrameCount = initFrames.length;
    p._configFrameCount = initFrames.length;
    p._radarReady = true;
    p._scheduleUpdate = vi.fn();
    p._clearLayers = vi.fn();
    p._initRadar = vi.fn(async () => {});

    vi.setSystemTime((T0 + 660) * 1000);
    json = { host: 'https://tilecache.rainviewer.com', radar: { past: list(T0 + 600) } };
    await p._updateRadar();
    expect({ init: initFrames.length, held: p._radarPaths.length }).toEqual({ init: 7, held: 7 });
    expect(p._initRadar).not.toHaveBeenCalled();
    expect(p._scheduleUpdate).toHaveBeenCalled();
  });
});
