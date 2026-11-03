// Overlay data requests that the server accepts and never answers. Each
// had no time limit: the alerts and wildfire refresh chains waited forever,
// a zone held its worker and the batch, a fire's InciWeb lookup stayed
// pending (and cached), and a shared wind request blocked every overlay
// that asked for the same grid (pre-4.0 review, 2026-10-26).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  const L = { Layer, TileLayer, Control, geoJSON: vi.fn(), canvas: vi.fn(() => ({})) };
  return { ...L, default: L };
});
vi.mock('../src/shared-canvas-renderer', () => ({ sharedCanvasRenderer: () => ({}) }));

import { NwsAlertsLayer } from '../src/nws-alerts-layer';
import { WildfireLayer } from '../src/wildfire-layer';
import { findInciwebPage, _resetInciwebForTests } from '../src/inciweb';
import { WindGridFetcher } from '../src/wind-grid-fetcher';
import { DATA_TIMEOUT_MS, WIND_TIMEOUT_MS } from '../src/fetch-timeout';

/* eslint-disable @typescript-eslint/no-explicit-any */

// Like a real fetch to a server that never answers: settles only on abort.
const hangingFetch = vi.fn((_url: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_res, rej) => {
  init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
}));

const mapStub = (): any => ({
  on: vi.fn(), off: vi.fn(), once: vi.fn(), removeLayer: vi.fn(),
  getSize: () => ({ x: 0, y: 0 }), getBounds: () => ({ pad: () => null, intersects: () => true }),
  getZoom: () => 8, getCenter: () => ({ lat: 40, lng: -100 }),
});

const layers: any[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  hangingFetch.mockClear();
  vi.stubGlobal('fetch', hangingFetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const l of layers.splice(0)) l.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('overlay requests that never answer', () => {
  it('alerts list: fails at the limit and arms the backoff retry', async () => {
    const layer: any = new NwsAlertsLayer(mapStub(), () => ({ type: 'custom:weather-radar-card' } as any));
    layer._render = vi.fn();
    layers.push(layer);
    const done = layer._fetch();
    await vi.advanceTimersByTimeAsync(DATA_TIMEOUT_MS);
    await done;
    expect(layer._failureCount).toBe(1);
    expect(layer._timer).not.toBeNull();
  });

  it('zone shape: the batch ends at the limit and counts the zone as missing', async () => {
    const statuses: any[] = [];
    const layer: any = new NwsAlertsLayer(mapStub(), () => ({ type: 'custom:weather-radar-card' } as any), undefined, (s) => statuses.push(s));
    layer._render = vi.fn();
    layer._kv = { get: async () => undefined, set: async () => {}, delete: async () => {}, deleteMany: async () => {}, keysByAge: async () => [] };
    layers.push(layer);
    layer._features = [{ type: 'Feature', id: 'a', geometry: null, properties: { event: 'Wind Advisory', severity: 'Moderate', affectedZones: ['https://api.weather.gov/zones/forecast/Z1'] } }];
    const done = layer._resolveZones();
    await vi.advanceTimersByTimeAsync(DATA_TIMEOUT_MS);
    await done;
    expect(layer._zoneBatchRunning).toBe(false);
    expect(statuses.at(-1)).toMatchObject({ kind: 'zones', failures: 1 });
  });

  it('wildfire feed: fails at the limit and arms the backoff retry', async () => {
    const layer: any = new WildfireLayer(mapStub(), () => ({ type: 'custom:weather-radar-card' } as any));
    layers.push(layer);
    const done = layer._fetch();
    await vi.advanceTimersByTimeAsync(DATA_TIMEOUT_MS);
    await done;
    expect(layer._failureCount).toBe(1);
    expect(layer._timer).not.toBeNull();
  });

  it('InciWeb: the lookup gives up at the limit and the next popup tries again', async () => {
    _resetInciwebForTests();
    const lookup = findInciwebPage(['caknf-park-fire']);
    const settled = lookup.then(() => 'resolved', () => 'rejected');
    await vi.advanceTimersByTimeAsync(DATA_TIMEOUT_MS);
    expect(await settled).toBe('rejected');
    hangingFetch.mockClear();
    void findInciwebPage(['caknf-park-fire']).catch(() => {});
    expect(hangingFetch).toHaveBeenCalledTimes(1);   // not served the dead lookup
  });

  it('wind grid: the shared request gives up at the limit, and the next caller asks again', async () => {
    const fetcher = new WindGridFetcher();
    const opts = { south: 45, west: 0, north: 55, east: 15, source: 'dwd_icon' as const, timeIso: '2026-10-26T12:00:00Z', fetchImpl: hangingFetch as any };
    const first = fetcher.fetch(opts).then(() => 'resolved', (e) => e.name);
    await vi.advanceTimersByTimeAsync(WIND_TIMEOUT_MS);
    expect(await first).toBe('TimeoutError');
    const calls = hangingFetch.mock.calls.length;
    void fetcher.fetch(opts).catch(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(hangingFetch.mock.calls.length).toBeGreaterThan(calls);
  });
});
