/* eslint-disable @typescript-eslint/no-explicit-any */
import { LitElement, html, TemplateResult, css, CSSResultGroup } from 'lit';
import { HomeAssistant, fireEvent, LovelaceCardEditor } from 'custom-card-helpers';

import { WeatherRadarCardConfig, CoordinateConfig, Marker } from './types';
import { migrateConfig } from './marker-utils';
import { localize } from './localize/localize';
import { customElement, property, state } from 'lit/decorators.js';

// Subset of HA's device_class → default icon mapping.
// Sourced from the HA frontend (entity_components/*) — only the classes likely
// to appear on a marker (entities with lat/lon attributes) are included.
const DEVICE_CLASS_ICONS: Record<string, string> = {
  // binary_sensor
  battery: 'mdi:battery',
  battery_charging: 'mdi:battery-charging',
  cold: 'mdi:snowflake',
  connectivity: 'mdi:server-network',
  door: 'mdi:door-open',
  garage_door: 'mdi:garage-open',
  gas: 'mdi:gas-cylinder',
  heat: 'mdi:fire',
  light: 'mdi:brightness-7',
  lock: 'mdi:lock-open',
  moisture: 'mdi:water',
  motion: 'mdi:motion-sensor',
  moving: 'mdi:car',
  occupancy: 'mdi:home',
  opening: 'mdi:square-outline',
  plug: 'mdi:power-plug',
  power: 'mdi:power-plug',
  presence: 'mdi:home',
  problem: 'mdi:alert-circle',
  running: 'mdi:play',
  safety: 'mdi:shield-check',
  smoke: 'mdi:smoke-detector',
  sound: 'mdi:music-note',
  tamper: 'mdi:hand-pointing-up',
  vibration: 'mdi:vibrate',
  window: 'mdi:window-open',
  // sensor
  carbon_dioxide: 'mdi:molecule-co2',
  carbon_monoxide: 'mdi:molecule-co',
  current: 'mdi:current-ac',
  date: 'mdi:calendar',
  duration: 'mdi:timer-outline',
  energy: 'mdi:lightning-bolt',
  humidity: 'mdi:water-percent',
  illuminance: 'mdi:brightness-5',
  monetary: 'mdi:cash',
  pressure: 'mdi:gauge',
  signal_strength: 'mdi:wifi',
  temperature: 'mdi:thermometer',
  timestamp: 'mdi:clock',
  voltage: 'mdi:sine-wave',
};

@customElement('weather-radar-card-editor')
export class WeatherRadarCardEditor extends LitElement implements LovelaceCardEditor {
  @property({ attribute: false }) public hass?: HomeAssistant;

  @state() private _config?: WeatherRadarCardConfig;

  @state() private _helpers?: any;

  // Which sub-view of the editor is showing. Defaults to 'main' (the
  // top-level settings). Routing happens entirely in-memory — closing and
  // re-opening the editor returns to 'main', matching HA editor conventions.
  @state() private _view: 'main' | 'markers' = 'main';

  private _initialized = false;

  public setConfig(config: WeatherRadarCardConfig): void {
    // Run the same migration as the card so synthesised defaults (e.g. an
    // auto-created zone.home marker) and legacy single-marker fields appear
    // in the editor UI.
    this._config = migrateConfig(config);
    this.loadCardHelpers();
  }

  private _boundCenterUpdate = (e: Event): void => {
    const ev = e as CustomEvent;
    if (!this._config) return;
    this._config = {
      ...this._config,
      center_latitude: ev.detail.center_latitude,
      center_longitude: ev.detail.center_longitude,
      zoom_level: ev.detail.zoom_level,
    };
    fireEvent(this, 'config-changed', { config: this._config });
  };

  connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener('weather-radar-center-update', this._boundCenterUpdate);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('weather-radar-center-update', this._boundCenterUpdate);
  }

  protected shouldUpdate(): boolean {
    if (!this._initialized) {
      this._initialize();
    }

    return true;
  }

  protected render(): TemplateResult | void {
    if (!this.hass || !this._helpers) {
      return html``;
    }
    if (!this._config) return html``;
    return this._view === 'markers'
      ? this._renderMarkersView(this._config)
      : this._renderMainView(this._config);
  }

  private _renderMainView(config: WeatherRadarCardConfig): TemplateResult {
    return html`
      <div class="values">

        <!-- MAP -->
        <h3 class="section-header">${localize('editor.section.map')}</h3>
        <ha-selector
          .hass=${this.hass}
          .selector=${{
            select: {
              options: [
                { value: 'RainViewer', label: localize('editor.map.source_rainviewer') },
                { value: 'NOAA', label: localize('editor.map.source_noaa') },
                { value: 'DWD', label: localize('editor.map.source_dwd') },
              ],
            },
          }}
          .value=${config.data_source || 'RainViewer'}
          .label=${localize('editor.map.radar_source')}
          .configValue=${'data_source'}
          @value-changed=${this._handleSelectorChanged}
        ></ha-selector>
        <div class="side-by-side">
          <ha-selector
            .hass=${this.hass}
            .selector=${{
              select: {
                options: [
                  { value: 'Auto', label: localize('editor.map.style_auto') },
                  { value: 'Light', label: localize('editor.map.style_light') },
                  { value: 'Voyager', label: localize('editor.map.style_voyager') },
                  { value: 'Dark', label: localize('editor.map.style_dark') },
                  { value: 'Satellite', label: localize('editor.map.style_satellite') },
                  { value: 'OSM', label: localize('editor.map.style_osm') },
                ],
              },
            }}
            .value=${config.map_style || 'Auto'}
            .label=${localize('editor.map.map_style')}
            .configValue=${'map_style'}
            @value-changed=${this._handleSelectorChanged}
          ></ha-selector>
          <ha-selector
            .hass=${this.hass}
            .selector=${{
              select: {
                options: [
                  { value: '', label: localize('editor.map.zoom_default') },
                  { value: '4', label: '4' },
                  { value: '5', label: '5' },
                  { value: '6', label: '6' },
                  { value: '7', label: '7' },
                  { value: '8', label: '8' },
                  { value: '9', label: '9' },
                  { value: '10', label: '10' },
                ],
              },
            }}
            .value=${config.zoom_level?.toString() || ''}
            .label=${localize('editor.map.zoom_level')}
            .configValue=${'zoom_level'}
            @value-changed=${this._handleSelectorNumberChanged}
          ></ha-selector>
        </div>

        <!-- LOCATION -->
        <h3 class="section-header">${localize('editor.section.location')}</h3>
        <div class="side-by-side">
          <ha-textfield
            label=${localize('editor.location.centre_latitude')}
            .value=${this._formatCoordinateValue(config.center_latitude)}
            .configValue=${'center_latitude'}
            @input=${this._valueChangedCoordinate}
            helper=${localize('editor.location.number_or_entity')}
          ></ha-textfield>
          <ha-textfield
            label=${localize('editor.location.centre_longitude')}
            .value=${this._formatCoordinateValue(config.center_longitude)}
            .configValue=${'center_longitude'}
            @input=${this._valueChangedCoordinate}
            helper=${localize('editor.location.number_or_entity')}
          ></ha-textfield>
        </div>

        <!-- MARKERS -->
        <h3 class="section-header">${localize('editor.section.markers')}</h3>
        <button
          class="subpage-nav-row"
          @click=${() => this._setView('markers')}
        >
          <span class="subpage-nav-label">${localize('editor.section.markers')}</span>
          <span class="subpage-nav-summary">
            ${localize('editor.markers.count_summary').replace('{n}', String((config.markers ?? []).length))}
          </span>
          <span class="subpage-nav-chevron">›</span>
        </button>

        <!-- DISPLAY -->
        <h3 class="section-header">${localize('editor.section.display')}</h3>
        <div class="side-by-side">
          <label>${localize('editor.display.show_zoom')}
            <ha-switch .checked=${config.show_zoom === true} .configValue=${'show_zoom'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.show_playback')}
            <ha-switch .checked=${config.show_playback === true} .configValue=${'show_playback'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.show_recenter')}
            <ha-switch .checked=${config.show_recenter === true} .configValue=${'show_recenter'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
        </div>
        <div class="side-by-side">
          <label>${localize('editor.display.show_scale')}
            <ha-switch .checked=${config.show_scale === true} .configValue=${'show_scale'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.show_range')}
            <ha-switch .checked=${config.show_range === true} .configValue=${'show_range'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.extra_labels')}
            <ha-switch .checked=${config.extra_labels === true} .configValue=${'extra_labels'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
        </div>
        <div class="side-by-side">
          <label>${localize('editor.display.static_map')}
            <ha-switch .checked=${config.static_map === true} .configValue=${'static_map'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.square_map')}
            <ha-switch .checked=${config.square_map === true} .configValue=${'square_map'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.cluster_markers')}
            <ha-switch .checked=${config.cluster_markers !== false} .configValue=${'cluster_markers'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
        </div>
        <div class="side-by-side">
          <label>${localize('editor.display.show_snow')}
            <ha-switch .checked=${config.show_snow === true} .configValue=${'show_snow'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.show_color_bar')}
            <ha-switch .checked=${config.show_color_bar !== false} .configValue=${'show_color_bar'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
          <label>${localize('editor.display.show_progress_bar')}
            <ha-switch .checked=${config.show_progress_bar !== false} .configValue=${'show_progress_bar'} @change=${this._valueChangedSwitch}></ha-switch>
          </label>
        </div>

        <!-- INTERACTION -->
        <h3 class="section-header">${localize('editor.section.interaction')}</h3>
        <label>${localize('editor.interaction.disable_scroll')}
          <ha-switch .checked=${config.disable_scroll === true} .configValue=${'disable_scroll'} @change=${this._valueChangedSwitch}></ha-switch>
        </label>
        <ha-selector
          .hass=${this.hass}
          .selector=${{
            select: {
              options: [
                { value: 'none', label: localize('editor.interaction.double_tap_none') },
                { value: 'recenter', label: localize('editor.interaction.double_tap_recenter') },
                { value: 'toggle_play', label: localize('editor.interaction.double_tap_toggle_play') },
              ],
            },
          }}
          .value=${config.double_tap_action || 'none'}
          .label=${localize('editor.interaction.double_tap_action')}
          .configValue=${'double_tap_action'}
          @value-changed=${this._handleSelectorChanged}
        ></ha-selector>

        <!-- ANIMATION -->
        <h3 class="section-header">${localize('editor.section.animation')}</h3>
        <div class="side-by-side">
          <ha-textfield
            label=${localize('editor.animation.frame_count')}
            .value=${config.frame_count ? config.frame_count : ''}
            .configValue=${'frame_count'}
            @input=${this._valueChangedNumber}
            helper=${localize('editor.animation.default_5')}
          ></ha-textfield>
          <ha-textfield
            label=${localize('editor.animation.frame_delay')}
            .value=${config.frame_delay ? config.frame_delay : ''}
            .configValue=${'frame_delay'}
            @input=${this._valueChangedNumber}
            helper=${localize('editor.animation.default_500')}
          ></ha-textfield>
          <ha-textfield
            label=${localize('editor.animation.restart_delay')}
            .value=${config.restart_delay ? config.restart_delay : ''}
            .configValue=${'restart_delay'}
            @input=${this._valueChangedNumber}
            helper=${localize('editor.animation.default_1000')}
          ></ha-textfield>
        </div>
        <label>${localize('editor.animation.animated_transitions')}
          <ha-switch
            .checked=${config.animated_transitions !== false}
            .configValue=${'animated_transitions'}
            @change=${this._valueChangedSwitch}
          ></ha-switch>
        </label>
        ${config.animated_transitions !== false ? html`
          <ha-textfield
            label=${localize('editor.animation.transition_time')}
            .value=${config.transition_time !== undefined ? config.transition_time : ''}
            .configValue=${'transition_time'}
            @input=${this._valueChangedNumber}
            helper=${localize('editor.animation.transition_time_helper')}
            ?disabled=${config.smooth_animation === true}
          ></ha-textfield>
          <label>
            <ha-switch
              .checked=${config.smooth_animation === true}
              .configValue=${'smooth_animation'}
              @change=${this._valueChangedSwitch}
            ></ha-switch>
            <span>${localize('editor.animation.smooth_animation')}</span>
          </label>
          <ha-selector
            .hass=${this.hass}
            .selector=${{ number: { min: 0, max: 1, step: 0.05, mode: 'slider' } }}
            .value=${config.smooth_overlap ?? 1}
            .label=${localize('editor.animation.smooth_overlap')}
            .helper=${localize('editor.animation.smooth_overlap_helper')}
            .configValue=${'smooth_overlap'}
            .disabled=${config.smooth_animation !== true}
            @value-changed=${this._handleSelectorChanged}
          ></ha-selector>
        ` : ''}

        <!-- APPEARANCE -->
        <h3 class="section-header">${localize('editor.section.appearance')}</h3>
        <div class="side-by-side">
          <ha-textfield
            label=${localize('editor.appearance.height')}
            .value=${config.height ? config.height : ''}
            .configValue=${'height'}
            @input=${this._valueChangedString}
            helper=${localize('editor.appearance.height_helper')}
          ></ha-textfield>
          <ha-textfield
            label=${localize('editor.appearance.width')}
            .value=${config.width ? config.width : ''}
            .configValue=${'width'}
            @input=${this._valueChangedString}
            helper=${localize('editor.appearance.width_helper')}
          ></ha-textfield>
        </div>
        <ha-selector
          .hass=${this.hass}
          .selector=${{ number: { min: 0.1, max: 1.0, step: 0.05, mode: 'slider' } }}
          .value=${config.radar_opacity ?? 1.0}
          .label=${localize('editor.appearance.radar_opacity')}
          .helper=${localize('editor.appearance.radar_opacity_helper')}
          .configValue=${'radar_opacity'}
          @value-changed=${this._handleSelectorChanged}
        ></ha-selector>

      </div>
    `;
  }

  private _renderMarkersView(config: WeatherRadarCardConfig): TemplateResult {
    const markers = config.markers ?? [];
    return html`
      <div class="values">
        <button class="subpage-back" @click=${() => this._setView('main')}>
          ‹ ${localize('editor.markers.back')}
        </button>
        <h3 class="section-header">${localize('editor.section.markers')}</h3>
        ${markers.map((m, i) => this._renderMarkerRow(m, i))}
        <button class="add-marker-btn" @click=${this._addMarker}>${localize('editor.markers.add')}</button>
      </div>
    `;
  }

  private _setView(view: 'main' | 'markers'): void {
    this._view = view;
    // Scroll the editor pane back to the top so the user always lands at the
    // start of the new view, not part-way down where they were on the old one.
    this.shadowRoot?.querySelector('.values')?.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  private _renderMarkerRow(m: Marker, i: number) {
    const trackOptions = [
      { value: '', label: localize('editor.markers.track_off') },
      { value: 'entity', label: localize('editor.markers.track_entity') },
      { value: 'true', label: localize('editor.markers.track_always') },
    ];
    const trackValue = m.track === true ? 'true' : (m.track === 'entity' ? 'entity' : '');

    return html`
      <div class="marker-row">
        <div class="marker-row-header">
          <span class="marker-row-label">${localize('editor.markers.label', '{n}', String(i + 1))}</span>
          <button class="remove-marker-btn" @click=${() => this._removeMarker(i)}>${localize('editor.markers.remove')}</button>
        </div>
        <ha-selector
          .hass=${this.hass}
          .selector=${{
            entity: {
              filter: [
                { domain: 'device_tracker' },
                { domain: 'person' },
                { domain: 'zone' },
              ],
            },
          }}
          .value=${m.entity || ''}
          .label=${localize('editor.markers.entity')}
          .markerIndex=${i}
          .markerField=${'entity'}
          @value-changed=${this._updateMarkerSelector}
        ></ha-selector>
        ${!m.entity ? html`
          <div class="side-by-side">
            <ha-textfield
              label=${localize('editor.markers.latitude')}
              .value=${m.latitude !== undefined ? String(m.latitude) : ''}
              .markerIndex=${i}
              .markerField=${'latitude'}
              @input=${this._updateMarkerFieldNumber}
            ></ha-textfield>
            <ha-textfield
              label=${localize('editor.markers.longitude')}
              .value=${m.longitude !== undefined ? String(m.longitude) : ''}
              .markerIndex=${i}
              .markerField=${'longitude'}
              @input=${this._updateMarkerFieldNumber}
            ></ha-textfield>
          </div>
        ` : ''}
        ${m.entity && m.entity.startsWith('person.') ? html`
          <label class="marker-mobile-only">${localize('editor.markers.use_entity_picture')}
            <ha-switch
              .checked=${m.icon === 'entity_picture'}
              .markerIndex=${i}
              @change=${this._toggleEntityPicture}
            ></ha-switch>
          </label>
        ` : ''}
        ${m.icon !== 'entity_picture' ? html`
          <ha-icon-picker
            .hass=${this.hass}
            .label=${localize('editor.markers.icon')}
            .value=${m.icon || ''}
            .markerIndex=${i}
            .markerField=${'icon'}
            @value-changed=${this._updateMarkerSelector}
          ></ha-icon-picker>
        ` : html`
          <ha-textfield
            label=${localize('editor.markers.icon_entity')}
            .value=${m.icon_entity || ''}
            .markerIndex=${i}
            .markerField=${'icon_entity'}
            @input=${this._updateMarkerField}
          ></ha-textfield>
        `}
        <ha-selector
          .hass=${this.hass}
          .selector=${{ select: { options: trackOptions } }}
          .value=${trackValue}
          .label=${localize('editor.markers.tracking')}
          .markerIndex=${i}
          .markerField=${'track'}
          @value-changed=${this._updateMarkerSelector}
        ></ha-selector>
        ${m.entity && m.icon !== 'entity_picture' ? html`
          <div class="marker-color-row">
            <span class="color-label">${localize('editor.markers.icon_colour')}</span>
            <input
              type="color"
              .value=${m.color || '#888888'}
              .markerIndex=${i}
              @input=${this._updateMarkerColor}
            />
            ${m.color ? html`
              <button class="clear-color-btn" @click=${() => this._clearMarkerColor(i)}>${localize('editor.markers.reset')}</button>
            ` : ''}
          </div>
        ` : ''}
        <label class="marker-mobile-only">${localize('editor.markers.mobile_only')}
          <ha-switch
            .checked=${m.mobile_only === true}
            .markerIndex=${i}
            .markerField=${'mobile_only'}
            @change=${this._updateMarkerSwitch}
          ></ha-switch>
        </label>
      </div>
    `;
  }

  private _addMarker(): void {
    if (!this._config) return;
    const markers = [...(this._config.markers ?? []), {}];
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _removeMarker(i: number): void {
    if (!this._config) return;
    const markers = (this._config.markers ?? []).filter((_, idx) => idx !== i);
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _updateMarkerField(ev): void {
    if (!this._config) return;
    const target = ev.target;
    const i: number = target.markerIndex;
    const field: string = target.markerField;
    const value: string = target.value?.trim() ?? '';
    const markers = [...(this._config.markers ?? [])];
    markers[i] = { ...markers[i], [field]: value || undefined };
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _updateMarkerFieldNumber(ev): void {
    if (!this._config) return;
    const target = ev.target;
    const i: number = target.markerIndex;
    const field: string = target.markerField;
    const raw: string = target.value?.trim() ?? '';
    const num = raw === '' ? undefined : parseFloat(raw);
    const markers = [...(this._config.markers ?? [])];
    markers[i] = { ...markers[i], [field]: num };
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _updateMarkerSelector(ev: CustomEvent): void {
    if (!this._config) return;
    const target = ev.target as any;
    const i: number = target.markerIndex;
    const field: string = target.markerField;
    let value: any = ev.detail.value;
    if (field === 'track') {
      value = value === 'true' ? true : value === 'entity' ? 'entity' : undefined;
    } else if (value === '' || value === null) {
      value = undefined;
    }
    const markers = [...(this._config.markers ?? [])];
    const updated: Marker = { ...markers[i], [field]: value };

    // When the user picks an entity and no icon is set yet, default the icon
    // to the entity's natural representation: a photo for person.*, otherwise
    // the entity's HA icon attribute (e.g. mdi:home for zone.home).
    if (field === 'entity' && value && !updated.icon) {
      const derived = this._defaultIconForEntity(value as string);
      if (derived) updated.icon = derived;
    }

    markers[i] = updated;
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _defaultIconForEntity(entityId: string): string | undefined {
    const state = this.hass?.states[entityId];
    const haIcon = state?.attributes?.icon;
    if (typeof haIcon === 'string' && haIcon) return haIcon;
    if (entityId.startsWith('person.')) {
      return state?.attributes?.entity_picture ? 'entity_picture' : 'mdi:account';
    }
    if (entityId.startsWith('zone.')) {
      return entityId === 'zone.home' ? 'mdi:home' : 'mdi:map-marker-radius';
    }
    // device_tracker uses source_type, not device_class
    if (entityId.startsWith('device_tracker.')) {
      const src = state?.attributes?.source_type;
      if (src === 'router') return 'mdi:router-wireless';
      if (src === 'bluetooth' || src === 'bluetooth_le') return 'mdi:bluetooth';
      return 'mdi:crosshairs-gps';
    }
    const cls = state?.attributes?.device_class;
    if (typeof cls === 'string' && cls) {
      const icon = DEVICE_CLASS_ICONS[cls];
      if (icon) return icon;
    }
    return 'mdi:map-marker';
  }

  private _toggleEntityPicture(ev: Event): void {
    if (!this._config) return;
    const target = ev.target as HTMLInputElement & { markerIndex: number };
    const i = target.markerIndex;
    const markers = [...(this._config.markers ?? [])];
    const cur = markers[i];
    markers[i] = target.checked
      ? { ...cur, icon: 'entity_picture' }
      : { ...cur, icon: this._defaultIconForEntity(cur.entity ?? '') };
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _updateMarkerColor(ev: Event): void {
    if (!this._config) return;
    const target = ev.target as HTMLInputElement & { markerIndex: number };
    const markers = [...(this._config.markers ?? [])];
    markers[target.markerIndex] = { ...markers[target.markerIndex], color: target.value };
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _clearMarkerColor(i: number): void {
    if (!this._config) return;
    const markers = [...(this._config.markers ?? [])];
    const m = { ...markers[i] };
    delete m.color;
    markers[i] = m;
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _updateMarkerSwitch(ev): void {
    if (!this._config) return;
    const target = ev.target;
    const i: number = target.markerIndex;
    const field: string = target.markerField;
    const markers = [...(this._config.markers ?? [])];
    markers[i] = { ...markers[i], [field]: target.checked || undefined };
    this._config = { ...this._config, markers };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _initialize(): void {
    if (this.hass === undefined) return;
    if (this._config === undefined) return;
    if (this._helpers === undefined) return;
    this._initialized = true;
  }

  private async loadCardHelpers(): Promise<void> {
    this._helpers = await (window as any).loadCardHelpers();
  }

  private _handleSelectorChanged(ev: CustomEvent): void {
    const configValue = (ev.target as any).configValue;
    const value = ev.detail.value;

    if (!this._config || !configValue) return;
    if (this._config[configValue] === value) return;

    if (value === '' || value === null) {
      const newConfig = { ...this._config };
      delete newConfig[configValue];
      this._config = newConfig;
    } else {
      this._config = {
        ...this._config,
        [configValue]: value,
      };
    }
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _handleSelectorNumberChanged(ev: CustomEvent): void {
    const configValue = (ev.target as any).configValue;
    const value = ev.detail.value;

    if (!this._config || !configValue) return;

    const numValue = value === '' || value === null ? null : Number(value);
    if (this._config[configValue] === numValue) return;

    if (numValue === null) {
      const newConfig = { ...this._config };
      delete newConfig[configValue];
      this._config = newConfig;
    } else {
      this._config = {
        ...this._config,
        [configValue]: numValue,
      };
    }
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _valueChangedSwitch(ev): void {
    const target = ev.target;

    if (!this._config || !this.hass || !target) {
      return;
    }
    this._config = {
      ...this._config,
      [target.configValue]: target.checked,
    };
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _valueChangedNumber(ev): void {
    if (!this._config || !this.hass) {
      return;
    }
    const target = ev.target;
    const configValue = target.configValue;
    const value = target.value;
    if (this._config[configValue] === Number(value)) {
      return;
    }

    if (configValue) {
      if (value === '' || value === null) {
        const newConfig = { ...this._config };
        delete newConfig[configValue];
        this._config = newConfig;
      } else {
        this._config = {
          ...this._config,
          [configValue]: Number(value),
        };
      }
    }
    fireEvent(this, 'config-changed', { config: this._config });
  }

  private _valueChangedString(ev): void {
    if (!this._config || !this.hass) {
      return;
    }
    const target = ev.target;
    const configValue = target.configValue;
    const value = target.value;
    if (this._config[configValue] === value) {
      return;
    }

    if (configValue) {
      if (value === '') {
        const newConfig = { ...this._config };
        delete newConfig[configValue];
        this._config = newConfig;
      } else {
        this._config = {
          ...this._config,
          [configValue]: value,
        };
      }
    }
    fireEvent(this, 'config-changed', { config: this._config });
  }

  /**
   * Formats coordinate config for display in text field
   * Handles numbers, strings, and entity objects
   */
  private _formatCoordinateValue(value: CoordinateConfig | undefined): string {
    if (value === undefined || value === null) {
      return '';
    }
    if (typeof value === 'number') {
      return value.toString();
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && 'entity' in value) {
      // For object format, just show the entity ID
      return value.entity;
    }
    return '';
  }

  /**
   * Handles coordinate field changes (accepts both numbers and entity IDs)
   */
  private _valueChangedCoordinate(ev): void {
    if (!this._config || !this.hass) {
      return;
    }
    const target = ev.target;
    if (target.configValue) {
      const value = target.value?.trim();

      if (value === '' || value === null) {
        // Remove config value
        delete this._config[target.configValue];
      } else {
        // Check if it's a number or entity ID
        const numValue = parseFloat(value);

        if (!isNaN(numValue)) {
          // Store as number (backwards compatible)
          this._config = {
            ...this._config,
            [target.configValue]: numValue,
          };
        } else if (value.includes('.')) {
          // Looks like an entity ID (has a dot)
          this._config = {
            ...this._config,
            [target.configValue]: value,
          };
        } else {
          // Invalid - show console warning but keep value
          console.warn(
            `Weather Radar Card Editor: '${value}' should be a number or entity ID (e.g., device_tracker.phone)`,
          );
          this._config = {
            ...this._config,
            [target.configValue]: value,
          };
        }
      }
    }
    fireEvent(this, 'config-changed', { config: this._config });
  }

  static styles: CSSResultGroup = css`
    ha-select,
    ha-selector,
    ha-textfield {
      margin-bottom: 16px;
      display: block;
    }
    .section-header {
      font-size: 0.75em;
      font-weight: 600;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--primary-color);
      margin: 20px 0 8px 0;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--divider-color);
    }
    .section-header:first-child {
      margin-top: 4px;
    }
    .section-description {
      font-size: 0.85em;
      color: var(--secondary-text-color);
      margin: 0 0 12px 0;
    }
    .subsection {
      margin-left: 16px;
      padding-left: 8px;
      border-left: 2px solid var(--divider-color);
      margin-bottom: 8px;
    }
    label {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 0;
      font-size: 0.95em;
    }
    ha-switch {
      padding: 12px 6px;
    }
    .side-by-side {
      display: flex;
      gap: 8px;
    }
    .side-by-side > * {
      flex: 1;
      min-width: 0;
    }
    .values {
      padding: 0 16px 8px 16px;
      background: var(--secondary-background-color);
    }
    .marker-row {
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      padding: 8px 12px;
      margin-bottom: 8px;
    }
    .marker-row-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 4px;
    }
    .marker-row-label {
      font-size: 0.85em;
      font-weight: 600;
      color: var(--secondary-text-color);
    }
    .remove-marker-btn {
      font-size: 0.8em;
      padding: 2px 8px;
      border: 1px solid var(--error-color, #f44336);
      border-radius: 4px;
      background: none;
      color: var(--error-color, #f44336);
      cursor: pointer;
    }
    .add-marker-btn {
      width: 100%;
      padding: 8px;
      border: 1px dashed var(--primary-color);
      border-radius: 6px;
      background: none;
      color: var(--primary-color);
      cursor: pointer;
      font-size: 0.9em;
      margin-bottom: 8px;
    }
    /* Subpage navigation row on the main editor page — clickable, looks
       like a settings list item with chevron. */
    .subpage-nav-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 8px;
      border: 1px solid var(--divider-color);
      border-radius: 6px;
      background: var(--card-background-color, var(--ha-card-background, transparent));
      color: var(--primary-text-color);
      cursor: pointer;
      font-size: 0.95em;
      margin-bottom: 8px;
      text-align: left;
    }
    .subpage-nav-row:hover {
      border-color: var(--primary-color);
    }
    .subpage-nav-label { flex: 1; }
    .subpage-nav-summary {
      color: var(--secondary-text-color);
      font-size: 0.9em;
    }
    .subpage-nav-chevron {
      color: var(--secondary-text-color);
      font-size: 1.4em;
      line-height: 1;
    }
    /* Back-button at the top of a subpage view. */
    .subpage-back {
      display: inline-block;
      margin: 4px 0 8px 0;
      padding: 4px 10px 4px 6px;
      border: none;
      background: none;
      color: var(--primary-color);
      font-size: 0.9em;
      cursor: pointer;
    }
    .subpage-back:hover { text-decoration: underline; }
    .marker-mobile-only {
      font-size: 0.85em;
    }
    .marker-color-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 0 8px 0;
    }
    .color-label {
      font-size: 0.85em;
      color: var(--secondary-text-color);
      flex: 1;
    }
    input[type='color'] {
      width: 40px;
      height: 32px;
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      cursor: pointer;
      padding: 2px;
      background: none;
    }
    .clear-color-btn {
      font-size: 0.8em;
      padding: 2px 8px;
      border: 1px solid var(--divider-color);
      border-radius: 4px;
      background: none;
      color: var(--secondary-text-color);
      cursor: pointer;
    }
  `;
}
