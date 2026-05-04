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
import { CARD_VERSION } from './const';
import { localize } from './localize/localize';
import { RateLimiter } from './rate-limiter';
import { FetchTileLayer } from './fetch-tile-layer';
import { RadarToolbar } from './radar-toolbar';
import { RadarPlayer } from './radar-player';
import {
  isMobileDevice,
  getCurrentUserInfo,
  getCoordinateConfig,
  resolveCoordinatePair,
} from './coordinate-utils';
import { createMarkerIconForMarker, HOME_PATH } from './marker-icon';
import { migrateConfig, resolveMarkerPosition, resolveTracking } from './marker-utils';

/* eslint no-console: 0 */
console.info(
  `%c  WEATHER-RADAR-CARD \n%c  ${localize('common.version')} ${CARD_VERSION}    `,
  'color: orange; font-weight: bold; background: black',
  'color: white; font-weight: bold; background: dimgray',
);

(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
  type: 'weather-radar-card',
  name: 'Weather Radar Card',
  description: 'A rain radar card using tiled imagery from RainViewer, NOAA/NWS, and DWD',
});

@customElement('weather-radar-card')
export class WeatherRadarCard extends LitElement implements LovelaceCard {
  public static async getConfigElement(): Promise<LovelaceCardEditor> {
    return document.createElement('weather-radar-card-editor') as LovelaceCardEditor;
  }
  public static getStubConfig(): Record<string, unknown> { return {}; }

  // ── HA properties ────────────────────────────────────────────────────────

  @property({ type: Boolean, reflect: true }) public isPanel = false;
  @property({ attribute: false }) public hass!: HomeAssistant;
  @property({ attribute: false }) private _config!: WeatherRadarCardConfig;
  @property({ attribute: false }) public editMode?: boolean;

  // ── Map / player state ────────────────────────────────────────────────────

  private _map: L.Map | null = null;
  private _currentMapStyle: string | null = null;
  private _townLayer: FetchTileLayer | null = null;
  private _toolbar: RadarToolbar | null = null;
  private _markers: Map<number, L.Marker> = new Map();
  private _clusterGroup: L.MarkerClusterGroup | null = null;
  private _trackedMarkerIdx = -1;
  private _clusterSpiderfied = false;
  private _lastTrackedPosition: { lat: number; lon: number } | null = null;
  private _rangeRings: L.Circle[] = [];
  private _dynamicStyleEl!: HTMLStyleElement;
  private _player: RadarPlayer | null = null;

  @state() private _pendingCenter: { lat: number; lon: number; zoom: number } | null = null;
  private _userMoveInProgress = false;

  private _navReloadTimer: ReturnType<typeof setTimeout> | null = null;
  private _visObserver: IntersectionObserver | null = null;
  private _resizeObserver: ResizeObserver | null = null;
  private _visibilityHandler: (() => void) | null = null;
  private _navContainer: HTMLElement | null = null;
  private _markUserMove: (() => void) | null = null;
  private _darkModeQuery: MediaQueryList | null = null;
  private _darkModeHandler: (() => void) | null = null;

