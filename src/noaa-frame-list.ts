// NOAA frame-time discovery against the NCEP opengeo GeoServer.
//
// Unlike the old eventdriven ImageServer (which refused browser
// metadata requests entirely — the reason 3.7.0-alpha2 had to quantise
// blindly to a 10-min grid), opengeo's per-layer GetCapabilities is
// small (~8 KB), CORS-open (`access-control-allow-origin: *`), and
// lists the layer's ACTUAL frame timestamps in its WMS-T time
// dimension — real scan-completion times at ~2-min cadence, newest
// ~2 min behind wall clock, ~2 h of history (~60 entries). Probed
// 2026-06-12; full research in `.dev/opengeo-noaa-research.md`.
// radar.weather.gov runs on this same server, so it is NWS's
// production-scale public backend, not a side door.
//
// This turns the NOAA flow RainViewer-shaped: fetch the listing, pick
// exact TIMEs. No lag constant, no stride guessing, no duplicate-frame
// dedup as the primary mechanism.

import { gridPhase } from './stride-phase';

const OPENGEO = 'https://opengeo.ncep.noaa.gov/geoserver';

// NOAA's MRMS radar mosaics, one opengeo workspace each (extents from their
// GetCapabilities, 2026-10-08). The CONUS layer alone left Alaska, Hawaii,
// Puerto Rico and Guam blank. CONUS is listed LAST so it draws on top where
// the Caribbean mosaic overlaps Florida.
export interface NoaaRegion {
  id: string;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
}
export const NOAA_REGIONS: NoaaRegion[] = [
  { id: 'hawaii', bbox: { minLat: 15, maxLat: 26, minLon: -164, maxLon: -151 } },
  { id: 'alaska', bbox: { minLat: 50, maxLat: 72, minLon: -176, maxLon: -126 } },
  { id: 'carib', bbox: { minLat: 10, maxLat: 25, minLon: -90, maxLon: -60 } },
  { id: 'guam', bbox: { minLat: 9, maxLat: 18, minLon: 140, maxLon: 150 } },
  { id: 'conus', bbox: { minLat: 20, maxLat: 55, minLon: -130, maxLon: -60 } },
];

// One GetMap through the global endpoint draws every region: the server
// snaps each layer to its own nearest scan for a single TIME (verified
// 2026-10-08 — a Hawaii tile requested with a CONUS scan time matched
// Hawaii's own tile byte for byte), so no per-region layers are needed.
export const NOAA_OPENGEO_WMS_URL = `${OPENGEO}/ows`;
export const NOAA_OPENGEO_LAYER = NOAA_REGIONS.map((r) => `${r.id}:${r.id}_bref_qcd`).join(',');

/**
 * The region whose scan times drive the loop: the one containing the map
 * centre (CONUS wins where it overlaps the Caribbean mosaic), else CONUS.
 * Frames then fall on that region's own scans; other regions snap to theirs.
 */
export function noaaRegionAt(lat: number, lon: number): string {
  const lng = ((((lon + 180) % 360) + 360) % 360) - 180;
  const inside = (r: NoaaRegion): boolean =>
    lat >= r.bbox.minLat && lat <= r.bbox.maxLat && lng >= r.bbox.minLon && lng <= r.bbox.maxLon;
  const conus = NOAA_REGIONS.find((r) => r.id === 'conus')!;
  if (inside(conus)) return 'conus';
  return NOAA_REGIONS.find(inside)?.id ?? 'conus';
}

const capsUrl = (region: string): string =>
  `${OPENGEO}/${region}/${region}_bref_qcd/ows?service=WMS&version=1.3.0&request=GetCapabilities`;

/**
 * Parse the WMS-T time dimension out of a GetCapabilities document.
 * Returns epoch SECONDS sorted ascending; [] when no parseable list
 * is present (caller falls back to the legacy computed grid).
 *
 * Handles the discrete-list form GeoServer emits for this layer
 * (`t1,t2,t3,...`). The interval form (`start/end/period`) is NOT
 * expanded — opengeo doesn't use it for the radar mosaics, and
 * synthesising a grid from it would reintroduce exactly the
 * guessed-timestamps problem this module exists to remove.
 */
