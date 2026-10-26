// Range rings centre on the first drawn marker and must move with it; a
// mobile_only marker that this device doesn't draw must not steer the map.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import { cardHass, mountCard, trackerState } from './helpers/mount-card';
import { resolveTracking } from '../src/marker-utils';
import { isMobileDevice } from '../src/coordinate-utils';

/* eslint-disable @typescript-eslint/no-explicit-any */

const desktopWidth = window.innerWidth;
afterEach(() => {
  document.body.innerHTML = '';
  (window as any).innerWidth = desktopWidth;
});

describe('range rings', () => {
  it('follow the first marker when its entity moves', async () => {
    const hass = cardHass({ states: trackerState(40, -100) });
    const el = await mountCard({ show_range: true, markers: [{ entity: 'device_tracker.car' }] }, hass);
    expect(el._rangeRings.length).toBe(3);
    el.hass = { ...hass, states: trackerState(45, -90) };
    await el.updateComplete;
    for (const ring of el._rangeRings) {
      const c = ring.getLatLng();
      expect([c.lat, c.lng]).toEqual([45, -90]);
    }
  });
});

describe('mobile_only tracked marker', () => {
  const markers = [
    { latitude: 51, longitude: 0 },
    { entity: 'device_tracker.car', track: 'entity', mobile_only: true },
  ];

  it('does not steer the map on a desktop', async () => {
    expect(isMobileDevice()).toBe(false);
    const hass = cardHass({ states: trackerState(51, 0) });
    const el = await mountCard({ center_latitude: 51, center_longitude: 0, markers }, hass);
    el.hass = { ...hass, states: trackerState(48, 2) };
    await el.updateComplete;
    expect(el._markers.has(1)).toBe(false);
    expect(el._trackedMarkerIdx).toBe(-1);
    expect(el._map.getCenter().lat).toBeCloseTo(51, 2);
  });

  it('is skipped by the shared resolver only off mobile', () => {
    const hass = cardHass({ states: trackerState(48, 2) });
    expect(resolveTracking(markers as any, hass, 0, 0)).toBeNull();
    (window as any).innerWidth = 400;
    expect(isMobileDevice()).toBe(true);
    expect(resolveTracking(markers as any, hass, 0, 0)).toEqual({ lat: 48, lon: 2, markerIndex: 1 });
  });
});
