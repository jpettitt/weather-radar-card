import { LovelaceCardConfig } from 'custom-card-helpers';
import type { WindSource } from './wind-source-caps';

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
   * Custom frame interval (minutes). For NOAA this is surfaced in the
   * editor as the "Frame interval" dropdown (2/5/10) and snaps to the
   * nearest offered step. For the grid sources (RainViewer/DWD) it's a
   * YAML-only escape hatch for the perf cost of large past_minutes
   * ranges, snapped to a multiple of the source's native interval.
   * Defaults to the source's default interval.
   */
  frame_stride_minutes?: number;
  frame_delay?: number;
  /** Extra milliseconds to hold the last frame before the loop wraps back
   * to the first. Previously only present via LovelaceCardConfig's index
   * signature even though the editor exposes it and the player consumes
   * it (default 1000). */
  restart_delay?: number;
  animated_transitions?: boolean;
  transition_time?: number;
  radar_opacity?: number;
  smooth_animation?: boolean;
  /**
   * Smooth-mode crossfade overlap fraction. 0 = sequential (cushion
   * fade-out starts when fade-in ends, no dip but cushion is held).
   * 1 = simultaneous (both fade through the entire frame_delay window
   * at the same time, brief alpha dip mid-transition). Default 1.
   * Only takes effect when `smooth_animation: true`. Exposed as a
   * slider in the editor's Animation section; for tuning the look of
   * the crossfade.
   */
  smooth_overlap?: number;
  /**
   * Default playback-speed multiplier applied to frame_delay. The toolbar
   * exposes a button that cycles through ¼×, ½×, 1×, 2×, 4×; this config
   * value is the YAML default that applies until a user overrides it.
   * When `viewer_layer_control` is on, the override is persisted per
   * user via ViewerState (HA frontend storage) so each viewer's choice
   * follows them across browsers and devices. When `viewer_layer_control`
   * is off, the button still works for the current session but the
   * choice is not saved.
   */
  playback_speed?: number;
  /**
   * Slide each radar layer in the estimated direction of rain motion
   * during the crossfade transition, so the rain appears to drift
   * smoothly between frames instead of appearing in its new position
   * while the old position fades out underneath.
   *
   * The motion vector is recovered by running pyramidal Lucas-Kanade
   * optical flow on consecutive frame snapshots — no external wind
   * data, no source dependency. Works for all three radar sources
   * (DWD, RainViewer, NOAA). Runs in a Web Worker when available so
   * slow devices don't see UI jank; falls back to synchronous main-
   * thread execution if Worker construction fails (e.g. corporate CSP).
   *
   * Pairs naturally with `smooth_overlap: 0` (sequential timing) so
   * the composite stays at full opacity through the slide — overlap > 0
   * still works but lets the alpha dip be slightly visible mid-slide.
   *
   * Default off. Frames without enough texture (light rain, clear sky)
   * fall back to the static crossfade automatically.
   */
  motion_compensation?: boolean;
  center_longitude?: CoordinateConfig;
  center_latitude?: CoordinateConfig;
  zoom_level?: number;
  /** Pan the map horizontally (pixels) after initialization. Positive = right, negative = left. */
  pan_offset_x?: number;
  /** Pan the map vertically (pixels) after initialization. Positive = down, negative = up. */
  pan_offset_y?: number;
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
  /** Wind data source for the overlay grid. Defaults to 'dwd_aicon'
   * (DWD's AI-augmented variant of ICON-D2 — same 0.25° global grid,
   * same hourly cadence, AI post-processing improves short-range
   * accuracy). Set to 'dwd_icon' for the raw ICON-D2 numerical model
   * or 'ndfd_wind' for NWS NDFD (2.5 km, US regions only). Fresh
   * installs in US locations get 'ndfd_wind' auto-set by getStubConfig;
   * configs without this field resolve at runtime to DEFAULT_WIND_SOURCE
   * ('dwd_aicon') — see src/wind-source-caps.ts. */
  wind_source?: WindSource;
  /** 10m wind overlay (barbs / arrows). The "dwd_" name predates the
   * generalised wind source system in 3.7 — kept for config compatibility.
   * Both styles are client-rendered from the WindSource U/V grid. */
  dwd_wind?: 'off' | 'barbs' | 'arrows';
  /** Grid-density multiplier for the wind overlay (0.25–4). 1 = default. Higher = more arrows on screen. Applies to every wind source — the "dwd_" prefix is legacy naming (see dwd_wind). */
  dwd_wind_density?: number;
  /** Icon-size multiplier for the wind overlay (0.5–2). 1 = default 22px. Applies to every wind source. */
  dwd_wind_size?: number;
  /** Animated wind streamline overlay (à la DWD WarnWetter app). Stacks with dwd_wind. Applies to every wind source. */
  dwd_wind_flow?: boolean;
  /** YAML-only: stroke colour for streamline particles on light basemaps (osm / light / auto-light).
   * Any CSS colour string. Default `rgba(25,30,45,1)`. Editor doesn't expose this. */
  dwd_wind_flow_color_light?: string;
  /** YAML-only: stroke colour for streamline particles on dark basemaps (dark / auto-dark).
   * Any CSS colour string. Default `rgba(220,225,235,1)`. Editor doesn't expose this. */
  dwd_wind_flow_color_dark?: string;
  /** YAML-only: stroke colour for streamline particles on satellite basemaps. Defaults to bright
   * near-white because satellite imagery has more varied terrain (forests, snow, water) than the
   * dark Carto basemap and needs more contrast. Any CSS colour string. Default `rgba(255,255,255,1)`. */
  dwd_wind_flow_color_sat?: string;
  show_snow?: boolean;
  show_progress_bar?: boolean;
  /** YAML-only: height in pixels of the tappable/draggable progress region. The visible track remains 8px. Default 8px. */
  progress_bar_touch_height?: number;
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
  /**
   * Hide strikes older than this many minutes. Card-side cap only — does
   * NOT change the Blitzortung integration's own max-age setting (the
   * integration may still track older strikes; we just don't render them).
   * Effective cap is min(this, integration's max-age). Default 30 min.
   */
  lightning_max_age_minutes?: number;
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

  // ── Per-user viewer state (3.7+) ─────────────────────────────────────────
  // See docs/viewer-state-api.md. Dormant by default — no behaviour change
  // unless a feature consumer opts the card in via `viewer_layer_control`.

  /**
   * Admin opt-in for per-user, per-card state (overlay visibility, playback
   * preferences, etc.) persisted via HA's frontend storage WebSocket API.
   * When false / unset, no identity is minted and no WS calls fire.
   * When true, the card auto-mints `_layer_state_id` on the next setConfig.
   */
  viewer_layer_control?: boolean;

  /**
   * Auto-managed by the card. Stable identity used as the per-card storage
   * key for viewer state. Minted automatically when `viewer_layer_control`
   * is on; re-minted on dashboard-path mismatch or within-dashboard
   * copy-paste collision. **Users should not edit this by hand.**
   */
  _layer_state_id?: {
    dash: string;
    nonce: string;
  };
}
