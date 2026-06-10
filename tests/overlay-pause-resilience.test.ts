/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression tests for the overlay pause/resilience fixes from the
// 2026-06-09 review:
//
//   1. pause() only cancelled the ARMED refresh timer — a fetch already
//      in flight when pause() ran completed and its tail re-armed the
//      chain via _scheduleNext, so wildfire/alerts kept polling at full
//      cadence for as long as the card stayed hidden.
//   2. A transient WFIGS failure (NIFC 503 / rate-limit) blanked every
//      displayed fire perimeter for the 5-30 min until the next retry,
//      because _fetchWfigs returned [] on error and _fetch assigned it
//      unconditionally.
//   3. The wind overlays were missing from the host's visibility-pause
//      roster entirely; their self-rescheduling refresh chains and (for
//      the streamline canvas) the 15 fps rAF loop ran while hidden.
//
// Tests use Object.create(Class.prototype) to exercise the private
// methods' logic directly against hand-seeded state — the constructors
// need a live Leaflet map, which the suite avoids on principle
// ("stub Leaflet, test the helpers").

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as any).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  const layerGroup = vi.fn(() => ({ addTo: vi.fn(), remove: vi.fn(), clearLayers: vi.fn() }));
  const DomUtil = { create: vi.fn(() => ({ style: {} })), setPosition: vi.fn() };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent },
  };
});

import { WildfireLayer } from '../src/wildfire-layer';
import { NwsAlertsLayer } from '../src/nws-alerts-layer';
import { WindOverlay } from '../src/wind-overlay';
import { WindFlowOverlay } from '../src/wind-flow-overlay';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. _scheduleNext paused guard ────────────────────────────────────────

describe('overlay _scheduleNext honours pause', () => {
  function bareWildfire(): any {
    const l = Object.create(WildfireLayer.prototype);
    l._timer = null;
    l._pausedAt = null;
    l._features = [];
    l._getConfig = () => ({});
    return l;
  }

  function bareAlerts(): any {
    const l = Object.create(NwsAlertsLayer.prototype);
    l._timer = null;
    l._pausedAt = null;
    l._features = [];
    l._getConfig = () => ({});
    return l;
  }

  it('wildfire: does not re-arm while paused (in-flight fetch tail)', () => {
    const l = bareWildfire();
    l._pausedAt = Date.now();      // paused
    l._scheduleNext();             // the in-flight fetch's tail call
    expect(l._timer).toBeNull();   // chain must NOT re-arm
  });

  it('wildfire: arms normally when not paused', () => {
    const l = bareWildfire();
    l._scheduleNext();
    expect(l._timer).not.toBeNull();
    clearTimeout(l._timer);
  });

  it('alerts: does not re-arm while paused', () => {
    const l = bareAlerts();
    l._pausedAt = Date.now();
    l._scheduleNext();
    expect(l._timer).toBeNull();
  });

  it('alerts: arms normally when not paused', () => {
    const l = bareAlerts();
    l._scheduleNext();
    expect(l._timer).not.toBeNull();
    clearTimeout(l._timer);
  });
});

// ── 2. Wildfire keeps displayed features on transient fetch failure ─────

describe('WildfireLayer transient-failure resilience', () => {
  function bareFetchable(): any {
    const l = Object.create(WildfireLayer.prototype);
    l._gen = 0;
    l._abortCtrl = null;
    l._timer = null;
    l._pausedAt = null;
    l._getConfig = () => ({});
    l._failureCount = 0;
    l._features = [{ id: 'existing-fire' }];
    l._inciwebSlugs = new Set<string>();
    l._inciwebReady = false;
    l._filter = vi.fn((f: unknown[]) => f);
    l._render = vi.fn();
    l._scheduleNext = vi.fn();
    return l;
  }

  it('keeps the existing perimeters when the WFIGS fetch fails (null)', async () => {
    const l = bareFetchable();
    l._scheduleRetry = vi.fn();
    l._fetchWfigs = vi.fn(async () => null);          // transient 503
    l._fetchInciwebSlugs = vi.fn(async () => null);
    await l._fetch();
    expect(l._features).toEqual([{ id: 'existing-fire' }]);  // NOT blanked
    expect(l._filter).not.toHaveBeenCalled();
    expect(l._render).toHaveBeenCalled();             // still re-renders
    // Chain continues via the BACKOFF path, not the normal cadence —
    // retrying a rate-limited host on the normal interval kept the
    // block alive.
    expect(l._scheduleRetry).toHaveBeenCalled();
    expect(l._failureCount).toBe(1);
    expect(l._scheduleNext).not.toHaveBeenCalled();
  });

  it('replaces features on a successful fetch — including a genuinely empty feed', async () => {
    const l = bareFetchable();
    l._fetchWfigs = vi.fn(async () => []);            // real "no fires" data
    l._fetchInciwebSlugs = vi.fn(async () => null);
    await l._fetch();
    expect(l._filter).toHaveBeenCalledWith([]);
    expect(l._features).toEqual([]);                  // empty feed DOES replace
  });
});

