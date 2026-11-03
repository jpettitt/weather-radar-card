// Zone shapes are fetched through a pool (24 at a time, in-view alerts
// first). A status-less failure is NWS's burst block: the batch stops, the
// layer backs off (5 s doubling to 5 min) and resumes at half the pool; a
// batch that brings shapes restores full speed. Before this, a cold cache
// with marine on fired 2,100 requests at once, got blocked, and re-fired
// the same burst every 60 s, so the alerts never got shapes (2026-10-16).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  return { Layer, TileLayer, Control, default: { Layer, TileLayer, Control } };
});

import { NwsAlertsLayer } from '../src/nws-alerts-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ZONE = (id: string | number): string => `https://api.weather.gov/zones/forecast/Z${id}`;
const SHAPE = JSON.stringify({ geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } });

// Every layer a test makes is cleared after it: a worker still awaiting
// something would otherwise call the next test's fetch.
const layers: any[] = [];

function makeLayer(onStatus?: (s: any) => void): any {
  const map = { on: vi.fn(), off: vi.fn(), getSize: () => ({ x: 0, y: 0 }), getBounds: () => ({ pad: () => null }), removeLayer: vi.fn() };
  const layer = new NwsAlertsLayer(map as any, () => ({ type: 'custom:weather-radar-card' } as any), undefined, onStatus) as any;
  layer._render = vi.fn();
  layers.push(layer);
  return layer;
}

function alert(id: string, zones: string[]): any {
  return { type: 'Feature', id, geometry: null, properties: { event: 'Wind Advisory', severity: 'Moderate', affectedZones: zones } };
}

/** A fake api.weather.gov: answers after 10 ms, records peak concurrency and
 * order, and blocks (status-less TypeError, as the browser reports NWS's 403
 * without CORS) while `blocked()` says so. */
function fakeNws(blocked: () => boolean = () => false) {
  const state = { inFlight: 0, peak: 0, order: [] as string[], calls: 0 };
  global.fetch = vi.fn((url: string) => {
    state.calls++;
    state.order.push(url);
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    const fail = blocked();
    return new Promise<Response>((resolve, reject) => {
      setTimeout(() => {
        state.inFlight--;
        if (fail) reject(new TypeError('Failed to fetch'));
        else resolve(new Response(SHAPE));
      }, 10);
    });
  }) as any;
  return state;
}

/** Advance fake time in 10 ms steps until `cond` holds (the pool chains
 * timers through microtasks, which runAllTimersAsync does not follow).
 * A step is one event-loop turn of a few microseconds, so nothing waited
 * on here may depend on real I/O: on a loaded CI runner the zone write's
 * gzip did not finish inside 500 steps (2026-10-17). */
async function until(cond: () => boolean, maxSteps = 500): Promise<void> {
  for (let i = 0; i < maxSteps && !cond(); i++) await vi.advanceTimersByTimeAsync(10);
  expect(cond()).toBe(true);
}

const batchDone = (layer: any) => !layer._zoneBatchRunning;

