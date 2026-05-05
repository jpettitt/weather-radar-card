// NWS standard warning colours, sourced from https://www.weather.gov/help-map.
// Used by the NWS alerts overlay for polygon stroke + fill.
//
// Coverage: the most common ~70 events plus a fallback. NWS publishes ~90
// distinct event names; rarely-used ones (e.g. "Lakeshore Flood Statement",
// "Test Tornado Warning") fall through to the default fallback colour.
//
// Hex values are kept verbatim from the NWS reference table — do not
// "tidy" them, the colour choices are deliberate (e.g. multiple greens
// distinguish flood watch from special marine warning).

export const NWS_ALERT_COLORS: Record<string, string> = {
  // Tornado / severe convective
  'Tornado Warning': '#FF0000',
  'Tornado Watch': '#FFFF00',
  'Severe Thunderstorm Warning': '#FFA500',
  'Severe Thunderstorm Watch': '#DB7093',
  'Severe Weather Statement': '#00FFFF',
  'Special Weather Statement': '#FFE4B5',
  'Extreme Wind Warning': '#FF8C00',

  // Flood
  'Flash Flood Warning': '#8B0000',
  'Flash Flood Watch': '#2E8B57',
  'Flash Flood Statement': '#8B0000',
  'Flood Warning': '#00FF00',
  'Flood Watch': '#2E8B57',
  'Flood Statement': '#00FF00',
  'Flood Advisory': '#00FF7F',
  'Coastal Flood Warning': '#228B22',
  'Coastal Flood Watch': '#66CDAA',
  'Coastal Flood Statement': '#6B8E23',
  'Coastal Flood Advisory': '#7CFC00',
  'Lakeshore Flood Warning': '#228B22',
  'Lakeshore Flood Watch': '#66CDAA',
  'Lakeshore Flood Advisory': '#7CFC00',
  'Hydrologic Outlook': '#90EE90',

  // Winter weather
  'Winter Storm Warning': '#FF69B4',
  'Winter Storm Watch': '#4682B4',
  'Winter Weather Advisory': '#7B68EE',
  'Blizzard Warning': '#FF4500',
  'Ice Storm Warning': '#8B008B',
  'Snow Squall Warning': '#C71585',
  'Lake Effect Snow Warning': '#008B8B',
  'Lake Effect Snow Advisory': '#48D1CC',
  'Freezing Rain Advisory': '#DA70D6',
  'Freezing Fog Advisory': '#008080',
  'Frost Advisory': '#6495ED',
  'Freeze Warning': '#483D8B',
  'Freeze Watch': '#00FFFF',
  'Hard Freeze Warning': '#9400D3',
  'Hard Freeze Watch': '#4169E1',

  // Tropical
  'Hurricane Warning': '#DC143C',
  'Hurricane Watch': '#FF00FF',
  'Tropical Storm Warning': '#B22222',
  'Tropical Storm Watch': '#F08080',
  'Tropical Depression Warning': '#FFA07A',
  'Storm Surge Warning': '#B524F7',
  'Storm Surge Watch': '#DB7FF7',
  'Hurricane Force Wind Warning': '#CD5C5C',
  'Hurricane Force Wind Watch': '#9932CC',
  'Typhoon Warning': '#DC143C',
  'Typhoon Watch': '#FF00FF',

  // Wind
  'High Wind Warning': '#DAA520',
  'High Wind Watch': '#B8860B',
  'Wind Advisory': '#D2B48C',

  // Fire weather
  'Red Flag Warning': '#FF1493',
  'Fire Weather Watch': '#FFDEAD',
  'Extreme Fire Danger': '#E9967A',

  // Heat
  'Heat Advisory': '#FF7F50',
  'Excessive Heat Warning': '#C71585',
  'Excessive Heat Watch': '#800000',

  // Cold / wind chill
  'Wind Chill Warning': '#B0C4DE',
  'Wind Chill Watch': '#5F9EA0',
  'Wind Chill Advisory': '#AFEEEE',
  'Extreme Cold Warning': '#0000FF',
  'Extreme Cold Watch': '#0000FF',
  'Cold Weather Advisory': '#AFEEEE',

  // Visibility / atmosphere
  'Dense Fog Advisory': '#708090',
  'Dense Smoke Advisory': '#F0E68C',
  'Air Quality Alert': '#808080',
  'Air Stagnation Advisory': '#808080',
  'Ashfall Advisory': '#A9A9A9',
  'Ashfall Warning': '#A9A9A9',
  'Volcano Warning': '#2F4F4F',

  // Marine (coastal/offshore)
  'Special Marine Warning': '#FFA500',
  'Marine Weather Statement': '#FFDAB9',
  'Gale Warning': '#DDA0DD',
  'Gale Watch': '#FFC0CB',
  'Storm Warning': '#9400D3',
  'Storm Watch': '#FFE4B5',
  'Small Craft Advisory': '#D8BFD8',
  'Small Craft Advisory For Hazardous Seas': '#D8BFD8',
  'Small Craft Advisory For Rough Bar': '#D8BFD8',
  'Small Craft Advisory For Winds': '#D8BFD8',
  'Brisk Wind Advisory': '#D8BFD8',
  'Hazardous Seas Warning': '#D8BFD8',
  'Hazardous Seas Watch': '#483D8B',
  'High Surf Warning': '#228B22',
  'High Surf Advisory': '#BA55D3',
  'Rip Current Statement': '#40E0D0',
  'Beach Hazards Statement': '#40E0D0',
  'Sneaker Wave Statement': '#40E0D0',
  'Tsunami Warning': '#FD6347',
  'Tsunami Watch': '#FF00FF',
  'Tsunami Advisory': '#D2691E',

  // Civil / other
  'Civil Danger Warning': '#FFB6C1',
  'Civil Emergency Message': '#FFB6C1',
  'Local Area Emergency': '#C0C0C0',
  'Evacuation Immediate': '#7FFF00',
  'Hazardous Materials Warning': '#4B0082',
  'Nuclear Power Plant Warning': '#4B0082',
  'Radiological Hazard Warning': '#4B0082',
  'Shelter In Place Warning': '#FA8072',
  'Earthquake Warning': '#8B4513',
  'Avalanche Warning': '#1E90FF',
  'Avalanche Watch': '#F4A460',
  'Avalanche Advisory': '#CD853F',
  'Child Abduction Emergency': '#FFFFFF',
  'Law Enforcement Warning': '#C0C0C0',
  '911 Telephone Outage': '#C0C0C0',
};

// Fallback for any event string not in the table above. Medium slate blue —
// visually distinct from any standard NWS colour so unknown events stand out
// for triage rather than blending in.
export const NWS_ALERT_DEFAULT_COLOR = '#7B68EE';

export function colorForEvent(event: string | undefined): string {
  if (!event) return NWS_ALERT_DEFAULT_COLOR;
  return NWS_ALERT_COLORS[event] ?? NWS_ALERT_DEFAULT_COLOR;
}
