import { HomeAssistant } from 'custom-card-helpers';
import { Marker, ViewPreset, WeatherRadarCardConfig } from './types';
import { entityPosition, movedBeyondJitter, resolveTracking } from './marker-utils';
import { localize } from './localize/localize';

export const DEFAULT_PRESET_TIMEOUT_MIN = 5;

// Following an entity re-pans only past ~10 m (movedBeyondJitter), which is
// a few pixels at the deepest zoom; this tolerance keeps a followed stop
// counting as "on it" through that slack.
const ON_STOP_PX = 10;

type LatLon = { lat: number; lon: number };

// The editor and its preview card talk through window events, as the
// centre back-propagation does. The open preset also lives on window, so a
// preview rebuilt or mounted after the editor still finds it.
/** Editor → preview: the preset open in the editor, or null. */
export const PRESET_FOCUS_EVENT = 'weather-radar-preset-focus';
/** Preview → editor: the map was moved by hand while a preset was open. */
export const PRESET_MAP_EVENT = 'weather-radar-preset-map';

export interface PresetMapMove {
  index: number;
  latitude: number;
  longitude: number;
  zoom: number;
}

type PresetFocusWindow = { __weatherRadarPresetFocus?: number | null };

export function setEditorPresetFocus(index: number | null): void {
  (window as PresetFocusWindow).__weatherRadarPresetFocus = index;
  window.dispatchEvent(new CustomEvent(PRESET_FOCUS_EVENT, { detail: { index } }));
}

export function editorPresetFocus(): number | null {
  const v = (window as PresetFocusWindow).__weatherRadarPresetFocus;
  return typeof v === 'number' ? v : null;
}

/** A rotation stop: the live tracked marker, the configured view, or a preset index. */
export type StopKey = 'tracked' | 'default' | number;

/** Idle time before a held stop returns to rest, or null for never. */
export function presetTimeoutMs(cfg: Pick<WeatherRadarCardConfig, 'preset_timeout'>): number | null {
  const v = cfg.preset_timeout;
  const min = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : DEFAULT_PRESET_TIMEOUT_MIN;
  return min === 0 ? null : min * 60_000;
}

/** show_recenter, on by default once presets exist: the button is how they're reached. */
export function recenterRequested(cfg: Pick<WeatherRadarCardConfig, 'show_recenter' | 'presets'>): boolean {
  return cfg.show_recenter ?? (cfg.presets?.length ?? 0) > 0;
}

/** Where a preset points now: its entity while that reports a position, else its coordinates. */
export function presetPosition(p: ViewPreset, hass: HomeAssistant | undefined): LatLon | null {
  const live = p.entity ? entityPosition(hass, p.entity) : null;
  if (live) return live;
  if (Number.isFinite(p.latitude) && Number.isFinite(p.longitude)) {
    return { lat: p.latitude as number, lon: p.longitude as number };
  }
  return null;
}

function entityName(hass: HomeAssistant | undefined, entityId: string): string {
  const friendly = hass?.states[entityId]?.attributes?.friendly_name;
  return typeof friendly === 'string' && friendly ? friendly : entityId;
}

export function presetName(p: ViewPreset, index: number, hass: HomeAssistant | undefined): string {
  const name = p.name?.trim();
  if (name) return name;
  if (p.entity) return entityName(hass, p.entity);
  return localize('ui.preset_n', '{n}', String(index + 1));
}

/**
 * The marker the card follows, when its entity reports a position. A
 * tracked marker without one (no GPS, unavailable, or a static track: true
 * marker) isn't a stop: the card has nothing live to show for it.
 */
export function liveTrackedStop(
  markers: Marker[],
  hass: HomeAssistant | undefined,
): (LatLon & { entity: string; name: string }) | null {
  const winner = resolveTracking(markers, hass, 0, 0);
  const entity = winner ? markers[winner.markerIndex].entity : undefined;
  const pos = entity ? entityPosition(hass, entity) : null;
  return entity && pos ? { ...pos, entity, name: entityName(hass, entity) } : null;
}

/**
 * Where a re-centre press goes. Off the current stop (panned, zoomed, or a
 * followed entity moved out of view): back to it, as the button did before
 * presets. On it: the next stop, wrapping to the first.
 */
