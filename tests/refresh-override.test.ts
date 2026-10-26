// alerts_refresh_seconds and wildfire_refresh_minutes are YAML-only and went
// to setTimeout unchecked: -60 s polled api.weather.gov ~1000 times a second.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  return { Layer, TileLayer, Control, default: { Layer, TileLayer, Control } };
});

import { refreshOverrideMs } from '../src/refresh-override';
import { NwsAlertsLayer } from '../src/nws-alerts-layer';
import { WildfireLayer } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

describe('refreshOverrideMs', () => {
  it('is null (adaptive default) for anything but a positive number', () => {
    for (const v of [undefined, null, 0, -1, -60, NaN, Infinity, -Infinity, '60', true, {}]) {
      expect(refreshOverrideMs(v, 1000, 30_000)).toBeNull();
    }
  });

  it('never goes below the floor, and keeps values above it', () => {
    for (const v of [0.001, 0.5, 1, 10, 29.9, 30, 31, 120, 3600]) {
      const ms = refreshOverrideMs(v, 1000, 30_000)!;
      expect(ms).toBeGreaterThanOrEqual(30_000);
      expect(ms).toBe(Math.max(30_000, v * 1000));
    }
  });
});

describe('layer refresh cadence with a bad override', () => {
  const realFetch = global.fetch;
  const layers: any[] = [];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    for (const l of layers.splice(0)) l.clear();
    vi.useRealTimers();
    global.fetch = realFetch;
  });

  it.each([[-60], [0.01], [0]])('alerts_refresh_seconds %s: no tight polling loop', async (secs) => {
    let calls = 0;
    global.fetch = vi.fn(async () => { calls++; return new Response(JSON.stringify({ features: [] })); }) as any;
    const map = { on: vi.fn(), off: vi.fn(), getSize: () => ({ x: 0, y: 0 }), getBounds: () => ({ pad: () => null }), removeLayer: vi.fn(), getZoom: () => 9 };
    const layer = new NwsAlertsLayer(map as any, () => ({ type: 'custom:weather-radar-card', alerts_refresh_seconds: secs } as any)) as any;
    layer._render = vi.fn();
    layers.push(layer);
    await layer._fetch();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });

  it('alerts_refresh_seconds 45: refreshes every 45 s', async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => { calls++; return new Response(JSON.stringify({ features: [] })); }) as any;
    const map = { on: vi.fn(), off: vi.fn(), getSize: () => ({ x: 0, y: 0 }), getBounds: () => ({ pad: () => null }), removeLayer: vi.fn(), getZoom: () => 9 };
    const layer = new NwsAlertsLayer(map as any, () => ({ type: 'custom:weather-radar-card', alerts_refresh_seconds: 45 } as any)) as any;
    layer._render = vi.fn();
    layers.push(layer);
    await layer._fetch();
    await vi.advanceTimersByTimeAsync(44_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toBe(2);
  });

  // The real _scheduleNext on a bare instance; _fetch only re-arms.
  function bareWildfire(cfg: Record<string, unknown>): any {
    const l = Object.create(WildfireLayer.prototype);
    l._timer = null; l._pausedAt = null; l._features = [{ id: 1 }];
    l._getConfig = () => cfg;
    l._fetch = vi.fn(async () => { l._scheduleNext(); });
    layers.push({ clear: () => { if (l._timer) clearTimeout(l._timer); } });
    return l;
  }

  it.each([[-1], [0.01]])('wildfire_refresh_minutes %s: at most one fetch a minute', async (min) => {
    const l = bareWildfire({ wildfire_refresh_minutes: min });
    l._scheduleNext();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(l._fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(l._fetch).toHaveBeenCalledTimes(min > 0 ? 1 : 0);
  });

  it('wildfire_refresh_minutes -1 keeps the adaptive 5 min', async () => {
    const l = bareWildfire({ wildfire_refresh_minutes: -1 });
    l._scheduleNext();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(l._fetch).toHaveBeenCalledTimes(1);
  });
});