  private _rainviewerLimiter = new RateLimiter(500);
  private _noaaLimiter = new RateLimiter(120);
  // DWD via maps.dwd.de is fronted by Akamai with no documented per-IP
  // limit. 500/min (matches RainViewer) is well within polite budget for
  // a single user — burst pan/zoom can pull ~80 tiles in one move and
  // the previous 120/min cap was visibly throttling without ever seeing
  // 429s from the server.
  private _dwdLimiter = new RateLimiter(500);
  private _dwdCoverageWarned = false;

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

  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this._config) return false;
    return changedProps.has('_config') || changedProps.has('hass')
      || changedProps.has('editMode') || changedProps.has('_pendingCenter');
  }

  protected firstUpdated(): void {
    this._dynamicStyleEl = document.createElement('style');
    this._dynamicStyleEl.id = 'radar-dynamic';
    this.shadowRoot!.appendChild(this._dynamicStyleEl);
    this._setupProgressBarScrub();
    this._initMap();
  }

  protected updated(changedProps: PropertyValues): void {
    if (changedProps.has('editMode') && !this.editMode) {
      this._pendingCenter = null;
    }
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
    }
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    this._teardown();
  }

  // ── Render ────────────────────────────────────────────────────────────────

  protected render(): TemplateResult | void {
    if (!this._config) return html``;
    const mapStyle = this._effectiveMapStyle();
    const isMapDark = mapStyle === 'dark' || mapStyle === 'satellite';
    const dataSource = this._config.data_source ?? 'RainViewer';
    const showColourBar = this._config.show_color_bar !== false;
    const colourBarSrc = dataSource === 'NOAA'
      ? '/local/community/weather-radar-card/radar-colour-bar-nws.png'
      : dataSource === 'DWD'
        ? '/local/community/weather-radar-card/radar-colour-bar-dwd.png'
        : '/local/community/weather-radar-card/radar-colour-bar-universalblue.png';
    return html`
      <ha-card class=${isMapDark ? 'map-dark' : ''} style="${this._config.width && this._validateCssSize(this._config.width) ? `width:${this._config.width}` : ''}">
        <div id="color-bar" style="height:8px;display:${showColourBar ? '' : 'none'}">
          <img id="img-color-bar" height="8" style="vertical-align:top" src=${colourBarSrc} />
        </div>
        <div id="rate-limit-banner" class="status-banner" style="display:none">
          ${localize('ui.rate_limited')}
        </div>
        ${this.editMode && this._pendingCenter ? html`
          <button class="save-center-btn" @click=${this._savePendingCenter}>
            ${localize('ui.save_map_center')}
          </button>
        ` : ''}
        <div id="mapid" style="${this._config.square_map && !this._config.height ? 'aspect-ratio:1/1' : `height:${this._calculateHeight()}`}"></div>
        <div id="div-progress-bar" style="height:8px;cursor:pointer;display:${this._config.show_progress_bar === false ? 'none' : 'flex'}"></div>
        <div id="bottom-container">
          <div id="timestampid" style="height:32px;float:left;position:absolute">
            <p id="timestamp" style="margin:0;padding:4px 8px;font-size:12px;white-space:nowrap"></p>
          </div>
          <div id="attribution" style="font-size:10px;text-align:right;padding:4px 8px"></div>
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
    const hasDoubleTapAction = cfg.double_tap_action && cfg.double_tap_action !== 'none';
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

    // Warn once if the HA location is outside DWD's coverage (Germany + ~50–150 km buffer).
    if (cfg.data_source === 'DWD' && !this._dwdCoverageWarned && (haLat !== 0 || haLon !== 0)) {
      const inside = haLat >= 46 && haLat <= 56 && haLon >= 5 && haLon <= 16;
      if (!inside) {
        console.warn(
          `[weather-radar-card] DWD selected but HA location (${haLat.toFixed(2)}, ${haLon.toFixed(2)}) is outside DWD coverage; the map will show only no-data.`,
        );
      }
      this._dwdCoverageWarned = true;
    }

    this._player = new RadarPlayer({
      map: this._map,
      shadowRoot: this.shadowRoot!,
      getConfig: () => this._config,
      rainviewerLimiter: this._rainviewerLimiter,
      noaaLimiter: this._noaaLimiter,
      dwdLimiter: this._dwdLimiter,
    });
    this._player.toolbar = this._toolbar;
    this._player.start(cfg.frame_count ?? 5);
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
    if (this._clusterGroup) { this._clusterGroup.clearLayers(); this._clusterGroup = null; }
    this._clusterSpiderfied = false;
    if (this._map) { this._map.remove(); this._map = null; }
    this._currentMapStyle = null;
    this._townLayer = null;
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
      .addTo(this._map).setZIndex(0);

    if (!osmLabels && labelUrl) {
      this._townLayer = new FetchTileLayer(labelUrl, {
        subdomains: 'abcd', detectRetina: false, tileSize, zoomOffset,
      } as any).addTo(this._map);
      this._townLayer.setZIndex(2);
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
    this._toolbar = new RadarToolbar({
      showRecenter,
      showPlayback,
      onRecenter: () => this._recenter(),
      onPlay: () => this._player?.togglePlay(),
      onSkipBack: () => this._player?.skipBack(),
      onSkipNext: () => this._player?.skipNext(),
    });
    this._toolbar.addTo(this._map);
  }

  private _savePendingCenter(): void {
    if (!this._pendingCenter) return;
    const { lat, lon, zoom } = this._pendingCenter;
    this._pendingCenter = null;
    // Communicate to the editor element via a window event so the editor can
    // fire config-changed from the correct element. Firing it from the card
    // causes HA to call setConfig back with the old stored config (snap-back).
    window.dispatchEvent(new CustomEvent('weather-radar-center-update', {
      detail: {
        center_latitude: Math.round(lat * 10000) / 10000,
        center_longitude: Math.round(lon * 10000) / 10000,
        zoom_level: zoom,
      },
    }));
  }

  private _setupDoubleTapAction(): void {
    if (!this._map) return;
    const action = this._config.double_tap_action;
    if (!action || action === 'none') return;
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
    const bar = this.shadowRoot?.getElementById('div-progress-bar');
    if (!bar) return;
    let active = false;

    const seek = (e: PointerEvent): void => {
      if (!this._player || this._player.frameCount === 0) return;
      const rect = bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1 - 1e-9, (e.clientX - rect.left) / rect.width));
      this._player.scrubTo(Math.floor(ratio * this._player.frameCount));
    };

    bar.addEventListener('pointerdown', (e) => {
      active = true;
      bar.setPointerCapture(e.pointerId);
      seek(e);
    });
    bar.addEventListener('pointermove', (e) => { if (active) seek(e); });
    bar.addEventListener('pointerup', () => {
      if (!active) return;
      active = false;
      this._player?.scrubEnd();
    });
    bar.addEventListener('pointercancel', () => {
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
        this._player?.onNavSettled(this._config.frame_count ?? 5);
      }, 100);
      if (this._userMoveInProgress && this.editMode && this._map) {
        const c = this._map.getCenter();
        this._pendingCenter = { lat: c.lat, lon: c.lng, zoom: this._map.getZoom() };
      }
      this._userMoveInProgress = false;
    });
  }

  // ── Visibility / resize observers ─────────────────────────────────────────

  private _setupVisibilityObserver(): void {
    this._visObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) this._player?.onVisibilityVisible();
      else this._player?.onVisibilityHidden();
    }, { threshold: 0.1 });
    this._visObserver.observe(this);
    this._visibilityHandler = () => {
      if (document.hidden) this._player?.onVisibilityHidden();
      else this._player?.onVisibilityVisible();
    };
    document.addEventListener('visibilitychange', this._visibilityHandler);
  }

  private _setupResizeObserver(): void {
    const mapEl = this.shadowRoot?.getElementById('mapid');
    if (!mapEl) return;
    this._resizeObserver = new ResizeObserver(() => this._map?.invalidateSize());
    this._resizeObserver.observe(mapEl);
  }

  // ── Styles ────────────────────────────────────────────────────────────────

  static styles = [
    unsafeCSS(leafletCss),
    unsafeCSS(markerClusterCss),
    css`
      :host { display: block; isolation: isolate; }
      ha-card { overflow: hidden; position: relative; }
      #mapid { width: 100%; position: relative; }
      .status-banner {
        position: absolute; top: 8px; left: 50%; transform: translateX(-50%);
        z-index: 1000; background: rgba(180,60,0,0.85); color: #fff;
        padding: 4px 12px; border-radius: 4px;
        font: 12px/1.5 'Helvetica Neue',Arial,sans-serif;
        pointer-events: none; white-space: nowrap;
      }
      .marker-entity-picture {
        border-radius: 50%; border: 2px solid white;
        box-shadow: 0 1px 3px rgba(0,0,0,0.4); object-fit: cover;
      }
      .marker-mdi-icon { background: none; border: none; }
      .radar-toolbar { background: white; border-radius: 4px; }
      .radar-toolbar li { list-style: none; }
      #div-progress-bar {
        background: var(--ha-card-background, var(--card-background-color));
      }
      #bottom-container {
        height: 32px; font-size: 10px; position: relative;
        background: var(--ha-card-background, var(--card-background-color));
        color: var(--primary-text-color);
      }
      #bottom-container a { color: var(--primary-color); }
      .map-dark .leaflet-control-scale-line {
        color: #bbb; border-color: #bbb; background: rgba(0,0,0,0.5);
      }
      .save-center-btn {
        position: absolute; bottom: 48px; left: 50%; transform: translateX(-50%);
        z-index: 1000; background: var(--primary-color); color: var(--text-primary-color, #fff);
        border: none; border-radius: 4px; padding: 6px 16px; cursor: pointer;
        font: 12px/1.5 'Helvetica Neue', Arial, sans-serif;
        white-space: nowrap; box-shadow: 0 2px 6px rgba(0,0,0,0.3);
      }
    `,
  ];
}
