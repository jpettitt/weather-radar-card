import { HomeAssistant } from 'custom-card-helpers';
import { Marker, WeatherRadarCardConfig } from './types';
import { getSourceCaps } from './source-caps';

/**
 * Convert legacy time-related fields to the source-agnostic
 * past_minutes / forecast_minutes model introduced in 3.5.
 *
 *   - frame_count → past_minutes = (frame_count - 1) × intervalMin,
 *     using the configured source's native interval. Existing configs
 *     get a time-range that closely matches what their frame_count
 *     was producing on the prior version.
 *   - dwd_forecast_hours → forecast_minutes = hours × 60.
 *
 * Only fills missing fields; user-set past_minutes / forecast_minutes
 * always win. Returns the same object reference when no migration is
 * needed (so callers can detect a no-op).
 */
function migrateTimeRange(config: WeatherRadarCardConfig): WeatherRadarCardConfig {
  const needsPast = config.past_minutes === undefined && config.frame_count !== undefined;
  const needsForecast = config.forecast_minutes === undefined && config.dwd_forecast_hours !== undefined;
  if (!needsPast && !needsForecast) return config;

  const next = { ...config };
  if (needsPast) {
    const caps = getSourceCaps(config.data_source);
    // Frame-listing sources migrate on the DEFAULT STRIDE, not the
    // native interval: a 3.6-era NOAA `frame_count: 12` ran at the old
    // 5-min stride and covered ~55 min — defaultStrideMin (5) keeps
    // that span. Using intervalMin (the 2-min native scan cadence)
    // would silently shrink the loop to ~22 min.
    const stride = caps.defaultStrideMin ?? caps.intervalMin;
    next.past_minutes = Math.max(0, (config.frame_count! - 1) * stride);
  }
  if (needsForecast) {
    next.forecast_minutes = Math.max(0, config.dwd_forecast_hours! * 60);
  }
  return next;
}

/**
 * True when `frame_count` is present but doing nothing because a time-based
 * field (`past_minutes` / `frame_stride_minutes`) is also set. `frame_count`
 * has been deprecated since 3.5 and only feeds migration when it stands
 * alone (see `migrateTimeRange`); combined with the time fields it is a
 * silent no-op that reads as a self-contradictory config to the user
 * (issue #191). Pure predicate so the card can warn without duplicating
 * the precedence rule; the warning itself lives in the card's runtime
 * `_migrateConfig` wrapper so it fires on load, not per editor keystroke.
 */
export function frameCountIsOverridden(config: WeatherRadarCardConfig): boolean {
  return config.frame_count !== undefined
    && (config.past_minutes !== undefined || config.frame_stride_minutes !== undefined);
}

export function migrateConfig(config: WeatherRadarCardConfig): WeatherRadarCardConfig {
  config = migrateTimeRange(config);

  // markers explicitly set (including empty array) — respect the user's choice
  if (config.markers !== undefined) return config;

  // Explicit show_marker:false — user wants no marker
  if (config.show_marker === false) return { ...config, markers: [] };

  // No legacy fields and no markers — default to a home zone marker
  if (config.show_marker !== true && config.marker_latitude === undefined && config.mobile_marker_latitude === undefined) {
    return { ...config, markers: [{ entity: 'zone.home' }] };
  }

  const markers: Marker[] = [];
  const latCfg = config.marker_latitude;
  const lonCfg = config.marker_longitude;
  const m: Marker = {};

  if (latCfg === undefined && lonCfg === undefined) {
    // No position given — default to the home zone so the marker is always visible.
    m.entity = 'zone.home';
  } else if (typeof latCfg === 'string' && latCfg === lonCfg) {
    m.entity = latCfg;
  } else {
    if (typeof latCfg === 'number') m.latitude = latCfg;
    if (typeof lonCfg === 'number') m.longitude = lonCfg;
    if (typeof latCfg === 'string') m.entity = latCfg;
  }
  if (config.marker_icon) m.icon = config.marker_icon;
  if (config.marker_icon_entity) m.icon_entity = config.marker_icon_entity;
  markers.push(m);

  const mLat = config.mobile_marker_latitude;
  const mLon = config.mobile_marker_longitude;
  if ((mLat !== undefined || mLon !== undefined) && (mLat !== latCfg || mLon !== lonCfg)) {
    const mm: Marker = { mobile_only: true };
    if (typeof mLat === 'string' && mLat === mLon) {
      mm.entity = mLat;
    } else {
      if (typeof mLat === 'number') mm.latitude = mLat;
      if (typeof mLon === 'number') mm.longitude = mLon;
      if (typeof mLat === 'string') mm.entity = mLat;
    }
    if (config.mobile_marker_icon) mm.icon = config.mobile_marker_icon;
    if (config.mobile_marker_icon_entity) mm.icon_entity = config.mobile_marker_icon_entity;
    markers.push(mm);
  }

  return { ...config, markers };
}

export function resolveMarkerPosition(
  markerCfg: Marker,
  hass: HomeAssistant | undefined,
  fallbackLat: number,
  fallbackLon: number,
): { lat: number; lon: number } {
  if (markerCfg.entity) {
    const state = hass?.states[markerCfg.entity];
    const lat = parseFloat(state?.attributes?.latitude as string);
    const lon = parseFloat(state?.attributes?.longitude as string);
    if (!isNaN(lat) && !isNaN(lon)) return { lat, lon };
  }
  return {
    lat: markerCfg.latitude ?? fallbackLat,
    lon: markerCfg.longitude ?? fallbackLon,
  };
}

export function resolveTracking(
  markers: Marker[],
  hass: HomeAssistant | undefined,
  fallbackLat: number,
  fallbackLon: number,
): { lat: number; lon: number; markerIndex: number } | null {
  const userId = hass?.user?.id;
  let winnerIdx = -1;
  let winnerPriority = 0;

  for (let i = 0; i < markers.length; i++) {
    const m = markers[i];
    if (!m.track) continue;

    let p = 0;
    if (m.track === 'entity' && m.entity) {
      const state = hass?.states[m.entity];
      if (m.entity.startsWith('person.') && state?.attributes?.user_id === userId) {
        p = 3;
      } else {
        p = 2;
      }
    } else if (m.track === true) {
      p = 1;
    }
    if (p === 0) continue;

    if (p > winnerPriority) {
      winnerIdx = i;
      winnerPriority = p;
    } else if (p === winnerPriority) {
      console.warn('Weather Radar Card: multiple markers at the same track priority — using first');
    }
  }

  if (winnerIdx < 0) return null;
  const pos = resolveMarkerPosition(markers[winnerIdx], hass, fallbackLat, fallbackLon);
  return { ...pos, markerIndex: winnerIdx };
}
