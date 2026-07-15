// Per-data-source capability table. Drives the time-range model so the
// editor and the radar player can both ask "what's the native frame
// interval for this source?", "how far back / forward does the API
// support?", and "what should the dropdown defaults be?".
//
// Replacing the old frame_count config: users now think in time
// (past_minutes / forecast_minutes); the player derives frame_count
// from (past + forecast) / interval, optionally with a stride override.
//
// To add a new source: add a row here, wire the player's _fetchPaths
// to handle it, and the editor automatically picks up the right
// presets / forecast row visibility.

import { WeatherRadarCardConfig } from './types';

export interface SourceCaps {
  /** Native frame spacing in minutes (server's natural cadence). */
  intervalMin: number;
  /** Hard upper limit on past_minutes that the API can serve. */
  maxPastMin: number;
  /**
   * UX-only cap for the editor's preset dropdown — typically lower
   * than maxPastMin to avoid the perf cost of huge ranges (DWD's
   * 84h × 12 frames/h is the canonical example). YAML configs can
   * still reach maxPastMin; the editor surfaces those as a
   * "(YAML)" entry at the bottom of the dropdown.
   */
  editorMaxPastMin: number;
  /** Hard upper limit on forecast_minutes (0 = source has no forecast). */
  maxForecastMin: number;
  /** Default past_minutes when nothing is configured. */
  defaultPastMin: number;
  /** Default forecast_minutes when nothing is configured. */
  defaultForecastMin: number;
  /**
   * Frame-listing sources (currently NOAA/opengeo): the server
   * publishes its actual frame timestamps, frames are picked by
   * snapping an ideal grid to the listing, and the stride is a free
   * choice rather than a multiple of intervalMin. When set:
   *  - strideChoices are the editor-offered strides (minutes);
   *    a YAML frame_stride_minutes snaps to the nearest choice.
   *  - defaultStrideMin is the stride when none is configured, and
   *    the basis for the legacy frame_count migration (so a 3.6-era
   *    `frame_count: 12` still maps to the time span the user saw).
   */
  strideChoices?: number[];
  defaultStrideMin?: number;
}

export const SOURCE_CAPS: Record<string, SourceCaps> = {
  RainViewer: {
    intervalMin: 10,
    maxPastMin: 120,        // RainViewer free tier returns at most 13 frames × 10 min
    editorMaxPastMin: 120,  // = API max (no perf concern at 13 frames)
    maxForecastMin: 0,
    defaultPastMin: 60,
    defaultForecastMin: 0,
  },
  NOAA: {
    // NOAA serves from NCEP's opengeo GeoServer (the radar.weather.gov
    // backend) as of 3.7: its per-layer GetCapabilities lists the
    // layer's ACTUAL frame timestamps (~2-min scan cadence, newest
    // ~2 min behind wall clock) and is CORS-open to browsers — see
    // src/noaa-frame-list.ts and `.dev/opengeo-noaa-research.md`.
    // This replaced the eventdriven ImageServer flow whose metadata
    // refused browsers and forced blind 10-min quantisation plus a
    // 15-min lag constant (3.7.0-alpha2's "math isn't mathing" era).
    //
    // intervalMin reflects the native scan cadence; the user-facing
    // stride is a free pick from strideChoices because frame times
    // come from the listing, not from a computed grid. Default 5 min
    // restores the 3.6-era loop density (12-13 frames/h) — with
    // genuinely unique frames this time.
    intervalMin: 2,
    // The opengeo listing holds ~60 frames ≈ 2 h of history.
    maxPastMin: 120,
    editorMaxPastMin: 120,
    maxForecastMin: 0,
    defaultPastMin: 60,
    defaultForecastMin: 0,
    strideChoices: [2, 5, 10],
    defaultStrideMin: 5,
  },
  DWD: {
    intervalMin: 5,
    maxPastMin: 5040,       // GetCapabilities advertises ~84h of history
    editorMaxPastMin: 720,  // 12h — beyond this, frame counts hurt; YAML escape hatch
    maxForecastMin: 120,    // Radar_wn-product_*_ger carries +2h nowcast
    defaultPastMin: 120,    // matches the DWD WarnWetter app
    defaultForecastMin: 120,
  },
};

