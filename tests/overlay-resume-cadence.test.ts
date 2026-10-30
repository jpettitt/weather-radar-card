/* eslint-disable @typescript-eslint/no-explicit-any */
// resume() tested the time hidden against a fixed 60 s / 5 min, not the
// interval _scheduleNext armed, and then started the full interval again.
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
  const geoJSON = vi.fn(() => ({ addTo: vi.fn(), on: vi.fn(), getLayers: () => [] }));
  const canvas = vi.fn(() => ({}));
  return {
    Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent, geoJSON, canvas,
    default: { Layer, TileLayer, Control, layerGroup, DomUtil, DomEvent, geoJSON, canvas },
  };
});

import { WildfireLayer } from '../src/wildfire-layer';
import { NwsAlertsLayer } from '../src/nws-alerts-layer';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function bare(Cls: any, cfg: any, features: unknown[]): any {
  const l = Object.create(Cls.prototype);
  l._timer = null;
  l._pausedAt = null;
  l._dueAt = null;
  l._features = features;
  l._getConfig = () => cfg;
  // The network edge only: count fetches, then re-arm the chain the way the
  // real _fetch tail does.
  // resume() also redraws the wildfire layer for the current view.
  l._render = vi.fn();
  l._showDetail = vi.fn();
  l._fetchCount = 0;
  l._fetch = function () { this._fetchCount++; this._scheduleNext(); return Promise.resolve(); };
  return l;
}

describe('overlay resume vs refresh cadence', () => {
  it('alerts: 50 s visible / 50 s hidden for 20 min still refreshes', () => {
    const l = bare(NwsAlertsLayer, {}, [{ id: 'a' }]);
    l._scheduleNext();                 // as after the first fetch
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(50_000);  // visible
      l.pause();
      vi.advanceTimersByTime(50_000);  // hidden (tab switch / scrolled away)
      l.resume();
    }
    // 10 minutes of 60 s alerts cadence with half the time visible.
    expect(l._fetchCount).toBeGreaterThan(0);
  });

  it('wildfire: wildfire_refresh_minutes 60 is not exceeded by a 6 min hide', () => {
    const l = bare(WildfireLayer, { wildfire_refresh_minutes: 60 }, [{ id: 'f' }]);
    l._scheduleNext();
    vi.advanceTimersByTime(60_000);
    l.pause();
    vi.advanceTimersByTime(6 * 60_000);
    l.resume();
    // 7 minutes after the last fetch, with a 60-minute configured cadence.
    expect(l._fetchCount).toBe(0);
    // It still fires 60 min after the last fetch, not 60 min after the resume.
    vi.advanceTimersByTime(53 * 60_000 - 1);
    expect(l._fetchCount).toBe(0);
    vi.advanceTimersByTime(1);
    expect(l._fetchCount).toBe(1);
  });

  it.each([['alerts', NwsAlertsLayer], ['wildfire', WildfireLayer]])('%s: a refresh that came due while hidden runs at resume', (_name, Cls) => {
    const l = bare(Cls, {}, [{ id: 'x' }]);
    l._scheduleNext();
    l.pause();
    vi.advanceTimersByTime(31 * 60_000);
    expect(l._fetchCount).toBe(0);
    l.resume();
    expect(l._fetchCount).toBe(1);
  });

  it.each([['alerts', NwsAlertsLayer], ['wildfire', WildfireLayer]])('%s: a fetch in flight at resume arms the next one itself', (_name, Cls) => {
    const l = bare(Cls, {}, [{ id: 'x' }]);
    l._scheduleNext();
    l._dueAt = null;   // what _fetch sets as it starts
    l.pause();
    l.resume();
    vi.advanceTimersByTime(60 * 60_000);
    expect(l._fetchCount).toBe(0);
  });

  it.each([['alerts', NwsAlertsLayer], ['wildfire', WildfireLayer]])('%s: a fetch that ends while paused arms nothing until resume', (_name, Cls) => {
    const l = bare(Cls, {}, [{ id: 'x' }]);
    l.pause();
    l._scheduleNext();   // the tail of a fetch that was in flight at pause()
    vi.advanceTimersByTime(60 * 60_000);
    expect(l._fetchCount).toBe(0);
    l.resume();
    expect(l._fetchCount).toBe(1);
  });
});