// ── 3. Wind overlays pause/resume ────────────────────────────────────────

describe('WindOverlay pause/resume', () => {
  function bareWind(): any {
    const o = Object.create(WindOverlay.prototype);
    o._paused = false;
    o._refreshTimer = null;
    o._debounceTimer = null;
    return o;
  }

  it('pause cancels the hourly chain and the move debounce', () => {
    const o = bareWind();
    o._refreshTimer = setTimeout(() => {}, 1000);
    o._debounceTimer = setTimeout(() => {}, 1000);
    o.pause();
    expect(o._paused).toBe(true);
    expect(o._refreshTimer).toBeNull();
    expect(o._debounceTimer).toBeNull();
  });

  it('_scheduleHourlyRefresh is a no-op while paused', () => {
    const o = bareWind();
    o._paused = true;
    o._scheduleHourlyRefresh();
    expect(o._refreshTimer).toBeNull();
  });

  it('resume refreshes immediately and re-arms the hourly chain', () => {
    const o = bareWind();
    o._paused = true;
    o._refresh = vi.fn(async () => {});
    o.resume();
    expect(o._paused).toBe(false);
    expect(o._refresh).toHaveBeenCalledOnce();
    expect(o._refreshTimer).not.toBeNull();
    clearTimeout(o._refreshTimer);
  });
});

describe('WindFlowOverlay pause/resume', () => {
  function bareFlow(): any {
    const w = Object.create(WindFlowOverlay.prototype);
    w._paused = false;
    w._running = false;
    w._animFrame = 0;
    w._refreshTimer = null;
    w._gen = 0;
    return w;
  }

  it('pause stops the particle loop and the hourly chain', () => {
    const w = bareFlow();
    w._running = true;
    w._refreshTimer = setTimeout(() => {}, 1000);
    w.pause();
    expect(w._paused).toBe(true);
    expect(w._running).toBe(false);
    expect(w._refreshTimer).toBeNull();
  });

  it('_restart is a no-op while paused (resize/moveend firing on a hidden card)', async () => {
    const w = bareFlow();
    w._paused = true;
    // No map / canvas seeded — if the paused guard regressed, _restart
    // would throw on the missing map, failing this test loudly.
    await w._restart();
    expect(w._running).toBe(false);
  });

  it('_scheduleHourlyRefresh is a no-op while paused', () => {
    const w = bareFlow();
    w._paused = true;
    w._scheduleHourlyRefresh();
    expect(w._refreshTimer).toBeNull();
  });

  it('resume restarts the loop and re-arms the hourly chain', () => {
    const w = bareFlow();
    w._paused = true;
    w._restart = vi.fn(async () => {});
    w.resume();
    expect(w._paused).toBe(false);
    expect(w._restart).toHaveBeenCalledOnce();
    expect(w._refreshTimer).not.toBeNull();
    clearTimeout(w._refreshTimer);
  });
});

// ── Failure backoff (live-debugged: api.weather.gov rate-limit) ─────────
//
// "TypeError: Failed to fetch" from api.weather.gov is its rate limiter
// blocking without CORS headers. Retrying on the normal cadence (60 s
// with alerts displayed) hammered the blocking host and kept the block
// alive indefinitely — observed live as repeated fetch-failed errors
// with no recovery. Both polling layers now back off exponentially on
// consecutive failures and reset on success.

