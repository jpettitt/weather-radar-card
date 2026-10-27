// Card paths that no test reached: a mutant that removed any of them passed
// the full suite (pre-4.0 cross-cutting review). Real card on happy-dom.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import { cardHass, mountCard, tick } from './helpers/mount-card';

/* eslint-disable @typescript-eslint/no-explicit-any */

afterEach(() => { document.body.innerHTML = ''; });

describe('layer toggle off', () => {
  it('stops the overlay, and on starts a new one', async () => {
    const el = await mountCard({ show_alerts: true, show_layer_toggles: true }, cardHass());
    const layer = el._alertsLayer;
    expect(layer).toBeTruthy();
    const clear = vi.spyOn(layer, 'clear');
    const button = el._layerToggles._buttons.get('alerts');
    button.click();
    expect(clear).toHaveBeenCalledOnce();
    expect(el._alertsLayer).toBeNull();
    button.click();
    expect(el._alertsLayer).toBeTruthy();
    expect(el._alertsLayer).not.toBe(layer);
  });
});

describe('structural config change', () => {
  it('rebuilds the map once, after the debounce', async () => {
    const cfg = { type: 'custom:weather-radar-card', data_source: 'RainViewer' };
    const el = await mountCard(cfg, cardHass());
    const map = el._map;
    el.setConfig({ ...cfg, data_source: 'NOAA' });
    el.setConfig({ ...cfg, data_source: 'DWD' });
    expect(el._map).toBe(map);
    await tick(300);
    expect(el._map).toBeTruthy();
    expect(el._map).not.toBe(map);
  });
});

describe('configured centre edited while a preset is held', () => {
  it('drops the held preset and moves the map to the new centre', async () => {
    const cfg = {
      type: 'custom:weather-radar-card', center_latitude: 40, center_longitude: -100, zoom_level: 7,
      presets: [{ name: 'Bay', latitude: 37.6, longitude: -122.2, zoom: 9 }],
    };
    const el = await mountCard(cfg, cardHass());
    el._viewPresets.recenter();
    expect(el._viewPresets.held).toBe(0);
    el.setConfig({ ...cfg, center_latitude: 45 });
    expect(el._viewPresets.held).toBeNull();
    expect(el._map.getCenter().lat).toBeCloseTo(45, 3);
  });
});