export function nextStop(stops: StopKey[], current: StopKey, onStop: boolean): StopKey {
  if (!onStop) return current;
  return stops[(stops.indexOf(current) + 1) % stops.length];
}

/** The slice of L.Map the rotation drives; tests pass a fake. */
export interface PresetMap {
  getCenter(): { lat: number; lng: number };
  getZoom(): number;
  getMinZoom(): number;
  getMaxZoom(): number;
  setView(center: [number, number], zoom: number): unknown;
  panTo(center: [number, number]): unknown;
  project(latlng: [number, number], zoom: number): { x: number; y: number };
}

export interface StopChange {
  /** The stop holding the map instead of rest (tracking paused, idle timer running); null at rest. */
  held: 'default' | number | null;
  /** Text beside the re-centre button; null hides it. */
  label: string | null;
  /** Presets keep their label as a tap-to-clear chip; Default and the tracked marker show it briefly. */
  sticky: boolean;
}

export interface PresetHost {
  map: PresetMap;
  getConfig(): WeatherRadarCardConfig;
  getHass(): HomeAssistant | undefined;
  /** The configured centre: where re-centre went before presets. */
  defaultCenter(): LatLon;
  /** Called before the map moves, so the host can treat the move as programmatic. */
  onChange(change: StopChange): void;
}

/**
 * The re-centre button's rotation: the live tracked marker (if any),
 * Default, then each preset with a position. Rest is the first stop. Any
 * other stop is held: tracking stops panning the map, and after
 * preset_timeout idle minutes the rotation returns to rest. A held entity
 * preset follows its entity instead. With Default the only stop, a press
 * just re-centres, as the button did before presets.
 */
export class ViewPresets {
  private _held: 'default' | number | null = null;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _lastFollowed: LatLon | null = null;
  // The preset open in the editor, held for as long as it's open.
  private _editing: number | null = null;

  constructor(private readonly _host: PresetHost) {}

  /** The stop holding the map, or null at rest. */
  get held(): 'default' | number | null {
    return this._held;
  }

  /** True while a stop other than rest holds the map; tracking must not pan it. */
  get isHolding(): boolean {
    return this._held !== null;
  }

  // While the editor has a preset open, re-centre and the chip return to
  // it: a pan elsewhere would write nothing, so the rotation is no use there.
  recenter(): void {
    if (this._editing !== null) { this._go(this._editing); return; }
    const current = this._currentKey();
    const view = this._view(current);
    this._go(nextStop(this._stops(), current, !view || this._isAt(view)));
  }

  /** Back to rest: the live tracked marker, else Default. */
  clear(): void {
    this._go(this._editing ?? this._stops()[0]);
  }

  /** The user touched the map: restart the idle countdown. */
  touch(): void {
    if (this._held !== null) this._arm();
  }

  /** Forget the held stop without moving: the configured view was edited and moves the map itself. */
  drop(): void {
    if (this._held === null) return;
    this._held = null;
    this._disarm();
    this._host.onChange({ held: null, label: null, sticky: false });
  }

  /**
   * The editor has preset i open: hold it with no idle timeout, so the
   * preview shows what's being edited; null hands the map back to rest. A
   * preset already in view isn't re-shown, so a map drag written back to
   * the config doesn't jump the map.
   */
  edit(i: number | null): void {
    const was = this._editing;
    this._editing = i;
    if (i === null) {
      if (was !== null) this.clear();
      return;
    }
    const view = this._view(i);
    if (this._held === i && (!view || this._isAt(view))) return;
    this._go(i);
  }

  /** On a hass update: keep a held entity preset in view as it moves. */
  follow(): void {
    if (typeof this._held !== 'number') return;
    const p = this._presets()[this._held];
    const pos = p?.entity ? presetPosition(p, this._host.getHass()) : null;
    if (!pos || (this._lastFollowed && !movedBeyondJitter(this._lastFollowed, pos))) return;
    this._lastFollowed = pos;
    this._host.map.panTo([pos.lat, pos.lon]);
  }

