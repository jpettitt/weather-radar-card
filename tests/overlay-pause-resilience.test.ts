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
  // Enough of geoJSON/canvas for the alerts layer's real render path to run.
  const geoJSON = vi.fn(() => ({ addTo: vi.fn() }));
  const canvas = vi.fn(() => ({}));
  return {
    Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent, geoJSON, canvas,
    default: { Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent, geoJSON, canvas },
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
    l._all = [];
    l._outlineStamp = '';
    l._outlinesAt = 0;
    l._detail = new Map();
    l._showDetail = vi.fn();
    l._filter = vi.fn((f: unknown[]) => f);
    l._render = vi.fn();
    l._scheduleNext = vi.fn();
    return l;
  }

  it('keeps the existing perimeters when the WFIGS fetch fails (null)', async () => {
    const l = bareFetchable();
    l._scheduleRetry = vi.fn();
    l._fetchWfigs = vi.fn(async () => null);          // transient 503
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

  it('_scheduleHourlyRefresh replaces an armed chain rather than adding one', () => {
    const o = bareWind();
    o._scheduleHourlyRefresh();
    o._scheduleHourlyRefresh();
    expect(vi.getTimerCount()).toBe(1);
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

  it('resume with preload_while_hidden re-arms the hourly chain instead of forking it', () => {
    const w = bareFlow();
    w._preloadWhileHidden = true;
    w._restart = vi.fn(async () => {});
    w._scheduleHourlyRefresh();         // armed at construction
    expect(vi.getTimerCount()).toBe(1);
    w.pause();                           // preload keeps the chain alive
    expect(w._refreshTimer).not.toBeNull();
    w.resume();
    expect(vi.getTimerCount()).toBe(1);  // one chain, not two
    clearTimeout(w._refreshTimer);
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

// ── Lightning canvas layer: hit-test + draw order ────────────────────────
//
// The DOM-marker implementation (and its time-sliced backlog drain) was
// replaced by a single canvas — strikes are painted, not mounted, so the
// per-strike DOM cost that froze editor-open is structurally gone. What
// needs regression coverage now is the DIY interaction layer the canvas
// brought with it: the click hit-test (MOST RECENT strike within
// tolerance wins, per user decision — recency beats distance when
// strikes overlap) and the painters-algorithm draw order.

describe('LightningLayer canvas hit-test', () => {
  async function bareLightning(): Promise<any> {
    const { LightningLayer } = await import('../src/lightning-layer');
    const l = Object.create(LightningLayer.prototype);
    l._strikes = new Map();
    // Identity projection: strikes store container px directly in lat/lon.
    l._map = { latLngToContainerPoint: ([lat, lon]: [number, number]) => ({ x: lon, y: lat }) };
    l._padX = 0;
    l._padY = 0;
    return l;
  }

  it('picks the most recent strike within tolerance, not the nearest', async () => {
    const l = await bareLightning();
    // Older strike 1px from the click; newer strike 8px away. Both are
    // inside the 10px tolerance — recency must win.
    l._strikes.set('geo_location.older_closer', { ts: 1000, lat: 100, lon: 101, pulseUntil: 0 });
    l._strikes.set('geo_location.newer_farther', { ts: 2000, lat: 100, lon: 108, pulseUntil: 0 });
    expect(l._hitTest({ x: 100, y: 100 })).toBe('geo_location.newer_farther');
  });

  it('falls back to the nearer strike when the newer one is out of tolerance', async () => {
    const l = await bareLightning();
    l._strikes.set('geo_location.older_closer', { ts: 1000, lat: 100, lon: 101, pulseUntil: 0 });
    l._strikes.set('geo_location.newer_farther', { ts: 2000, lat: 100, lon: 120, pulseUntil: 0 });
    expect(l._hitTest({ x: 100, y: 100 })).toBe('geo_location.older_closer');
  });

  it('returns null when nothing is within tolerance', async () => {
    const l = await bareLightning();
    l._strikes.set('geo_location.far', { ts: 1000, lat: 500, lon: 500, pulseUntil: 0 });
    expect(l._hitTest({ x: 100, y: 100 })).toBeNull();
  });

  it('tolerance is a radius: 10px away hits, 11px misses', async () => {
    const l = await bareLightning();
    l._strikes.set('geo_location.edge', { ts: 1000, lat: 100, lon: 110, pulseUntil: 0 });
    expect(l._hitTest({ x: 100, y: 100 })).toBe('geo_location.edge');
    expect(l._hitTest({ x: 89, y: 100 })).toBeNull();
  });
});

describe('LightningLayer canvas draw order', () => {
  // _drawOrder projects through LAYER points minus the canvas's pinned
  // layer-point origin — NOT container points. Container points include
  // the live drag delta, and a repaint mid-drag (hass tick, pulse frame)
  // at container coordinates applied that delta on top of the pane's own
  // transform: strikes visibly moved at 2× drag speed until moveend
  // (live-debugged on the testbed). Layer points are drag-stable.
  async function bareLightning(): Promise<any> {
    const { LightningLayer } = await import('../src/lightning-layer');
    const l = Object.create(LightningLayer.prototype);
    l._strikes = new Map();
    l._map = { latLngToLayerPoint: ([lat, lon]: [number, number]) => ({ x: lon, y: lat }) };
    l._originLayerPoint = { x: 0, y: 0 };
    return l;
  }

  it('sorts oldest-first so newer strikes paint on top, and derives bolt phase from age', async () => {
    const l = await bareLightning();
    const now = 100_000_000;
    l._strikes.set('a', { ts: now - 60_000, lat: 10, lon: 10, pulseUntil: 0 });  // 60s old → plus
    l._strikes.set('b', { ts: now - 5_000, lat: 20, lon: 20, pulseUntil: 0 });   // 5s old → bolt
    l._strikes.set('c', { ts: now - 120_000, lat: 30, lon: 30, pulseUntil: 0 }); // 120s old → plus
    const order = l._drawOrder(now, 1800, 200, 200, 20);
    expect(order.map((d: any) => d.ts)).toEqual([now - 120_000, now - 60_000, now - 5_000]);
    expect(order.map((d: any) => d.isBolt)).toEqual([false, false, true]);
  });

  it('culls strikes outside the canvas plus margin and past max age', async () => {
    const l = await bareLightning();
    const now = 100_000_000;
    l._strikes.set('visible', { ts: now - 1_000, lat: 50, lon: 50, pulseUntil: 0 });
    l._strikes.set('offcanvas', { ts: now - 1_000, lat: 50, lon: 500, pulseUntil: 0 });
    l._strikes.set('expired', { ts: now - 2_000_000, lat: 60, lon: 60, pulseUntil: 0 });
    const order = l._drawOrder(now, 1800, 200, 200, 20);
    expect(order).toHaveLength(1);
    expect(order[0].x).toBe(50);
  });

  it('paints relative to the pinned canvas origin (drag-stable layer coords)', async () => {
    const l = await bareLightning();
    const now = 100_000_000;
    l._originLayerPoint = { x: -30, y: -40 };
    l._strikes.set('s', { ts: now - 1_000, lat: 10, lon: 20, pulseUntil: 0 });
    const order = l._drawOrder(now, 1800, 200, 200, 20);
    expect(order[0].x).toBe(50);   // 20 - (-30)
    expect(order[0].y).toBe(50);   // 10 - (-40)
  });
});

// ── Settled-strike buffer invalidation ──────────────────────────────────
//
// The offscreen buffer holds every strike older than the bolt window;
// each pulse frame is a blit + the live tail instead of an O(strikes)
// full repaint. Live-debugged: a 5000-strike stress config saturated
// the main thread because every arriving strike's 600 ms pulse ran ~36
// full-set repaints. The win depends on ARRIVALS NOT INVALIDATING THE
// BUFFER — these tests pin the invalidation rules.

describe('LightningLayer buffer invalidation', () => {
  async function bareLightning(): Promise<any> {
    const { LightningLayer } = await import('../src/lightning-layer');
    const l = Object.create(LightningLayer.prototype);
    l._strikes = new Map();
    l._bufferDirty = false;
    l._bufferMaxTs = 50_000;
    l._scheduleRedraw = vi.fn();
    return l;
  }

  it('a fresh strike arrival does NOT dirty the buffer (draws live)', async () => {
    const l = await bareLightning();
    l._collectStrikes = () => new Map([
      ['geo_location.fresh', { ts: 60_000, lat: 0, lon: 0, pulseUntil: 0 }],
    ]);
    l._refreshFromHass();
    expect(l._bufferDirty).toBe(false);
    expect(l._scheduleRedraw).toHaveBeenCalled();
  });

  it('a backlog strike older than the buffer cutoff dirties it', async () => {
    const l = await bareLightning();
    l._collectStrikes = () => new Map([
      ['geo_location.old', { ts: 40_000, lat: 0, lon: 0, pulseUntil: 0 }],
    ]);
    l._refreshFromHass();
    expect(l._bufferDirty).toBe(true);
  });

  it('a removal dirties the buffer (strike may be baked in)', async () => {
    const l = await bareLightning();
    l._strikes.set('geo_location.gone', { ts: 40_000, lat: 0, lon: 0, pulseUntil: 0 });
    l._collectStrikes = () => new Map();
    l._refreshFromHass();
    expect(l._bufferDirty).toBe(true);
    expect(l._strikes.size).toBe(0);
  });

  it('a no-op tick neither dirties nor schedules', async () => {
    const l = await bareLightning();
    const strike = { ts: 60_000, lat: 0, lon: 0, pulseUntil: 0 };
    l._strikes.set('geo_location.same', strike);
    l._collectStrikes = () => new Map([['geo_location.same', strike]]);
    l._refreshFromHass();
    expect(l._bufferDirty).toBe(false);
    expect(l._scheduleRedraw).not.toHaveBeenCalled();
  });
});

// ── 4. Alerts refresh keeps an unchanged layer (and its open popup) ─────
//
// _fetch rendered unconditionally, so every 60 s refresh tore the polygon
// layer down and rebuilt it, closing whatever popup was open (2026-10-10
// review). The other render paths already passed skipIfDecisionsUnchanged.

describe('NwsAlertsLayer refresh with an unchanged alert set', () => {
  const tornado = (id = 'https://api.weather.gov/alerts/urn:oid:1'): any => ({
    type: 'Feature',
    id,
    properties: {
      event: 'Tornado Warning', severity: 'Extreme', urgency: 'Immediate', certainty: 'Observed',
      affectedZones: [],
    },
    geometry: { type: 'Polygon', coordinates: [[[-97, 35], [-96, 35], [-96, 36], [-97, 35]]] },
  });

  function bareAlertsForFetch(): any {
    const l = Object.create(NwsAlertsLayer.prototype);
    l._gen = 0;
    l._abortCtrl = null;
    l._zoneAbortCtrl = null;
    l._failureCount = 0;
    l._timer = null;
    l._pausedAt = null;
    l._features = [];
    l._renderDecisions = new Map();
    l._polygonLayer = null;
    l._zoneCache = new Map();
    l._map = { getCenter: () => ({ lat: 35, lng: -97 }), removeLayer: vi.fn(), getSize: () => ({ x: 800, y: 600 }) };
    l._getConfig = () => ({ alerts_types: ['Tornado Warning'] });
    l._resolveZones = vi.fn(async () => {});
    return l;
  }

  function stubAlerts(features: unknown[]): void {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ type: 'FeatureCollection', features }),
    })));
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('does not rebuild the polygon layer when the refresh returns the same alerts', async () => {
    const l = bareAlertsForFetch();
    stubAlerts([tornado()]);
    await l._fetch();                       // first paint
    const drawn = l._polygonLayer;
    expect(drawn).not.toBeNull();
    await l._fetch();                       // 60 s later, nothing changed
    expect(l._map.removeLayer).not.toHaveBeenCalled();
    expect(l._polygonLayer).toBe(drawn);
    if (l._timer) clearTimeout(l._timer);
  });

  it('still rebuilds when an alert is updated (NWS issues a new id)', async () => {
    const l = bareAlertsForFetch();
    stubAlerts([tornado()]);
    await l._fetch();
    const drawn = l._polygonLayer;
    stubAlerts([tornado('https://api.weather.gov/alerts/urn:oid:2')]);
    await l._fetch();
    expect(l._map.removeLayer).toHaveBeenCalledWith(drawn);
    expect(l._polygonLayer).not.toBe(drawn);
    if (l._timer) clearTimeout(l._timer);
  });
});
