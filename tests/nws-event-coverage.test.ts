// Every event type NWS can issue needs its official colour, and weather
// events their category; an unmapped one falls to 'other' and the fallback
// colour, so a user filtering by category silently loses it. NWS renames events
// (Excessive Heat → Extreme Heat in 2025), so this pins the live list.

import { describe, it, expect } from 'vitest';
import { categoryForEvent } from '../src/nws-alert-categories';
import { NWS_ALERT_COLORS, NWS_ALERT_DEFAULT_COLOR, colorForEvent } from '../src/nws-alert-colors';

// https://api.weather.gov/alerts/types, fetched 2026-10-08. Refresh when NWS
// renames or adds events.
const NWS_EVENT_TYPES = [
  '911 Telephone Outage', 'Administrative Message', 'Air Quality Alert', 'Air Stagnation Advisory',
  'Ashfall Advisory', 'Ashfall Warning', 'Avalanche Advisory', 'Avalanche Warning',
  'Avalanche Watch', 'Beach Hazards Statement', 'Blizzard Warning', 'Blowing Dust Advisory',
  'Blowing Dust Warning', 'Blue Alert', 'Brisk Wind Advisory', 'Child Abduction Emergency',
  'Civil Danger Warning', 'Civil Emergency Message', 'Coastal Flood Advisory',
  'Coastal Flood Statement', 'Coastal Flood Warning', 'Coastal Flood Watch',
  'Cold Weather Advisory', 'Dense Fog Advisory', 'Dense Smoke Advisory', 'Dust Advisory',
  'Dust Storm Warning', 'Earthquake Warning', 'Evacuation Immediate', 'Extreme Heat Warning',
  'Extreme Heat Watch', 'Extreme Cold Warning', 'Extreme Cold Watch', 'Extreme Fire Danger',
  'Extreme Wind Warning', 'Fire Warning', 'Fire Weather Watch', 'Flash Flood Statement',
  'Flash Flood Warning', 'Flash Flood Watch', 'Flood Advisory', 'Flood Statement', 'Flood Warning',
  'Flood Watch', 'Freeze Warning', 'Freeze Watch', 'Freezing Fog Advisory',
  'Freezing Spray Advisory', 'Frost Advisory', 'Gale Warning', 'Gale Watch',
  'Hazardous Materials Warning', 'Hazardous Seas Warning', 'Hazardous Seas Watch',
  'Hazardous Weather Outlook', 'Heat Advisory', 'Heavy Freezing Spray Warning',
  'Heavy Freezing Spray Watch', 'High Surf Advisory', 'High Surf Warning', 'High Wind Warning',
  'High Wind Watch', 'Hurricane Force Wind Warning', 'Hurricane Force Wind Watch',
  'Hurricane Warning', 'Hurricane Watch', 'Hydrologic Outlook', 'Ice Storm Warning',
  'Lake Effect Snow Warning', 'Lake Wind Advisory', 'Lakeshore Flood Advisory',
  'Lakeshore Flood Statement', 'Lakeshore Flood Warning', 'Lakeshore Flood Watch',
  'Law Enforcement Warning', 'Local Area Emergency', 'Low Water Advisory',
  'Marine Weather Statement', 'Nuclear Power Plant Warning', 'Radiological Hazard Warning',
  'Red Flag Warning', 'Rip Current Statement', 'Severe Thunderstorm Warning',
  'Severe Thunderstorm Watch', 'Severe Weather Statement', 'Shelter In Place Warning',
  'Short Term Forecast', 'Small Craft Advisory', 'Snow Squall Warning', 'Special Marine Warning',
  'Special Weather Statement', 'Storm Surge Warning', 'Storm Surge Watch', 'Storm Warning',
  'Storm Watch', 'Test', 'Tornado Warning', 'Tornado Watch', 'Tropical Cyclone Local Statement',
  'Tropical Storm Warning', 'Tropical Storm Watch', 'Tsunami Advisory', 'Tsunami Warning',
  'Tsunami Watch', 'Typhoon Warning', 'Typhoon Watch', 'Volcano Warning', 'Wind Advisory',
  'Winter Storm Warning', 'Winter Storm Watch', 'Winter Weather Advisory',
];

// No official colour worth adding: fall back by design.
const FALLBACK_COLOUR_BY_DESIGN = new Set(['Administrative Message', 'Test', 'Blue Alert']);

describe('NWS event coverage', () => {
  it.each([
    ['Extreme Heat Warning', 'heat'], ['Extreme Heat Watch', 'heat'],
    ['Tropical Cyclone Local Statement', 'tropical'], ['Lake Wind Advisory', 'wind'],
    ['Dust Storm Warning', 'wind'], ['Blowing Dust Warning', 'wind'], ['Blowing Dust Advisory', 'wind'],
    ['Dust Advisory', 'wind'], ['Fire Warning', 'fire_weather'], ['Lakeshore Flood Statement', 'flood'],
    ['Freezing Spray Advisory', 'marine'], ['Heavy Freezing Spray Warning', 'marine'],
    ['Heavy Freezing Spray Watch', 'marine'], ['Low Water Advisory', 'marine'],
  ])('puts %s in %s', (event, category) => {
    expect(categoryForEvent(event)).toBe(category);
  });

  it('gives every event NWS issues its official colour', () => {
    const missing = NWS_EVENT_TYPES.filter((e) => !FALLBACK_COLOUR_BY_DESIGN.has(e) && !(e in NWS_ALERT_COLORS));
    expect(missing).toEqual([]);
  });

  it('maps the 2025 Extreme Heat rename like the old Excessive Heat names', () => {
    expect(categoryForEvent('Extreme Heat Warning')).toBe('heat');
    expect(colorForEvent('Extreme Heat Warning')).toBe('#C71585');
    expect(colorForEvent('Extreme Heat Watch')).toBe('#800000');
    expect(colorForEvent('Extreme Heat Warning')).not.toBe(NWS_ALERT_DEFAULT_COLOR);
  });
});
