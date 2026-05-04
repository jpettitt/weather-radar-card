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
  frame_count?: number;
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
  /** DWD-only: WMS layer name override. Default Niederschlagsradar (past-only); auto-switches to Radar_wn-product_1x1km_ger when dwd_forecast_hours > 0 since that one carries the +2h nowcast. */
  dwd_layer?: string;
  /** DWD-only: include this many hours of nowcast forecast in the playback range. Default 0. */
  dwd_forecast_hours?: number;
  show_snow?: boolean;
  show_progress_bar?: boolean;
  show_color_bar?: boolean;
  // Simple shortcut string OR a standard HA action object e.g. {action: navigate, navigation_path: /lovelace/1}
  double_tap_action?: string | { action: string; [key: string]: unknown };
  disable_scroll?: boolean;
  show_warning?: boolean;
  show_error?: boolean;
  test_gui?: boolean;
  show_header_toggle?: boolean;
}
