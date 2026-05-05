// Maps NWS event strings to category keys. Categories are the user-visible
// grouping in the editor and the (Phase 2) layer-toggle menu — exposing
// ~90 raw event strings to the YAML/UI is unworkable, so we cluster them.
//
// Each event string in NWS_ALERT_COLORS should appear here too; events
// missing from this map land in 'other'.

export type AlertCategory =
  | 'tornado'
  | 'thunderstorm'
  | 'flood'
  | 'winter'
  | 'tropical'
  | 'fire_weather'
  | 'heat'
  | 'wind'
  | 'marine'
  | 'other';

export const ALL_ALERT_CATEGORIES: AlertCategory[] = [
  'tornado', 'thunderstorm', 'flood', 'winter', 'tropical',
  'fire_weather', 'heat', 'wind', 'marine', 'other',
];

// Default category set for new users — every category EXCEPT marine.
// Most users are inland; coastal/offshore alerts generate noise that's
// irrelevant to them. Coastal users opt back in via config or the layer
// menu (Phase 2). See "Lessons from the wildfire build" in the design doc.
export const DEFAULT_ALERT_CATEGORIES: AlertCategory[] = [
  'tornado', 'thunderstorm', 'flood', 'winter', 'tropical',
  'fire_weather', 'heat', 'wind', 'other',
];

const EVENT_TO_CATEGORY: Record<string, AlertCategory> = {
  // tornado
  'Tornado Warning': 'tornado',
  'Tornado Watch': 'tornado',

  // thunderstorm (severe convective, plus the catch-all SPS / SVR statement)
  'Severe Thunderstorm Warning': 'thunderstorm',
  'Severe Thunderstorm Watch': 'thunderstorm',
  'Severe Weather Statement': 'thunderstorm',
  'Special Weather Statement': 'thunderstorm',
  'Extreme Wind Warning': 'thunderstorm',

  // flood
  'Flash Flood Warning': 'flood',
  'Flash Flood Watch': 'flood',
  'Flash Flood Statement': 'flood',
  'Flood Warning': 'flood',
  'Flood Watch': 'flood',
  'Flood Statement': 'flood',
  'Flood Advisory': 'flood',
  'Coastal Flood Warning': 'flood',
  'Coastal Flood Watch': 'flood',
  'Coastal Flood Statement': 'flood',
  'Coastal Flood Advisory': 'flood',
  'Lakeshore Flood Warning': 'flood',
  'Lakeshore Flood Watch': 'flood',
  'Lakeshore Flood Advisory': 'flood',
  'Hydrologic Outlook': 'flood',

  // winter
  'Winter Storm Warning': 'winter',
  'Winter Storm Watch': 'winter',
  'Winter Weather Advisory': 'winter',
  'Blizzard Warning': 'winter',
  'Ice Storm Warning': 'winter',
  'Snow Squall Warning': 'winter',
  'Lake Effect Snow Warning': 'winter',
  'Lake Effect Snow Advisory': 'winter',
  'Freezing Rain Advisory': 'winter',
  'Freezing Fog Advisory': 'winter',
  'Frost Advisory': 'winter',
  'Freeze Warning': 'winter',
  'Freeze Watch': 'winter',
  'Hard Freeze Warning': 'winter',
  'Hard Freeze Watch': 'winter',

  // tropical
  'Hurricane Warning': 'tropical',
  'Hurricane Watch': 'tropical',
  'Tropical Storm Warning': 'tropical',
  'Tropical Storm Watch': 'tropical',
  'Tropical Depression Warning': 'tropical',
  'Storm Surge Warning': 'tropical',
  'Storm Surge Watch': 'tropical',
  'Hurricane Force Wind Warning': 'tropical',
  'Hurricane Force Wind Watch': 'tropical',
  'Typhoon Warning': 'tropical',
  'Typhoon Watch': 'tropical',

  // fire_weather
  'Red Flag Warning': 'fire_weather',
  'Fire Weather Watch': 'fire_weather',
  'Extreme Fire Danger': 'fire_weather',

  // heat
  'Heat Advisory': 'heat',
  'Excessive Heat Warning': 'heat',
  'Excessive Heat Watch': 'heat',

  // wind (also covers cold/wind chill — treated as a wind-related grouping
  // since users typically toggle "I care about wind events" together)
  'High Wind Warning': 'wind',
  'High Wind Watch': 'wind',
  'Wind Advisory': 'wind',
  'Wind Chill Warning': 'wind',
  'Wind Chill Watch': 'wind',
  'Wind Chill Advisory': 'wind',
  'Extreme Cold Warning': 'wind',
  'Extreme Cold Watch': 'wind',
  'Cold Weather Advisory': 'wind',

  // marine
  'Special Marine Warning': 'marine',
  'Marine Weather Statement': 'marine',
  'Gale Warning': 'marine',
  'Gale Watch': 'marine',
  'Storm Warning': 'marine',
  'Storm Watch': 'marine',
  'Small Craft Advisory': 'marine',
  'Small Craft Advisory For Hazardous Seas': 'marine',
  'Small Craft Advisory For Rough Bar': 'marine',
  'Small Craft Advisory For Winds': 'marine',
  'Brisk Wind Advisory': 'marine',
  'Hazardous Seas Warning': 'marine',
  'Hazardous Seas Watch': 'marine',
  'High Surf Warning': 'marine',
  'High Surf Advisory': 'marine',
  'Rip Current Statement': 'marine',
  'Beach Hazards Statement': 'marine',
  'Sneaker Wave Statement': 'marine',
  'Tsunami Warning': 'marine',
  'Tsunami Watch': 'marine',
  'Tsunami Advisory': 'marine',

  // other (visibility / civil / geophysical / general — anything that
  // doesn't fit the weather-domain buckets above)
  'Dense Fog Advisory': 'other',
  'Dense Smoke Advisory': 'other',
  'Air Quality Alert': 'other',
  'Air Stagnation Advisory': 'other',
  'Ashfall Advisory': 'other',
  'Ashfall Warning': 'other',
  'Volcano Warning': 'other',
  'Civil Danger Warning': 'other',
  'Civil Emergency Message': 'other',
  'Local Area Emergency': 'other',
  'Evacuation Immediate': 'other',
  'Hazardous Materials Warning': 'other',
  'Nuclear Power Plant Warning': 'other',
  'Radiological Hazard Warning': 'other',
  'Shelter In Place Warning': 'other',
  'Earthquake Warning': 'other',
  'Avalanche Warning': 'other',
  'Avalanche Watch': 'other',
  'Avalanche Advisory': 'other',
  'Child Abduction Emergency': 'other',
  'Law Enforcement Warning': 'other',
  '911 Telephone Outage': 'other',
};

export function categoryForEvent(event: string | undefined): AlertCategory {
  if (!event) return 'other';
  return EVENT_TO_CATEGORY[event] ?? 'other';
}

// Resolve the category set the user has actually opted into, distinguishing
// "key absent / undefined" (treat as default — DEFAULT_ALERT_CATEGORIES)
// from "explicit empty array" (treat as opt out of everything). The latter
// is the path used by the editor when the user unchecks every category
// toggle — they expect it to mean "show nothing", not "snap back to
// defaults".
export function getActiveAlertCategories(
  configured: string[] | undefined,
): Set<AlertCategory> {
  if (configured === undefined) return new Set(DEFAULT_ALERT_CATEGORIES);
  return new Set(configured as AlertCategory[]);
}
