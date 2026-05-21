/* eslint-disable @typescript-eslint/no-explicit-any */
import { LitElement, html, css, unsafeCSS, TemplateResult, PropertyValues } from 'lit';
import { property, customElement, state } from 'lit/decorators.js';
import { HomeAssistant, LovelaceCardEditor, LovelaceCard, handleAction, ActionConfig } from 'custom-card-helpers';
import * as L from 'leaflet';
// @ts-expect-error — rollup-plugin-string imports CSS as a raw string
import leafletCss from 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
// @ts-expect-error — rollup-plugin-string imports CSS as a raw string
import markerClusterCss from 'leaflet.markercluster/dist/MarkerCluster.css';

import './editor';
import { WeatherRadarCardConfig, Marker } from './types';
import { CARD_VERSION, BUILD_TIMESTAMP, Z_BASEMAP, Z_LABELS } from './const';
import { getEffectiveTimeRange } from './source-caps';
import { localize } from './localize/localize';
import { rainviewerLimiter, noaaLimiter, dwdLimiter } from './rate-limiters';
import { FetchTileLayer } from './fetch-tile-layer';
import { WindOverlay } from './wind-overlay';
import { defaultWindSourceForLocation, DEFAULT_WIND_SOURCE } from './wind-source-caps';
import { WindFlowOverlay } from './wind-flow-overlay';
import { RadarToolbar, SPEED_STEPS } from './radar-toolbar';
import { RadarPlayer } from './radar-player';

// localStorage key for the toolbar's playback-speed multiplier. Shared
// across every weather-radar-card on the page so a user-set speed
// preference applies wherever the card is embedded.
const PLAYBACK_SPEED_KEY = 'wrc-playback-speed';

// Clamp to the SPEED_STEPS range. Values outside it indicate either a
// stale localStorage entry from a future version with different presets
// or a YAML config someone typed by hand. Either way the sensible
// behaviour is to pin to the nearest supported preset rather than
// freezing the loop at an extreme value.
function clampSpeed(n: number): number {
  const lo = SPEED_STEPS[0];
  const hi = SPEED_STEPS[SPEED_STEPS.length - 1];
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

// Resolve the effective starting playback speed. localStorage (the
// user's button-click preference) wins if set, otherwise the card's
// playback_speed config value, otherwise 1×. Each layer parses and
// clamps independently so a corrupt entry doesn't poison the chain.
function resolvePlaybackSpeed(stored: string | null, configDefault: number | undefined): number {
  if (stored != null) {
    const n = Number(stored);
    if (Number.isFinite(n) && n > 0) return clampSpeed(n);
  }
  if (typeof configDefault === 'number' && Number.isFinite(configDefault) && configDefault > 0) {
    return clampSpeed(configDefault);
  }
  return 1;
}
import {
  isMobileDevice,
  getCurrentUserInfo,
  getCoordinateConfig,
  resolveCoordinatePair,
} from './coordinate-utils';
import { createMarkerIconForMarker, HOME_PATH } from './marker-icon';
import { migrateConfig, resolveMarkerPosition, resolveTracking } from './marker-utils';
import { WildfireLayer } from './wildfire-layer';
import { NwsAlertsLayer } from './nws-alerts-layer';
import { LightningLayer } from './lightning-layer';
import { isBlitzortungLoaded } from './lightning-helpers';
import { getRegionWarnings } from './region-warning';
import {
  PROGRESS_BAR_TRACK_HEIGHT,
  progressBarFrameIndex,
  resolveProgressBarTouchHeight,
} from './progress-bar-utils';

/* eslint no-console: 0 */
console.info(
  `%c  WEATHER-RADAR-CARD \n%c  ${localize('common.version')} ${CARD_VERSION}  (built ${BUILD_TIMESTAMP})    `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'weather-radar-card',
  name: 'Weather Radar Card',
  description: 'A rain radar card using tiled imagery from RainViewer, NOAA/NWS, and DWD',
  // Tell HA's card picker to render a live preview (defaults to false on
  // unknown custom cards, so without this we get just the name +
  // description tile — no map. The card uses getStubConfig() below to
  // pick the preview / initial config.)
  preview: true,
  documentationURL: 'https://github.com/jpettitt/weather-radar-card',
});