export const DEFAULT_SOURCE = 'RainViewer';

export function getSourceCaps(source: string | undefined): SourceCaps {
  return SOURCE_CAPS[source ?? DEFAULT_SOURCE] ?? SOURCE_CAPS[DEFAULT_SOURCE];
}

export interface EffectiveTimeRange {
  /** Resolved past_minutes after defaults + clamping. */
  pastMin: number;
  /** Resolved forecast_minutes after defaults + clamping. */
  forecastMin: number;
  /** Effective frame interval in minutes — stride override or source native. */
  strideMin: number;
  /** Number of frames to load: floor((past + forecast) / stride) + 1, min 1. */
  frameCount: number;
}

/**
 * Resolve the effective time range for the configured source, applying:
 *   - source-specific defaults when fields are absent
 *   - hard caps from SOURCE_CAPS (silent — the editor is responsible
 *     for surfacing user-visible warnings; player just behaves)
 *   - stride override (frame_stride_minutes) snapped to a multiple of
 *     the native interval, falling back to native if invalid
 *
 * Single source of truth used by both the editor (preset filtering,
 * helper text) and the radar player (frame count + spacing).
 */
export function getEffectiveTimeRange(cfg: WeatherRadarCardConfig): EffectiveTimeRange {
  const caps = getSourceCaps(cfg.data_source);

  const rawPast = cfg.past_minutes ?? caps.defaultPastMin;
  const rawForecast = cfg.forecast_minutes ?? caps.defaultForecastMin;
  const pastMin = Math.max(0, Math.min(caps.maxPastMin, rawPast));
  const forecastMin = Math.max(0, Math.min(caps.maxForecastMin, rawForecast));

  // Stride resolution differs by source kind:
  //  - Frame-listing sources (strideChoices set): stride is a free
  //    pick — frame times snap to the server's listing afterwards, so
  //    grid alignment is irrelevant. A YAML value snaps to the nearest
  //    offered choice; absent → defaultStrideMin.
  //  - Grid sources: stride must be a positive multiple of the native
  //    interval; anything else falls back to native. Snapping to a
  //    multiple keeps frame timestamps aligned to the API's served
  //    times.
  let strideMin: number;
  const rawStride = cfg.frame_stride_minutes;
  if (caps.strideChoices && caps.strideChoices.length > 0) {
    strideMin = caps.defaultStrideMin ?? caps.strideChoices[0];
    if (typeof rawStride === 'number' && rawStride > 0) {
      strideMin = caps.strideChoices.reduce((best, c) =>
        Math.abs(c - rawStride) < Math.abs(best - rawStride) ? c : best);
    }
  } else {
    strideMin = caps.intervalMin;
    if (typeof rawStride === 'number' && rawStride >= caps.intervalMin) {
      const k = Math.round(rawStride / caps.intervalMin);
      strideMin = Math.max(1, k) * caps.intervalMin;
    }
  }

  // frameCount = (history span / stride) + 1, floored at 1 — past_minutes=0
  // (and forecast_minutes=0) gives a single static frame, which the player
  // shows without ever entering the animation loop (_scheduleNext returns
  // early when loaded slots < 2). The periodic 5-min refresh still updates
  // the single frame so it doesn't go stale. Pre-3.6.0 the floor was 2,
  // which silently turned a "no animation" config into a 2-frame loop.
  const totalMin = pastMin + forecastMin;
  const frameCount = Math.max(1, Math.floor(totalMin / strideMin) + 1);

  return { pastMin, forecastMin, strideMin, frameCount };
}

/**
 * True when the playback toolbar (play/pause/skip) would have anything to
 * control. A single static frame (frameCount === 1) never starts the
 * animation loop, so the buttons would be dead controls — shared by the
 * editor (hides the show_playback toggle) and the card (suppresses the
 * toolbar group even for hand-written YAML the editor gate doesn't reach).
 */
export function shouldShowPlayback(cfg: WeatherRadarCardConfig): boolean {
  return cfg.show_playback === true && getEffectiveTimeRange(cfg).frameCount > 1;
}
