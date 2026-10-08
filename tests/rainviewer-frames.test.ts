// RainViewer frames are picked by time, not count. Its list (up to 13 frames,
// 10 min apart) can skip a slot — 12 frames with one 20-min gap on
// 2026-10-08 — and taking the last N frames then reached 10 min further back
// than past_minutes.

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

import { RadarPlayer, pickRainViewerFrames, type RadarFrame } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NEWEST = Date.UTC(2026, 9, 8, 19, 50) / 1000;
const at = (minBack: number): RadarFrame => ({ time: NEWEST - minBack * 60, path: `/v2/radar/${minBack}` });
// 120 min of 10-min frames, newest last, with the given slots missing.
const list = (...missing: number[]): RadarFrame[] =>
  [120, 110, 100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0].filter((m) => !missing.includes(m)).map(at);
const minsBack = (frames: RadarFrame[]): number[] => frames.map((f) => (NEWEST - f.time) / 60);

describe('pickRainViewerFrames', () => {
  it('keeps the window to past_minutes when a slot inside it is missing', () => {
    // By count (the last 7) this reached back 70 minutes.
    expect(minsBack(pickRainViewerFrames(list(30), 60, 10))).toEqual([60, 50, 40, 20, 10, 0]);
  });

  it('takes every frame of a full window', () => {
    expect(minsBack(pickRainViewerFrames(list(), 60, 10))).toEqual([60, 50, 40, 30, 20, 10, 0]);
  });

  it('strides by time from the newest frame, not by list position', () => {
    // With 20 missing, position-based thinning picked 0, 10, 30, 50.
    expect(minsBack(pickRainViewerFrames(list(20), 60, 20))).toEqual([60, 40, 0]);
  });

  it('tolerates a few seconds of jitter in frame times', () => {
    const frames = list().map((f, i) => (i === 10 ? { ...f, time: f.time + 7 } : f));
    expect(pickRainViewerFrames(frames, 120, 10)).toHaveLength(13);
  });

  it('returns nothing for an empty list', () => {
    expect(pickRainViewerFrames([], 60, 10)).toEqual([]);
  });

  it("keeps a 20-min loop on its grid when RainViewer adds the frame between", () => {
    const phase = NEWEST; // the grid the loop started on
    const next = [...list().slice(1), { time: NEWEST + 600, path: '/v2/radar/new' }];
    // Anchored on the newest frame this picked NEWEST + 10 min, 10 min after the last frame.
    expect(minsBack(pickRainViewerFrames(next, 60, 20, phase))).toEqual([60, 40, 20, 0]);
  });
});

describe('RainViewer updates', () => {
  function makePlayer(cfg: Partial<WeatherRadarCardConfig>): any {
    const p = new RadarPlayer({
      map: {
        on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
        getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
        getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      } as any,
      shadowRoot: { getElementById: () => null, host: {} } as any,
      getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
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

  it('rebuilds when a gap entering or leaving the window changes the frame count', async () => {
    const p = makePlayer({ data_source: 'RainViewer', past_minutes: 60 });
    p._radarPaths = pickRainViewerFrames(list(30), 60, 10); // 6 frames
    p._listedFrameCount = 6;
    p._fetchPaths = vi.fn(async () => pickRainViewerFrames(list(), 60, 10)); // 7 frames
    await p._updateRadar();
    expect(p._initRadar).toHaveBeenCalledOnce();
    expect(p._shiftInFrame).not.toHaveBeenCalled();
  });

  it('shifts as usual while the count holds', async () => {
    const p = makePlayer({ data_source: 'RainViewer', past_minutes: 60 });
    p._radarPaths = pickRainViewerFrames(list(), 60, 10).slice(0, 7);
    p._listedFrameCount = 7;
    const next = [...list(), { time: NEWEST + 600, path: '/v2/radar/new' }];
    p._fetchPaths = vi.fn(async () => pickRainViewerFrames(next, 60, 10));
    await p._updateRadar();
    expect(p._initRadar).not.toHaveBeenCalled();
    expect(p._shiftInFrame).toHaveBeenCalledOnce();
  });
});