  /** The stop the next press goes to, for the button's tooltip. */
  nextLabel(): string {
    const stops = this._stops();
    if (this._editing !== null) return this._label(this._editing);
    if (stops.length === 1) return localize('ui.recenter');
    const current = this._currentKey();
    const view = this._view(current);
    return this._label(nextStop(stops, current, !view || this._isAt(view)));
  }

  dispose(): void {
    this._disarm();
  }

  private _presets(): ViewPreset[] {
    return this._host.getConfig().presets ?? [];
  }

  private _tracked(): (LatLon & { entity: string; name: string }) | null {
    return liveTrackedStop(this._host.getConfig().markers ?? [], this._host.getHass());
  }

  private _stops(): StopKey[] {
    const hass = this._host.getHass();
    const tracked = this._tracked();
    const stops: StopKey[] = tracked ? ['tracked', 'default'] : ['default'];
    const defaultZoom = this._snapZoom(this._host.getConfig().zoom_level ?? 7);
    this._presets().forEach((p, i) => {
      if (!presetPosition(p, hass)) return;
      // A preset of the tracked entity at the card's zoom is the tracked
      // stop again; at another zoom it's a stop of its own.
      if (tracked && p.entity === tracked.entity && this._presetZoom(p) === defaultZoom) return;
      stops.push(i);
    });
    return stops;
  }

  private _currentKey(): StopKey {
    if (this._held !== null) return this._held;
    return this._tracked() ? 'tracked' : 'default';
  }

  private _view(key: StopKey): (LatLon & { zoom: number }) | null {
    let pos: LatLon | null;
    let zoom = this._snapZoom(this._host.getConfig().zoom_level ?? 7);
    if (key === 'tracked') {
      pos = this._tracked();
    } else if (key === 'default') {
      pos = this._host.defaultCenter();
    } else {
      const p = this._presets()[key];
      pos = p ? presetPosition(p, this._host.getHass()) : null;
      if (p) zoom = this._presetZoom(p);
    }
    return pos ? { lat: pos.lat, lon: pos.lon, zoom } : null;
  }

  private _presetZoom(p: ViewPreset): number {
    return this._snapZoom(Number.isFinite(p.zoom) ? p.zoom as number : this._host.getConfig().zoom_level ?? 7);
  }

  // Leaflet snaps setView's zoom to whole levels within the map's range.
  // Unsnapped, a preset at zoom 18 would never read as "on it" and the
  // button would keep returning there instead of moving on.
  private _snapZoom(zoom: number): number {
    const map = this._host.map;
    return Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), Math.round(zoom)));
  }

  private _isAt(view: LatLon & { zoom: number }): boolean {
    const map = this._host.map;
    if (Math.abs(map.getZoom() - view.zoom) > 0.01) return false;
    // Absolute pixels rather than container points, which depend on the
    // map's size (and collapse to the origin in a zero-size test map).
    const c = map.getCenter();
    const a = map.project([c.lat, c.lng], view.zoom);
    const b = map.project([view.lat, view.lon], view.zoom);
    return Math.hypot(a.x - b.x, a.y - b.y) <= ON_STOP_PX;
  }

  private _label(key: StopKey): string {
    if (key === 'tracked') return this._tracked()?.name ?? localize('ui.stop_default');
    if (key === 'default') return localize('ui.stop_default');
    return presetName(this._presets()[key] ?? {}, key, this._host.getHass());
  }

  private _go(key: StopKey): void {
    // Default is held only when there's a tracked marker it pauses.
    this._held = key === 'tracked' || (key === 'default' && !this._tracked()) ? null : key;
    if (this._held === null) this._disarm();
    else this._arm();
    const view = this._view(key);
    this._lastFollowed = typeof key === 'number' && view ? { lat: view.lat, lon: view.lon } : null;
    // A lone Default stop is plain re-centring: nothing to tell apart.
    const label = this._stops().length > 1 ? this._label(key) : null;
    this._host.onChange({ held: this._held, label, sticky: typeof key === 'number' });
    if (view) this._host.map.setView([view.lat, view.lon], view.zoom);
  }

  private _arm(): void {
    this._disarm();
    if (this._editing !== null) return;
    const ms = presetTimeoutMs(this._host.getConfig());
    if (ms === null) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.clear();
    }, ms);
  }

  private _disarm(): void {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
  }
}
