import { describe, it, expect } from 'vitest';
import { HomeAssistant } from 'custom-card-helpers';
import { getRegionWarnings } from '../src/region-warning';
import { WeatherRadarCardConfig } from '../src/types';

// Lightweight hass-with-country mock — the real mockHass helper doesn't
// include `country`, which is what the region-warning logic keys off.
// Optional `home` overrides HA's configured latitude/longitude (the
// fallback for the coverage-bbox check when cfg has no centre literal).
function hassFor(
  country: string | undefined,
  home?: { latitude: number; longitude: number },
): HomeAssistant | undefined {
  if (country === undefined) {
    // Simulate the case where hass.config.country isn't populated yet —
    // we should silently skip the warning rather than firing false
    // positives. (See the "unknown — assume the user knows what they're
    // doing" branch in region-warning.ts.)
    return { config: {} } as unknown as HomeAssistant;
  }
  return { config: { country, ...(home ?? {}) } } as unknown as HomeAssistant;
}

function cfg(overrides: Partial<WeatherRadarCardConfig> = {}): WeatherRadarCardConfig {
  return { type: 'custom:weather-radar-card', ...overrides } as WeatherRadarCardConfig;
}

describe('getRegionWarnings — empty cases', () => {
  it('returns no banner when country is unknown', () => {
    expect(getRegionWarnings(hassFor(undefined), cfg({ show_wildfires: true })))
      .toEqual([]);
  });

  it('returns no banner when hass itself is undefined', () => {
    expect(getRegionWarnings(undefined, cfg({ show_wildfires: true })))
      .toEqual([]);
  });

  it('returns no banner when country is US even with all features enabled', () => {
    const result = getRegionWarnings(
      hassFor('US'),
      cfg({ show_wildfires: true, show_alerts: true, data_source: 'NOAA' }),
    );
    expect(result).toEqual([]);
  });

  it('returns no banner when no US-only feature is enabled, even outside US', () => {
    expect(getRegionWarnings(hassFor('GB'), cfg())).toEqual([]);
  });
});

describe('getRegionWarnings — single feature', () => {
  it('shows the wildfire-specific banner when only wildfires is enabled', () => {
    const [msg, ...rest] = getRegionWarnings(hassFor('GB'), cfg({ show_wildfires: true }));
    expect(rest).toEqual([]);
    expect(msg).toMatch(/[Ww]ildfire/);
  });

  it('shows the alerts-specific banner when only NWS alerts is enabled', () => {
    const [msg, ...rest] = getRegionWarnings(hassFor('GB'), cfg({ show_alerts: true }));
    expect(rest).toEqual([]);
    expect(msg).toMatch(/NWS/);
  });

  it('shows the NOAA-specific banner when only NOAA data source is selected', () => {
    const [msg, ...rest] = getRegionWarnings(hassFor('GB'), cfg({ data_source: 'NOAA' }));
    expect(rest).toEqual([]);
    expect(msg).toMatch(/NOAA/);
  });

  it('NOAA selection is case-insensitive', () => {
    expect(getRegionWarnings(hassFor('GB'), cfg({ data_source: 'noaa' }))).toHaveLength(1);
    expect(getRegionWarnings(hassFor('GB'), cfg({ data_source: 'NoAa' }))).toHaveLength(1);
  });
});

