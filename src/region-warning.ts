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

// Map-centre coverage bboxes. Used to suppress the radar-source warnings
// when the user has explicitly centred the map on real coverage area
// regardless of their HA-configured country. Symmetric to the country
// allowlist above — country is a coarse proxy, centre coordinates are the
// precise check. Bounds are generous (include some ocean / border regions)
// because a missed suppression is worse than an over-eager one: the false
// positive in this direction is a too-cautious banner that the user can
// dismiss, while a false negative would be a misleading "this won't work
// for you" warning over a map that's working fine.
//
// DWD bbox: Germany + immediate radar overlap into neighbours.
const DWD_COVERAGE_BBOX = { minLat: 44.0, maxLat: 56.5, minLon: 1.0, maxLon: 18.0 };
// NOAA NEXRAD bbox: CONUS + AK + HI + PR/USVI. Wide because Hawaii is
// low-latitude and Alaska extends across the dateline; intentional that
// it sweeps in some ocean and the western Caribbean.
const US_COVERAGE_BBOX = { minLat: 15.0, maxLat: 72.0, minLon: -180.0, maxLon: -64.0 };

function inBbox(
  lat: unknown,
  lon: unknown,
  b: { minLat: number; maxLat: number; minLon: number; maxLon: number },
): boolean {
  return typeof lat === 'number' && typeof lon === 'number'
    && lat >= b.minLat && lat <= b.maxLat
    && lon >= b.minLon && lon <= b.maxLon;
}

export function getRegionWarnings(
  hass: HomeAssistant | undefined,
  cfg: WeatherRadarCardConfig,
): string[] {
  // custom-card-helpers' HassConfig type omits `country` even though HA
  // populates it at runtime — cast to any to read it without typings churn.
  const country = (hass?.config as any)?.country as string | undefined;
  if (!country) return [];   // unknown — assume the user knows what they're doing

  const messages: string[] = [];

  // Effective map centre: config literal wins, fall back to HA's home
  // location. Entity-tracked coordinates (CoordinateConfig as a string or
  // EntityCoordinate object) aren't resolved here — they'd require hass
  // state lookup at banner-render time. Conservative fallback: when the
  // centre can't be resolved as a literal number, coverage check returns
  // false and the warning fires as it did before this change.
  const centreLat = typeof cfg.center_latitude === 'number'
    ? cfg.center_latitude
    : (hass?.config as any)?.latitude;
  const centreLon = typeof cfg.center_longitude === 'number'
    ? cfg.center_longitude
    : (hass?.config as any)?.longitude;
  const showingUs = inBbox(centreLat, centreLon, US_COVERAGE_BBOX);
  const showingDwd = inBbox(centreLat, centreLon, DWD_COVERAGE_BBOX);

  // Catalogue of features that only have US data coverage. Each entry's
  // `key` is the localize suffix used for its individual banner; when more
  // than one is enabled at once we collapse to a single combined banner
  // instead of stacking near-identical messages.
  //
  // NOAA's `enabled` ANDs in the coverage check: a user with NOAA selected
  // whose map is centred on the US is successfully viewing NOAA data
  // regardless of where they live, so the warning is misleading and we
  // suppress it. Wildfires / alerts don't get the same treatment — their
  // overlays only ever have US data, so the warning informs the user the
  // feature will be empty for them. Map centre doesn't change that.
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
      enabled: (cfg.data_source ?? '').toUpperCase() === 'NOAA' && !showingUs,
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
  // are US-only", which is wrong. Fires when DWD is selected AND the user's
  // country is outside DWD_COVERAGE_COUNTRIES AND the map centre is outside
  // the DWD coverage bbox — i.e. when the user neither lives in DWD coverage
  // nor is explicitly viewing it.
  if ((cfg.data_source ?? '').toUpperCase() === 'DWD'
      && !DWD_COVERAGE_COUNTRIES.has(country)
      && !showingDwd) {
    messages.push(localize('ui.region_warning.dwd_de_only'));
  }

  return messages;
}
