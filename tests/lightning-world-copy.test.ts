/* eslint-disable @typescript-eslint/no-explicit-any */
// After a pan across the antimeridian, Leaflet keeps unwrapped longitudes:
// a view of Asia reached by panning west from the US runs from about -320
// to -202. A strike drawn at its entity's longitude (+88 for India) was a
// world away. Real LightningLayer on a real Leaflet map (happy-dom); only
// the timers, Path2D and the 2D context are faked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as L from 'leaflet';
import { LightningLayer } from '../src/lightning-layer';

const INDIA = { lat: 27.83, lon: 87.95 };

function makeMap(center: [number, number], zoom: number): L.Map {
  const el = document.createElement('div');
  Object.defineProperty(el, 'clientWidth', { value: 600 });
  Object.defineProperty(el, 'clientHeight', { value: 400 });
  document.body.appendChild(el);
  return L.map(el, { attributionControl: false, zoomControl: false }).setView(center, zoom, { animate: false });
}

function hassWithStrike(lat: number, lon: number): any {
  return { states: { 'geo_location.strike_1': {
    entity_id: 'geo_location.strike_1', state: '10',
    attributes: { source: 'blitzortung', latitude: lat, longitude: lon, publication_date: new Date(Date.now() - 120_000).toISOString() },
  } } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.setSystemTime(new Date('2026-11-24T02:00:00Z'));
  vi.stubGlobal('Path2D', class { constructor(_p?: string) { void _p; } });
  const ctx = new Proxy({}, { get: (_t, p) => (p === 'canvas' ? undefined : () => undefined), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('LightningLayer world copies', () => {
  it.each([
    ['the view of Asia after a pan west (-320 to -202)', [28, -261] as [number, number], INDIA],
    ['a view centred on the 180° line', [-20, 180] as [number, number], { lat: -20, lon: -177.5 }],
  ])('draws and hits a strike in %s', async (_name, center, strike) => {
    const map = makeMap(center, 4);
    const layer: any = new LightningLayer(map, () => ({ type: 'custom:weather-radar-card' } as any), hassWithStrike(strike.lat, strike.lon));
    layer.start();
    await vi.advanceTimersByTimeAsync(50);
    // Where the strike is on screen: the copy of its longitude in this view.
    const lngInView = strike.lon + 360 * Math.round((center[1] - strike.lon) / 360);
    const pt = map.latLngToContainerPoint([strike.lat, lngInView]);
    const size = map.getSize();
    expect(pt.x > 0 && pt.x < size.x && pt.y > 0 && pt.y < size.y).toBe(true);
    expect(layer._hitTest(pt)).toBe('geo_location.strike_1');
    // The paint list holds it at that spot (canvas coordinates: the origin
    // is pinned half a view up and left of the container).
    const drawn = layer._drawOrder(Date.now(), 1800, size.x * 2, size.y * 2, 20);
    expect(drawn).toHaveLength(1);
    map.fire('click', { containerPoint: pt, latlng: map.containerPointToLatLng(pt) });
    let at: L.LatLng | undefined;
    map.eachLayer((l) => { if (l instanceof L.Popup && l.isOpen()) at = l.getLatLng() ?? undefined; });
    expect(at?.lng).toBeCloseTo(lngInView, 6);
    layer.clear();
    map.remove();
  });
});
