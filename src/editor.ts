/* eslint-disable @typescript-eslint/no-explicit-any */
import { LitElement, html, TemplateResult, css, CSSResultGroup } from 'lit';
import { HomeAssistant, fireEvent, LovelaceCardEditor } from 'custom-card-helpers';

import { WeatherRadarCardConfig, CoordinateConfig, Marker } from './types';
import { migrateConfig } from './marker-utils';
import { localize } from './localize/localize';
import { ALL_ALERT_CATEGORIES, getActiveAlertCategories } from './nws-alert-categories';
import { isBlitzortungLoaded } from './lightning-helpers';
import { isSectionHeightPinned } from './card-layout';
import { getSourceCaps, getEffectiveTimeRange } from './source-caps';
import { WIND_SOURCE_CAPS, getWindSourceCaps, DEFAULT_WIND_SOURCE, type WindSource } from './wind-source-caps';
import { customElement, property, state } from 'lit/decorators.js';

// Curated past-time presets in minutes. Editor filters to ≤ source's
// editorMaxPastMin. 20/40 give finer-grained control at the small end
// where users care most; the upper end skips toward larger steps.
const PAST_PRESETS_MIN = [20, 40, 60, 120, 240, 360, 720, 1440, 2880, 4320, 5040];

function formatDuration(min: number): string {
  if (min < 60) return `${min} min`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

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
  @state() private _view: 'main' | 'markers' | 'overlays' | 'wind' = 'main';

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
    // Tell every weather-radar-card on the dashboard that *some* editor is
    // now open. Cards use this to switch on auto-propagate of pan/zoom
    // into the editor's Lat/Long/Zoom fields — see _initMap in the card.
    //
    // Also bump a global mount counter so a preview card that mounts
    // AFTER us (and therefore missed the 'opened' event) can detect that
    // an editor is already live and start pushing immediately. Without
    // this, the back-prop silently never fires for the preview-card +
    // editor pair when the dialog mounts the editor first.
    const w = window as unknown as { __weatherRadarCardEditorCount?: number };
    w.__weatherRadarCardEditorCount = (w.__weatherRadarCardEditorCount ?? 0) + 1;
    window.dispatchEvent(new CustomEvent('weather-radar-editor-opened'));
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.removeEventListener('weather-radar-center-update', this._boundCenterUpdate);
    const w = window as unknown as { __weatherRadarCardEditorCount?: number };
    w.__weatherRadarCardEditorCount = Math.max(0, (w.__weatherRadarCardEditorCount ?? 0) - 1);
    window.dispatchEvent(new CustomEvent('weather-radar-editor-closed'));
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
    if (this._view === 'markers') return this._renderMarkersView(this._config);
    if (this._view === 'overlays') return this._renderOverlaysView(this._config);
    if (this._view === 'wind') return this._renderWindView(this._config);
    return this._renderMainView(this._config);
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
        ${this._renderTimeRangeFields(config)}
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
          <ha-input
            label=${localize('editor.location.centre_latitude')}
            .value=${this._formatCoordinateValue(config.center_latitude)}
            .configValue=${'center_latitude'}
            @input=${this._valueChangedCoordinate}
            hint=${localize('editor.location.number_or_entity')}
          ></ha-input>
          <ha-input
            label=${localize('editor.location.centre_longitude')}
            .value=${this._formatCoordinateValue(config.center_longitude)}
            .configValue=${'center_longitude'}
            @input=${this._valueChangedCoordinate}
            hint=${localize('editor.location.number_or_entity')}
          ></ha-input>
        </div>

        <!-- MARKERS AND OVERLAYS -->
        <h3 class="section-header">${localize('editor.section.markers_and_overlays')}</h3>
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
        <button
          class="subpage-nav-row"
          @click=${() => this._setView('overlays')}
        >
          <span class="subpage-nav-label">${localize('editor.section.overlays')}</span>
          <span class="subpage-nav-summary">${this._overlaysSummary(config)}</span>
          <span class="subpage-nav-chevron">›</span>
        </button>
        <button
          class="subpage-nav-row"
          @click=${() => this._setView('wind')}
        >
          <span class="subpage-nav-label">${localize('editor.section.wind_overlay')}</span>
          <span class="subpage-nav-summary">${this._windSummary(config)}</span>
          <span class="subpage-nav-chevron">›</span>
        </button>

        <!-- DISPLAY -->
        <h3 class="section-header">${localize('editor.section.display')}</h3>
        <div class="side-by-side">
          <label>
            <ha-switch .checked=${config.show_zoom === true} .configValue=${'show_zoom'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_zoom')}</span>
          </label>
          <label>
            <ha-switch .checked=${config.show_playback === true} .configValue=${'show_playback'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_playback')}</span>
          </label>
          <label>
            <ha-switch .checked=${config.show_recenter === true} .configValue=${'show_recenter'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_recenter')}</span>
          </label>
        </div>
        <div class="side-by-side">
          <label>
            <ha-switch .checked=${config.show_scale === true} .configValue=${'show_scale'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_scale')}</span>
          </label>
          <label>
            <ha-switch .checked=${config.show_range === true} .configValue=${'show_range'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_range')}</span>
          </label>
          <label>
            <ha-switch .checked=${config.extra_labels === true} .configValue=${'extra_labels'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.extra_labels')}</span>
          </label>
        </div>
        <div class="side-by-side">
          <label>
            <ha-switch .checked=${config.static_map === true} .configValue=${'static_map'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.static_map')}</span>
          </label>
          ${(() => {
            // square_map has no effect once the card's height is being
            // externally pinned: an explicit `height:` config wins, and
            // a sections-grid cell with a fixed row count constrains
            // the card to that cell. Grey out the toggle in those cases
            // so the user isn't left wondering why nothing happened.
            // grid_options.rows: 'auto' means HA gave the card freedom
            // to pick — that counts as un-pinned.
            const heightPinned = !!config.height || isSectionHeightPinned(config);
            return html`
              <label class=${heightPinned ? 'disabled-row' : ''}
                     title=${heightPinned ? localize('editor.display.square_map_disabled_helper') : ''}>
                <ha-switch
                  .checked=${config.square_map === true}
                  .disabled=${heightPinned}
                  .configValue=${'square_map'}
                  @change=${this._valueChangedSwitch}
                ></ha-switch>
                <span>${localize('editor.display.square_map')}</span>
              </label>
            `;
          })()}
          <label>
            <ha-switch .checked=${config.cluster_markers !== false} .configValue=${'cluster_markers'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.cluster_markers')}</span>
          </label>
        </div>
        <div class="side-by-side">
          <label>
            <ha-switch .checked=${config.show_snow === true} .configValue=${'show_snow'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_snow')}</span>
          </label>
          <label>
            <ha-switch .checked=${config.show_color_bar !== false} .configValue=${'show_color_bar'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_color_bar')}</span>
          </label>
          <label>
            <ha-switch .checked=${config.show_progress_bar !== false} .configValue=${'show_progress_bar'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_progress_bar')}</span>
          </label>
          <label>
            <ha-switch .checked=${config.show_loading_spinner !== false} .configValue=${'show_loading_spinner'} @change=${this._valueChangedSwitch}></ha-switch>
            <span>${localize('editor.display.show_loading_spinner')}</span>
          </label>
        </div>

        <!-- INTERACTION -->
        <h3 class="section-header">${localize('editor.section.interaction')}</h3>
        <label>
          <ha-switch .checked=${config.disable_scroll === true} .configValue=${'disable_scroll'} @change=${this._valueChangedSwitch}></ha-switch>
          <span>${localize('editor.interaction.disable_scroll')}</span>
        </label>
        <ha-selector
          .hass=${this.hass}
          .selector=${{
            select: {
              options: [
                { value: 'zoom_in', label: localize('editor.interaction.double_tap_zoom_in') },
                { value: 'recenter', label: localize('editor.interaction.double_tap_recenter') },
                { value: 'toggle_play', label: localize('editor.interaction.double_tap_toggle_play') },
                { value: 'none', label: localize('editor.interaction.double_tap_none') },
              ],
            },
          }}
          .value=${typeof config.double_tap_action === 'string' ? config.double_tap_action : 'zoom_in'}
          .label=${localize('editor.interaction.double_tap_action')}
          .configValue=${'double_tap_action'}
          @value-changed=${this._handleSelectorChanged}
        ></ha-selector>

        <!-- ANIMATION -->
        <h3 class="section-header">${localize('editor.section.animation')}</h3>
        <div class="side-by-side">
          <ha-input
            label=${localize('editor.animation.frame_delay')}
            .value=${config.frame_delay ? config.frame_delay : ''}
            .configValue=${'frame_delay'}
            @input=${this._valueChangedNumber}
            hint=${localize('editor.animation.default_500')}
          ></ha-input>
          <ha-input
            label=${localize('editor.animation.restart_delay')}
            .value=${config.restart_delay ? config.restart_delay : ''}
            .configValue=${'restart_delay'}
            @input=${this._valueChangedNumber}
            hint=${localize('editor.animation.default_1000')}
          ></ha-input>
        </div>
        <label>
          <ha-switch
            .checked=${config.animated_transitions !== false}
            .configValue=${'animated_transitions'}
            @change=${this._valueChangedSwitch}
          ></ha-switch>
          <span>${localize('editor.animation.animated_transitions')}</span>
        </label>
        ${config.animated_transitions !== false ? html`
          <ha-input
            label=${localize('editor.animation.transition_time')}
            .value=${config.transition_time !== undefined ? config.transition_time : ''}
            .configValue=${'transition_time'}
            @input=${this._valueChangedNumber}
            hint=${localize('editor.animation.transition_time_helper')}
            ?disabled=${config.smooth_animation === true}
          ></ha-input>
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
          <label>
            <ha-switch
              .checked=${config.motion_compensation === true}
              .configValue=${'motion_compensation'}
              @change=${this._valueChangedSwitch}
            ></ha-switch>
            <span>${localize('editor.animation.motion_compensation')}</span>
          </label>
          <div class="section-description">${localize('editor.animation.motion_compensation_helper')}</div>
        ` : ''}
        <ha-selector
          .hass=${this.hass}
          .selector=${{
            select: {
              mode: 'dropdown',
              options: [
                { value: 0.25, label: localize('editor.animation.playback_speed_quarter') },
                { value: 0.5,  label: localize('editor.animation.playback_speed_half') },
                { value: 1,    label: localize('editor.animation.playback_speed_normal') },
                { value: 2,    label: localize('editor.animation.playback_speed_double') },
                { value: 4,    label: localize('editor.animation.playback_speed_quad') },
              ],
            },
          }}
          .value=${config.playback_speed ?? 1}
          .label=${localize('editor.animation.playback_speed')}
          .helper=${localize('editor.animation.playback_speed_helper')}
          .configValue=${'playback_speed'}
          @value-changed=${this._handleSelectorChanged}
        ></ha-selector>
        ${getEffectiveTimeRange(config).frameCount > 1 ? html`
        <label>
          <ha-switch
            .checked=${config.start_paused === true}
            .configValue=${'start_paused'}
            @change=${this._valueChangedSwitch}
          ></ha-switch>
          <span>${localize('editor.animation.start_paused')}</span>
        </label>
        <div class="section-description">${localize('editor.animation.start_paused_helper')}</div>
        ` : ''}
        <label>
          <ha-switch
            .checked=${config.viewer_layer_control === true}
            .configValue=${'viewer_layer_control'}
            @change=${this._valueChangedSwitch}
          ></ha-switch>
          <span>${localize('editor.animation.viewer_layer_control')}</span>
        </label>
        <div class="section-description">${localize('editor.animation.viewer_layer_control_helper')}</div>

        <!-- APPEARANCE -->
        <h3 class="section-header">${localize('editor.section.appearance')}</h3>
        <div class="side-by-side">
          ${(() => {
            // A fixed-row sections-grid cell owns the height (see
            // card-layout.ts / resolveCardLayout): the `height:` config is
            // ignored, so disable + dim the field and explain why, rather
            // than letting the user type a value that does nothing. Same
            // treatment as the square_map toggle above. Gated on the
            // section constraint only — an explicit height must stay
            // editable so the user can clear or change it.
            const sectionLocked = isSectionHeightPinned(config);
            return html`
              <ha-input
                class=${sectionLocked ? 'disabled-row' : ''}
                label=${localize('editor.appearance.height')}
                .value=${config.height ? config.height : ''}
                .configValue=${'height'}
                .disabled=${sectionLocked}
                @input=${this._valueChangedString}
                hint=${sectionLocked
                  ? localize('editor.appearance.height_section_locked_helper')
                  : localize('editor.appearance.height_helper')}
              ></ha-input>
            `;
          })()}
          <ha-input
            label=${localize('editor.appearance.width')}
            .value=${config.width ? config.width : ''}
            .configValue=${'width'}
            @input=${this._valueChangedString}
            hint=${localize('editor.appearance.width_helper')}
          ></ha-input>
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

  // Compose the right-hand summary text for the Overlays nav row. Empty
  // string means neither overlay is enabled — the user gets just the row
  // label with no count, which reads as "tap to enable".
  private _overlaysSummary(config: WeatherRadarCardConfig): string {
    const parts: string[] = [];
    if (config.show_wildfires === true) parts.push(localize('ui.region_warning.label.wildfires'));
    if (config.show_alerts === true) parts.push(localize('ui.region_warning.label.alerts'));
    if (config.show_lightning === true) parts.push(localize('editor.overlays.lightning_label'));
    if (parts.length === 0) return localize('editor.overlays.none_enabled');
    return parts.join(', ');
  }

  // Right-hand summary for the Wind Overlay nav row. Stacks the active
  // layers ("Barbs + Flow") so the user can see the current state without
  // entering the subpage.
  private _windSummary(config: WeatherRadarCardConfig): string {
    const parts: string[] = [];
    const style = config.dwd_wind ?? 'off';
    if (style === 'barbs') parts.push(localize('editor.wind.summary_barbs'));
    else if (style === 'arrows') parts.push(localize('editor.wind.summary_arrows'));
    if (config.dwd_wind_flow === true) parts.push(localize('editor.wind.summary_flow'));
    if (parts.length === 0) return localize('editor.wind.summary_off');
    return parts.join(' + ');
  }

  private _renderWindView(config: WeatherRadarCardConfig): TemplateResult {
    const style = config.dwd_wind ?? 'off';
    return html`
      <div class="values">
        <button class="subpage-back" @click=${() => this._setView('main')}>
          ‹ ${localize('editor.wind.back')}
        </button>

        <h3 class="section-header">${localize('editor.wind.header')}</h3>
        <p class="section-description">${localize('editor.wind.description')}</p>
        <p class="section-description" style="font-size:0.78em;font-style:italic;margin-top:-8px">
          ${this._cadenceNoteForSource(config.wind_source)}
        </p>

        <ha-selector
          .hass=${this.hass}
          .selector=${{
            select: {
              mode: 'dropdown',
              options: this._buildWindSourceOptions(),
            },
          }}
          .value=${(config.wind_source ?? DEFAULT_WIND_SOURCE) as string}
          .label=${localize('editor.wind.source_label')}
          .helper=${localize('editor.wind.source_helper')}
          .configValue=${'wind_source'}
          @value-changed=${this._handleSelectorChanged}
        ></ha-selector>

        <ha-selector
          .hass=${this.hass}
          .selector=${{
            select: {
              mode: 'dropdown',
              options: [
                { value: 'off', label: localize('editor.wind.style_off') },
                { value: 'barbs', label: localize('editor.wind.style_barbs') },
                { value: 'arrows', label: localize('editor.wind.style_arrows') },
              ],
            },
          }}
          .value=${style}
          .label=${localize('editor.wind.style_label')}
          .configValue=${'dwd_wind'}
          @value-changed=${this._handleSelectorChanged}
        ></ha-selector>

        ${style !== 'off' ? html`
          <ha-selector
            .hass=${this.hass}
            .selector=${{ number: { min: 0.25, max: 4, step: 0.25, mode: 'slider' } }}
            .value=${config.dwd_wind_density ?? 1}
            .label=${localize('editor.wind.density_label')}
            .helper=${localize('editor.wind.density_helper')}
            .configValue=${'dwd_wind_density'}
            @value-changed=${this._handleSelectorChanged}
          ></ha-selector>
          <ha-selector
            .hass=${this.hass}
            .selector=${{ number: { min: 0.5, max: 2, step: 0.25, mode: 'slider' } }}
            .value=${config.dwd_wind_size ?? 1}
            .label=${localize('editor.wind.size_label')}
            .helper=${localize('editor.wind.size_helper')}
            .configValue=${'dwd_wind_size'}
            @value-changed=${this._handleSelectorChanged}
          ></ha-selector>
        ` : ''}

        <label>
          <ha-switch
            .checked=${config.dwd_wind_flow === true}
            .configValue=${'dwd_wind_flow'}
            @change=${this._valueChangedSwitch}
          ></ha-switch>
          <span>${localize('editor.wind.flow_label')}</span>
        </label>
      </div>
    `;
  }

  private _renderOverlaysView(config: WeatherRadarCardConfig): TemplateResult {
    return html`
      <div class="values">
        <button class="subpage-back" @click=${() => this._setView('main')}>
          ‹ ${localize('editor.overlays.back')}
        </button>

        <!-- WILDFIRES -->
        <h3 class="section-header">${localize('editor.overlays.wildfires_header')}</h3>
        <p class="section-description">${localize('editor.overlays.wildfires_description')}</p>
        <label>
          <ha-switch .checked=${config.show_wildfires === true} .configValue=${'show_wildfires'} @change=${this._valueChangedSwitch}></ha-switch>
          <span>${localize('editor.display.show_wildfires')}</span>
        </label>
        ${config.show_wildfires === true ? html`
          <div class="side-by-side">
            <ha-input
              label=${localize('editor.overlays.wildfire_min_acres')}
              .value=${config.wildfire_min_acres !== undefined ? String(config.wildfire_min_acres) : ''}
              hint=${localize('editor.overlays.wildfire_min_acres_helper')}
              .configValue=${'wildfire_min_acres'}
              @input=${this._valueChangedNumber}
            ></ha-input>
            <ha-input
              label=${localize('editor.overlays.wildfire_radius_km')}
              .value=${config.wildfire_radius_km !== undefined ? String(config.wildfire_radius_km) : ''}
              hint=${localize('editor.overlays.wildfire_radius_km_helper')}
              .configValue=${'wildfire_radius_km'}
              @input=${this._valueChangedNumber}
            ></ha-input>
          </div>
        ` : ''}

        <!-- NWS ALERTS -->
        <h3 class="section-header">${localize('editor.overlays.alerts_header')}</h3>
        <p class="section-description">${localize('editor.overlays.alerts_description')}</p>
        <label>
          <ha-switch .checked=${config.show_alerts === true} .configValue=${'show_alerts'} @change=${this._valueChangedSwitch}></ha-switch>
          <span>${localize('editor.display.show_alerts')}</span>
        </label>
        ${config.show_alerts === true ? html`
          <ha-selector
            .hass=${this.hass}
            .selector=${{
              select: {
                options: [
                  { value: 'Extreme', label: localize('editor.display.alerts_severity.extreme') },
                  { value: 'Severe', label: localize('editor.display.alerts_severity.severe') },
                  { value: 'Moderate', label: localize('editor.display.alerts_severity.moderate') },
                  { value: 'Minor', label: localize('editor.display.alerts_severity.minor') },
                  { value: 'Unknown', label: localize('editor.display.alerts_severity.unknown') },
                ],
              },
            }}
            .value=${config.alerts_min_severity ?? 'Minor'}
            .label=${localize('editor.display.alerts_min_severity')}
            .helper=${localize('editor.display.alerts_min_severity_helper')}
            .configValue=${'alerts_min_severity'}
            @value-changed=${this._handleSelectorChanged}
          ></ha-selector>
          <ha-input
            label=${localize('editor.overlays.alerts_radius_km')}
            .value=${config.alerts_radius_km !== undefined ? String(config.alerts_radius_km) : ''}
            hint=${localize('editor.overlays.alerts_radius_km_helper')}
            .configValue=${'alerts_radius_km'}
            @input=${this._valueChangedNumber}
          ></ha-input>
          <p class="section-description" style="margin-top:12px">${localize('editor.overlays.alerts_categories_label')}</p>
          ${this._renderAlertCategoryToggles(config)}
        ` : ''}

        <!-- LIGHTNING -->
        ${this._renderLightningSection(config)}
      </div>
    `;
  }

  // Lightning row. Toggle is greyed out (same disabled-row pattern as
  // square_map) when the Blitzortung integration isn't loaded — the
  // overlay can't render without it. The max-age field is the
  // card-side cap, distinct from the integration's own max-age.
  private _renderLightningSection(config: WeatherRadarCardConfig): TemplateResult {
    const integrationLoaded = isBlitzortungLoaded(this.hass);
    return html`
      <h3 class="section-header">${localize('editor.overlays.lightning_header')}</h3>
      <p class="section-description">${localize('editor.overlays.lightning_description')}</p>
      <label class=${integrationLoaded ? '' : 'disabled-row'}
             title=${integrationLoaded ? '' : localize('editor.overlays.lightning_integration_required')}>
        <ha-switch
          .checked=${config.show_lightning === true}
          .disabled=${!integrationLoaded}
          .configValue=${'show_lightning'}
          @change=${this._valueChangedSwitch}
        ></ha-switch>
        <span>${localize('editor.display.show_lightning')}</span>
      </label>
      ${config.show_lightning === true && integrationLoaded ? html`
        <ha-input
          label=${localize('editor.overlays.lightning_max_age_minutes')}
          .value=${config.lightning_max_age_minutes !== undefined ? String(config.lightning_max_age_minutes) : ''}
          hint=${localize('editor.overlays.lightning_max_age_minutes_helper')}
          .configValue=${'lightning_max_age_minutes'}
          @input=${this._valueChangedNumber}
        ></ha-input>
      ` : ''}
    `;
  }

  // Render a checkbox per alert category. Reflects the active set
  // (alerts_categories config or the default if unset). Toggling rebuilds
  // the alerts_categories list and fires config-changed.
  private _renderAlertCategoryToggles(config: WeatherRadarCardConfig): TemplateResult {
    const active = getActiveAlertCategories(config.alerts_categories);
    return html`
      <div class="alert-category-grid">
        ${ALL_ALERT_CATEGORIES.map((cat) => html`
          <label class="alert-category">
            <ha-switch
              .checked=${active.has(cat)}
              .alertCategory=${cat}
              @change=${this._toggleAlertCategory}
            ></ha-switch>
            <span>${localize(`editor.overlays.alerts_category.${cat}`)}</span>
          </label>
        `)}
      </div>
    `;
  }

  private _toggleAlertCategory = (ev: Event): void => {
    if (!this._config) return;
    const target = ev.target as any;
    const cat = target.alertCategory as string;
    const isOn = !!target.checked;
    // Start from the currently-active set (defaults when unset, explicit
    // when set — including explicit empty meaning "none enabled").
    const current = getActiveAlertCategories(this._config.alerts_categories);
    if (isOn) current.add(cat as any); else current.delete(cat as any);
    // Persist the explicit set even when empty — an empty array means
    // "user opted out of every category", which the layer correctly
    // treats as "render nothing". Reverting to defaults is done by
    // removing the key from YAML, not by us.
    this._config = { ...this._config, alerts_categories: Array.from(current) };
    fireEvent(this, 'config-changed', { config: this._config });
  };

  private _renderMarkersView(config: WeatherRadarCardConfig): TemplateResult {
    const markers = config.markers ?? [];
    return html`
      <div class="values">
        <button class="subpage-back" @click=${() => this._setView('main')}>
          ‹ ${localize('editor.markers.back')}
        </button>
        <h3 class="section-header">${localize('editor.section.markers')}</h3>
        ${markers.map((m, i) => this._renderMarkerRow(m, i))}
        <ha-button class="add-marker-btn" @click=${this._addMarker}>${localize('editor.markers.add')}</ha-button>
      </div>
    `;
  }

  private _setView(view: 'main' | 'markers' | 'overlays' | 'wind'): void {
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
          <ha-button class="remove-marker-btn" @click=${() => this._removeMarker(i)}>${localize('editor.markers.remove')}</ha-button>
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
            <ha-input
              label=${localize('editor.markers.latitude')}
              .value=${m.latitude !== undefined ? String(m.latitude) : ''}
              .markerIndex=${i}
              .markerField=${'latitude'}
              @input=${this._updateMarkerFieldNumber}
            ></ha-input>
            <ha-input
              label=${localize('editor.markers.longitude')}
              .value=${m.longitude !== undefined ? String(m.longitude) : ''}
              .markerIndex=${i}
              .markerField=${'longitude'}
              @input=${this._updateMarkerFieldNumber}
            ></ha-input>
          </div>
        ` : ''}
        ${m.entity && m.entity.startsWith('person.') ? html`
          <label class="marker-mobile-only">
            <ha-switch
              .checked=${m.icon === 'entity_picture'}
              .markerIndex=${i}
              @change=${this._toggleEntityPicture}
            ></ha-switch>
            <span>${localize('editor.markers.use_entity_picture')}</span>
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
          <ha-input
            label=${localize('editor.markers.icon_entity')}
            .value=${m.icon_entity || ''}
            .markerIndex=${i}
            .markerField=${'icon_entity'}
            @input=${this._updateMarkerField}
          ></ha-input>
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
              <ha-button class="clear-color-btn" @click=${() => this._clearMarkerColor(i)}>${localize('editor.markers.reset')}</ha-button>
            ` : ''}
          </div>
        ` : ''}
        <label class="marker-mobile-only">
          <ha-switch
            .checked=${m.mobile_only === true}
            .markerIndex=${i}
            .markerField=${'mobile_only'}
            @change=${this._updateMarkerSwitch}
          ></ha-switch>
          <span>${localize('editor.markers.mobile_only')}</span>
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

  // Render the past + (optional) forecast time-range dropdowns plus a
  // helper line showing derived frame count. Only the past row is
  // unconditional; the forecast row is omitted entirely (not greyed)
  // for sources where maxForecastMin === 0, so RainViewer / NOAA users
  // never see a row that doesn't apply.
  private _renderTimeRangeFields(config: WeatherRadarCardConfig): TemplateResult {
    const caps = getSourceCaps(config.data_source);
    const range = getEffectiveTimeRange(config);

    const pastOptions = this._buildPastOptions(config.past_minutes, caps.editorMaxPastMin);
    const pastValue = String(config.past_minutes ?? caps.defaultPastMin);

    const forecastOptions = caps.maxForecastMin > 0
      ? this._buildForecastOptions(config.forecast_minutes, caps.maxForecastMin)
      : null;
    const forecastValue = caps.maxForecastMin > 0
      ? String(config.forecast_minutes ?? caps.defaultForecastMin)
      : '';

    // Frame-interval dropdown for frame-listing sources (NOAA): the
    // stride is a first-class editor knob there, not a YAML-only
    // override — the server lists real scan times and the card snaps
    // an ideal grid of this spacing onto them.
    const strideOptions = caps.strideChoices
      ? caps.strideChoices.map((v) => ({
          value: String(v),
          label: localize('editor.time_range.stride_option').replace('{n}', String(v)),
        }))
      : null;

    // Helper text: "≈ N frames at X-min intervals", flagged when a
    // YAML-only stride override is in effect so the user knows the
    // editor isn't the source of truth for that knob. Sources with a
    // stride dropdown never flag — the dropdown IS the source of
    // truth. Single-frame case (past_minutes=0 + no forecast) gets a
    // distinct line — the generic helper would read "≈ 1 frames at
    // 5-min intervals" which is both grammatically wrong and
    // misleading.
    const isStrideOverride = !caps.strideChoices && range.strideMin !== caps.intervalMin;
    const helper = range.frameCount === 1
      ? localize('editor.time_range.helper_static')
      : isStrideOverride
        ? localize('editor.time_range.helper_stride')
          .replace('{n}', String(range.frameCount))
          .replace('{stride}', String(range.strideMin))
        : localize('editor.time_range.helper')
          .replace('{n}', String(range.frameCount))
          .replace('{interval}', String(range.strideMin));

    return html`
      <div class="side-by-side">
        <ha-selector
          .hass=${this.hass}
          .selector=${{ select: { options: pastOptions } }}
          .value=${pastValue}
          .label=${localize('editor.time_range.past')}
          .configValue=${'past_minutes'}
          @value-changed=${this._handleSelectorNumberChanged}
        ></ha-selector>
        ${strideOptions ? html`
          <ha-selector
            .hass=${this.hass}
            .selector=${{ select: { options: strideOptions } }}
            .value=${String(range.strideMin)}
            .label=${localize('editor.time_range.stride')}
            .configValue=${'frame_stride_minutes'}
            @value-changed=${this._handleSelectorNumberChanged}
          ></ha-selector>
        ` : ''}
        ${forecastOptions ? html`
          <ha-selector
            .hass=${this.hass}
            .selector=${{ select: { options: forecastOptions } }}
            .value=${forecastValue}
            .label=${localize('editor.time_range.forecast')}
            .configValue=${'forecast_minutes'}
            @value-changed=${this._handleSelectorNumberChanged}
          ></ha-selector>
        ` : ''}
      </div>
      <div class="time-range-helper">${helper}</div>
    `;
  }

  // Builds the past-time dropdown options from PAST_PRESETS_MIN,
  // filtered to ≤ editor cap. Prepends a 0 / Off entry for users who
  // want a static current frame with no animation loop. If the
  // configured raw value isn't in the preset list (either > cap or
  // just an off-grid YAML value), appends it as a "(YAML)" entry at
  // the bottom so the user sees their actual current value rather
  // than a wrong display.
  // Wind-source dropdown options. Order is stable across the list so the
  // user's pick lands on the same row each time. Labels come from the
  // i18n table when present, with the registry's English label as fallback.
  private _buildWindSourceOptions(): { value: string; label: string }[] {
    return (Object.values(WIND_SOURCE_CAPS) as { id: WindSource; label: string }[])
      .map(c => ({
        value: c.id,
        label: localize(`editor.wind.source_${c.id}`) || c.label,
      }));
  }

  // Per-source cadence note shown under the source dropdown. Tries the
  // i18n key first (`editor.wind.cadence_<id>`), falls back to the
  // registry's English cadenceNote so a missing translation never blanks
  // the UI. The legacy `editor.wind.cadence_note` (DWD-only wording) is
  // intentionally not consulted — keeping that line in the locale files
  // avoids breakage but it's superseded by the per-source line.
  private _cadenceNoteForSource(source: WindSource | undefined): string {
    const caps = getWindSourceCaps(source);
    return localize(`editor.wind.cadence_${caps.id}`) || caps.cadenceNote;
  }

  private _buildPastOptions(rawValue: number | undefined, editorCap: number): { value: string; label: string }[] {
    const opts: { value: string; label: string }[] = [
      { value: '0', label: localize('editor.time_range.past_off') },
    ];
    opts.push(...PAST_PRESETS_MIN
      .filter(m => m <= editorCap)
      .map(m => ({ value: String(m), label: formatDuration(m) })));
    if (rawValue !== undefined && rawValue !== 0 && !PAST_PRESETS_MIN.includes(rawValue)) {
      opts.push({
        value: String(rawValue),
        label: `${formatDuration(rawValue)} ${localize('editor.time_range.yaml_suffix')}`,
      });
    }
    return opts;
  }

  // Forecast presets: Off + each whole hour up to the source's max.
  // (Currently only DWD: 0 / 60 / 120.)
  private _buildForecastOptions(rawValue: number | undefined, maxMin: number): { value: string; label: string }[] {
    const opts: { value: string; label: string }[] = [
      { value: '0', label: localize('editor.time_range.forecast_off') },
    ];
    for (let m = 60; m <= maxMin; m += 60) opts.push({ value: String(m), label: formatDuration(m) });
    if (rawValue !== undefined && rawValue !== 0 && !opts.some(o => Number(o.value) === rawValue)) {
      opts.push({
        value: String(rawValue),
        label: `${formatDuration(rawValue)} ${localize('editor.time_range.yaml_suffix')}`,
      });
    }
    return opts;
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
    ha-input {
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
    .time-range-helper {
      font-size: 0.8em;
      color: var(--secondary-text-color);
      margin: -8px 0 16px 0;
    }
    .subsection {
      margin-left: 16px;
      padding-left: 8px;
      border-left: 2px solid var(--divider-color);
      margin-bottom: 8px;
    }
    /* Every toggle renders as [switch] [label-text], left-aligned with a
       gap. DOM order is the same: <ha-switch> first, then a <span> with
       the label text. Standard checkbox UX. */
    label {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 0;
      font-size: 0.95em;
    }
    /* Greyed-out look for switches whose effect is overridden by another
       config field (e.g. square_map when height is pinned by the user
       or by a sections-grid cell). The switch itself is .disabled via
       the property; this just dims the label text alongside it. */
    label.disabled-row {
      opacity: 0.55;
      cursor: not-allowed;
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
    /* Two-column grid for the alert-category checkboxes — keeps the list
       compact instead of stacking 10 full-width rows. */
    .alert-category-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0 12px;
      margin-bottom: 8px;
    }
    .alert-category {
      padding: 4px 0;
      font-size: 0.9em;
    }
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