describe('getRegionWarnings — combined banner', () => {
  it('uses a single combined banner for two enabled features (not stacked)', () => {
    const result = getRegionWarnings(
      hassFor('GB'),
      cfg({ show_wildfires: true, show_alerts: true }),
    );
    expect(result).toHaveLength(1);
    // Should mention both feature labels in one message.
    expect(result[0]).toMatch(/Wildfires/);
    expect(result[0]).toMatch(/NWS/);
  });

  it('uses a single combined banner for all three enabled features', () => {
    const result = getRegionWarnings(
      hassFor('GB'),
      cfg({ show_wildfires: true, show_alerts: true, data_source: 'NOAA' }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/Wildfires/);
    expect(result[0]).toMatch(/NWS/);
    expect(result[0]).toMatch(/NOAA/);
  });

  it('uses an Oxford-style join with "and" before the last item', () => {
    const result = getRegionWarnings(
      hassFor('GB'),
      cfg({ show_wildfires: true, show_alerts: true, data_source: 'NOAA' }),
    );
    expect(result[0]).toMatch(/and/);
  });
});

describe('getRegionWarnings — country variants', () => {
  it.each(['CA', 'GB', 'DE', 'AU', 'JP', ''])(
    'shows a banner for non-US country %s',
    (country) => {
      const result = getRegionWarnings(hassFor(country), cfg({ show_wildfires: true }));
      // Empty string is treated as "no country known" → no banner (line 26 in
      // region-warning.ts: `if (!country) return []`). Match that behaviour.
      if (country === '') expect(result).toEqual([]);
      else expect(result).toHaveLength(1);
    },
  );
});

describe('getRegionWarnings — DWD coverage', () => {
  it.each(['DE', 'NL', 'BE', 'LU', 'FR', 'CH', 'AT', 'CZ', 'PL', 'DK'])(
    'shows no DWD banner inside coverage country %s',
    (country) => {
      expect(getRegionWarnings(hassFor(country), cfg({ data_source: 'DWD' })))
        .toEqual([]);
    },
  );

  it.each(['US', 'GB', 'ES', 'IT', 'AU', 'JP'])(
    'shows the DWD banner outside coverage country %s',
    (country) => {
      const [msg, ...rest] = getRegionWarnings(hassFor(country), cfg({ data_source: 'DWD' }));
      expect(rest).toEqual([]);
      expect(msg).toMatch(/DWD/);
    },
  );

  it('DWD selection is case-insensitive', () => {
    expect(getRegionWarnings(hassFor('GB'), cfg({ data_source: 'dwd' }))).toHaveLength(1);
    expect(getRegionWarnings(hassFor('GB'), cfg({ data_source: 'DwD' }))).toHaveLength(1);
  });

  it('US-only banner and DWD banner stack independently when both apply', () => {
    // Hypothetical: alerts on (US-only) + DWD selected, country GB. Both
    // are enabled so both banners surface — they describe different
    // regions and shouldn't be combined into one sentence.
    const result = getRegionWarnings(
      hassFor('GB'),
      cfg({ show_alerts: true, data_source: 'DWD' }),
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatch(/NWS/);
    expect(result[1]).toMatch(/DWD/);
  });
});

// Centre-aware suppression: even when the country check would fire,
// suppress the warning if the map is explicitly centred on real coverage.
// The user has gone out of their way to view that region — assume they
// know what they're doing.
describe('getRegionWarnings — coverage-bbox suppression', () => {
  // Reference points used across tests.
  const BERLIN  = { latitude: 52.52, longitude: 13.40 };  // inside DWD bbox
  const NYC     = { latitude: 40.71, longitude: -74.01 }; // inside US bbox
  const HONOLULU = { latitude: 21.31, longitude: -157.86 }; // US bbox (HI corner)
  const LONDON  = { latitude: 51.51, longitude: -0.13 };  // outside both

  it('suppresses the DWD warning when map centre is in DWD coverage (US user, Berlin centre)', () => {
    const result = getRegionWarnings(
      hassFor('US'),
      cfg({ data_source: 'DWD', center_latitude: BERLIN.latitude, center_longitude: BERLIN.longitude }),
    );
    expect(result).toEqual([]);
  });

  it('fires the DWD warning when map centre is OUTSIDE DWD coverage (US user, NYC centre)', () => {
    const [msg, ...rest] = getRegionWarnings(
      hassFor('US'),
      cfg({ data_source: 'DWD', center_latitude: NYC.latitude, center_longitude: NYC.longitude }),
    );
    expect(rest).toEqual([]);
    expect(msg).toMatch(/DWD/);
  });

  it('suppresses the NOAA warning when map centre is in US coverage (DE user, NYC centre)', () => {
    const result = getRegionWarnings(
      hassFor('DE'),
      cfg({ data_source: 'NOAA', center_latitude: NYC.latitude, center_longitude: NYC.longitude }),
    );
    expect(result).toEqual([]);
  });

  it('suppresses the NOAA warning for the Hawaii corner of the bbox', () => {
    const result = getRegionWarnings(
      hassFor('DE'),
      cfg({ data_source: 'NOAA', center_latitude: HONOLULU.latitude, center_longitude: HONOLULU.longitude }),
    );
    expect(result).toEqual([]);
  });

  it('fires the NOAA warning when map centre is OUTSIDE US coverage (DE user, Berlin centre)', () => {
    const [msg, ...rest] = getRegionWarnings(
      hassFor('DE'),
      cfg({ data_source: 'NOAA', center_latitude: BERLIN.latitude, center_longitude: BERLIN.longitude }),
    );
    expect(rest).toEqual([]);
    expect(msg).toMatch(/NOAA/);
  });

  it('falls back to HA home location when cfg centre is unset (US user with German home → no DWD warning)', () => {
    // Pathological setup but real: HA reports country=US but the location coords
    // are in Berlin. Without an explicit cfg centre, fallback uses hass home,
    // which is in DWD coverage → warning suppressed.
    const result = getRegionWarnings(
      hassFor('US', BERLIN),
      cfg({ data_source: 'DWD' }),
    );
    expect(result).toEqual([]);
  });

  it('wildfires + alerts warnings are NOT coverage-suppressed (semantic is different)', () => {
    // Wildfires and alerts only have US data. A non-US user who centres on the
    // US still sees the overlays empty unless THEIR map has US overlay data —
    // the warning is about the overlay never having content outside the US, not
    // about radar tile coverage. Suppression by map centre would be misleading.
    const result = getRegionWarnings(
      hassFor('DE'),
      cfg({ show_wildfires: true, center_latitude: NYC.latitude, center_longitude: NYC.longitude }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/wildfire/i);
  });

  it('NOAA suppression interacts cleanly with combined message: NOAA suppressed → wildfires-only fires alone', () => {
    // DE user, NOAA + wildfires both enabled, map on NYC. NOAA gets suppressed
    // (showingUs=true); wildfires stays enabled. Result is just the wildfires
    // message, not the combined "wildfires and NOAA radar" template.
    const result = getRegionWarnings(
      hassFor('DE'),
      cfg({
        data_source: 'NOAA',
        show_wildfires: true,
        center_latitude: NYC.latitude,
        center_longitude: NYC.longitude,
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/wildfire/i);
    expect(result[0]).not.toMatch(/NOAA/);
  });

  it('entity-coord centre falls back to no-suppression (warning still fires)', () => {
    // CoordinateConfig as a string entity reference means the literal coords
    // aren't in cfg. Without HA home coords either, the bbox check can't
    // succeed → warning fires as it did before this change. Conservative.
    const result = getRegionWarnings(
      hassFor('US'),  // no home coords
      cfg({
        data_source: 'DWD',
        center_latitude: 'sensor.berlin_lat' as unknown as number,
        center_longitude: 'sensor.berlin_lon' as unknown as number,
      }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatch(/DWD/);
  });
});
