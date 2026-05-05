/* eslint-disable @typescript-eslint/no-explicit-any */
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { localize } from './localize/localize';

// Returns banner messages for any enabled overlay/data-source whose coverage
// region doesn't include the user's HA-configured country. Empty array means
// no warnings to display. Caller renders the messages in the status-banner
// stack above the map.
//
// Detection is intentionally coarse — we trust hass.config.country (an ISO
// 3166-1 alpha-2 code) and don't try to handle territories or coastal/marine
// edge cases. False positives (e.g. a user in PR seeing the US-only message)
// are preferable to false negatives that would silently fail to load data.

// DWD's radar network covers Germany plus a buffer that overlaps immediate
// neighbours. Treat any of these as "in coverage" so users in border regions
// who legitimately see DWD data don't get a noisy banner.
const DWD_COVERAGE_COUNTRIES = new Set([
  'DE', 'NL', 'BE', 'LU', 'FR', 'CH', 'AT', 'CZ', 'PL', 'DK',
]);

export function getRegionWarnings(
  hass: HomeAssistant | undefined,
  cfg: WeatherRadarCardConfig,
): string[] {
  // custom-card-helpers' HassConfig type omits `country` even though HA
  // populates it at runtime — cast to any to read it without typings churn.
  const country = (hass?.config as any)?.country as string | undefined;
  if (!country) return [];   // unknown — assume the user knows what they're doing

  const messages: string[] = [];

  // Catalogue of features that only have US data coverage. Each entry's
  // `key` is the localize suffix used for its individual banner; when more
  // than one is enabled at once we collapse to a single combined banner
  // instead of stacking near-identical messages.
  const usOnly: Array<{ enabled: boolean; key: string; label: string }> = [
    {
      enabled: cfg.show_wildfires === true,
      key: 'wildfires_us_only',
      label: localize('ui.region_warning.label.wildfires'),
    },
    {
      enabled: cfg.show_alerts === true,
      key: 'alerts_us_only',
      label: localize('ui.region_warning.label.alerts'),
    },
    {
      enabled: (cfg.data_source ?? '').toUpperCase() === 'NOAA',
      key: 'noaa_us_only',
      label: localize('ui.region_warning.label.noaa'),
    },
  ];

  if (country !== 'US') {
    const enabled = usOnly.filter((e) => e.enabled);
    if (enabled.length === 1) {
      messages.push(localize(`ui.region_warning.${enabled[0].key}`));
    } else if (enabled.length > 1) {
      // Combined: "Wildfires, NWS alerts and NOAA radar are US-only..."
      const labels = enabled.map((e) => e.label);
      const joined = labels.length === 2
        ? `${labels[0]} ${localize('ui.region_warning.and')} ${labels[1]}`
        : `${labels.slice(0, -1).join(', ')} ${localize('ui.region_warning.and')} ${labels[labels.length - 1]}`;
      const template = localize('ui.region_warning.combined');
      messages.push(template.replace('{features}', joined));
    }
  }

  // DWD is a separate region (Germany + immediate neighbours). Stand-alone
  // banner — collapsing it into the US block would read as "X and DWD radar
  // are US-only", which is wrong. The warning fires for any country outside
  // DWD_COVERAGE_COUNTRIES so users in e.g. ES or GB selecting DWD see a
  // visible explanation rather than a silently grey map.
  if ((cfg.data_source ?? '').toUpperCase() === 'DWD'
      && !DWD_COVERAGE_COUNTRIES.has(country)) {
    messages.push(localize('ui.region_warning.dwd_de_only'));
  }

  return messages;
}
