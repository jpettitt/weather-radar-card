import { describe, it, expect } from 'vitest';
import { HomeAssistant } from 'custom-card-helpers';
import { getRegionWarnings } from '../src/region-warning';
import { WeatherRadarCardConfig } from '../src/types';

// Lightweight hass-with-country mock — the real mockHass helper doesn't
// include `country`, which is what the region-warning logic keys off.
function hassFor(country: string | undefined): HomeAssistant | undefined {
  if (country === undefined) {
    // Simulate the case where hass.config.country isn't populated yet —
    // we should silently skip the warning rather than firing false
    // positives. (See the "unknown — assume the user knows what they're
    // doing" branch in region-warning.ts.)
    return { config: {} } as unknown as HomeAssistant;
  }
  return { config: { country } } as unknown as HomeAssistant;
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
