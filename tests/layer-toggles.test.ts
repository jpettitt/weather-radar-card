// Overlay toggles: which overlays get one, how a viewer's choices are kept
// (a real ViewerState over a faked hass.callWS), and the top-right bar
// built with real Leaflet DOM helpers.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as L from 'leaflet';
import type { HomeAssistant } from 'custom-card-helpers';
import {
  LayerToggleBar, OverlayKey, OverlayVisibility, OVERLAY_KEYS, overlayConfigured,
} from '../src/layer-toggles';
import { ViewerState, _resetLiveCardsForTests } from '../src/viewer-state';
import type { WeatherRadarCardConfig } from '../src/types';

const cfg = (c: Partial<WeatherRadarCardConfig>) => ({ type: 'custom:weather-radar-card', ...c }) as WeatherRadarCardConfig;
const withBlitzortung = { config: { components: ['blitzortung'] } } as unknown as HomeAssistant;

describe('overlayConfigured', () => {
  it('follows show_alerts and show_wildfires', () => {
    expect(overlayConfigured('alerts', cfg({ show_alerts: true }), undefined)).toBe(true);
    expect(overlayConfigured('alerts', cfg({}), undefined)).toBe(false);
    expect(overlayConfigured('wildfires', cfg({ show_wildfires: true }), undefined)).toBe(true);
    expect(overlayConfigured('wildfires', cfg({ show_wildfires: false }), undefined)).toBe(false);
  });

  it('counts barbs, arrows or streamlines as wind', () => {
    expect(overlayConfigured('wind', cfg({ dwd_wind: 'barbs' }), undefined)).toBe(true);
    expect(overlayConfigured('wind', cfg({ dwd_wind: 'arrows' }), undefined)).toBe(true);
    expect(overlayConfigured('wind', cfg({ dwd_wind_flow: true }), undefined)).toBe(true);
    expect(overlayConfigured('wind', cfg({ dwd_wind: 'off' }), undefined)).toBe(false);
  });

  it('needs the Blitzortung integration for lightning', () => {
    expect(overlayConfigured('lightning', cfg({ show_lightning: true }), withBlitzortung)).toBe(true);
    expect(overlayConfigured('lightning', cfg({ show_lightning: true }), undefined)).toBe(false);
    expect(overlayConfigured('lightning', cfg({}), withBlitzortung)).toBe(false);
  });
});

describe('OverlayVisibility', () => {
  it('without stored state, shows everything until hidden, for this page load', () => {
    const v = new OverlayVisibility(() => null);
    expect(OVERLAY_KEYS.every((k) => v.isOn(k))).toBe(true);
    v.set('wildfires', false);
    expect(v.isOn('wildfires')).toBe(false);
    expect(v.isOn('alerts')).toBe(true);
    v.set('wildfires', true);
    expect(v.isOn('wildfires')).toBe(true);
  });

  describe('with viewer_layer_control on', () => {
    let callWS: ReturnType<typeof vi.fn>;
    let state: ViewerState;

    beforeEach(() => {
      _resetLiveCardsForTests();
      window.history.replaceState({}, '', '/lovelace/0');
      callWS = vi.fn(async () => ({}));
      const config = cfg({ viewer_layer_control: true, _layer_state_id: { dash: '/lovelace/0', nonce: 'n1' } });
      state = new ViewerState({ hass: { callWS } as unknown as HomeAssistant, getConfig: () => config });
      state.ensureIdentity();
    });

    afterEach(() => {
      state.dispose();
    });

    it('reads a choice saved on another device', async () => {
      callWS.mockResolvedValueOnce({ value: { layer_alerts: false } });
      await state.hydrate();
      const v = new OverlayVisibility(() => state);
      expect(v.isOn('alerts')).toBe(false);
      expect(v.isOn('wind')).toBe(true);
    });

    it('stores only a hidden overlay, and showing it again removes the entry', async () => {
      await state.hydrate();
      const v = new OverlayVisibility(() => state);
      v.set('lightning', false);
      expect(state.get('layer_lightning')).toBe(false);
      v.set('lightning', true);
      expect(state.get('layer_lightning')).toBeUndefined();
      expect(v.isOn('lightning')).toBe(true);
    });
  });
});

