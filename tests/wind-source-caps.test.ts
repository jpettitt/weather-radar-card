import { describe, it, expect } from 'vitest';
import {
  bboxInUsCoverage,
  defaultWindSourceForLocation,
  getWindSourceCaps,
  WIND_SOURCE_CAPS,
  DEFAULT_WIND_SOURCE,
} from '../src/wind-source-caps';

describe('defaultWindSourceForLocation', () => {
  // Country code is the cleanest signal. Used by hass.config.country.
  it('returns ndfd_wind when country is "US"', () => {
    expect(defaultWindSourceForLocation(40, -100, 'US')).toBe('ndfd_wind');
  });

  it('case-insensitive on country code', () => {
    expect(defaultWindSourceForLocation(40, -100, 'us')).toBe('ndfd_wind');
  });

  it('returns the global default for non-US country, even if lat/lon happens to be US-ish', () => {
    // Country wins over bbox — guards against geocoding weirdness.
    expect(defaultWindSourceForLocation(40, -100, 'CA')).toBe(DEFAULT_WIND_SOURCE);
  });

  // Bbox fallback for when HA hasn't set country (older installs / minimal configs).
  it('returns ndfd_wind for CONUS bbox without country', () => {
    expect(defaultWindSourceForLocation(40, -100)).toBe('ndfd_wind');     // Kansas
    expect(defaultWindSourceForLocation(34, -118)).toBe('ndfd_wind');     // Los Angeles
    expect(defaultWindSourceForLocation(40.7, -74)).toBe('ndfd_wind');    // New York
  });

  it('returns ndfd_wind for Alaska bbox', () => {
    expect(defaultWindSourceForLocation(61.2, -149.9)).toBe('ndfd_wind'); // Anchorage
    expect(defaultWindSourceForLocation(64.8, -147.7)).toBe('ndfd_wind'); // Fairbanks
  });

  it('returns ndfd_wind for Hawaii bbox', () => {
    expect(defaultWindSourceForLocation(21.3, -157.9)).toBe('ndfd_wind'); // Honolulu
  });

  it('returns ndfd_wind for Puerto Rico bbox', () => {
    expect(defaultWindSourceForLocation(18.4, -66.1)).toBe('ndfd_wind'); // San Juan
  });

  it('returns the global default outside NDFD coverage', () => {
    // Compared against DEFAULT_WIND_SOURCE rather than a string literal
    // so flipping the default in one place doesn't require touching the
    // tests. Today DEFAULT_WIND_SOURCE = 'dwd_aicon'.
    expect(defaultWindSourceForLocation(52, 13)).toBe(DEFAULT_WIND_SOURCE);       // Berlin
    expect(defaultWindSourceForLocation(-33.9, 151.2)).toBe(DEFAULT_WIND_SOURCE); // Sydney
    expect(defaultWindSourceForLocation(35.7, 139.7)).toBe(DEFAULT_WIND_SOURCE);  // Tokyo
  });

  it('honours non-US country code even when lat/lon brushes the US bbox', () => {
    // Ottawa (45.4°N, -75.7°W) is inside the CONUS bbox but country=CA
    // should win — Canadian users get the global-default DWD source
    // (currently AICON), not NDFD.
    expect(defaultWindSourceForLocation(45.4, -75.7, 'CA')).toBe(DEFAULT_WIND_SOURCE);
    // Tijuana (32.5°N, -117°W) is inside CONUS bbox but in Mexico.
    expect(defaultWindSourceForLocation(32.5, -117, 'MX')).toBe(DEFAULT_WIND_SOURCE);
  });

  it('returns the global default for missing / non-finite coords with no country', () => {
    expect(defaultWindSourceForLocation(undefined, undefined)).toBe(DEFAULT_WIND_SOURCE);
    expect(defaultWindSourceForLocation(null, null)).toBe(DEFAULT_WIND_SOURCE);
    expect(defaultWindSourceForLocation(NaN, NaN)).toBe(DEFAULT_WIND_SOURCE);
    expect(defaultWindSourceForLocation(Infinity, 0)).toBe(DEFAULT_WIND_SOURCE);
  });

  it('DEFAULT_WIND_SOURCE is dwd_aicon (AI-augmented ICON-D2)', () => {
    // Locked in 3.7: AICON wins by default for non-US users because it
    // visibly improves short-range accuracy at zero behaviour cost
    // vs. raw ICON-D2 (same endpoint, same grid, same cadence).
    expect(DEFAULT_WIND_SOURCE).toBe('dwd_aicon');
  });
});

describe('getWindSourceCaps', () => {
  it('returns the default-source caps when source is undefined', () => {
    expect(getWindSourceCaps(undefined).id).toBe(DEFAULT_WIND_SOURCE);
  });

  it('returns dwd_icon caps with EPSG:4326 axes and U/V bands', () => {
    const caps = getWindSourceCaps('dwd_icon');
    expect(caps.crs).toBe('EPSG:4326');
    expect(caps.bands).toBe('uv');
    expect(caps.coverageId).toBe('dwd__Icon_reg025_fd_sl_UV10M');
    expect(caps.wcsUrl).toContain('maps.dwd.de');
  });

  it('returns ndfd_wind caps with EPSG:3857 axes and speed/dir bands', () => {
    const caps = getWindSourceCaps('ndfd_wind');
    expect(caps.crs).toBe('EPSG:3857');
    expect(caps.bands).toBe('speed_dir');
    expect(caps.coverageId).toBe('ndfd__wind');
    expect(caps.wcsUrl).toContain('mapservices.weather.noaa.gov');
  });

  it('AICON is plug-compatible with ICON-D2 (same WCS endpoint, CRS, step, bands)', () => {
    // DescribeCoverage on dwd__Aicon_reg025_fd_sl_UV10M confirms it
    // serves the same global EPSG:4326 0.25° grid with U/V bands as
    // ICON-D2. Pin that here so a future caps-table edit doesn't
    // accidentally diverge them.
    const icon = getWindSourceCaps('dwd_icon');
    const aicon = getWindSourceCaps('dwd_aicon');
    expect(aicon.wcsUrl).toBe(icon.wcsUrl);
    expect(aicon.crs).toBe(icon.crs);
    expect(aicon.bands).toBe(icon.bands);
    expect(aicon.nativeStep).toBe(icon.nativeStep);
    // Different coverage id (the only thing that should differ).
    expect(aicon.coverageId).not.toBe(icon.coverageId);
    expect(aicon.coverageId).toContain('Aicon');
  });

  it('every registry entry has a non-empty label and cadenceNote', () => {
    for (const caps of Object.values(WIND_SOURCE_CAPS)) {
      expect(caps.label.length).toBeGreaterThan(0);
      expect(caps.cadenceNote.length).toBeGreaterThan(0);
    }
  });
});

// ── Antimeridian normalisation (2026-06 review backlog) ──────────────────

describe('bboxInUsCoverage — unwrapped longitudes', () => {
  it('handles a viewport whose centre exceeds 180 after world-wrap panning', () => {
    // Leaflet supplies continuous longitudes; a viewport over western
    // Alaska reached by panning east can centre at e.g. lon 200
    // (= -160). The NDFD auto-fallback used to misfire there.
    expect(bboxInUsCoverage(58, 190, 65, 210)).toBe(true);   // centre lon 200 → -160 (Alaska)
  });

  it('still rejects genuinely non-US centres in wrapped space', () => {
    expect(bboxInUsCoverage(50, 130, 60, 150)).toBe(false);  // Siberia
  });
});