@customElement('weather-radar-card')
export class WeatherRadarCard extends LitElement implements LovelaceCard {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    return document.createElement('weather-radar-card-editor') as LovelaceCardEditor;
  }
  // Picked by HA's card-picker to render the preview AND used as the
  // initial config when the user adds the card to a dashboard. Keep
  // it compact enough to fit the picker pane (~250px tall) but
  // representative of what the card normally does — RainViewer, home
  // marker (auto-created by migrateConfig from absent markers[]),
  // default crossfade. The user tunes from here.
  //
  // wind_source is set here based on HA location so a fresh-install
  // user in the US automatically gets NDFD (~2.5 km regional forecast)
  // when they later turn the wind overlay on. Existing configs (which
  // never went through this code path) lack wind_source entirely and
  // fall back at runtime to ICON-D2 globally — see DEFAULT_WIND_SOURCE.
  public static getStubConfig(hass?: HomeAssistant): Record<string, unknown> {
    const stub: Record<string, unknown> = { height: '220px' };
    if (hass?.config) {
      const lat = hass.config.latitude;
      const lon = hass.config.longitude;
      const country = (hass.config as { country?: string }).country;
      stub.wind_source = defaultWindSourceForLocation(lat, lon, country);
    }
    return stub;
  }

  // ── HA properties ────────────────────────────────────────────────────────

  @property({ type: Boolean, reflect: true }) public isPanel = false;
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) private _config!: WeatherRadarCardConfig;
  @property({ attribute: false }) public editMode?: boolean;

  // ── Map / player state ────────────────────────────────────────────────────

  private _map: L.Map | null = null;
  private _currentMapStyle: string | null = null;
  private _townLayer: FetchTileLayer | null = null;
  private _windOverlay: WindOverlay | null = null;
  private _windFlow: WindFlowOverlay | null = null;
  private _toolbar: RadarToolbar | null = null;
  private _markers: Map<number, L.Marker> = new Map();
  private _clusterGroup: L.MarkerClusterGroup | null = null;
  private _trackedMarkerIdx = -1;
  private _clusterSpiderfied = false;
  private _lastTrackedPosition: { lat: number; lon: number } | null = null;
  private _rangeRings: L.Circle[] = [];
  private _dynamicStyleEl!: HTMLStyleElement;
  private _player: RadarPlayer | null = null;
  private _wildfireLayer: WildfireLayer | null = null;
  private _alertsLayer: NwsAlertsLayer | null = null;
  private _lightningLayer: LightningLayer | null = null;

  // True while the user is actively editing this card via HA's edit dialog.
  // Detected via window-level events from the editor element's lifecycle —
  // we can't infer it from the card's `editMode` property, which only tells
  // us the dashboard is editable, not whether the card's edit dialog is open.
  // Used to decide whether to auto-propagate pan/zoom into the editor's
  // Lat/Long/Zoom fields.
  @state() private _editorOpen = false;
  private _editorOpenedHandler: (() => void) | null = null;
  private _editorClosedHandler: (() => void) | null = null;
  private _userMoveInProgress = false;

  private _navReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private _visObserver: IntersectionObserver | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _visibilityHandler: (() => void) | null = null;
  private _navContainer: HTMLElement | null = null;
  private _markUserMove: (() => void) | null = null;
  private _darkModeQuery: MediaQueryList | null = null;
  private _darkModeHandler: (() => void) | null = null;

  // Per-source rate limiters live as module-level singletons in
  // ./rate-limiters so the sliding-window count survives card teardown
  // (config edit) AND is shared across multiple card instances on the
  // dashboard. See that file for rate choices.

  // ── Helpers ───────────────────────────────────────────────────────────────

  private _effectiveMapStyle(): string {
    const configured = this._config?.map_style?.toLowerCase();
    if (configured && configured !== 'auto') return configured;
    const isEnglish = (this.hass?.language ?? 'en').startsWith('en');
    // Follow HA's dark-mode flag when available — the user can set it directly
    // or have HA follow the browser. Fall back to OS prefs only if HA hasn't
    // exposed a value yet.
    const haDark = (this.hass as any)?.themes?.darkMode;
    const isDark = typeof haDark === 'boolean'
      ? haDark
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (isDark) return 'dark';
    return isEnglish ? 'light' : 'osm';
  }

  private _validateCssSize(value: string): boolean {
    return /^\d+(\.\d+)?(px|%|em|rem|vh|vw)$/.test(value);
  }

  private _calculateHeight(): string {
    const cfg = this._config;
    if (cfg.height && this._validateCssSize(cfg.height)) return cfg.height;
    return '400px';
  }

  /**
   * Detect whether we're being rendered inside HA's card-add picker.
   * Walks up through both light DOM and shadow DOM hosts looking for a
   * `hui-card-picker` ancestor. Hass alone is not a reliable signal —
   * the picker passes hass through like a normal mount.
   */
  private _isInPickerPreview(): boolean {
    let el: Node | null = this.parentNode ?? (this.getRootNode() as ShadowRoot)?.host ?? null;
    while (el) {
      const tag = (el as Element)?.tagName?.toLowerCase?.();
      if (tag === 'hui-card-picker') return true;
      el = (el as ShadowRoot).host ?? el.parentNode;
    }
    return false;
  }

  // ── HA lifecycle ──────────────────────────────────────────────────────────

  public setConfig(config: WeatherRadarCardConfig): void {
    if (config.height && config.square_map) {
      console.warn("Weather Radar Card: Both 'height' and 'square_map' configured. height takes priority.");
    }
    const oldConfig = this._config;
    this._config = this._migrateConfig(config);
    // Any structural change → full reset. Stale CSS-transition state on
    // radar layers from the previous animation regime is the cleanest to
    // wipe by destroying the map and rebuilding. The exception is the
    // back-propagated map view (center_latitude / center_longitude /
    // zoom_level): the user is mid-pan/zoom and a teardown would interrupt
    // them. Ignore those keys for the diff.
    if (this._map && oldConfig && this._isOnlyViewBackpropChange(oldConfig, this._config)) {
      // Direct YAML edits of lat/lon/zoom still need to move the map. Skip
      // when the live view already matches (the back-prop case), otherwise
      // setView would re-fire moveend and bounce another config update.
      this._syncMapViewIfNeeded();
      return;
    }
    if (this._map) {
      this._teardown();
      this._initMap();
    }
  }

  private _syncMapViewIfNeeded(): void {
    if (!this._map || !this._config) return;
    const isMobile = isMobileDevice();
    const haLat = this.hass?.config?.latitude ?? 0;
    const haLon = this.hass?.config?.longitude ?? 0;
    const target = resolveCoordinatePair(
      getCoordinateConfig(this._config.center_latitude, undefined, isMobile),
      getCoordinateConfig(this._config.center_longitude, undefined, isMobile),
      haLat, haLon, this.hass,
    );
    const targetZoom = this._config.zoom_level ?? 7;
    const current = this._map.getCenter();
    const r4 = (n: number): number => Math.round(n * 10000) / 10000;
    if (r4(current.lat) === r4(target.lat)
      && r4(current.lng) === r4(target.lon)
      && this._map.getZoom() === targetZoom) return;
    this._map.setView([target.lat, target.lon], targetZoom);
  }

  private _isOnlyViewBackpropChange(a: WeatherRadarCardConfig, b: WeatherRadarCardConfig): boolean {
    const VIEW_KEYS = new Set(['center_latitude', 'center_longitude', 'zoom_level']);
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    let changed = false;
    for (const k of keys) {
      const av = JSON.stringify((a as Record<string, unknown>)[k]);
      const bv = JSON.stringify((b as Record<string, unknown>)[k]);
      if (av === bv) continue;
      if (!VIEW_KEYS.has(k)) return false;
      changed = true;
    }
    return changed;
  }

  private _migrateConfig(config: WeatherRadarCardConfig): WeatherRadarCardConfig {
    const result = migrateConfig(config);
    if (result !== config) {
      // Only warn when legacy fields were actually present — not for the
      // synthesised default zone.home marker on a brand-new config.
      const hadLegacy = config.show_marker !== undefined
        || config.marker_latitude !== undefined
        || config.marker_longitude !== undefined
        || config.mobile_marker_latitude !== undefined
        || config.mobile_marker_longitude !== undefined
        || config.marker_icon !== undefined
        || config.marker_icon_entity !== undefined
        || config.mobile_marker_icon !== undefined
        || config.mobile_marker_icon_entity !== undefined;
      if (hadLegacy) {
        console.warn('Weather Radar Card: single-marker config fields are deprecated. Migrate to the markers[] array format.');
      }
    }
    return result;
  }

  public getCardSize(): number { return 10; }

  /**
   * Tells HA's sections-view grid the card knows how to resize, which
   * suppresses the "may not display correctly with custom sizes" banner.
   * Defaults match the card's typical 400px height: 4 rows × 56px
   * default density ≈ 224px (so the user can shrink down to roughly the
   * picker preview), up to 12 rows × 56px ≈ 672px wide-pane.
   *
   * The card's existing ResizeObserver (set up in `_setupResizeObserver`)
   * calls `_map.invalidateSize()` whenever the container changes shape,
   * so Leaflet's tiles reflow correctly when the grid cell resizes.
   */
  public getGridOptions(): {
    columns?: number | 'full';
    rows?: number | 'auto';
    min_columns?: number;
    min_rows?: number;
    max_columns?: number;
    max_rows?: number;
  } {
    return {
      columns: 12,        // full row by default
      rows: 7,            // ≈ 392 px at 56 px/row — close to the 400 px height default
      min_columns: 6,     // half a row minimum
      min_rows: 4,        // ≈ 224 px — readable even at the smallest
    };
  }

  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this._config) return false;
    return changedProps.has('_config') || changedProps.has('hass')
      || changedProps.has('editMode');
  }

  protected firstUpdated(): void {
    this._dynamicStyleEl = document.createElement('style');
    this._dynamicStyleEl.id = 'radar-dynamic';
    this.shadowRoot!.appendChild(this._dynamicStyleEl);
    this._setupProgressBarScrub();
    this._initMap();
  }

  protected updated(changedProps: PropertyValues): void {
    if (!this._map && this._config) {
      this._initMap();
    } else if (changedProps.has('hass') && this._map) {
      // HA dark-mode flip can change the effective map style — rebuild if so.
      if (this._effectiveMapStyle() !== this._currentMapStyle) {
        this._teardown();
        this._initMap();
        return;
      }
      if (this._markers.size > 0) {
        this._updateMarkerPositions();
        const hasTracking = (this._config?.markers ?? []).some(m => m.track);
        if (hasTracking) this._resolveTracking();
      }
      this._wildfireLayer?.updateHass(this.hass);
      this._alertsLayer?.updateHass(this.hass);
      this._lightningLayer?.updateHass(this.hass);
    }
  }

  public connectedCallback(): void {
    super.connectedCallback();
    // Listen for the editor element's lifecycle so we can switch on
    // auto-propagate of pan/zoom into the editor's Lat/Long/Zoom fields
    // ONLY while the user is editing this card. The editor dispatches the
    // events on its own connect/disconnect (see editor.ts).
    this._editorOpenedHandler = () => { this._editorOpen = true; };
    this._editorClosedHandler = () => { this._editorOpen = false; };
    window.addEventListener('weather-radar-editor-opened', this._editorOpenedHandler);
    window.addEventListener('weather-radar-editor-closed', this._editorClosedHandler);
    // Race fix: if the editor already mounted before us (preview card in
    // the edit dialog — order is up to HA), its 'opened' event has been
    // and gone. The editor maintains a global mount counter; consult it
    // so we don't get stuck with _editorOpen=false through the entire
    // edit session and silently never push pan/zoom back to the form.
    if ((window as unknown as { __weatherRadarCardEditorCount?: number }).__weatherRadarCardEditorCount) {
      this._editorOpen = true;
    }
    // HA detaches and re-attaches the card when re-organising the DOM
    // (entering edit mode, sections-grid layout changes). disconnectedCallback
    // calls _teardown() which removes the Leaflet map; connectedCallback
    // doesn't re-init on its own. Without nudging the lifecycle here, no
    // property changes after re-attach so updated() never fires and the
    // radar stays blank. requestUpdate forces an update cycle whose
    // updated() handler already has the `if (!this._map && this._config)`
    // → re-init path.
    if (this._config && !this._map) {
      this.requestUpdate();
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._editorOpenedHandler) window.removeEventListener('weather-radar-editor-opened', this._editorOpenedHandler);
    if (this._editorClosedHandler) window.removeEventListener('weather-radar-editor-closed', this._editorClosedHandler);
    this._editorOpenedHandler = null;
    this._editorClosedHandler = null;
    this._teardown();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): TemplateResult | void {
    if (!this._config) return html``;
    // Show a static preview image when rendered inside HA's card picker
    // dialog. Otherwise the picker would hammer the tile API on every
    // open AND the result looks like an empty map whenever there's no
    // current rain in the user's area.
    if (this._isInPickerPreview()) {
      return html`
        <ha-card>
          <img src="/local/community/weather-radar-card/preview.jpg"
               style="width:100%; display:block; border-radius: var(--ha-card-border-radius, 12px); object-fit: cover;"
               alt="Weather Radar Card preview" />
        </ha-card>
      `;
    }
    const mapStyle = this._effectiveMapStyle();
    const isMapDark = mapStyle === 'dark' || mapStyle === 'satellite';
    const dataSource = this._config.data_source ?? 'RainViewer';
    const showColourBar = this._config.show_color_bar !== false;
    const progressBarTouchHeight = resolveProgressBarTouchHeight(this._config.progress_bar_touch_height);
    const colourBarSrc = dataSource === 'NOAA'
      ? '/local/community/weather-radar-card/radar-colour-bar-nws.png'
      : dataSource === 'DWD'
        ? '/local/community/weather-radar-card/radar-colour-bar-dwd.png'
        : '/local/community/weather-radar-card/radar-colour-bar-universalblue.png';
    // Layout mode:
    //   aspect-mode → square_map without an explicit height. The map div
    //                 carries aspect-ratio:1/1 and the card grows to its
    //                 content (chrome stacks above + below). Pre-existing
    //                 behaviour, preserved as-is.
    //   flex-mode  → everything else. ha-card is a flex column with
    //                height:100% (fills sections-grid cells) AND
    //                min-height:<configured height> (preserves the user's
    //                expected baseline in regular dashboards). The map
    //                div is flex:1 so it absorbs whatever vertical room
    //                is left after the fixed-height chrome (color bar,
    //                progress bar, bottom bar).
    const isAspectMode = !!this._config.square_map && !this._config.height;
    const cardClasses = [
      isMapDark ? 'map-dark' : '',
      isAspectMode ? 'aspect-mode' : 'flex-mode',
    ].filter(Boolean).join(' ');
    const cardStyles: string[] = [];
    if (this._config.width && this._validateCssSize(this._config.width)) {
      cardStyles.push(`width:${this._config.width}`);
    }
    if (!isAspectMode) {
      cardStyles.push(`min-height:${this._calculateHeight()}`);
    }
    return html`
      <ha-card class=${cardClasses} style=${cardStyles.join(';')}>
        <div id="color-bar" style="height:8px;display:${showColourBar ? '' : 'none'}">
          <img id="img-color-bar" height="8" style="vertical-align:top" src=${colourBarSrc} />
        </div>
        <div id="banner-stack" class="banner-stack">
          ${getRegionWarnings(this.hass, this._config).map(msg => html`
            <div class="status-banner status-banner-info">${msg}</div>
          `)}
          <div id="rate-limit-banner" class="status-banner" style="display:none">
            ${localize('ui.rate_limited')}
          </div>
        </div>
        <div id="mapid"></div>
        <div id="div-progress-bar" style="height:${PROGRESS_BAR_TRACK_HEIGHT}px;display:${this._config.show_progress_bar === false ? 'none' : 'block'}">
          <div id="div-progress-touch-target" style="height:${progressBarTouchHeight}px">
            <div id="div-progress-track" style="height:${PROGRESS_BAR_TRACK_HEIGHT}px"></div>
          </div>
        </div>
        <div id="bottom-container">
          <div id="timestampid">
            <p id="timestamp"></p>
          </div>
          <div id="loading-spinner" class="loading-spinner" style="display:none" role="status" aria-live="polite" aria-label=${localize('ui.loading_radar_tiles')}>
            <div class="loading-spinner-arc" aria-hidden="true"></div>
          </div>
          <div id="attribution"></div>
        </div>
      </ha-card>
    `;
  }

  // ── Map init / teardown ───────────────────────────────────────────────────

  private _initMap(): void {
    const mapEl = this.shadowRoot?.getElementById('mapid');
    if (!mapEl || this._map) return;

    const cfg = this._config;
    const mapStyle = this._effectiveMapStyle();
    this._currentMapStyle = mapStyle;
    const isMobile = isMobileDevice();
    const userInfo = getCurrentUserInfo(this.hass);
    const haLat = this.hass?.config?.latitude ?? 0;
    const haLon = this.hass?.config?.longitude ?? 0;

    const center = resolveCoordinatePair(
      getCoordinateConfig(cfg.center_latitude, undefined, isMobile, userInfo?.deviceTracker),
      getCoordinateConfig(cfg.center_longitude, undefined, isMobile, userInfo?.deviceTracker),
      haLat, haLon, this.hass,
    );

    const isStatic = cfg.static_map === true;
    // Leaflet's built-in double-click zoom stays on for two cases: when no
    // double_tap_action is configured at all (back-compat default), and
    // when the user has explicitly chosen 'zoom_in' (the documented way
    // to keep the zoom behaviour now that 'none' truly means none).
    // Every other value (recenter, toggle_play, 'none', or an HA action
    // object) suppresses Leaflet zoom so it doesn't fight the custom action.
    const action = cfg.double_tap_action;
    const hasDoubleTapAction = action !== undefined && action !== 'zoom_in';
    this._map = L.map(mapEl as HTMLElement, {
      zoomControl: cfg.show_zoom === true && !isStatic,
      // Disable Leaflet's built-in double-click zoom when a custom action is configured.
      scrollWheelZoom: !isStatic, doubleClickZoom: !isStatic && !hasDoubleTapAction,
      boxZoom: !isStatic, dragging: !isStatic, keyboard: !isStatic, touchZoom: !isStatic,
      wheelPxPerZoomLevel: 120, attributionControl: false,
      minZoom: 3, maxZoom: 16,
    }).setView([center.lat, center.lon], cfg.zoom_level ?? 7);

    if (cfg.disable_scroll === true && !isStatic) {
      this._map.dragging.disable();
    }
    if (cfg.show_scale === true) {
      const metric = (this.hass?.config?.unit_system?.length ?? 'km') === 'km';
      L.control.scale({ imperial: !metric, metric }).addTo(this._map);
    }
    this._setupBasemap(mapStyle);
    this._setupWindOverlay();
    this._setupAttribution(mapStyle);
    this._setupMarkers(mapStyle);
    this._setupToolbar();
    this._setupNavListeners();
    this._setupDoubleTapAction();
    this._setupVisibilityObserver();
    this._setupResizeObserver();
    // For map_style: auto, reinit the map when the OS colour scheme changes so
    // the basemap tiles and scale-control styling swap. Chrome (footer, links)
    // follows HA theme variables and updates automatically.
    const isAuto = !cfg.map_style || cfg.map_style.toLowerCase() === 'auto';
    if (isAuto) {
      this._darkModeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this._darkModeHandler = () => {
        this._teardown();
        this.requestUpdate();
      };
      this._darkModeQuery.addEventListener('change', this._darkModeHandler);
    }

    // DWD-outside-coverage warning is surfaced as a status banner via
    // getRegionWarnings() in render() — a single visible UI cue users will
    // actually see, replacing the earlier one-shot console.warn that only
    // helped developers.

    this._player = new RadarPlayer({
      map: this._map,
      shadowRoot: this.shadowRoot!,
      getConfig: () => this._config,
      rainviewerLimiter,
      noaaLimiter,
      dwdLimiter,
    });
    this._player.toolbar = this._toolbar;
    // frame count is derived from past_minutes / forecast_minutes / stride
    // via getEffectiveTimeRange — passed in for back-compat with the
    // start(frameCount) signature. Player re-derives from this._cfg
    // internally too.
    this._player.start(getEffectiveTimeRange(cfg).frameCount);

    if (cfg.show_wildfires === true) {
      this._wildfireLayer = new WildfireLayer(this._map, () => this._config, this.hass);
      this._wildfireLayer.start();
    }

    if (cfg.show_alerts === true) {
      this._alertsLayer = new NwsAlertsLayer(this._map, () => this._config, this.hass);
      this._alertsLayer.start();
    }

    // Lightning overlay only attaches when the user has BOTH opted in via
    // config AND has the Blitzortung integration loaded. The integration
    // is the data source — without it the layer would silently render
    // nothing, so we don't even instantiate it.
    if (cfg.show_lightning === true && isBlitzortungLoaded(this.hass)) {
      this._lightningLayer = new LightningLayer(this._map, () => this._config, this.hass);
      this._lightningLayer.start();
    }
  }

  private _teardown(): void {
    if (this._navReloadTimer) clearTimeout(this._navReloadTimer);
    if (this._visObserver) { this._visObserver.disconnect(); this._visObserver = null; }
    if (this._resizeObserver) { this._resizeObserver.disconnect(); this._resizeObserver = null; }
    if (this._visibilityHandler) {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandler = null;
    }
    if (this._navContainer && this._markUserMove) {
      this._navContainer.removeEventListener('pointerdown', this._markUserMove);
      this._navContainer.removeEventListener('wheel', this._markUserMove);
      this._navContainer = null;
      this._markUserMove = null;
    }
    if (this._darkModeQuery && this._darkModeHandler) {
      this._darkModeQuery.removeEventListener('change', this._darkModeHandler);
      this._darkModeQuery = null;
      this._darkModeHandler = null;
    }
    this._player?.clear();
    this._player = null;
    this._wildfireLayer?.clear();
    this._wildfireLayer = null;
    this._alertsLayer?.clear();
    this._alertsLayer = null;
    this._lightningLayer?.clear();
    this._lightningLayer = null;
    if (this._clusterGroup) { this._clusterGroup.clearLayers(); this._clusterGroup = null; }
    this._clusterSpiderfied = false;
    if (this._map) { this._map.remove(); this._map = null; }
    this._currentMapStyle = null;
    this._townLayer = null;
    this._windOverlay?.destroy();
    this._windOverlay = null;
    this._windFlow?.destroy();
    this._windFlow = null;
    this._toolbar = null;
    this._markers.clear();
    this._trackedMarkerIdx = -1;
    this._lastTrackedPosition = null;
    this._rangeRings = [];
  }

  // ── Basemap ───────────────────────────────────────────────────────────────

  private _setupBasemap(mapStyle: string): void {
    if (!this._map) return;
    const cfg = this._config;
    const tileSize = cfg.extra_labels ? 128 : 256;
    const zoomOffset = cfg.extra_labels ? 1 : 0;

    let url: string, style = '', subdomains = 'abcd', labelUrl = '', osmLabels = false;
    switch (mapStyle) {
      case 'dark':
        url = 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png';
        style = 'dark_nolabels';
        labelUrl = 'https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}.png'; break;
      case 'voyager':
        url = 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png';
        style = 'rastertiles/voyager_nolabels';
        labelUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png'; break;
      case 'satellite':
        url = 'https://server.arcgisonline.com/ArcGIS/rest/services/{style}/MapServer/tile/{z}/{y}/{x}';
        style = 'World_Imagery';
        labelUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager_only_labels/{z}/{x}/{y}.png'; break;
      case 'osm':
        osmLabels = true; subdomains = 'abc';
        url = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'; break;
      default:
        url = 'https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}.png';
        style = 'light_nolabels';
        labelUrl = 'https://{s}.basemaps.cartocdn.com/light_only_labels/{z}/{x}/{y}.png';
    }

    new FetchTileLayer(url, { style, subdomains, detectRetina: false, tileSize, zoomOffset } as any)
      .addTo(this._map).setZIndex(Z_BASEMAP);

    if (!osmLabels && labelUrl) {
      this._townLayer = new FetchTileLayer(labelUrl, {
        subdomains: 'abcd', detectRetina: false, tileSize, zoomOffset,
      } as any).addTo(this._map);
      this._townLayer.setZIndex(Z_LABELS);
    }
  }

  private _setupWindOverlay(): void {
    if (!this._map) return;
    const cfg = this._config;
    // Wind overlay is data-source-independent: ICON-D2 (10 m wind) is a
    // global product, so it stacks usefully on RainViewer / NOAA radars too.
    // The dwd_time_override / forecast_minutes anchors are still honoured
    // when DWD radar is the source; for other sources the wind shows live.

    // Anchor matches the radar's latest playback frame: override (or now) plus forecast.
    // Override + forecast only meaningful when DWD radar is selected; otherwise live.
    const isDwdRadar = cfg.data_source === 'DWD';
    const forecastMs = isDwdRadar ? (cfg.forecast_minutes ?? 0) * 60_000 : 0;
    const baseMs = isDwdRadar && cfg.dwd_time_override
      ? new Date(cfg.dwd_time_override).getTime()
      : Date.now();
    const anchorMs = baseMs + forecastMs;
    const useAnchor = isDwdRadar && (cfg.dwd_time_override != null || forecastMs > 0);
    const timeMs = useAnchor ? anchorMs : undefined;

    const windSource = cfg.wind_source ?? DEFAULT_WIND_SOURCE;
    const mode = cfg.dwd_wind ?? 'off';
    if (mode === 'barbs' || mode === 'arrows') {
      this._windOverlay = new WindOverlay(this._map, {
        style: mode,
        density: cfg.dwd_wind_density,
        size: cfg.dwd_wind_size,
        timeMs,
        source: windSource,
      });
    }
    if (cfg.dwd_wind_flow === true) {
      // Pick streamline colour from the active basemap. Satellite is split out
      // from the plain dark Carto map: satellite imagery has more varied
      // terrain (forests, snow, water) and benefits from a brighter stroke,
      // while the Carto dark map has a uniform dark slate background and a
      // softer near-white reads better there. YAML-only override keys
      // (`dwd_wind_flow_color_{light,dark,sat}`) let users tune for
      // theming or custom basemap palettes.
      let defaultColor: string;
      let customColor: string | undefined;
      if (this._currentMapStyle === 'satellite') {
        defaultColor = 'rgba(255,255,255,1)';
        customColor = cfg.dwd_wind_flow_color_sat;
      } else if (this._currentMapStyle === 'dark') {
        defaultColor = 'rgba(220,225,235,1)';
        customColor = cfg.dwd_wind_flow_color_dark;
      } else {
        defaultColor = 'rgba(25,30,45,1)';
        customColor = cfg.dwd_wind_flow_color_light;
      }
      this._windFlow = new WindFlowOverlay(this._map, {
        timeMs,
        particleColor: customColor ?? defaultColor,
        source: windSource,
      });
    }
  }

  private _setupAttribution(mapStyle: string): void {
    const el = this.shadowRoot?.getElementById('attribution');
    if (!el) return;
    const ds = this._config.data_source ?? 'RainViewer';
    const radarCredit = ds === 'NOAA'
      ? 'Radar: <a href="https://www.weather.gov" target="_blank">NOAA/NWS</a>'
      : ds === 'DWD'
        ? 'Radar: <a href="https://www.dwd.de" target="_blank">DWD</a>'
        : 'Radar: <a href="https://rainviewer.com" target="_blank">RainViewer</a>';
    const mapCredit = mapStyle === 'osm'
      ? '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors'
      : mapStyle === 'satellite'
        ? '&copy; <a href="http://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank">ESRI</a>'
        : '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> &copy; <a href="https://carto.com/attribution" target="_blank">CARTO</a>';
    el.innerHTML = `<a href="https://leafletjs.com" target="_blank">Leaflet</a> | ${mapCredit} | ${radarCredit}`;
  }

  // ── Markers ───────────────────────────────────────────────────────────────

  private _createClusterIcon(cluster: L.MarkerCluster, isDark: boolean): L.DivIcon {
    const count = cluster.getChildCount();
    const children = cluster.getAllChildMarkers() as any[];
    const zoneChildren = children.filter(m => {
      const cfg = m._wrcCfg as Marker | undefined;
      return cfg?.entity?.startsWith('zone.') || !cfg?.icon || cfg?.icon === 'default';
    });
    const zoneCount = zoneChildren.length;

    if (zoneCount > 0) {
      // Prefer zone.home as the representative; otherwise the first zone-like marker.
      const homeChild = zoneChildren.find(m => (m._wrcCfg as Marker | undefined)?.entity === 'zone.home');
      const repCfg = ((homeChild ?? zoneChildren[0])._wrcCfg) as Marker | undefined;
      const repIcon = repCfg?.icon || (
        repCfg?.entity === 'zone.home' ? 'mdi:home'
          : repCfg?.entity?.startsWith('zone.') ? 'mdi:map-marker-radius'
            : undefined
      );

      const iconSize = 28;
      const defaultColor = isDark ? '#EEEEEE' : '#333333';
      const iconColor = repCfg?.color ?? defaultColor;
      const iconHtml = repIcon?.startsWith('mdi:')
        ? `<ha-icon icon="${repIcon}" style="--mdc-icon-size:${iconSize}px;color:${iconColor};display:block"></ha-icon>`
        : `<svg viewBox="0 0 24 24" width="${iconSize}" height="${iconSize}"><path fill="${iconColor}" d="${HOME_PATH}"/></svg>`;

      const otherCount = count - zoneCount;
      const badge = otherCount > 0 ? (() => {
        const badgeBg = isDark ? '#EEEEEE' : '#222222';
        const badgeFg = isDark ? '#222222' : '#FFFFFF';
        const badgeSize = otherCount < 10 ? 14 : otherCount < 100 ? 17 : 20;
        const badgeFs = otherCount < 10 ? 10 : otherCount < 100 ? 9 : 8;
        return `<div style="position:absolute;top:-4px;right:-4px;min-width:${badgeSize}px;height:${badgeSize}px;padding:0 3px;box-sizing:border-box;background:${badgeBg};color:${badgeFg};border-radius:${badgeSize}px;display:flex;align-items:center;justify-content:center;font:bold ${badgeFs}px/1 'Helvetica Neue',Arial,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,0.4)">${otherCount}</div>`;
      })() : '';
      return L.divIcon({
        html: `<div style="position:relative;width:${iconSize}px;height:${iconSize}px">${iconHtml}${badge}</div>`,
        className: 'weather-radar-cluster',
        iconSize: [iconSize, iconSize] as L.PointExpression,
      });
    }

    const bg = isDark ? '#1a1a2e' : '#ffffff';
    const fg = isDark ? '#e0e0e0' : '#333333';
    const ring = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.15)';
    const size = count < 10 ? 32 : count < 100 ? 38 : 44;
    const fs = count < 10 ? 12 : count < 100 ? 11 : 10;

    return L.divIcon({
      html: `<div style="width:${size}px;height:${size}px;background:${bg};border:2px solid ${ring};border-radius:50%;display:flex;align-items:center;justify-content:center;color:${fg};box-shadow:0 2px 6px rgba(0,0,0,0.35);font:bold ${fs}px/1 'Helvetica Neue',Arial,sans-serif">${count}</div>`,
      className: 'weather-radar-cluster',
      iconSize: [size, size] as L.PointExpression,
    });
  }

  private _setupMarkers(mapStyle: string): void {
    if (!this._map) return;
    const cfg = this._config;
    const markers = cfg.markers ?? [];
    const isMobile = isMobileDevice();
    const haLat = this.hass?.config?.latitude ?? 0;
    const haLon = this.hass?.config?.longitude ?? 0;
    const useClustering = cfg.cluster_markers !== false && markers.length > 1;
    let rangeRingsSet = false;

    // Determine tracking winner upfront — the tracked marker bypasses the cluster.
    const initialWinner = resolveTracking(markers, this.hass, haLat, haLon);
    this._trackedMarkerIdx = initialWinner?.markerIndex ?? -1;

    if (useClustering) {
      const isDark = mapStyle === 'dark' || mapStyle === 'satellite';
      this._clusterGroup = L.markerClusterGroup({
        iconCreateFunction: (c) => this._createClusterIcon(c, isDark),
        maxClusterRadius: 60,
        // Cap markercluster's internal zoom range (issue #110). With map maxZoom
        // raised to 16 in 3.1.2, the deeper cluster tree exposed a markercluster
        // bug where _bounds becomes undefined during _zoomEnd, leaving the
        // marker pane empty. Beyond zoom 11 markers naturally separate anyway.
        disableClusteringAtZoom: 11,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: false,  // zoom-to-bounds re-clusters immediately at the same zoom
        spiderfyOnMaxZoom: false,    // handled by clusterclick below
        animate: true,
      });
      // Always spiderfy on click. Stop the DOM event so it doesn't bubble to the
      // map container — without this, markercluster's map-level 'click' listener
      // (_unspiderfyWrapper) fires in the same tick and immediately collapses it.
      this._clusterGroup.on('clusterclick', (e: any) => {
        if (e.originalEvent) L.DomEvent.stop(e.originalEvent);
        // Set the flag BEFORE calling spiderfy() so that any hass update arriving
        // during the animation does not snap markers back to their entity positions.
        this._clusterSpiderfied = true;
        e.layer.spiderfy();
      });
      this._clusterGroup.on('spiderfied', () => { this._clusterSpiderfied = true; });
      this._clusterGroup.on('unspiderfied', () => { this._clusterSpiderfied = false; });
      this._clusterGroup.addTo(this._map);
    }

    for (let i = 0; i < markers.length; i++) {
      const markerCfg = markers[i];
      if (markerCfg.mobile_only && !isMobile) continue;

      const { lat, lon } = resolveMarkerPosition(markerCfg, this.hass, haLat, haLon);
      const icon = createMarkerIconForMarker(markerCfg, this.hass, mapStyle);
      const lMarker = L.marker([lat, lon], { icon, interactive: false });
      (lMarker as any)._wrcCfg = markerCfg;
      this._markers.set(i, lMarker);
      lMarker.setZIndexOffset(i === this._trackedMarkerIdx ? 1000 : 0);

      if (useClustering && i !== this._trackedMarkerIdx) {
        this._clusterGroup!.addLayer(lMarker);
      } else {
        lMarker.addTo(this._map);
      }

      if (!rangeRingsSet && cfg.show_range) {
        const metric = (this.hass?.config?.unit_system?.length ?? 'km') === 'km';
        for (const r of (metric ? [50000, 100000, 200000] : [48280, 96561, 193121])) {
          this._rangeRings.push(
            L.circle([lat, lon], { radius: r, weight: 1, fill: false, opacity: 0.3, interactive: false })
              .addTo(this._map),
          );
        }
        rangeRingsSet = true;
      }
    }
  }

  private _updateMarkerPositions(): void {
    const markers = this._config?.markers ?? [];
    const haLat = this.hass?.config?.latitude ?? 0;
    const haLon = this.hass?.config?.longitude ?? 0;
    for (const [i, lMarker] of this._markers.entries()) {
      const markerCfg = markers[i];
      if (!markerCfg) continue;
      const { lat, lon } = resolveMarkerPosition(markerCfg, this.hass, haLat, haLon);

      // Skip setLatLng for clustered markers while spiderfied. During spiderfy,
      // markercluster calls setLatLng(spiderPosition) on each marker to place it
      // at its leg endpoint. Calling setLatLng(originalPosition) here would snap
      // it back to the cluster centre, making the icons vanish while the cluster
      // icon stays grey (spiderfied state but no visible markers).
      const inSpiderfy = this._clusterSpiderfied && this._clusterGroup && i !== this._trackedMarkerIdx;
      if (!inSpiderfy) {
        const cur = lMarker.getLatLng();
        if (cur.lat !== lat || cur.lng !== lon) lMarker.setLatLng([lat, lon]);
      }
    }
  }

  private _resolveTracking(): void {
    if (!this._map || this._userMoveInProgress) return;
    const markers = this._config?.markers ?? [];
    const haLat = this.hass?.config?.latitude ?? 0;
    const haLon = this.hass?.config?.longitude ?? 0;
    const result = resolveTracking(markers, this.hass, haLat, haLon);
    const newWinnerIdx = result?.markerIndex ?? -1;

    // Move tracked marker between layers when the winner changes.
    if (this._clusterGroup && newWinnerIdx !== this._trackedMarkerIdx) {
      this._moveTrackedMarker(newWinnerIdx);
    } else {
      this._trackedMarkerIdx = newWinnerIdx;
    }

    // Keep the tracked marker above all others.
    // Skip while spiderfied — markercluster sets zIndexOffset:1000000 on each
    // spiderfied marker so they appear above the cluster icon; resetting to 0
    // would make them sink below the cluster icon and become invisible.
    if (!this._clusterSpiderfied) {
      for (const [i, lMarker] of this._markers.entries()) {
        lMarker.setZIndexOffset(newWinnerIdx === i ? 1000 : 0);
      }
    }
    if (result) {
      const last = this._lastTrackedPosition;
      // Only pan when the tracked marker has actually moved (>~10 m).
      // Calling panTo every hass tick with the same coords causes unnecessary
      // map animation and move events even when the entity hasn't changed position.
      const moved = !last ||
        Math.abs(last.lat - result.lat) > 0.0001 ||
        Math.abs(last.lon - result.lon) > 0.0001;
      if (moved) {
        this._lastTrackedPosition = { lat: result.lat, lon: result.lon };
        this._map.panTo([result.lat, result.lon]);
      }
    } else {
      this._lastTrackedPosition = null;
    }
  }

  private _moveTrackedMarker(newWinnerIdx: number): void {
    // Return old tracked marker to the cluster group.
    if (this._trackedMarkerIdx >= 0) {
      const old = this._markers.get(this._trackedMarkerIdx);
      if (old && this._map?.hasLayer(old)) {
        this._map.removeLayer(old);
        this._clusterGroup!.addLayer(old);
      }
    }

    // Promote new tracked marker out of the cluster group onto the map directly.
    if (newWinnerIdx >= 0) {
      const nw = this._markers.get(newWinnerIdx);
      if (nw) {
        if (this._clusterGroup!.hasLayer(nw)) this._clusterGroup!.removeLayer(nw);
        nw.addTo(this._map!);
      }
    }
    this._trackedMarkerIdx = newWinnerIdx;
  }

  // ── Toolbar ───────────────────────────────────────────────────────────────

  private _setupToolbar(): void {
    if (!this._map) return;
    const cfg = this._config;
    const showRecenter = cfg.show_recenter === true && cfg.static_map !== true;
    const showPlayback = cfg.show_playback === true;
    if (!showRecenter && !showPlayback) return;
    // Restore the user's previous playback speed (if any) before the
    // toolbar mounts so the button label and the player's effective
    // frame_delay both start coherent. localStorage (set by a runtime
    // button click) wins over the YAML default; the YAML default acts
    // as a per-card factory value for new browsers or after the user
    // clears localStorage. Single-key localStorage entry shared across
    // all cards on the page — a per-card key is overkill for a UI
    // preference that's expected to be the same everywhere.
    const savedSpeed = resolvePlaybackSpeed(
      localStorage.getItem(PLAYBACK_SPEED_KEY),
      this._config.playback_speed,
    );
    this._player?.setSpeedMultiplier(savedSpeed);

    this._toolbar = new RadarToolbar({
      showRecenter,
      showPlayback,
      onRecenter: () => this._recenter(),
      onPlay: () => this._player?.togglePlay(),
      onSkipBack: () => this._player?.skipBack(),
      onSkipNext: () => this._player?.skipNext(),
      initialSpeed: savedSpeed,
      onSpeedChange: (m) => {
        this._player?.setSpeedMultiplier(m);
        try {
          localStorage.setItem(PLAYBACK_SPEED_KEY, String(m));
        } catch {
          // Quota or privacy-mode block — speed still works for this
          // session, it just won't persist across reloads.
        }
      },
    });
    this._toolbar.addTo(this._map);
  }

  // Push the current map centre + zoom into the editor's Lat/Long/Zoom
  // fields via a window event. The editor element (in editor.ts) listens
  // for this and calls config-changed itself — firing it from the card
  // causes HA to round-trip back through setConfig with the old stored
  // values, which would snap the map back.
  private _pushCenterToEditor(): void {
    if (!this._map) return;
    const c = this._map.getCenter();
    window.dispatchEvent(new CustomEvent('weather-radar-center-update', {
      detail: {
        center_latitude: Math.round(c.lat * 10000) / 10000,
        center_longitude: Math.round(c.lng * 10000) / 10000,
        zoom_level: this._map.getZoom(),
      },
    }));
  }

  private _setupDoubleTapAction(): void {
    if (!this._map) return;
    const action = this._config.double_tap_action;
    // Bail when the value is one we don't need a custom handler for:
    //   undefined / 'zoom_in' → Leaflet's built-in double-click zoom is
    //                           on (see _initMap); we sit out.
    //   'none'                → user explicitly asked for nothing; we
    //                           sit out AND _initMap turned zoom off too.
    if (action === undefined || action === 'zoom_in' || action === 'none') return;
    this._map.on('dblclick', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stopPropagation(e);
      if (action === 'recenter') { this._recenter(); return; }
      if (action === 'toggle_play') { this._player?.togglePlay(); return; }
      // HA action object — e.g. {action: 'navigate', navigation_path: '/lovelace/1'}
      if (typeof action === 'object') {
        handleAction(this, this.hass, { tap_action: action as ActionConfig }, 'tap');
      }
    });
  }

  private _recenter(): void {
    if (!this._map) return;
    const cfg = this._config;
    const isMobile = isMobileDevice();
    const c = resolveCoordinatePair(
      getCoordinateConfig(cfg.center_latitude, undefined, isMobile),
      getCoordinateConfig(cfg.center_longitude, undefined, isMobile),
      this.hass?.config?.latitude ?? 0, this.hass?.config?.longitude ?? 0, this.hass,
    );
    this._map.setView([c.lat, c.lon], cfg.zoom_level ?? 7);
  }

  // ── Navigation pause ──────────────────────────────────────────────────────

  private _setupProgressBarScrub(): void {
    const touchTarget = this.shadowRoot?.getElementById('div-progress-touch-target');
    if (!touchTarget) return;
    let active = false;

    const seek = (e: PointerEvent): void => {
      if (!this._player || this._player.frameCount === 0) return;
      const rect = touchTarget.getBoundingClientRect();
      this._player.scrubTo(progressBarFrameIndex(e.clientX, rect.left, rect.width, this._player.frameCount));
    };

    touchTarget.addEventListener('pointerdown', (e) => {
      active = true;
      touchTarget.setPointerCapture(e.pointerId);
      seek(e);
    });
    touchTarget.addEventListener('pointermove', (e) => { if (active) seek(e); });
    touchTarget.addEventListener('pointerup', () => {
      if (!active) return;
      active = false;
      this._player?.scrubEnd();
    });
    touchTarget.addEventListener('pointercancel', () => {
      active = false;
      this._player?.scrubEnd();
    });
  }

  private _setupNavListeners(): void {
    if (!this._map) return;
    // pointerdown and wheel fire for real user gestures but NOT for programmatic
    // moves like invalidateSize() or setView(). Use them to gate the save button.
    this._navContainer = (this._map as any).getContainer() as HTMLElement;
    this._markUserMove = (): void => { this._userMoveInProgress = true; };
    this._navContainer.addEventListener('pointerdown', this._markUserMove, { passive: true });
    this._navContainer.addEventListener('wheel', this._markUserMove, { passive: true });

    this._map.on('movestart zoomstart', () => {
      if (this._navReloadTimer) clearTimeout(this._navReloadTimer);
      this._player?.onNavPaused();
    });
    this._map.on('moveend zoomend', () => {
      if (this._navReloadTimer) clearTimeout(this._navReloadTimer);
      this._navReloadTimer = setTimeout(() => {
        this._player?.onNavSettled(getEffectiveTimeRange(this._config).frameCount);
      }, 100);
      // When the user is editing this card, push the new map view straight
      // into the editor's Lat/Long/Zoom fields. WYSIWYG — no save button.
      // editMode alone isn't enough (it just means the dashboard is
      // editable); _editorOpen is set by the editor element's lifecycle.
      if (this._userMoveInProgress && this.editMode && this._editorOpen) {
        this._pushCenterToEditor();
      }
      this._userMoveInProgress = false;
    });
  }

  // ── Visibility / resize observers ─────────────────────────────────────────

  private _setupVisibilityObserver(): void {
    // Triggered by IntersectionObserver (card scrolled off-screen) AND
    // document.visibilitychange (tab hidden). Either condition pauses
    // ALL network activity we control: radar player frame loop +
    // overlay-layer polling timers. Tile fetches for the basemap and
    // labels naturally stop too — Leaflet only requests new tiles when
    // the view changes, which doesn't happen while the card is hidden.
    const onHide = (): void => {
      this._player?.onVisibilityHidden();
      this._wildfireLayer?.pause();
      this._alertsLayer?.pause();
      this._lightningLayer?.pause();
    };
    const onShow = (): void => {
      this._player?.onVisibilityVisible();
      this._wildfireLayer?.resume();
      this._alertsLayer?.resume();
      this._lightningLayer?.resume();
    };
    this._visObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) onShow();
      else onHide();
    }, { threshold: 0.1 });
    this._visObserver.observe(this);
    this._visibilityHandler = () => {
      if (document.hidden) onHide();
      else onShow();
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  // ⚠️  Do not "simplify" by removing the requestAnimationFrame defer or
  // the try/catch. Both compensate for a framework limitation in
  // leaflet.markercluster that we cannot fix from this side:
  //
  //   Markercluster initialises its internal cluster tree
  //   (`_topClusterLevel._bounds`) lazily, on the first event tick that
  //   needs bounds — there is NO public lifecycle hook to wait for "tree
  //   ready." Our ResizeObserver can fire BEFORE that first event tick,
  //   in which case calling map.invalidateSize() drives markercluster's
  //   resize handler into reading the undefined `_bounds` and throwing
  //   "Cannot read properties of undefined (reading 'lat')".
  //
  // The rAF defer gives the cluster tree's lazy init time to complete
  // (it's a microtask, so it lands before the next paint). The try/catch
  // is belt-and-braces for the rare case where the cluster tree is even
  // slower to settle than one rAF — the observer will fire again on the
  // next resize tick and re-attempt cleanly.
  //
  // Issue #110 is the original instance of the same root cause on the
  // zoomEnd path; this method handles the resize path. If a future
  // markercluster release adds a proper "ready" event, this method
  // becomes a candidate for simplification — until then, leave the
  // timing dance intact.
  private _setupResizeObserver(): void {
    const mapEl = this.shadowRoot?.getElementById('mapid');
    if (!mapEl) return;
    this._resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        if (!this._map) return;
        try {
          this._map.invalidateSize();
        } catch (e) {
          console.warn('[weather-radar-card] invalidateSize() raised — likely the markercluster init race. Recovering on next resize.', e);
        }
      });
    });
    this._resizeObserver.observe(mapEl);
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  static styles = [
    unsafeCSS(leafletCss),
    unsafeCSS(markerClusterCss),
    css`
      :host {
        display: block; isolation: isolate; height: 100%;
        /* DWD coverage overlay theme hooks. RGB picks the colour, alpha
           multiplies the original mask opacity (so wash density and outline
           antialiasing both scale). Set to "transparent" to hide. */
        --dwd-coverage-dim-color: rgba(0, 0, 0, 1);
        --dwd-coverage-outline-color: rgba(255, 0, 255, 1);
      }
      /* flex-mode is the default: ha-card fills its container vertically
         (sections-grid cell), with min-height set inline from the user's
         height config so a regular dashboard still renders at the
         expected size. The map div is flex:1, absorbing whatever
         vertical space is left after the fixed-height chrome. */
      ha-card.flex-mode {
        overflow: hidden; position: relative;
        display: flex; flex-direction: column; height: 100%;
        /* Container-query context for the bottom-row narrow-width
           rule below (drops the date half of the timestamp at ≤397px). */
        container-type: inline-size;
      }
      ha-card.flex-mode #mapid {
        flex: 1 1 auto; min-height: 0;
      }
      /* aspect-mode (square_map without explicit height): the map div
         is square via aspect-ratio; ha-card grows to its content. Same
         behaviour as before the flex refactor. */
      ha-card.aspect-mode {
        overflow: hidden; position: relative;
        container-type: inline-size;
      }
      ha-card.aspect-mode #mapid {
        aspect-ratio: 1 / 1;
      }
      #mapid { width: 100%; position: relative; }
      .banner-stack {
        position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
        z-index: 1000; display: flex; flex-direction: column; gap: 4px;
        align-items: center; pointer-events: none; max-width: calc(100% - 16px);
      }
      .status-banner {
        background: rgba(180,60,0,0.85); color: #fff;
        padding: 4px 12px; border-radius: 4px;
        font: 12px/1.5 'Helvetica Neue',Arial,sans-serif;
        pointer-events: none; text-align: center;
      }
      .status-banner-info { background: rgba(40,80,160,0.85); }
      .marker-entity-picture {
        border-radius: 50%; border: 2px solid white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.4); object-fit: cover;
      }
      .marker-mdi-icon { background: none; border: none; }
      .radar-toolbar { background: white; border-radius: 4px; }
      .radar-toolbar li { list-style: none; }
      #div-progress-bar {
        position: relative; z-index: 1001;
        background: var(--ha-card-background, var(--card-background-color));
      }
      #div-progress-touch-target {
        position: absolute; left: 0; right: 0; bottom: 0;
        display: flex; align-items: flex-end;
        cursor: pointer; touch-action: none;
      }
      #div-progress-track {
        display: flex; width: 100%;
      }
      /* Bottom row: timestamp on the left, attribution on the right,
         centered spinner overlay. Flex layout so the two text blocks
         share the available width and never overlap on narrow cards
         (~390 px or less). Both can ellipsis-truncate when the row is
         too tight to show everything; the spinner is absolute-
         positioned so it doesn't participate in the flex flow. */
      #bottom-container {
        height: 32px; font-size: 10px; position: relative;
        display: flex; align-items: center;
        background: var(--ha-card-background, var(--card-background-color));
        color: var(--primary-text-color);
      }
      #bottom-container a { color: var(--primary-color); }
      #timestampid {
        flex: 0 1 auto; min-width: 0;
        max-width: calc(50% - 16px);
        overflow: hidden;
      }
      #timestamp {
        margin: 0; padding: 4px 8px; font-size: 12px; white-space: nowrap;
        overflow: hidden; text-overflow: ellipsis;
      }
      #attribution {
        flex: 1 1 auto; min-width: 0;
        text-align: right; padding: 4px 8px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      /* On narrow cards (≤397px) drop the date prefix so just the time
         shows alongside the attribution. The timestamp is rendered as
         <span class="ts-date">… </span><span class="ts-time">…</span>
         in radar-player.ts so the two halves are independently
         hideable. Container query on ha-card means this responds to
         the card's actual width regardless of viewport (sections grid,
         panel mode, masonry — all "just work"). */
      @container (max-width: 397px) {
        .ts-date { display: none; }
      }
      .map-dark .leaflet-control-scale-line {
        color: #bbb; border-color: #bbb; background: rgba(0,0,0,0.5);
        text-shadow: none;
      }
      /* Leaflet defaults give controls (zoom, scale) z-index 1000 and the
         popup pane z-index 700, so an open wildfire / NWS-alert popup
         renders BEHIND the zoom buttons and gets visually clipped on
         small cards. Lift the popup pane above the controls — the user
         has to close the popup to interact with the controls again,
         which is the expected modal-ish UX for these popups. */
      .leaflet-popup-pane { z-index: 1100; }
      .loading-spinner {
        position: absolute; top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        width: 20px; height: 20px;
        display: flex; align-items: center; justify-content: center;
        pointer-events: none;
      }
      .loading-spinner-arc {
        width: 16px; height: 16px; box-sizing: border-box;
        border: 2px solid var(--divider-color, rgba(0,0,0,0.15));
        border-top-color: var(--primary-text-color);
        border-radius: 50%;
        animation: wrc-spinner-rotate 0.8s linear infinite;
      }
      @keyframes wrc-spinner-rotate {
        to { transform: rotate(360deg); }
      }
      @media (prefers-reduced-motion: reduce) {
        .loading-spinner-arc { animation: none; }
      }
      /* Lightning overlay (Blitzortung). The divIcon outer container
         carries the animation; the inner SVG paints the bolt. overflow:
         visible on the SVG lets the brief scale(2) flash spill outside
         the divIcon box without being clipped. */
      .wrc-lightning-icon {
        pointer-events: auto;
        cursor: pointer;
      }
      .wrc-lightning-icon svg {
        overflow: visible;
      }
      @keyframes wrc-lightning-pulse {
        0%   { transform: scale(2);   filter: brightness(2); opacity: 1; }
        60%  { transform: scale(1.3); filter: brightness(1.4); opacity: 1; }
        100% { transform: scale(1);   filter: brightness(1);   opacity: 1; }
      }
      .wrc-lightning-pulse {
        animation: wrc-lightning-pulse 600ms ease-out;
      }
      @media (prefers-reduced-motion: reduce) {
        .wrc-lightning-pulse { animation: none; }
      }
    `,
  ];
}
