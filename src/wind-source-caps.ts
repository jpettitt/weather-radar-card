// Wind data source registry. Each source supplies U/V (or convertible-to-
// U/V) on a regular grid via WCS GetCoverage with text/plain output, so
// the existing wind-grid-fetcher pipeline can consume any of them after
// per-source URL/CRS/band-mapping handling. Adding a new source is
// largely a new entry in WIND_SOURCE_CAPS plus any URL/CRS quirks.
//
// 'dwd_aicon': DWD's AI-augmented variant of ICON-D2. Default for
//   non-US users — globally populated, visibly better short-range
//   accuracy than the raw numerical model. Same 0.25° global lat/lon
//   grid, same U/V components, same hourly cadence as ICON-D2, served
//   from the same WCS endpoint. DescribeCoverage confirms identical
//   CRS, axes, bands, and format support to ICON-D2.
//
// 'dwd_icon': Raw DWD ICON-D2 numerical model — same shape as AICON
//   but without the AI post-processing layer. Kept as an opt-in for
//   users who prefer the unadjusted model output.
//
// 'ndfd_wind': NWS GeoServer hosts the National Digital Forecast
//   Database wind forecast (NDFD = forecaster blend of HRRR, RAP, NAM,
//   GFS) on a Web Mercator (EPSG:3857) grid, ~2.5 km native over CONUS,
//   wind_speed / wind_direction bands, 3-hourly out to 7+ days.
//   Default for fresh installs whose HA location is in NWS coverage.
//   Outside CONUS / AK / HI / PR cells return fill values.

export type WindSource = 'dwd_icon' | 'dwd_aicon' | 'ndfd_wind';

// Global default for non-US locations, and the silent fallback when a
// config has no explicit `wind_source`. AICON is preferred over plain
// ICON-D2 because it ships AI-augmented post-processing on the same
// 0.25° global grid (same WCS endpoint, same hourly cadence) — visibly
// better short-range accuracy at zero behaviour cost. Existing configs
// without `wind_source` set silently upgrade to AICON on next reload;
// users who explicitly want the raw numerical model can still set
// `wind_source: 'dwd_icon'` in YAML or via the editor dropdown.
export const DEFAULT_WIND_SOURCE: WindSource = 'dwd_aicon';

export interface WindSourceCaps {
  /** Stable WindSource id. Persisted in user configs and used for cache keys. */
  id: WindSource;
  /** Human-readable label shown in the editor (English; localised separately). */
  label: string;
  /** WCS endpoint base URL. Combined with '?service=WCS&...' query params. */
  wcsUrl: string;
  /** WCS coverage identifier passed as `coverageId=`. */
  coverageId: string;
  /** Source CRS for subset axes. 'EPSG:4326' uses Lat/Long degree axes;
   * 'EPSG:3857' uses X/Y metres, with lat/lon → Mercator conversion done
   * client-side before the request and Mercator → lat/lon done after. */
  crs: 'EPSG:4326' | 'EPSG:3857';
  /** Native cell step. Units match `crs`: degrees for EPSG:4326, metres
   * for EPSG:3857. Used by adaptive WCS Scaling to estimate native cell
   * count for a bbox so huge viewports get downsampled server-side. */
  nativeStep: number;
  /** Band 0/1 semantics. 'uv' means band 0 = U, band 1 = V (eastward,
   * northward m/s). 'speed_dir' means band 0 = speed (m/s), band 1 =
   * direction (degrees, meteorological "from"); the fetcher converts to
   * U/V before storing in the WindGrid. */
  bands: 'uv' | 'speed_dir';
  /** Short cadence note for the editor's helper line. English; the i18n
   * key 'editor.wind.cadence_<id>' wins when present. */
  cadenceNote: string;
  /** Per-source streamline-trail length multiplier. 1.0 = render the
   * full TRAIL_LENGTH-segment ring buffer. Sources with a finer native
   * grid (e.g. NDFD at 2.5 km vs ICON-D2 at ~28 km) produce smoother,
   * more coherent particle paths that visually read as longer ribbons
   * even at the same per-frame pixel velocity — values < 1 trim the
   * rendered trail to compensate. */
  streakLengthMultiplier?: number;
}

