// Frame listings (NOAA GetCapabilities, RainViewer weather-maps.json) gate
// init and the update chain. A request the server accepts and never answers
// must give up, like the DWD run list does, or the map stays blank and stops
// refreshing.

import { describe, it, expect, vi, afterEach } from 'vitest';

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
import { fetchNoaaFrameTimes } from '../src/noaa-frame-list';
import { LISTING_TIMEOUT_MS, withTimeout } from '../src/fetch-timeout';
import type { WeatherRadarCardConfig } from '../src/types';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makePlayer(cfg: Partial<WeatherRadarCardConfig>): any {
  const map = {
    on: vi.fn(), off: vi.fn(), getZoom: () => 7, getSize: () => ({ x: 600, y: 400 }),
    getCenter: () => ({ lat: 40, lng: -95 }),
    getPane: vi.fn(), createPane: vi.fn(() => ({ style: {} })),
    getContainer: () => ({ getBoundingClientRect: () => ({ left: 0, top: 0 }) }),
  } as any;
  return new RadarPlayer({
    map,
    shadowRoot: { getElementById: () => null, host: {} } as any,
    getConfig: () => ({ type: 'custom:weather-radar-card', ...cfg } as WeatherRadarCardConfig),
    rainviewerLimiter: {} as any, noaaLimiter: {} as any, dwdLimiter: {} as any,
  });
}

// A request that is accepted and never answered; it only ends on abort.
const stalledFetch = (): any => vi.fn((_url: string, init?: RequestInit) => new Promise((_res, rej) => {
  init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
}));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('withTimeout', () => {
  it('rejects with a TimeoutError at the limit, even when the request ignores the abort', async () => {
    vi.useFakeTimers();
    let seen: AbortSignal | undefined;
    const p = withTimeout(1_000, undefined, (signal) => { seen = signal; return new Promise(() => {}); });
    const result = p.then(() => 'resolved', (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(999);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toBe('TimeoutError');
    expect(seen?.aborted).toBe(true);
  });

  it('a request that honours the abort still reports the timeout, not an AbortError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', stalledFetch());
    const result = withTimeout(1_000, undefined, (signal) => fetch('https://x.test', { signal }))
      .then(() => 'resolved', (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe('TimeoutError');
  });

  it("the caller's abort passes through as an AbortError", async () => {
    vi.stubGlobal('fetch', stalledFetch());
    const ctrl = new AbortController();
    const result = withTimeout(10_000, ctrl.signal, (signal) => fetch('https://x.test', { signal }))
      .then(() => 'resolved', (e: Error) => e.name);
    ctrl.abort();
    expect(await result).toBe('AbortError');
  });
});

describe('frame listing request that never answers', () => {
  it('fetchNoaaFrameTimes gives up after the listing limit', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const result = fetchNoaaFrameTimes().then(() => 'resolved', (e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(LISTING_TIMEOUT_MS);
    expect(await result).toBe('TimeoutError');
  });

  it('NOAA falls back to the legacy grid', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const p = makePlayer({ data_source: 'NOAA' });
    const frames = p._fetchPaths();
    await vi.advanceTimersByTimeAsync(LISTING_TIMEOUT_MS);
    const out = await frames;
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((f: any) => f.legacy)).toBe(true);
  });

  it('RainViewer update: the update chain is armed again', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const p = makePlayer({ data_source: 'RainViewer' });
    p._radarReady = true;
    p._radarPaths = [{ time: 1000, path: '' }];
    p._scheduleUpdate = vi.fn();
    void p._updateRadar();
    await vi.advanceTimersByTimeAsync(LISTING_TIMEOUT_MS);
    expect(p._scheduleUpdate).toHaveBeenCalledTimes(1);
  });

  it('RainViewer init: an init retry is scheduled', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const p = makePlayer({ data_source: 'RainViewer' });
    p._scheduleInitRetry = vi.fn();
    void p._initRadar();
    await vi.advanceTimersByTimeAsync(LISTING_TIMEOUT_MS);
    expect(p._scheduleInitRetry).toHaveBeenCalledTimes(1);
  });
});
