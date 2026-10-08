// A loop's frame grid is fixed when it starts (stride-phase.ts). Anchoring
// on the newest frame at every refresh let a 10-min NOAA loop, refreshed
// every 5 min, take each newest scan as a new frame and play at 5 minutes.

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

import { gridPhase, recallStridePhase, rememberStridePhase } from '../src/stride-phase';
import { RadarPlayer } from '../src/radar-player';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

const T0 = Date.UTC(2026, 9, 8, 20, 0) / 1000;
const MIN = 60_000;

describe('stride phase memory', () => {
  beforeEach(() => localStorage.clear());

  it('gridPhase is the offset past a multiple of the stride, for times before 1970 too', () => {
    expect(gridPhase(T0 + 183, 600)).toBe(183);
    expect(gridPhase(-17, 600)).toBe(583);
  });

  it('recalls a phase used less than maxAge ago, per source and stride', () => {
    rememberStridePhase('NOAA', 600, 183, 1_000_000);
    expect(recallStridePhase('NOAA', 600, 1_000_000 + 29 * MIN, 30 * MIN)).toBe(183);
    expect(recallStridePhase('NOAA', 600, 1_000_000 + 30 * MIN, 30 * MIN)).toBeNull();
    expect(recallStridePhase('NOAA', 300, 1_000_000, 30 * MIN)).toBeNull();
    expect(recallStridePhase('RainViewer', 600, 1_000_000, 30 * MIN)).toBeNull();
  });

  it("ignores a stored value it can't use", () => {
    localStorage.setItem('weather-radar-card:stride-phase:NOAA:600', '{not json');
    expect(recallStridePhase('NOAA', 600, 0, 30 * MIN)).toBeNull();
    rememberStridePhase('NOAA', 600, 900, 0); // outside the stride
    expect(recallStridePhase('NOAA', 600, 0, 30 * MIN)).toBeNull();
  });
});

describe('stride phase in the player', () => {
  const realFetch = global.fetch;
  let listing: number[];

  // NOAA scans every 2 min, 3 s past the minute, from fromMin to toMin after T0.
  const scans = (fromMin: number, toMin: number): number[] =>
    Array.from({ length: (toMin - fromMin) / 2 + 1 }, (_, i) => T0 + (fromMin + i * 2) * 60 + 3);
  const at = (min: number): void => { vi.setSystemTime((T0 + min * 60 + 90) * 1000); };

  function makePlayer(cfg: Partial<WeatherRadarCardConfig>): any {
    return new RadarPlayer({
      map: {
        on: vi.fn(), off: vi.fn(), getZoom: () => 6, getSize: () => ({ x: 600, y: 400 }),
        getCenter: () => ({ lat: 39.1, lng: -94.58 }),
        getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
        getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
      } as any,
      shadowRoot: { getElementById: () => null, host: {} } as any,
      getConfig: () => ({ type: 'custom:weather-radar-card', past_minutes: 60, ...cfg } as WeatherRadarCardConfig),
      rainviewerLimiter: {} as any,
      noaaLimiter: {} as any,
      dwdLimiter: {} as any,
    }) as any;
  }
  const noaa = (): any => makePlayer({ data_source: 'NOAA', frame_stride_minutes: 10 });
  const newest = async (p: any): Promise<number> => (await p._fetchPaths()).at(-1).time;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('rainviewer')) {
        return new Response(JSON.stringify({ host: 'https://tilecache.rainviewer.com', radar: { past: listing.map((t) => ({ time: t, path: `/v2/radar/${t}` })) } }));
      }
      const times = listing.map((t) => new Date(t * 1000).toISOString()).join(',');
      return new Response(`<Dimension name="time" units="ISO8601">${times}</Dimension>`);
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
  });

  it('a 10-min NOAA loop gains a frame every 10 minutes, not at every 5-min refresh', async () => {
    const p = noaa();
    listing = scans(0, 60); at(60);
    const first = await newest(p);
    expect(first).toBe(T0 + 3603);
    listing = scans(4, 66); at(66);
    expect(await newest(p)).toBe(first);
    listing = scans(10, 70); at(70);
    expect(await newest(p)).toBe(first + 600);
  });

  it('a card started within half its window keeps the grid in use', async () => {
    listing = scans(0, 60); at(60);
    await newest(noaa());
    listing = scans(6, 66); at(66); // a reload 6 min later; its newest scan is 6 min on
    expect(await newest(noaa())).toBe(T0 + 3603);
  });

  it('a card started after half its window anchors on the newest scan', async () => {
    listing = scans(0, 60); at(60);
    await newest(noaa());
    listing = scans(36, 96); at(96); // 36 min later, past half of 60
    expect(await newest(noaa())).toBe(T0 + 96 * 60 + 3);
  });

  it('rebuilding the loop keeps its grid', async () => {
    const p = noaa();
    listing = scans(0, 60); at(60);
    await newest(p);
    p._clearLayers();
    listing = scans(6, 66); at(66);
    expect(await newest(p)).toBe(T0 + 3603);
  });

  it('a 20-min RainViewer loop gains a frame every 20 minutes', async () => {
    const p = makePlayer({ data_source: 'RainViewer', frame_stride_minutes: 20 });
    const rv = (toMin: number): number[] => Array.from({ length: 13 }, (_, i) => T0 + (toMin - 120 + i * 10) * 60);
    listing = rv(60); at(60);
    expect(await newest(p)).toBe(T0 + 3600);
    listing = rv(70); at(70);
    expect(await newest(p)).toBe(T0 + 3600);
    listing = rv(80); at(80);
    expect(await newest(p)).toBe(T0 + 4800);
  });
});
