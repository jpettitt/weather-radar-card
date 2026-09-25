/* eslint-disable @typescript-eslint/no-explicit-any */
import { HomeAssistant } from 'custom-card-helpers';

// Pure helpers for the lightning overlay. Layer-specific code lives in
// lightning-layer.ts; everything in this file is side-effect-free and
// unit-testable without standing up a Leaflet map.

// Default Blitzortung integration max-age window. Used when we can't read
// the user's actual configured value out of HA (the integration stores it
// in a config entry, which Lovelace cards can't query directly). 7200 s
// (= 120 min) matches the integration's current default — verified
// empirically on a fresh install. See Open Questions in
// docs/lightning-feature-design.md for the long-term fix.
export const DEFAULT_BLITZORTUNG_MAX_AGE_SEC = 7200;

// hass.config.components is HA's loaded-integrations list, populated at
// startup and stable thereafter. We gate the editor toggle on it (not on
// whether any geo_location entities are currently present) so a quiet day
// doesn't make the toggle disappear.
export function isBlitzortungLoaded(hass: HomeAssistant | undefined): boolean {
  const components = (hass?.config as any)?.components;
  return Array.isArray(components) && components.includes('blitzortung');
}

// Linear interpolation between two #rrggbb hex strings. Returns a #rrggbb
// hex. Out-of-range t clamps to [0, 1] so a stale ageSec can't blow up
// to negative or > 1 channel values.
export function lerpHex(a: string, b: string, t: number): string {
  const ct = Math.max(0, Math.min(1, t));
  const av = parseHex(a);
  const bv = parseHex(b);
  const r = Math.round(av[0] + (bv[0] - av[0]) * ct);
  const g = Math.round(av[1] + (bv[1] - av[1]) * ct);
  const b2 = Math.round(av[2] + (bv[2] - av[2]) * ct);
  return `#${[r, g, b2].map(toHex2).join('')}`;
}

function parseHex(h: string): [number, number, number] {
  const s = h.startsWith('#') ? h.slice(1) : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function toHex2(n: number): string {
  return n.toString(16).padStart(2, '0');
}

// How long a freshly-arrived strike is rendered as a bolt before the
// layer swaps it to a plus-sign. Matches the "initial flash + 30
// seconds" UX brief: the bolt + pulse animation are the "happening
// right now" indicator; after 30 s the strike settles into the
// Blitzortung-style cross with age-derived colour. 30 s lines up with
// _refreshAges()'s tick rate, so the swap is at most one tick late.
export const BOLT_DURATION_SEC = 30;

// Map a strike's age (seconds since detection) to the post-bolt + sign's
// fill colour. Six-stop gradient mirroring Blitzortung's web map
// convention: white when fresh, ageing through yellow / orange / coral
// / red / dark red over the strike's lifetime. (Blitzortung renders
// this in 20-minute discrete buckets; we interpolate continuously so
// the colour change reads as gradual fade rather than stepped jumps.)
//
// White at t=0 is fine here even on light basemaps — the + sign is
// drawn with a black stroke + drop-shadow halo, so the shape is
// outlined regardless of fill colour.
//
// Edges held at the endpoint colour (t<0 and t>1 both clamp). Defensive
// against a zero / negative maxAgeSec — returns the start colour rather
// than dividing by zero.
const COLOR_STOPS: ReadonlyArray<{ t: number; c: string }> = [
  { t: 0.0, c: '#ffffff' },   // white       — just emerged from bolt phase
  { t: 0.2, c: '#ffeb3b' },   // yellow
  { t: 0.4, c: '#ff9800' },   // orange
  { t: 0.6, c: '#ff6347' },   // coral
  { t: 0.8, c: '#ff0000' },   // red
  { t: 1.0, c: '#8b0000' },   // dark red    — oldest, near max-age
];

export function colorForAge(ageSec: number, maxAgeSec: number): string {
  if (!(maxAgeSec > 0)) return COLOR_STOPS[0].c;
  const t = Math.max(0, Math.min(1, ageSec / maxAgeSec));
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    const a = COLOR_STOPS[i];
    const b = COLOR_STOPS[i + 1];
    // Stryker disable next-line EqualityOperator: at t === b.t the two segments' lerps both yield stop b's colour
    if (t <= b.t) {
      const span = b.t - a.t;
      // Stryker disable next-line ConditionalExpression, EqualityOperator: COLOR_STOPS is a fixed, evenly spaced constant so span is always 0.2; the guard is for a future bad edit
      return lerpHex(a.c, b.c, span > 0 ? (t - a.t) / span : 0);
    }
  }
  return COLOR_STOPS[COLOR_STOPS.length - 1].c;
}

// Compute the bearing from one lat/lon to another and bucket it into one
// of the 8 cardinal/ordinal directions. Returns the localize key suffix
// (caller does `localize('ui.lightning.bearing_${suffix}')`).
//
// Uses the standard great-circle initial-bearing formula. For the short
// distances we deal with (< Blitzortung's typical 100 km cap) the
// rhumb-vs-great-circle distinction is sub-degree, well below the 22.5°
// bucket width — great-circle is fine.
export type BearingCardinal = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export function bearingCardinal(
  fromLat: number, fromLon: number,
  toLat: number, toLon: number,
): BearingCardinal {
  const φ1 = (fromLat * Math.PI) / 180;
  const φ2 = (toLat * Math.PI) / 180;
  const Δλ = ((toLon - fromLon) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2)
          - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const θ = Math.atan2(y, x);
  // Normalise to [0, 360); bucket into 8 sectors of 45° each, anchored
  // so N covers (-22.5°, 22.5°).
  const deg = ((θ * 180) / Math.PI + 360) % 360;
  const idx = Math.floor(((deg + 22.5) % 360) / 45);
  return (['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const)[idx];
}

// Format a strike's age for the popup. Returns the localize key suffix
// plus the integer to interpolate via {n} — the i18n strings own the
// pluralisation and unit text per locale.
//
//   < 5 s            → just_now (no number)
//   5..119 s         → seconds_ago / {n}
//   120..3599 s      → minutes_ago / {n=floor(s/60)}
//   ≥ 3600 s         → hours_ago   / {n=floor(s/3600)}
//
// Strikes older than ~10 min should not normally appear (Blitzortung
// integration removes them) but the formatter is defensive and degrades
// gracefully to hours.
export type RelativeTime = { key: 'just_now' | 'seconds_ago' | 'minutes_ago' | 'hours_ago'; n: number };

export function relativeTime(seconds: number): RelativeTime {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 5) return { key: 'just_now', n: 0 };
  if (s < 120) return { key: 'seconds_ago', n: s };
  if (s < 3600) return { key: 'minutes_ago', n: Math.floor(s / 60) };
  return { key: 'hours_ago', n: Math.floor(s / 3600) };
}

// Build a deep link into the Blitzortung community web map zoomed to a
// specific location. The web map's URL is fragment-based and takes
// zoom/lat/lon directly, so this is a pure string format — no API call.
// Zoom is clamped to the web map's supported range (3..13).
export function formatBlitzortungUrl(zoom: number, lat: number, lon: number): string {
  const z = Math.max(3, Math.min(13, Math.round(zoom)));
  // 4-decimal precision matches the Blitzortung site's own URL convention
  // (~11 m, more than enough for a strike marker).
  const fmt = (n: number): string => n.toFixed(4);
  return `https://map.blitzortung.org/#${z}/${fmt(lat)}/${fmt(lon)}`;
}