export const WIND_SOURCE_CAPS: Record<WindSource, WindSourceCaps> = {
  dwd_icon: {
    id: 'dwd_icon',
    label: 'DWD ICON-D2 (global, ~28 km)',
    wcsUrl: 'https://maps.dwd.de/geoserver/dwd/wcs',
    coverageId: 'dwd__Icon_reg025_fd_sl_UV10M',
    crs: 'EPSG:4326',
    nativeStep: 0.25,
    bands: 'uv',
    cadenceNote: 'DWD ICON-D2 numerical model. 0.25° global grid (~28 km). Hourly anchor, +48 h forecast, new model run every 3 h.',
  },
  dwd_aicon: {
    id: 'dwd_aicon',
    label: 'DWD AICON (AI-augmented, global, ~28 km)',
    wcsUrl: 'https://maps.dwd.de/geoserver/dwd/wcs',
    coverageId: 'dwd__Aicon_reg025_fd_sl_UV10M',
    crs: 'EPSG:4326',
    nativeStep: 0.25,
    bands: 'uv',
    cadenceNote: 'DWD AICON — ICON-D2 with AI-augmented post-processing. Same 0.25° global grid (~28 km) and hourly cadence as ICON-D2; reportedly improves short-range accuracy.',
  },
  ndfd_wind: {
    id: 'ndfd_wind',
    label: 'NWS NDFD (US, 2.5 km)',
    wcsUrl: 'https://mapservices.weather.noaa.gov/geoserver/ndfd/wind/wcs',
    coverageId: 'ndfd__wind',
    crs: 'EPSG:3857',
    // Native grid steps to ~1428 m at the equator in EPSG:3857; on the
    // ground at CONUS latitudes that's ~1100 m, blending NDFD's 2.5 km
    // forecaster output. Mercator stretch is acceptable for the
    // smooth-visualization use case.
    nativeStep: 1428.5714285714,
    bands: 'speed_dir',
    cadenceNote: 'NWS NDFD forecaster blend (HRRR + RAP + NAM + GFS). 2.5 km CONUS / AK / HI / PR. Hourly updates, 3-hourly forecast steps out to 7+ days. Outside US coverage the card auto-switches to AICON so you still see global wind.',
    // NDFD's 2.5 km grid (~10× finer than ICON-D2) produces smoother
    // particle paths that read as visibly longer ribbons; trim the
    // rendered trail to keep visual streak length comparable to ICON.
    streakLengthMultiplier: 0.33,
  },
};

export function getWindSourceCaps(source: WindSource | undefined): WindSourceCaps {
  return WIND_SOURCE_CAPS[source ?? DEFAULT_WIND_SOURCE];
}

// ── US location detection ─────────────────────────────────────────────────
//
// Two-stage check: (1) HA's hass.config.country if set to 'US', (2) bbox
// fallback covering the populated NDFD regions. Used only at fresh-install
// time (getStubConfig) to pick a default wind_source. Existing configs
// without an explicit wind_source field continue to default at runtime to
// DEFAULT_WIND_SOURCE (currently 'dwd_aicon').
//
// Bboxes are intentionally generous: a user on the AK / HI / PR coast
// shouldn't slip into the global ICON default just because their lat/lon
// brushes the bbox edge. The cost of a false-positive (a Canadian who
// gets NDFD by accident) is just fill values outside coverage — they can
// switch back via the editor's wind_source dropdown.

interface UsRegionBbox {
  name: string;
  south: number;
  west: number;
  north: number;
  east: number;
}

const US_REGION_BBOXES: readonly UsRegionBbox[] = [
  { name: 'CONUS',       south: 24,  west: -125,  north: 50,  east: -66 },
  { name: 'Alaska',      south: 51,  west: -180,  north: 72,  east: -130 },
  { name: 'Hawaii',      south: 18,  west: -161,  north: 23,  east: -154 },
  { name: 'Puerto Rico', south: 17,  west: -67.5, north: 18.6, east: -65.2 },
];

function inUsBbox(lat: number, lon: number): boolean {
  // Leaflet supplies unwrapped longitudes after world-wrap panning
  // (|lon| can exceed 180), and a viewport straddling the antimeridian
  // averages to a centre well outside [-180, 180]. Normalise before
  // testing so the NDFD auto-fallback doesn't misfire near the
  // dateline (e.g. centre lon 187 is really -173 — Alaska).
  const wrapped = ((lon + 540) % 360) - 180;
  for (const r of US_REGION_BBOXES) {
    if (lat >= r.south && lat <= r.north && wrapped >= r.west && wrapped <= r.east) return true;
  }
  return false;
}

/** True when the centre of the given lat/lon bbox falls inside any NDFD
 * coverage region (CONUS / AK / HI / PR). Used at fetch time to decide
 * whether an NDFD-configured overlay should auto-fall-back to the global
 * default source for the current viewport.
 *
 * Centre-based (vs. "any overlap" or "≥X% overlap") because it's cheap,
 * deterministic, and matches user mental model — pan map east until the
 * cursor leaves the US, source flips. The flip happens at refetch time
 * (moveend), not per particle frame, so the transient mid-pan moment
 * doesn't matter. A 1° guard band on the bbox edges would smooth the
 * boundary but adds complexity for a barely-visible win. */
export function bboxInUsCoverage(south: number, west: number, north: number, east: number): boolean {
  const centreLat = (south + north) / 2;
  const centreLon = (west + east) / 2;
  return inUsBbox(centreLat, centreLon);
}

/** Pick the wind source that best matches HA's location. Used by
 * getStubConfig when the user adds a fresh card to a dashboard.
 * Returns 'ndfd_wind' for US locations (NWS coverage), else
 * DEFAULT_WIND_SOURCE.
 *
 * Country code (HA's `hass.config.country`, ISO 3166-1 alpha-2) wins
 * outright when present — a HA install with country='CA' gets the
 * default global source even if the lat/lon brushes the CONUS bbox
 * (Canadian border cities). The bbox fallback only runs when country
 * is missing entirely. */
export function defaultWindSourceForLocation(
  lat: number | undefined | null,
  lon: number | undefined | null,
  country?: string | null,
): WindSource {
  if (country) {
    return country.toUpperCase() === 'US' ? 'ndfd_wind' : DEFAULT_WIND_SOURCE;
  }
  if (typeof lat === 'number' && typeof lon === 'number'
    && Number.isFinite(lat) && Number.isFinite(lon)
    && inUsBbox(lat, lon)) {
    return 'ndfd_wind';
  }
  return DEFAULT_WIND_SOURCE;
}
