import { LovelaceCardConfig } from 'custom-card-helpers';

export interface Marker {
  entity?: string;
  latitude?: number;
  longitude?: number;
  icon?: string;       // "default" | "entity_picture" | "mdi:icon-name"
  icon_entity?: string;
  color?: string;      // CSS colour for default/MDI icons; ignored for entity_picture
  track?: 'entity' | true;
  mobile_only?: boolean;
}

// Entity coordinate configuration for dynamic location from entity attributes
export interface EntityCoordinate {
  entity: string;
  latitude_attribute?: string; // Default: 'latitude'
  longitude_attribute?: string; // Default: 'longitude'
}

// Coordinate can be a number, entity ID string, or entity config object
export type CoordinateConfig = number | string | EntityCoordinate;

export interface WeatherRadarCardConfig extends LovelaceCardConfig {
  show_range: boolean;
  show_scale: boolean;
  show_playback: boolean;
  show_recenter: boolean;
  static_map: boolean;
  show_zoom: boolean;
  square_map: boolean;
  height?: string;
  width?: string;
  extra_labels?: boolean;
  /** @deprecated since 3.5: use past_minutes (and forecast_minutes for sources that support it). Auto-migrated by migrateConfig. */
  frame_count?: number;
  /**
   * How many minutes of history to load. Source-specific defaults apply
   * when unset. The editor offers presets up to the source's maximum;
   * YAML can exceed the editor cap (clamped to the source's API limit).
   */
  past_minutes?: number;
  /**
   * How many minutes of forecast to include in the playback. Only
   * applies to sources that have a forecast (currently DWD).
   * Source-specific defaults apply when unset.
   */
  forecast_minutes?: number;
  /**
   * YAML-only escape hatch for the perf cost of large past_minutes
   * ranges: forces a custom frame interval (snapped to a multiple of
   * the source's native interval). Defaults to the native interval.
   */
  frame_stride_minutes?: number;
  frame_delay?: number;
  animated_transitions?: boolean;
  transition_time?: number;
  radar_opacity?: number;
  smooth_animation?: boolean;
  /**
   * Smooth-mode crossfade overlap fraction. 0 = sequential (cushion
   * fade-out starts when fade-in ends, no dip but cushion is held).
   * 1 = simultaneous (both fade through the entire frame_delay window
   * at the same time, brief alpha dip mid-transition). Default 1.
   * Only takes effect when `smooth_animation: true`. YAML-only; for
   * tuning the look of the crossfade.
   */
  smooth_overlap?: number;
  center_longitude?: CoordinateConfig;
  center_latitude?: CoordinateConfig;
  zoom_level?: number;
  markers?: Marker[];
  cluster_markers?: boolean;
  // Legacy single-marker fields — read-only; used only by _migrateConfig()
  /** @deprecated use markers[] */  show_marker?: boolean;
  /** @deprecated use markers[] */  marker_latitude?: CoordinateConfig;
  /** @deprecated use markers[] */  marker_longitude?: CoordinateConfig;
  /** @deprecated use markers[] */  mobile_marker_latitude?: CoordinateConfig;
  /** @deprecated use markers[] */  mobile_marker_longitude?: CoordinateConfig;
  /** @deprecated use markers[] */  marker_icon?: string;
  /** @deprecated use markers[] */  marker_icon_entity?: string;
  /** @deprecated use markers[] */  mobile_marker_icon?: string;
  /** @deprecated use markers[] */  mobile_marker_icon_entity?: string;
  type: string;
  name?: string;
  map_style?: string;
  data_source?: string;
  /** DWD-only: ISO timestamp to anchor frames at instead of "now" — for testing with historical rain. */
  dwd_time_override?: string;
  /** DWD-only: WMS layer name override. Default Niederschlagsradar (past-only); auto-switches to Radar_wn-product_1x1km_ger when forecast_minutes > 0 since that one carries the +2h nowcast. */
  dwd_layer?: string;
  /** @deprecated since 3.5: use forecast_minutes (source-agnostic). Auto-migrated by migrateConfig. */
  dwd_forecast_hours?: number;
  show_snow?: boolean;
  show_progress_bar?: boolean;
  show_color_bar?: boolean;
  show_loading_spinner?: boolean;
  // Wildfire overlay (US-only — see docs/wildfire-feature-design.md)
  show_wildfires?: boolean;
  wildfire_min_acres?: number;
  wildfire_radius_km?: number;
  wildfire_color?: string;
  wildfire_contained_color?: string;
  wildfire_fill_opacity?: number;
  wildfire_refresh_minutes?: number;
  // Lightning overlay (Blitzortung integration — see docs/lightning-feature-design.md)
  show_lightning?: boolean;
  /** One-shot brightness flash on new-strike appearance. Disabled when the user prefers reduced motion. */
  lightning_pulse?: boolean;
  /** YAML-only escape hatch for the inline-SVG icon dimension. Default 14 px reads on a busy storm without cluttering. */
  lightning_icon_size?: number;
  // NWS watches & warnings overlay (US-only — see docs/nws-alerts-feature-design.md)
  show_alerts?: boolean;
  alerts_categories?: string[];        // category keys; default: all except 'marine'
  alerts_types?: string[];             // explicit event-string allowlist; overrides alerts_categories when set
  alerts_radius_km?: number;
  alerts_min_severity?: 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
  alerts_fill_opacity?: number;
  alerts_refresh_seconds?: number;
  // Simple shortcut string OR a standard HA action object e.g. {action: navigate, navigation_path: /lovelace/1}
  double_tap_action?: string | { action: string; [key: string]: unknown };
  disable_scroll?: boolean;
  show_warning?: boolean;
  show_error?: boolean;
  test_gui?: boolean;
  show_header_toggle?: boolean;
  /**
   * HA's sections-view grid passes grid_options on the card config to
   * record the user's resize-handle position. We don't write it; we
   * read it (along with `height`) to know when the card's vertical
   * extent is being externally constrained — the editor uses that to
   * grey out controls (like square_map) that have no effect under that
   * constraint. `rows: 'auto'` means HA lets the card pick its height,
   * which is back to the unconstrained case.
   */
  grid_options?: {
    rows?: number | 'auto';
    columns?: number | 'full';
  };
}