describe('ViewerState.isHydrated', () => {
  it('turns true once the read finishes, even a failed one', async () => {
    _resetLiveCardsForTests();
    window.history.replaceState({}, '', '/lovelace/0');
    const callWS = vi.fn(async () => { throw new Error('ws down'); });
    const config = cfg({ viewer_layer_control: true, _layer_state_id: { dash: '/lovelace/0', nonce: 'n2' } });
    const state = new ViewerState({ hass: { callWS } as unknown as HomeAssistant, getConfig: () => config });
    state.ensureIdentity();
    expect(state.isHydrated).toBe(false);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await state.hydrate();
    expect(state.isHydrated).toBe(true);
    state.dispose();
  });
});

describe('LayerToggleBar', () => {
  function build(layers: OverlayKey[], hidden: OverlayKey[] = []) {
    const off = new Set(hidden);
    const onToggle = vi.fn((key: OverlayKey, on: boolean) => { if (on) off.delete(key); else off.add(key); });
    const bar = new LayerToggleBar({ layers, isOn: (k) => !off.has(k), onToggle });
    const el = bar.onAdd();
    const buttons = [...el.querySelectorAll('a')] as HTMLAnchorElement[];
    return { bar, el, buttons, onToggle, off };
  }

  it('has a button for each configured overlay, in a fixed order', () => {
    const { buttons } = build(['lightning', 'wind', 'alerts', 'wildfires']);
    expect(buttons.map((a) => a.title)).toEqual(['NWS alerts', 'Wind', 'Wildfires', 'Lightning']);
    expect(buttons.map((a) => a.querySelector('ha-icon')!.getAttribute('icon')))
      .toEqual(['mdi:alert', 'mdi:weather-windy', 'mdi:fire', 'mdi:flash']);
  });

  it('is a Leaflet bar of keyboard-reachable buttons', () => {
    const { el, buttons } = build(['alerts']);
    expect(el.classList.contains('leaflet-bar')).toBe(true);
    expect(el.classList.contains('radar-layer-toggles')).toBe(true);
    // An anchor without an href can't take keyboard focus.
    expect(buttons[0].getAttribute('href')).toBe('#');
    expect(buttons[0].getAttribute('role')).toBe('button');
    expect(buttons[0].getAttribute('aria-label')).toBe('NWS alerts');
  });

  it("doesn't follow the button's # link", () => {
    const { buttons } = build(['alerts']);
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    buttons[0].dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('sits top-right, apart from the playback toolbar', () => {
    expect(build(['wind']).bar.getPosition()).toBe('topright');
  });

  it('shows hidden overlays dimmed and unpressed', () => {
    const { buttons } = build(['alerts', 'wind'], ['wind']);
    expect(buttons.map((a) => a.getAttribute('aria-pressed'))).toEqual(['true', 'false']);
    expect(buttons[1].classList.contains('off')).toBe(true);
    expect(buttons[0].classList.contains('off')).toBe(false);
  });

  it('a tap flips that overlay and redraws the button', () => {
    const { buttons, onToggle } = build(['alerts', 'wind']);
    buttons[1].click();
    expect(onToggle).toHaveBeenLastCalledWith('wind', false);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('false');
    buttons[1].click();
    expect(onToggle).toHaveBeenLastCalledWith('wind', true);
    expect(buttons[1].classList.contains('off')).toBe(false);
  });

  it('sync picks up choices that change underneath it', () => {
    const { bar, buttons, off } = build(['wildfires']);
    off.add('wildfires');
    bar.sync();
    expect(buttons[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('keeps taps off the map', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const map = L.map(el).setView([0, 0], 3);
    const onClick = vi.fn();
    map.on('click', onClick);
    const bar = new LayerToggleBar({ layers: ['alerts'], isOn: () => true, onToggle: vi.fn() });
    bar.addTo(map);
    el.querySelector<HTMLAnchorElement>('.radar-layer-toggle')!.click();
    expect(onClick).not.toHaveBeenCalled();
    // The same tap on the map itself does reach it, so the check above can fail.
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
    expect(onClick).toHaveBeenCalledOnce();
    map.remove();
  });
});