describe('failure backoff ladders', () => {
  it('alerts: 60s doubling to a 30-minute cap', () => {
    const l = Object.create(NwsAlertsLayer.prototype) as any;
    expect(l._retryDelayMs(1)).toBe(60_000);
    expect(l._retryDelayMs(2)).toBe(120_000);
    expect(l._retryDelayMs(3)).toBe(240_000);
    expect(l._retryDelayMs(6)).toBe(30 * 60_000);    // capped
    expect(l._retryDelayMs(50)).toBe(30 * 60_000);   // no 2**huge blowup
  });

  it('wildfire: 5min doubling to a 60-minute cap', () => {
    const l = Object.create(WildfireLayer.prototype) as any;
    expect(l._retryDelayMs(1)).toBe(5 * 60_000);
    expect(l._retryDelayMs(2)).toBe(10 * 60_000);
    expect(l._retryDelayMs(5)).toBe(60 * 60_000);    // capped
  });

  it('alerts: a failed fetch increments the counter and arms the backoff timer', async () => {
    const l = Object.create(NwsAlertsLayer.prototype) as any;
    l._gen = 0;
    l._abortCtrl = null;
    l._zoneAbortCtrl = null;
    l._timer = null;
    l._pausedAt = null;
    l._failureCount = 0;
    l._features = [];
    l._getConfig = () => ({});
    const realFetch = global.fetch;
    global.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); }) as any;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await l._fetch();
      expect(l._failureCount).toBe(1);
      expect(l._timer).not.toBeNull();               // backoff retry armed
      clearTimeout(l._timer);
    } finally {
      global.fetch = realFetch;
      warn.mockRestore();
    }
  });

  it('alerts: backoff retry respects pause', () => {
    const l = Object.create(NwsAlertsLayer.prototype) as any;
    l._timer = null;
    l._pausedAt = Date.now();
    l._failureCount = 3;
    l._scheduleRetry();
    expect(l._timer).toBeNull();
  });
});

// ── Lightning strike-backlog drain (live-debugged: editor-open lockup) ──
//
// Each strike materialises as two DOM markers with inline SVG; a fresh
// mount during an active storm used to build the whole backlog (often
// hundreds of strikes, and editor-open runs TWO card instances) in one
// synchronous pass — multi-second UI freeze. Additions now queue and
// drain newest-first in time-budgeted slices per animation frame.

describe('LightningLayer pending-add drain', () => {
  async function bareLightning(): Promise<any> {
    const { LightningLayer } = await import('../src/lightning-layer');
    const l = Object.create(LightningLayer.prototype);
    l._strikes = new Map();
    l._pendingAdds = [];
    l._drainScheduled = false;
    l._addMarker = vi.fn();
    l._removeMarker = vi.fn();
    return l;
  }

  it('drains newest-first and stops at the time budget', async () => {
    const l = await bareLightning();
    for (let i = 0; i < 5; i++) {
      const id = `geo_location.s${i}`;
      const strike = { ts: 1000 + i, lat: 0, lon: 0, isBolt: false };
      l._strikes.set(id, strike);
      l._pendingAdds.push([id, strike]);
    }
    // Make each _addMarker "cost" enough that a 0ms budget stops after one.
    l._drainPendingAdds(0);
    expect(l._addMarker).toHaveBeenCalledTimes(1);
    // Newest strike (largest ts) materialised first.
    expect(l._addMarker.mock.calls[0][1].ts).toBe(1004);
    // Generous budget drains the rest.
    l._drainPendingAdds(1000);
    expect(l._addMarker).toHaveBeenCalledTimes(5);
    expect(l._pendingAdds).toHaveLength(0);
  });

  it('skips strikes removed while queued', async () => {
    const l = await bareLightning();
    const strike = { ts: 1000, lat: 0, lon: 0, isBolt: false };
    l._pendingAdds.push(['geo_location.gone', strike]);   // NOT in _strikes
    l._drainPendingAdds(1000);
    expect(l._addMarker).not.toHaveBeenCalled();
  });
});
