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

export const NOAA_OPENGEO_WMS_URL =
  'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows';
export const NOAA_OPENGEO_LAYER = 'conus_bref_qcd';

const CAPS_URL =
  `${NOAA_OPENGEO_WMS_URL}?service=WMS&version=1.3.0&request=GetCapabilities`;

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
export async function fetchNoaaFrameTimes(signal?: AbortSignal): Promise<number[]> {
  const res = await fetch(CAPS_URL, { signal });
  if (!res.ok) throw new Error(`NOAA capabilities HTTP ${res.status}`);
  return parseTimeDimension(await res.text());
}

/**
 * Pick frame times from the listing for a target loop: anchor at the
 * newest listed time, lay an ideal grid every `strideMin` back across
 * `pastMin`, and snap each ideal slot to the NEAREST listed time.
 * Snapped duplicates collapse (the listing is irregular — ~1.5 to
 * ~2.5 min between scans — so two adjacent ideal slots can legally
 * snap to the same scan). Returns epoch seconds ascending.
 *
 * Snapping to nearest (rather than at-or-before) keeps the mean
 * time error per slot minimal and is safe because every returned
 * value is a time the server explicitly listed — there is no risk of
 * requesting a nonexistent frame.
 */
export function pickFrameTimes(listedSec: number[], pastMin: number, strideMin: number): number[] {
  if (listedSec.length === 0) return [];
  const newest = listedSec[listedSec.length - 1];
  const strideSec = Math.max(60, Math.round(strideMin * 60));
  const slots = Math.max(0, Math.floor((pastMin * 60) / strideSec));
  const picked = new Set<number>();
  for (let i = slots; i >= 0; i--) {
    const ideal = newest - i * strideSec;
    picked.add(nearestListed(listedSec, ideal));
  }
  return Array.from(picked).sort((a, b) => a - b);
}

// Binary search for the listed time nearest to `target` (ties → newer).
function nearestListed(sorted: number[], target: number): number {
  let lo = 0, hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1; else hi = mid;
  }
  // sorted[lo] is the first value >= target; candidate below is lo-1.
  if (lo > 0 && target - sorted[lo - 1] < sorted[lo] - target) return sorted[lo - 1];
  return sorted[lo];
}