export function parseTimeDimension(xml: string): number[] {
  // Both 1.1.1 (<Extent name="time">) and 1.3.0 (<Dimension name="time">)
  // carry the same CSV payload; accept either so a server-side default
  // version change can't silently blank the list.
  const m = xml.match(/<(?:Dimension|Extent)[^>]*name="time"[^>]*>([^<]+)<\/(?:Dimension|Extent)>/i);
  if (!m) return [];
  // Stryker disable next-line MethodExpression: redundant with the per-entry trim below (whitespace never contains '/')
  const raw = m[1].trim();
  if (raw.includes('/')) return [];   // interval form — not expanded, see doc block
  const out: number[] = [];
  for (const part of raw.split(',')) {
    const t = Date.parse(part.trim());
    if (!Number.isNaN(t)) out.push(Math.floor(t / 1000));
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Fetch + parse the current frame-time listing. Throws on HTTP/network
 * failure; resolves [] on a 200 with an unparseable body. */
export async function fetchNoaaFrameTimes(signal?: AbortSignal, region = 'conus'): Promise<number[]> {
  const res = await fetch(capsUrl(region), { signal });
  if (!res.ok) throw new Error(`NOAA capabilities HTTP ${res.status}`);
  return parseTimeDimension(await res.text());
}

/** How far a scan may be from a grid slot and still stand in for it. */
const SLOT_TOLERANCE_SEC = 90;

/**
 * Pick frame times from the listing for a target loop: lay a grid every
 * `strideMin` at `phaseSec` (see stride-phase.ts; default: on the newest
 * listed time) back across `pastMin` from its newest slot a scan has
 * reached, and snap each slot to the NEAREST listed time. Slots with no
 * scan within 90 s (an outage) are left out, and snapped duplicates
 * collapse (the listing is irregular — ~1.5 to ~2.5 min between scans — so
 * two adjacent slots can legally snap to the same scan). Returns epoch
 * seconds ascending.
 *
 * Snapping to nearest (rather than at-or-before) keeps the mean
 * time error per slot minimal and is safe because every returned
 * value is a time the server explicitly listed — there is no risk of
 * requesting a nonexistent frame.
 */
export function pickFrameTimes(listedSec: number[], pastMin: number, strideMin: number, phaseSec?: number): number[] {
  if (listedSec.length === 0) return [];
  const newest = listedSec[listedSec.length - 1];
  const strideSec = Math.max(60, Math.round(strideMin * 60));
  const phase = gridPhase(phaseSec ?? newest, strideSec);
  // A slot no scan has reached yet isn't settled: its nearest scan may still
  // be published, and a frame taken early would be followed by a second one
  // for the same slot.
  const last = newest - gridPhase(newest - phase, strideSec);
  const slots = Math.max(0, Math.floor((pastMin * 60) / strideSec));
  const picked = new Set<number>();
  for (let i = slots; i >= 0; i--) {
    const ideal = last - i * strideSec;
    const t = nearestListed(listedSec, ideal);
    if (Math.abs(t - ideal) <= SLOT_TOLERANCE_SEC) picked.add(t);
  }
  // Stryker disable next-line MethodExpression,ArithmeticOperator: Set insertion order is already ascending (nearestListed is monotone in target); the sort is defensive
  return Array.from(picked).sort((a, b) => a - b);
}

// Binary search for the listed time nearest to `target` (ties → newer).
function nearestListed(sorted: number[], target: number): number {
  // Stryker disable next-line ArithmeticOperator: unreachable via pickFrameTimes (target <= newest); an out-of-range mid reads undefined, compares false and shrinks hi back
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    // Stryker disable next-line EqualityOperator: `<=` lands on the first value > target, and the below-candidate check returns the same time for an exact match
    if (sorted[mid] < target) lo = mid + 1; else hi = mid;
  }
  // sorted[lo] is the first value >= target; candidate below is lo-1.
  // (At lo = 0, sorted[-1] is undefined so the comparison is NaN/false and
  // the lo > 0 guard is redundant.)
  if (lo > 0 && target - sorted[lo - 1] < sorted[lo] - target) return sorted[lo - 1];
  return sorted[lo];
}