describe('zone pool', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const l of layers.splice(0)) l.clear();
    vi.useRealTimers();
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('fetches at most 24 zones at a time and gets them all', async () => {
    const nws = fakeNws();
    const layer = makeLayer();
    layer._features = [alert('a', Array.from({ length: 60 }, (_, i) => ZONE(i)))];
    void layer._resolveZones();
    await until(() => layer._zoneCache.size === 60 && batchDone(layer));
    expect(nws.peak).toBe(24);
    expect(nws.calls).toBe(60);
    expect(layer._zonePool).toBe(24);
    expect(layer._zoneBackoffMs).toBe(0);
    expect(layer._zoneRetryTimer).toBeNull();
  });

  it('fetches zones of alerts in view before those of hidden alerts, most severe first', async () => {
    const nws = fakeNws();
    const layer = makeLayer();
    // _features is severity-ascending: the last is the most severe.
    layer._features = [alert('minor', [ZONE('minor')]), alert('hidden', [ZONE('hidden')]), alert('severe', [ZONE('severe')])];
    layer._hidden.add('hidden');   // what a render leaves out of view (see nws-zone-queue-hidden.test.ts)
    layer._zonePool = 1;   // serialise so the order is observable
    void layer._resolveZones();
    await until(() => layer._zoneCache.size === 3 && batchDone(layer));
    expect(nws.order).toEqual([ZONE('severe'), ZONE('minor'), ZONE('hidden')]);
  });

  it('a block stops the batch, halves the pool, backs off 5 s, then finishes the rest', async () => {
    const statuses: any[] = [];
    let blocking = true;
    const nws = fakeNws(() => blocking);
    const layer = makeLayer((s) => statuses.push(s));
    layer._features = [alert('a', Array.from({ length: 50 }, (_, i) => ZONE(i)))];
    void layer._resolveZones();
    await until(() => batchDone(layer) && layer._zoneRetryTimer !== null);
    // The first 24 went out together and all failed; nothing more was tried.
    expect(nws.calls).toBe(24);
    expect(layer._zonePool).toBe(12);
    expect(layer._zoneBackoffMs).toBe(5000);
    expect(statuses).toEqual([{ kind: 'zones', failures: 50, total: 50 }]);
    // A refresh during the backoff fires nothing.
    await layer._resolveZones();
    expect(nws.calls).toBe(24);
    // The limit clears; the retry resumes at 12 at a time and gets them all.
    blocking = false;
    nws.peak = 0;
    await vi.advanceTimersByTimeAsync(5000);
    await until(() => layer._zoneCache.size === 50 && batchDone(layer));
    expect(nws.peak).toBe(12);
    expect(layer._zonePool).toBe(24);
    expect(layer._zoneBackoffMs).toBe(0);
    expect(statuses[statuses.length - 1]).toBeNull();
  });

  it('repeated blocks double the backoff to a 5 min cap and shrink the pool to a floor of 4', async () => {
    fakeNws(() => true);
    const layer = makeLayer();
    layer._features = [alert('a', Array.from({ length: 10 }, (_, i) => ZONE(i)))];
    const backoffs: number[] = [];
    const pools: number[] = [];
    void layer._resolveZones();
    for (let k = 0; k < 8; k++) {
      await until(() => batchDone(layer) && layer._zoneRetryTimer !== null);
      backoffs.push(layer._zoneBackoffMs);
      pools.push(layer._zonePool);
      await vi.advanceTimersByTimeAsync(layer._zoneBackoffMs);   // the retry starts the next batch
    }
    expect(backoffs).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]);
    expect(pools).toEqual([12, 6, 4, 4, 4, 4, 4, 4]);
  });

  it('a 404 is a plain failure: no backoff, the rest of the batch still runs', async () => {
    global.fetch = vi.fn(async (url: string) => (url === ZONE(1) ? new Response('gone', { status: 404 }) : new Response(SHAPE))) as any;
    const layer = makeLayer();
    layer._features = [alert('a', [ZONE(0), ZONE(1), ZONE(2)])];
    void layer._resolveZones();
    await until(() => batchDone(layer) && layer._zoneCache.size === 2);
    expect(layer._zoneBackoffMs).toBe(0);
    expect(layer._zoneRetryTimer).toBeNull();
  });

  it('a refresh during a running batch re-plans after it, picking up new alerts', async () => {
    const nws = fakeNws();
    const layer = makeLayer();
    layer._features = [alert('a', [ZONE('a')])];
    void layer._resolveZones();
    // The alerts list changes while 'a' is in flight.
    layer._features = [alert('a', [ZONE('a')]), alert('b', [ZONE('b')])];
    await layer._resolveZones();   // batch running: asks for a re-plan
    await until(() => layer._zoneCache.size === 2 && batchDone(layer));
    expect(nws.order).toEqual([ZONE('a'), ZONE('b')]);
  });

  it('a GeometryCollection zone is cached as a MultiPolygon; a zone without a shape is remembered, not refetched', async () => {
    const gc = JSON.stringify({ geometry: { type: 'GeometryCollection', geometries: [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, { type: 'Point', coordinates: [5, 5] }] } });
    const none = JSON.stringify({ geometry: null });
    const calls: string[] = [];
    global.fetch = vi.fn(async (url: string) => { calls.push(url); return new Response(url === ZONE('gc') ? gc : none); }) as any;
    const layer = makeLayer();
    layer._features = [alert('a', [ZONE('gc'), ZONE('none')])];
    void layer._resolveZones();
    await until(() => batchDone(layer) && layer._zoneCache.size === 2);
    expect(layer._zoneCache.get(ZONE('gc')).type).toBe('MultiPolygon');
    expect(layer._zoneCache.get(ZONE('gc')).coordinates).toHaveLength(1);
    expect(layer._zoneCache.get(ZONE('none')).coordinates).toEqual([]);
    expect(layer._zoneQueue()).toEqual([]);
    void layer._resolveZones();
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toHaveLength(2);
  });

  it('a batch planned while the map moves starts no request until the quiet callback', async () => {
    const nws = fakeNws();
    const layer = makeLayer();
    layer._features = [alert('a', Array.from({ length: 6 }, (_, i) => ZONE(i)))];
    layer._onMapBusy();
    void layer._resolveZones();
    await vi.advanceTimersByTimeAsync(300);
    expect(nws.calls).toBe(0);
    layer._onMapQuiet();
    await until(() => layer._zoneCache.size === 6 && batchDone(layer));
    expect(nws.calls).toBe(6);
  });

  it('workers already running pause before their next request while the map moves', async () => {
    const nws = fakeNws();
    const layer = makeLayer();
    layer._features = [alert('a', Array.from({ length: 12 }, (_, i) => ZONE(i)))];
    layer._zonePool = 2;
    void layer._resolveZones();
    await until(() => nws.calls >= 2);
    layer._onMapBusy();
    const atBusy = nws.calls;
    await vi.advanceTimersByTimeAsync(300);
    // At most the requests already past the check go out; the rest wait.
    expect(nws.calls - atBusy).toBeLessThanOrEqual(2);
    expect(layer._zoneCache.size).toBeLessThan(12);
    expect(batchDone(layer)).toBe(false);
    layer._onMapQuiet();
    await until(() => layer._zoneCache.size === 12 && batchDone(layer));
    expect(nws.calls).toBe(12);
  });

  it('clear() releases paused workers so an aborted batch drains', async () => {
    fakeNws();
    const layer = makeLayer();
    layer._features = [alert('a', [ZONE(0), ZONE(1), ZONE(2)])];
    layer._zonePool = 1;
    void layer._resolveZones();
    await vi.advanceTimersByTimeAsync(15);
    layer._onMapBusy();
    await vi.advanceTimersByTimeAsync(15);
    layer.clear();
    await until(() => batchDone(layer));
    expect(layer._quietWaiters).toEqual([]);
  });

  it('clear() drops the retry timer and the backoff', async () => {
    fakeNws(() => true);
    const layer = makeLayer();
    layer._features = [alert('a', [ZONE(0)])];
    void layer._resolveZones();
    await until(() => batchDone(layer) && layer._zoneRetryTimer !== null);
    layer.clear();
    expect(layer._zoneRetryTimer).toBeNull();
    expect(layer._zoneBackoffUntil).toBe(0);
    expect(layer._zonePool).toBe(24);
  });
});
