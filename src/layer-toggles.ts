import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { ViewerState } from './viewer-state';
import { isBlitzortungLoaded } from './lightning-helpers';
import { localize } from './localize/localize';

export type OverlayKey = 'alerts' | 'wind' | 'wildfires' | 'lightning';

// Left to right in the toggle bar.
const OVERLAYS: { key: OverlayKey; icon: string }[] = [
  { key: 'alerts', icon: 'mdi:alert' },
  { key: 'wind', icon: 'mdi:weather-windy' },
  { key: 'wildfires', icon: 'mdi:fire' },
  { key: 'lightning', icon: 'mdi:flash' },
];

export const OVERLAY_KEYS: OverlayKey[] = OVERLAYS.map((o) => o.key);

/**
 * Whether the config turns an overlay on. Only these get a toggle: the
 * dashboard's author decides what's available, the viewer what's showing.
 * Lightning also needs the Blitzortung integration, its data source.
 */
export function overlayConfigured(
  key: OverlayKey,
  cfg: WeatherRadarCardConfig,
  hass: HomeAssistant | undefined,
): boolean {
  switch (key) {
    case 'alerts': return cfg.show_alerts === true;
    case 'wind': return cfg.dwd_wind === 'barbs' || cfg.dwd_wind === 'arrows' || cfg.dwd_wind_flow === true;
    case 'wildfires': return cfg.show_wildfires === true;
    case 'lightning': return cfg.show_lightning === true && isBlitzortungLoaded(hass);
  }
}

const storageKey = (key: OverlayKey): string => `layer_${key}`;

/**
 * Which configured overlays the viewer has turned off: per user, across
 * devices, through ViewerState when viewer_layer_control is on; otherwise
 * until the page reloads. Sparse, as for playback speed: only a hidden
 * overlay is stored, so showing it again defers to the config.
 */
export class OverlayVisibility {
  private readonly _session = new Map<OverlayKey, false>();

  constructor(private readonly _state: () => ViewerState | null) {}

  isOn(key: OverlayKey): boolean {
    const state = this._state();
    if (state?.isActive) return state.get<boolean>(storageKey(key)) !== false;
    return !this._session.has(key);
  }

  set(key: OverlayKey, on: boolean): void {
    const state = this._state();
    if (on) {
      this._session.delete(key);
      state?.delete(storageKey(key));
    } else {
      this._session.set(key, false);
      state?.set(storageKey(key), false);
    }
  }
}

export interface LayerToggleBarOptions {
  layers: OverlayKey[];
  isOn: (key: OverlayKey) => boolean;
  onToggle: (key: OverlayKey, on: boolean) => void;
}

/** A row of overlay on/off buttons in the map's top-right corner. */
export class LayerToggleBar extends L.Control {
  private readonly _buttons = new Map<OverlayKey, HTMLAnchorElement>();

  constructor(private readonly _opts: LayerToggleBarOptions) {
    super({ position: 'topright' });
  }

  onAdd(): HTMLElement {
    const bar = L.DomUtil.create('div', 'leaflet-bar radar-layer-toggles');
    L.DomEvent.disableClickPropagation(bar);
    for (const { key, icon } of OVERLAYS) {
      if (!this._opts.layers.includes(key)) continue;
      const a = L.DomUtil.create('a', 'radar-layer-toggle', bar) as HTMLAnchorElement;
      a.href = '#';
      a.setAttribute('role', 'button');
      const name = localize(`ui.layers.${key}`);
      a.title = name;
      a.setAttribute('aria-label', name);
      L.DomUtil.create('ha-icon', '', a).setAttribute('icon', icon);
      L.DomEvent.on(a, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        this._opts.onToggle(key, !this._opts.isOn(key));
        this.sync();
      });
      this._buttons.set(key, a);
    }
    this.sync();
    return bar;
  }

  /** Show each button's current state, e.g. once a viewer's saved choices load. */
  sync(): void {
    for (const [key, a] of this._buttons) {
      const on = this._opts.isOn(key);
      a.classList.toggle('off', !on);
      a.setAttribute('aria-pressed', String(on));
    }
  }
}
