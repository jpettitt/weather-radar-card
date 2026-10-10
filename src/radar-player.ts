/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { HomeAssistant, formatTime } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { Z_RADAR_BASE } from './const';
import { RateLimiter } from './rate-limiter';
import { FetchTileLayer, FetchWmsTileLayer, layerSettled } from './fetch-tile-layer';
import { isDarkBasemapStyle } from './basemap-styles';
import { RadarToolbar } from './radar-toolbar';
import { localize } from './localize/localize';
import { getEffectiveTimeRange, getSourceCaps } from './source-caps';
import {
  FORECAST_REUSE_MAX_AGE_MS, TileCachePolicy, finalUpToMs, persistUntilFor, pinnedForecastPolicy,
} from './tile-cache';
import {
  chooseStartRun, dwdIsoTime, fetchLatestRun, markUnverified, pinToRun, planForecastRefresh, recalledRun,
  rememberRun, swappableFrames,
} from './forecast-refresh';
import {
  dropMissingNoaaLayer, fetchNoaaFrameTimes, noaaOpengeoLayers, noaaRegionAt, pickFrameTimes, NOAA_OPENGEO_WMS_URL,
} from './noaa-frame-list';
import { gridPhase, recallStridePhase, rememberStridePhase } from './stride-phase';
import { extractChannel } from './lk';
import { createLkWorker, LkWorkerClient, estimateMotionLk } from './lk-worker';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pick the frame whose `time` (epoch seconds) is closest to `nowSec`.
 * Pure function — factored out so the now-marker logic is unit-testable
 * without standing up a full RadarPlayer. Ties resolve to the lower index.
 */
export function nearestFrameIndex(frames: { time: number }[], nowSec: number): number {
  if (frames.length === 0) return -1;
  let best = 0;
  let bestDiff = Math.abs(frames[0].time - nowSec);
  for (let i = 1; i < frames.length; i++) {
    const d = Math.abs(frames[i].time - nowSec);
    if (d < bestDiff) { bestDiff = d; best = i; }
  }
  return best;
}

/**
 * Frame-load order for the initial radar fetch: "now" first, then backward
 * through the past frames, then forward through any forecast frames.
 * Pure function — factored out so it's unit-testable without standing up
 * a full RadarPlayer.
 *
 * "Now" first so a forecast-heavy config doesn't load the farthest-future
 * frame before it (issue #246). History before forecast because frames load
 * one at a time: history usually comes straight from the tile cache while
 * DWD's forecast can take 5–45 s, so forecast-first left a cached loop
 * waiting behind the network on every reload (#279).
 */
export function buildLoadOrder(frameCount: number, nowIndex: number): number[] {
  const now = Math.max(0, Math.min(frameCount - 1, nowIndex));
  const order: number[] = [];
  for (let fi = now; fi >= 0; fi--) order.push(fi);
  for (let fi = now + 1; fi < frameCount; fi++) order.push(fi);
  return order;
}

/**
 * After the frame at order[failedIdx] fails: the order index to try next, or
 * -1 to stop. A failed past frame means the older ones are past the archive
 * too, but the forecast leg is independent, so loading skips to it; a failed
 * "now" or forecast frame ends the load. Pure, for the same reason as
 * buildLoadOrder.
 */
export function resumeIndexAfterFailure(order: number[], failedIdx: number): number {
  const forwardStart = order[0] + 1;   // the backward leg is now..0
  if (failedIdx > 0 && failedIdx < forwardStart && forwardStart < order.length) return forwardStart;
  return -1;
}

/**
 * RainViewer frames on the stride grid at `phaseSec` (see stride-phase.ts;
 * default: on the newest frame), inside `pastMin` of the newest one on it.
 * By time, not count: the list (up to 13 frames, 10 min apart) can skip a
 * slot — 12 frames with one 20-min gap on 2026-10-08 — and the last N frames
 * then reached 10 min further back than past_minutes. A 60 s tolerance
 * absorbs any jitter in frame times.
 */
export function pickRainViewerFrames<T extends { time: number }>(
  past: T[], pastMin: number, strideMin: number, phaseSec?: number,
): T[] {
  const newest = past[past.length - 1]?.time;
  if (newest === undefined) return [];
  const strideSec = Math.max(600, Math.round(strideMin * 60));
  const phase = gridPhase(phaseSec ?? newest, strideSec);
  const onGrid = past.filter((f) => {
    const off = gridPhase(f.time - phase, strideSec);
    return Math.min(off, strideSec - off) < 60;
  });
  const last = onGrid[onGrid.length - 1]?.time ?? 0;
  return onGrid.filter((f) => last - f.time <= pastMin * 60 + 60);
}

/**
 * "15 minutes ago", "1:00 hours ago", "1:20 hours ago", "in 25 minutes" for
 * a frame `deltaMs` from now (negative = past). Uses Intl.RelativeTimeFormat,
 * as HA does for its own relative times (its frontend has no "ago" string
 * of its own), so the wording and translation match HA in every language.
 * Intl can only say "1 hour ago" for 1:20, so from an hour up the h:mm goes
 * into its plural-hours phrase in place of the number — whole hours too, so
 * the label keeps its shape as the loop crosses them.
 */
export function relativeTimeText(deltaMs: number, locale: string): string {
  const minutes = Math.max(1, Math.round(Math.abs(deltaMs) / 60_000));
  const sign = deltaMs < 0 ? -1 : 1;
  let rtf: Intl.RelativeTimeFormat;
  try {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'always' });
  } catch {
    rtf = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
  }
  if (minutes < 60) return rtf.format(sign * minutes, 'minute');
  const hm = `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
  return rtf.formatToParts(sign * 2, 'hour').map((part) => (part.type === 'integer' ? hm : part.value)).join('');
}

/**
 * Insert `v` into `arr` (assumed already sorted ascending) at its sorted
 * position, mutating `arr` in place. Returns the insertion index. Pure
 * function — factored out so it's unit-testable without standing up a
 * full RadarPlayer.
 */
export function insertSorted(arr: number[], v: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, v);
  return lo;
}

export interface RadarTileSize { size: 512 | 1024 | 2048; zoomOffset: number }

/**
 * Radar tile size for a map whose larger dimension is `px`: aim for ~6 tiles
 * across, so big panel/fullscreen maps make fewer requests. Powers of 2
 * because all three sources speak { 512, 1024, 2048 } (RainViewer in the URL
 * path, NOAA/DWD WMS render any width/height); zoomOffset keeps the
 * on-screen scale constant.
 *
 * 512 is the floor, not 256 (#279): small cards fetch some pixels outside
 * the view but make fewer requests, which is what DWD's per-request latency
 * and rate limit care about. It also stops layers created before the map
 * reaches its laid-out size (the first frame and the DWD coverage mask)
 * getting a smaller grid than the rest of the loop on maps up to 1200 px.
 */
export function pickRadarTileSize(px: number): RadarTileSize {
  if (px > 2400) return { size: 2048, zoomOffset: -3 };
  if (px > 1200) return { size: 1024, zoomOffset: -2 };
  return { size: 512, zoomOffset: -1 };
}

// ── Types ────────────────────────────────────────────────────────────────────

export type FrameStatus = 'empty' | 'loading' | 'loaded' | 'failed';
export interface RadarFrame {
  time: number;
  path: string;
  host?: string;
  /** DWD forecast run (epoch s) the frame is pinned to — see forecast-refresh.ts. */
  run?: number;
  /** Loaded before DWD's run was known; may hold a forecast — see RunFrame. */
  unverified?: boolean;
  /** From NOAA's legacy 10-min fallback grid (opengeo listing unavailable). */
  legacy?: boolean;
}

/**
 * Screen-space motion vector for one frame-to-frame transition.
 * Produced by the LK motion-compensation pipeline; applied as a CSS
 * translate in {@link RadarPlayer._showSlot}. Sign convention matches
 * the LK output: (dx, dy) is the displacement of rain content from
 * the older frame into the newer frame.
 */
interface MotionVector { dx: number; dy: number; confidence: number; }

// Legacy NOAA endpoint — fallback ONLY. The primary NOAA source is the
// NCEP opengeo GeoServer (radar.weather.gov's own backend) whose
// GetCapabilities lists actual frame times (~2-min cadence, ~2-min
// lag) — see src/noaa-frame-list.ts. This eventdriven ImageServer
// refused browser metadata requests when this was built (it allows them
// as of 2026-10), so its frames are computed on a
// blind 10-min grid behind a 15-min lag (the server rejects anything
// fresher — measured in `.dev/noaa-lag-probe.mjs`): correct but stale
// by 15-25 min. Used when the opengeo listing can't be fetched/parsed.
const NOAA_LEGACY_WMS_URL =
  'https://mapservices.weather.noaa.gov/eventdriven/services/radar/radar_base_reflectivity_time/ImageServer/WMSServer';
const NOAA_LEGACY_WMS_LAYER = 'radar_base_reflectivity_time';
const NOAA_LEGACY_STRIDE_MIN = 10;
const NOAA_LEGACY_LAG_MS = 15 * 60 * 1000;

const DWD_WMS_URL = 'https://maps.dwd.de/geoserver/dwd/wms';
const DWD_WMS_LAYER_DEFAULT = 'Niederschlagsradar';

// Dedicated Leaflet pane for the radar tile layers. Sits between the
// basemap (tilePane = 200) and the wind-flow canvas (wrcWindFlow = 250).
// Two reasons to give the radar its own pane:
//   1. Pane-level CSS opacity. radar_opacity is applied on the pane,
//      letting individual layers crossfade between 0 and 1 (always opaque
//      transitions). With the prior model — opacity set per-layer at
//      radar_opacity — two semi-transparent layers stacked during a
//      crossfade and the alpha-over composite brightened during the
//      overlap, producing visible "shadow clouds" / flicker on every
//      tick. Composite α is now constant at radar_opacity throughout.
//   2. Future runtime layer-toggle UX gets a single `display: none`
//      target instead of having to track every loaded radar layer.
const RADAR_PANE_NAME = 'wrcRadar';
const RADAR_PANE_Z_INDEX = 240;
// Frames usually appear 1–3 min after their timestamp; 5 min is safely past the lag.
const DWD_LAG_MS = 5 * 60 * 1000;

// DWD's WMS tiles bake a "no-data" mask into every frame — grey wash
// (rgba 126,126,126,77) outside coverage, magenta outline (G=0, B=255)
// at the boundary. Two crossfading layers compound the dim into a
// visible pulse, so we strip them at fetch time and re-render the
// boundary as a separate, snap-switched overlay (`makeDwdMaskOnlyFilter`).
//
// The hard part is telling outline-on-data antialiasing blends apart
// from the palette purples DWD uses for very heavy rain. Both fall in
// the same RGB neighbourhood, so we whitelist palette entries by exact
// triple — the legend only has a handful and they're stable per layer.
// Anything else with G low and R, B both bright is treated as outline.
// Exported for unit-test access — same pattern as nearestFrameIndex
// above. Not part of the public API; consumers should use
// makeDwdMaskFilter / makeDwdMaskOnlyFilter instead.
export const WN_PALETTE_PURPLES = new Set<number>([
  (153 << 16) | (0 << 8) | 153,
  (255 << 16) | (51 << 8) | 255,
]);
export const RV_PALETTE_PURPLES = new Set<number>([
  (229 << 16) | (0 << 8) | 76,   // 45–75 mm/h — red-purple, passes the purple-shape test
  (204 << 16) | (0 << 8) | 152,
  (102 << 16) | (0 << 8) | 203,
]);

export function dwdPaletteFor(layerName: string): Set<number> {
  return layerName.startsWith('Radar_wn-') ? WN_PALETTE_PURPLES : RV_PALETTE_PURPLES;
}

export type DwdPixelKind = 'data' | 'grey' | 'outline';

// Classify a single pixel. Shared by the data filter (drops everything
// that isn't 'data') and the mask-only filter (drops 'data', recolours
// the rest).
//
// Exported for testability — the classifier is the most fragile piece
// of the DWD mask-stripping pipeline (RGB-indistinguishable palette
// purples vs outline blends, exact-triple whitelist) and worth pinning
// against DWD palette drift.
export function classifyDwdPixel(
  r: number, g: number, b: number, a: number,
  paletteKeys: Set<number>,
): DwdPixelKind {
  if (a < 255) {
    // Semi-transparent ⇒ an antialiased mask edge. Wash edges keep
    // R≈G≈B; magenta-blend edges don't.
    return Math.abs(r - g) <= 15 && Math.abs(g - b) <= 15 ? 'grey' : 'outline';
  }
  // Opaque black is the dBZ layer's ≥ 85 dBZ class, not wash: the wash is
  // never opaque (alpha 77 or 128, depending on the layer).
  if (r === g && g === b && r !== 0) return 'grey';
  if (g === 0 && b === 255) return 'outline';
  // Purple-shape: G is the smallest channel, R and B both bright. Any
  // such pixel that's not a palette entry is an outline-on-data blend.
  if (g < 120 && r > 50 && b > 50 && r > g && b > g) {
    const key = (r << 16) | (g << 8) | b;
    if (!paletteKeys.has(key)) return 'outline';
  }
  return 'data';
}

function makeDwdMaskFilter(layerName: string): (data: Uint8ClampedArray) => void {
  const palette = dwdPaletteFor(layerName);
  return (data) => {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      if (classifyDwdPixel(data[i], data[i + 1], data[i + 2], data[i + 3], palette) !== 'data') {
        data[i + 3] = 0;
      }
    }
  };
}

// Inverse of makeDwdMaskFilter: drop radar data, keep the mask, and
// recolour to theme-controlled RGBA. Original alpha is multiplied by
// the themed alpha so wash density and outline antialiasing both
// respond proportionally.
function makeDwdMaskOnlyFilter(
  layerName: string,
  dim: readonly [number, number, number, number],
  outline: readonly [number, number, number, number],
): (data: Uint8ClampedArray) => void {
  const palette = dwdPaletteFor(layerName);
  return (data) => {
    for (let i = 0; i < data.length; i += 4) {
      const origA = data[i + 3];
      if (origA === 0) continue;
      const kind = classifyDwdPixel(data[i], data[i + 1], data[i + 2], origA, palette);
      if (kind === 'data') { data[i + 3] = 0; continue; }
      const c = kind === 'grey' ? dim : outline;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = Math.round((origA * c[3]) / 255);
    }
  };
}

/**
 * Build a CSS `clip-path: path(...)` string covering the coverage
 * INTERIOR, from the shared coverage-mask layer's captured pixels.
 *
 * Input: RGBA from the coverage-mask tiles drawn to a (downscaled)
 * canvas — wash/outline pixels carry alpha > 0 (the no-data EXTERIOR),
 * interior pixels are transparent. Output: a path made of scanline-run
 * rectangles over interior pixels, with vertically-identical runs
 * merged (a fully-interior viewport collapses to a single rect).
 * Returns '' when no interior pixel exists.
 *
 * Why clip-path and not mask-image: Leaflet panes are 0×0 positioned
 * containers, and CSS masking clips its painting area to the element
 * box — `mask-clip: border-box` (default) masked everything out, and
 * Chrome's `mask-clip: no-clip` misrenders on a zero box (verified
 * with a standalone repro: a thin strip instead of the masked image).
 * clip-path is a geometric clip with no painting-area concept; pixel
 * coordinates resolve from the reference-box origin — the pane origin
 * — regardless of box size, which the same repro confirmed working.
 *
 * Why clip at all: nowcast frames carry a different no-data geometry
 * than the analysis frame the displayed boundary is pinned to, so
 * forecast rain can legitimately extend past the drawn outline; and
 * motion compensation slides whole layers, pushing edge rain over the
 * boundary during transitions. Clipping the pane solves both. The
 * rectangle quantisation (one canvas pixel ≈ 2 screen px) is hidden
 * under the drawn boundary outline.
 *
 * scaleX/scaleY map canvas pixels → screen px; offsetX/offsetY place
 * canvas (0,0) in the pane's (layer-point) coordinate space.
 *
 * Exported for unit tests.
 */
export function coverageClipPath(
  data: Uint8ClampedArray, w: number, h: number,
  scaleX: number, scaleY: number, offsetX: number, offsetY: number,
): string {
  // Alpha above this = exterior (wash/outline). The wash's antialiased
  // fringe (tiny alphas) counts as interior so the clip sits slightly
  // outside the visual boundary line rather than inside it.
  const EXTERIOR_ALPHA = 8;
  interface Rect { x0: number; x1: number; y0: number; y1: number; }
  const open = new Map<string, Rect>();   // runs continuing from the previous row
  const done: Rect[] = [];
  for (let y = 0; y < h; y++) {
    const next = new Map<string, Rect>();
    let runStart = -1;
    for (let x = 0; x <= w; x++) {
      const interior = x < w && data[(y * w + x) * 4 + 3] <= EXTERIOR_ALPHA;
      if (interior && runStart < 0) runStart = x;
      if (!interior && runStart >= 0) {
        const key = `${runStart}:${x}`;
        const prev = open.get(key);
        if (prev && prev.y1 === y) {
          prev.y1 = y + 1;            // identical span continues — extend
          next.set(key, prev);
        } else {
          next.set(key, { x0: runStart, x1: x, y0: y, y1: y + 1 });
        }
        runStart = -1;
      }
    }
    // Runs that didn't continue into this row are finished.
    for (const [key, rect] of open) {
      if (!next.has(key) || next.get(key) !== rect) done.push(rect);
    }
    open.clear();
    for (const [key, rect] of next) open.set(key, rect);
  }
  done.push(...open.values());

  if (done.length === 0) return '';
  const fmt = (n: number): string => (Math.round(n * 10) / 10).toString();
  let path = '';
  for (const r of done) {
    const x = offsetX + r.x0 * scaleX;
    const y = offsetY + r.y0 * scaleY;
    const rw = (r.x1 - r.x0) * scaleX;
    const rh = (r.y1 - r.y0) * scaleY;
    path += `M${fmt(x)} ${fmt(y)}h${fmt(rw)}v${fmt(rh)}h${fmt(-rw)}Z`;
  }
  return path;
}

// Parse any CSS colour ("rgba(0,0,0,0.3)", "#ff00ff", "magenta",
// "transparent", …) into [r, g, b, a] bytes via the canvas 2D context.
// Returns null if the string didn't parse — assigning an invalid value
// to fillStyle leaves the previous (sentinel) value unchanged.
function parseCssColor(value: string): [number, number, number, number] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return null;
  const sentinel = '#010203';
  ctx.fillStyle = sentinel;
  ctx.fillStyle = trimmed;
  if (ctx.fillStyle === sentinel && trimmed.toLowerCase() !== sentinel) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}


export interface RadarPlayerOptions {
  map: L.Map;
  shadowRoot: ShadowRoot;
  getConfig: () => WeatherRadarCardConfig;
  rainviewerLimiter: RateLimiter;
  noaaLimiter: RateLimiter;
  dwdLimiter: RateLimiter;
  /**
   * Live accessor for hass — used to honour the user's HA-configured
   * time_format (Settings > General) for the timeline timestamp instead
   * of guessing from the browser's ambient locale, which is frequently
   * wrong (many users run an en-US browser/OS language regardless of
   * where they live, and even an explicit OS 12h/24h override often
   * isn't honoured by Intl's locale resolution). Optional — falls back
   * to the previous browser-locale behaviour when absent.
   */
  getHass?: () => HomeAssistant | undefined;
  /**
   * The basemap style actually drawn (Auto and fallbacks resolved), for the
   * progress bar's light/dark palette. Falls back to config.map_style.
   */
  getMapStyle?: () => string;
}

// ── RadarPlayer ──────────────────────────────────────────────────────────────

export class RadarPlayer {
  // Playback state (readable by card)
  run = true;
  navPaused = false;
  viewPaused = false;

  // Private radar state
  private _map: L.Map;
  private _shadowRoot: ShadowRoot;
  private _getConfig: () => WeatherRadarCardConfig;
  private _getHass?: () => HomeAssistant | undefined;
  private _getMapStyle?: () => string;
  private _rainviewerLimiter: RateLimiter;
  private _noaaLimiter: RateLimiter;
  private _dwdLimiter: RateLimiter;
  private _dwdSwapLogged = false;

  // Coverage overlay (DWD only) — a SINGLE shared layer, not per-frame.
  // Fetches the same WMS layer with makeDwdMaskOnlyFilter so only the
  // wash + outline survive (recoloured to theme variables). The
  // coverage geometry is the radar composite's no-data region, which
  // is identical in every frame — the original per-frame design built
  // one mask layer per radar frame and snap-switched between N
  // identical images, which at a 12 h history (~144 frames, ~6 tiles
  // each) meant ~900 redundant WMS requests per init that saturated
  // the browser's per-origin connection pool. One layer, fetched once
  // per init at the newest past frame's TIME, always visible.
  private _coverageMask: FetchWmsTileLayer | null = null;
  private _dwdMaskPaneCreated = false;
  private _dwdDimRgba: [number, number, number, number] | null = null;
  private _dwdOutlineRgba: [number, number, number, number] | null = null;

  private _radarImage: (FetchTileLayer | FetchWmsTileLayer)[] = [];
  // Date + time stored as separate parts so the bottom row can hide the
  // date half via CSS on narrow cards (container query in card styles).
  private _radarTime: { date: string; time: string }[] = [];
  private _radarPaths: RadarFrame[] = [];
  private _nowFrameIndex = -1;
  private _loadedSlots: number[] = [];
  private _frameStatuses: FrameStatus[] = [];
  private _radarReady = false;
  private _frameGeneration = 0;
  // Abort the RainViewer JSON metadata fetch (called from _fetchPaths)
  // when a new generation supersedes the previous one or the player is
  // torn down. The generation check already discards stale responses;
  // aborting just stops the wire bandwidth too. Only used by the
  // RainViewer path; DWD / NOAA derive frame timestamps locally.
  private _pathsAbortCtrl: AbortController | null = null;
  // True while NOAA is running on the legacy eventdriven fallback
  // (opengeo frame listing unavailable). Decides which WMS endpoint
  // the tile layers point at; reset to false on the next successful
  // listing fetch.
  private _noaaLegacyMode = false;
  // NOAA region whose scan times drive the loop, chosen from the map centre
  // when the loop is built (see noaaRegionAt); null until then.
  private _noaaListingRegion: string | null = null;
  // The opengeo layers the loop's tiles request (see _onNoaaLayerMissing).
  private _noaaLayersBuilt = '';
  // The loop's stride grid phase (stride-phase.ts), fixed at its first
  // listing; null until then.
  private _stridePhaseSec: number | null = null;
  // Displayed frame count. Starts as the caller's request but is
  // re-derived from reality as frames arrive: _initRadar sets it to the
  // number of frames the API actually returned, and _dedupFrames shrinks
  // it when duplicate frames are pruned from the loop.
  private _configFrameCount = 5;
  // The frame count the CARD asked for (from getEffectiveTimeRange).
  // Kept separately because onNavSettled's "did frame_count change?"
  // comparison must run against what was REQUESTED, not what's
  // displayed — _configFrameCount legitimately diverges from the
  // request (API returned fewer frames; dedup pruned duplicates), and
  // comparing the nav callback's requested count against the displayed
  // count made every pan/zoom take the full teardown + refetch branch
  // forever once they diverged.
  private _requestedFrameCount = 5;
  // Frames the source's listing gave the last init (before motion-comp dedup).
  private _listedFrameCount = 0;
  private _doRadarUpdate = false;
  // Trailing debounce for the post-view-change refresh work
  // (motion-comp resnapshot + coverage-clip rebuild). Tracked-marker
  // configs re-centre on every GPS jitter, firing moveend several
  // times a minute — each used to run the full pipeline (tile decode
  // awaits + canvas draws + an LK call per adjacent frame pair).
  // Coalescing behind 250 ms costs one debounce window of staleness
  // on work that is purely cosmetic for that window. Snapshot
  // INVALIDATION stays immediate in the event handlers, so stale
  // vectors can't be applied while the refresh is pending.
  private _viewRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Retry of an init that ended with no frames (see _scheduleInitRetry).
  private _initRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _initRetries = 0;

  private _scheduleViewRefresh(): void {
    if (this._viewRefreshTimer) clearTimeout(this._viewRefreshTimer);
    this._viewRefreshTimer = setTimeout(() => {
      this._viewRefreshTimer = null;
      void this._resnapshotAll();
      void this._updateCoverageClip();
    }, 250);
  }

  // Cancel function for the currently armed periodic-update timer.
  // _scheduleUpdate maintains a single-chain invariant by cancelling
  // this before arming a replacement; clear() cancels it on teardown.
  private _cancelScheduledUpdate: (() => void) | null = null;
  // Generation of the _initRadar currently loading frames, or -1 when
  // none. Read via the _initInFlight getter by onNavSettled's guard
  // against tearing down an in-flight init on every moveend.
  private _initFlightGen = -1;
  // Wall-clock ms of the last time we fetched fresh frame paths
  // (either via _initRadar or _updateRadar). Read by onVisibilityVisible
  // to decide whether resuming from a hidden state needs a full
  // re-init: the scheduled _updateRadar handles a single missed
  // refresh via the _doRadarUpdate flag, but on resume from device
  // sleep or a long-hidden tab we can be many refresh-cycles stale,
  // and a single _updateRadar would only freshen the newest slot
  // while leaving the rest of the loop holding hour-old data.
  private _lastFrameRefreshAt = 0;

  // Forecast refresh (forecast_refresh_minutes): when the last forecast
  // refetch happened, the replacement layers still loading, and the loaded
  // ones waiting for their frame to be off screen (keyed by frame time,
  // since a refresh tick can shift frame indices underneath them).
  private _lastForecastRefreshAt = 0;
  // Newest run, when init started the forecast from an older cached one;
  // the catch-up refresh after the first load moves to it.
  private _catchUpRun: number | null = null;
  // True while that catch-up is loading — the timestamp says "updating".
  private _catchUpPending = false;
  // DWD's newest nowcast run (epoch s) as last seen in its run list, or null.
  // Frames it covers are final, which is what lets them be persisted.
  private _dwdLatestRun: number | null = null;
  private _forecastLoading: FetchWmsTileLayer[] = [];
  private _stagedForecast = new Map<number, { frame: RadarFrame; layer: FetchWmsTileLayer }>();

  // Frame loop state — _loopGen is incremented to cancel in-flight timers
  private _currentSlot = 0;
  private _loopGen = 0;

  // Monotonic — each new current slot gets a higher z so it covers the previous one.
  private _zCounter = 0;

  // Slot index of the currently-shown frame. On each _showSlot tick
  // this is captured into a local `prev1` variable BEFORE being updated
  // to the new slot — that local is then scheduled for a delayed
  // fade-out (starts when the new slot finishes fading in). Older slots
  // (prev1 from earlier ticks) trust their own delayed-fade-out setup
  // from when they were the prev1 — we don't touch them again here.
  private _prev1Slot = -1;

  // Web worker timer (used only for the periodic 5-min radar update)
  private _worker: Worker | null = null;
  private _workerBlobUrl: string | null = null;
  private _workerCallbacks = new Map<number, () => void>();
  private _workerNextId = 0;

  // Rate-limit state
  private _rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
  private _isRateLimited = false;
  // Server-error (5xx) state — see the "Server error banner" section below.
  private _isServerError = false;

  // Toolbar reference (set externally after toolbar is created)
  toolbar: RadarToolbar | null = null;

  // Highest native tile zoom requested in this session. Bumped on zoom-in
  // via _onZoomEnd, never lowered. Passed as minNativeZoom on each layer
  // so zoom-out reuses cached high-res tiles instead of fetching at the
  // lower native zoom.
  private _pinnedNativeZoom = 0;

  // ── Motion compensation state ────────────────────────────────────────
  //
  // Per-frame snapshots of the visible radar tiles (distance-from-white
  // intensity grid at SNAPSHOT_GRID resolution), and per-transition
  // motion vectors derived from adjacent snapshots via pyramidal
  // Lucas-Kanade optical flow. Both arrays are parallel to
  // _radarImage[] — index = frame index.
  //
  // _frameMotion[fi] is the vector to USE when transitioning INTO
  // frame fi (so the slide ends in sync with the fade-in of the new
  // frame). _frameMotion[0] is always null because the oldest frame
  // has no predecessor.
  //
  // null entries mean either:
  //   - snapshot not captured yet (frame still loading), or
  //   - LK confidence below CONFIDENCE_FLOOR (image too flat for a
  //     trustworthy vector — fall back to static crossfade).
  //
  // _snapshotGen is bumped on each map move/zoom/resize so async LK
  // results from the previous viewport don't pollute the new one when
  // they eventually resolve.
  private _frameSnapshot: (Float32Array | null)[] = [];
  // Per-snapshot non-zero pixel count, tracked alongside _frameSnapshot
  // so we can detect partial captures (tiles still loading when 'load'
  // fired). Two snapshots with very different nz aren't comparing the
  // same content and produce spurious LK vectors with deceptively high
  // confidence — gated against in _computeMotionForFrame.
  private _frameSnapshotNz: number[] = [];
  private _frameMotion: (MotionVector | null)[] = [];
  private _snapshotGen = 0;
  // Tracks which frame indices we've already logged an "averaging
  // anomaly" for (direction flip or magnitude overshoot in
  // _smoothedMotion). The smoothed value is constant for a given
  // snapshot-generation, so logging once per fi per generation
  // avoids spamming the console while still surfacing every
  // anomalous transition for diagnostic.

  // LK worker client; lazy-initialised on first compensation request
  // so the worker isn't created when motion_compensation is off. Falls
  // back to synchronous main-thread execution if Worker construction
  // fails (e.g. corporate CSP blocks blob: workers).
  private _lkClient: LkWorkerClient | null = null;
  private _lkWorkerInitTried = false;

  // 96 × 96 snapshot keeps the LK compute under ~3 ms on a fast
  // desktop, ~10–25 ms on a low-end mobile/tablet — well within a
  // single animation frame even on slow hardware when run in the
  // worker. CONFIDENCE_FLOOR matches the prototype's empirical
  // "borderline" threshold (Shi-Tomasi min eigenvalue normalised by
  // pixel count). Below it, the gradient field is too flat for LK to
  // produce a trustworthy vector and we fall back to no compensation
  // rather than slide by whatever the noise floor returned.
  private static readonly SNAPSHOT_GRID = 96;
  private static readonly CONFIDENCE_FLOOR = 5;
  // Window for cross-tick motion-vector smoothing in _smoothedMotion.
  // ±2 around the current transition (5-tap median) — same as PR #156's
  // smoothMotionVectors. Suppresses the per-tick speed jumps that read
  // visually as "stepping" between frames: raw LK output for a typical
  // RainViewer loop showed 3× speed variation between adjacent
  // transitions, which the slide animation faithfully renders as a
  // step at every tick boundary even when overlap=1 makes the fade
  // itself continuous.
  private static readonly MOTION_SMOOTH_RADIUS = 2;
  // Coverage similarity floor: when the smaller of two snapshots'
  // non-zero pixel counts is below this fraction of the larger, the
  // snapshots aren't comparing the same content and we refuse to
  // compute motion (which would otherwise produce a spurious vector
  // with deceptively high confidence — LK aggregates whatever
  // gradient signal it finds, even on incompatible inputs). 0.6
  // tolerates a meaningful rain-decay difference between consecutive
  // frames while rejecting the ~3× nz mismatches we see when one
  // snapshot captures partially-loaded tiles.
  private static readonly COVERAGE_SIMILARITY_FLOOR = 0.6;
  // Absolute floor on snapshot coverage. Below this many non-zero
  // pixels the input is too sparse to produce a meaningful estimate
  // regardless of comparability — typically means a near-empty
  // (clear-sky) viewport or a snapshot captured before tiles arrived.
  private static readonly MIN_SNAPSHOT_NZ = 500;

  constructor(opts: RadarPlayerOptions) {
    this._map = opts.map;
    this._shadowRoot = opts.shadowRoot;
    this._getConfig = opts.getConfig;
    this._getHass = opts.getHass;
    this._getMapStyle = opts.getMapStyle;
    this._rainviewerLimiter = opts.rainviewerLimiter;
    this._noaaLimiter = opts.noaaLimiter;
    this._dwdLimiter = opts.dwdLimiter;
    this._startWorker();
    this._pinnedNativeZoom = Math.min(
      this._map.getZoom(),
      this._sourceMaxNativeZoom(),
    );
    this._map.on('zoomend', this._onZoomEnd);
    this._map.on('moveend', this._onMoveEnd);
    this._map.on('resize', this._onResize);
  }

  private _sourceMaxNativeZoom(): number {
    // Must match the maxNativeZoom set per source in _createLayer.
    return (this._cfg.data_source ?? 'RainViewer') === 'DWD' ? 8 : 7;
  }

  private _onZoomEnd = (): void => {
    if (!this._map) return;
    const newPin = Math.min(this._map.getZoom(), this._sourceMaxNativeZoom());
    if (newPin > this._pinnedNativeZoom) {
      this._pinnedNativeZoom = newPin;
      // Leaflet reads minNativeZoom each time _clampZoom runs; updating the
      // option on existing layers is enough, no redraw needed.
      // Forecast-refresh layers still loading or waiting to swap in count
      // too, or a swapped-in frame would sit on a different native zoom.
      const layers = [
        ...this._radarImage,
        ...this._forecastLoading,
        ...[...this._stagedForecast.values()].map((s) => s.layer),
      ];
      for (const layer of layers) {
        if (layer) (layer.options as any).minNativeZoom = newPin;
      }
      // Keep the mask on the frames' grid so its tiles stay shared.
      if (this._coverageMask) (this._coverageMask.options as any).minNativeZoom = newPin;
    }
    // Zoom changes pixel scale, so cached snapshots and the screen-
    // pixel motion vectors derived from them are stale. Drop them and
    // immediately recapture from whatever tiles are in the DOM at the
    // new zoom level; _onLayerLoaded will run again if new tiles also
    // arrive, overwriting with a fresher snapshot.
    this._invalidateSnapshots();
    this._scheduleViewRefresh();
  };

  private _onMoveEnd = (): void => {
    // Pan changes which tiles are visible, but Leaflet only fires the
    // layer-level 'load' event when it actually fetches NEW tiles. A
    // small pan within the already-cached tile set just repositions
    // existing tiles via CSS transform and never fires 'load' — which
    // means _onLayerLoaded never runs and motion compensation would
    // stay off indefinitely after a cached-pan. So we resnapshot here
    // directly using whatever tiles are in the DOM right now; if a
    // larger pan also triggers new tile fetches, _onLayerLoaded picks
    // those up later and overwrites with the fresher snapshot.
    this._invalidateSnapshots();
    this._scheduleViewRefresh();
  };

  // Map container size changed (window resize, parent reflow, theme
  // switch, etc.). Leaflet's tile manager will re-fetch tiles for the
  // new viewport and each layer will fire its own 'load' as its tiles
  // settle, at which point _onLayerLoaded rebuilds its snapshot. Drop
  // the cached snapshots and motion vectors now so playback runs
  // without compensation through the resize rather than animating
  // with stale viewport data.
  private _onResize = (): void => {
    this._invalidateSnapshots();
    this._scheduleViewRefresh();
  };

  // ── Motion compensation: snapshot + LK pipeline ──────────────────────

  // Lazy-initialise the LK worker on first request. We don't create it
  // in the constructor because motion_compensation is off by default
  // and we don't want every player to spawn a worker it never uses.
  private _ensureLkClient(): void {
    if (this._lkClient || this._lkWorkerInitTried) return;
    this._lkWorkerInitTried = true;
    const created = createLkWorker();
    if (created) {
      this._lkClient = new LkWorkerClient(created.worker, created.blobUrl);
    } else {
      // Worker construction unavailable — silently fall back to
      // synchronous LK on the main thread. Logged once so a user
      // troubleshooting performance reports under a strict CSP has a
      // breadcrumb.
      console.info(
        '[weather-radar-card] LK worker unavailable; motion compensation will run on the main thread.',
      );
    }
  }

  // Drop the per-frame snapshots and motion vectors and bump the
  // generation so any pending async LK results bail out. New
  // snapshots will be captured the next time tiles settle on each
  // frame (or immediately via _resnapshotAll for cached-pan cases).
  private _invalidateSnapshots(): void {
    this._snapshotGen++;
    if (this._frameSnapshot.length > 0) {
      this._frameSnapshot = new Array(this._frameSnapshot.length).fill(null);
      this._frameSnapshotNz = new Array(this._frameSnapshotNz.length).fill(0);
      this._frameMotion = new Array(this._frameMotion.length).fill(null);
    }
  }

  // Capture the current visible state of a loaded radar frame's tiles
  // to a downsampled distance-from-white intensity grid. The grid
  // feeds the LK call that estimates rain motion between consecutive
  // frames.
  //
  // Why render to canvas rather than read tile <img> pixels directly:
  // FetchTileLayer serves tiles via blob URLs (so the canvas is
  // same-origin and readable), but reading pixels per <img> would
  // require one canvas allocation each. Building a single
  // viewport-sized canvas and drawImage'ing every tile into it is
  // simpler and only marginally more memory.
  //
  // Why distance-from-white (not alpha): alpha works for DWD's banded
  // palette but is near-binary for RainViewer/NOAA's smooth ramps,
  // leaving no signal for LK at the rain edges. Distance-from-white
  // (`255 - min(R, G, B)`, weighted by alpha) reads the colour ramp
  // as a continuous gradient and works for all three sources.
  //
  // ## Async because of the decode race
  //
  // FetchTileLayer assigns `tile.src` to a blob URL and calls
  // Leaflet's `done()` callback synchronously immediately after — see
  // src/fetch-tile-layer.ts createFetchTile(). That fires the layer's
  // 'load' event the moment the LAST tile's `done()` runs, but at
  // that point the browser may not have finished DECODING the new
  // image data (`tile.src = url` is async). Tiles with the
  // `.leaflet-tile-loaded` class but `complete=false` aren't drawable
  // yet — our JS check skips them, producing a partial snapshot whose
  // motion-vector output looks plausible but is measuring random
  // gradient overlap rather than real rain motion.
  //
  // We await `tile.decode()` on any incomplete tile before drawing.
  // For already-decoded tiles decode() returns immediately, so the
  // cost is paid only on the first 'load' fire of a freshly-loaded
  // layer. Re-snapshot on pan/zoom resolves instantly.
  //
  // The async generation check (`genAtStart !== _snapshotGen`)
  // ensures a viewport change mid-decode discards the result rather
  // than polluting the new state.
  //
  // Skips silently when the layer's container isn't mounted yet, no
  // tiles have loaded, or canvas isn't available. Callers check the
  // _frameSnapshot[fi] slot to know whether a snapshot exists.
  private async _captureFrameSnapshot(fi: number): Promise<void> {
    const layer = this._radarImage[fi];
    if (!layer || !this._map) return;
    const container = (layer as any).getContainer?.() as HTMLElement | undefined;
    if (!container) return;
    // Broader selector than `.leaflet-tile-loaded`: pick up any tile
    // in this layer's grid. The decode-await below filters the actual
    // "drawable" set, and the JS isImageLoaded check in the draw loop
    // is the final gate. Using the class would be premature filtering
    // because Leaflet adds the class before the browser finishes
    // decoding (see the doc-block above).
    const tiles = container.querySelectorAll<HTMLImageElement>('img.leaflet-tile');
    if (tiles.length === 0) return;
    // Wait for any tile whose browser decode isn't complete yet.
    // decode() returns a resolved promise for already-decoded images,
    // so the common steady-state pan/zoom recapture costs nothing.
    // catch() swallows broken-image rejections — those tiles fail the
    // isImageLoaded check below and get skipped at draw time.
    const genAtStart = this._snapshotGen;
    await Promise.all(Array.from(tiles).map((t) => {
      if (t.complete && t.naturalWidth > 0) return Promise.resolve();
      return t.decode().catch(() => { /* broken; skip at draw time */ });
    }));
    // View changed during decode (pan/zoom/resize) — the snapshot for
    // the old viewport is no longer relevant; the new generation will
    // do its own capture.
    if (genAtStart !== this._snapshotGen) return;
    // Verify the layer wasn't replaced underneath us either (e.g. by
    // _updateRadar's shift, or a teardown).
    if (this._radarImage[fi] !== layer) return;
    const mapSize = this._map.getSize();
    const grid = RadarPlayer.SNAPSHOT_GRID;
    const canvas = document.createElement('canvas');
    canvas.width = grid;
    canvas.height = grid;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const mapRect = this._map.getContainer().getBoundingClientRect();
    const xScale = grid / mapSize.x;
    const yScale = grid / mapSize.y;
    for (const tileImg of Array.from(tiles)) {
      if (!tileImg.complete || tileImg.naturalWidth === 0) continue;
      const tr = tileImg.getBoundingClientRect();
      const sx = (tr.left - mapRect.left) * xScale;
      const sy = (tr.top - mapRect.top) * yScale;
      const sw = tr.width * xScale;
      const sh = tr.height * yScale;
      try {
        ctx.drawImage(tileImg, sx, sy, sw, sh);
      } catch {
        // Cross-origin taint shouldn't happen with FetchTileLayer's
        // blob URLs, but if it does we silently skip the tile rather
        // than throw.
      }
    }
    const imgData = ctx.getImageData(0, 0, grid, grid);
    const snapshot = extractChannel(imgData, 'distance-from-white');
    this._frameSnapshot[fi] = snapshot;
    // Count non-zero pixels so _computeMotionForFrame can detect a
    // partial-load capture (small nz next to a sibling frame's full
    // snapshot → LK would lock onto noise with high confidence).
    let nz = 0;
    for (let k = 0; k < snapshot.length; k++) if (snapshot[k] > 0) nz++;
    this._frameSnapshotNz[fi] = nz;
  }

  // After snapshotting frame fi, async-compute the motion vector that
  // takes frame fi-1's rain field into frame fi's. Stored as the
  // vector to animate when transitioning INTO frame fi. Skips if the
  // previous snapshot doesn't exist yet (fi is the oldest, or its
  // predecessor hasn't loaded). Discards stale async results via the
  // generation check so a viewport change mid-computation doesn't
  // pollute the new state with old-viewport vectors.
  private _computeMotionForFrame(fi: number): void {
    const cur = this._frameSnapshot[fi];
    const prev = this._frameSnapshot[fi - 1];
    if (!cur || !prev || !this._map) { this._frameMotion[fi] = null; return; }
    // Comparability check: two snapshots with very different non-zero
    // coverage aren't capturing the same scene (one was likely taken
    // while tiles were still loading — Leaflet's 'load' event empirically
    // fires before all tile <img> elements are decoded into the DOM as
    // class="leaflet-tile-loaded"). LK on incompatible inputs produces
    // spurious vectors with deceptively high Shi-Tomasi confidence,
    // because the algorithm just minimises the residual on whatever
    // gradient signal exists — not knowing the inputs don't correspond.
    // Without this gate the user sees occasional "rain teleports half
    // the screen" frames mixed in with normal slides.
    const prevNz = this._frameSnapshotNz[fi - 1];
    const curNz = this._frameSnapshotNz[fi];
    if (prevNz < RadarPlayer.MIN_SNAPSHOT_NZ || curNz < RadarPlayer.MIN_SNAPSHOT_NZ) {
      // Too sparse to be reliable. Leave any prior motion[fi] in
      // place — better an out-of-date vector than a wrong one.
      return;
    }
    const ratio = Math.min(prevNz, curNz) / Math.max(prevNz, curNz);
    if (ratio < RadarPlayer.COVERAGE_SIMILARITY_FLOOR) {
      // Snapshots have incompatible coverage. Same reasoning — keep
      // whatever motion[fi] already holds rather than overwriting.
      return;
    }
    this._ensureLkClient();
    const grid = RadarPlayer.SNAPSHOT_GRID;
    const genAtStart = this._snapshotGen;
    // The worker transfers (and detaches) the ArrayBuffers it
    // receives. Copy the snapshots first so future
    // _computeMotionForFrame calls — which read these same snapshots
    // for adjacent transitions — still find valid data.
    const i0 = new Float32Array(prev);
    const i1 = new Float32Array(cur);
    const mapSize = this._map.getSize();
    const xScale = mapSize.x / grid;
    const yScale = mapSize.y / grid;
    void estimateMotionLk(i0, i1, grid, grid, {}, this._lkClient).then((result) => {
      // Viewport changed since the call started — result is stale,
      // _invalidateSnapshots already cleared _frameMotion.
      if (genAtStart !== this._snapshotGen) return;
      if (result.confidence < RadarPlayer.CONFIDENCE_FLOOR) {
        this._frameMotion[fi] = null;
        return;
      }
      this._frameMotion[fi] = {
        dx: result.dx * xScale,
        dy: result.dy * yScale,
        confidence: result.confidence,
      };
    }).catch(() => {
      // Worker error or termination — quietly drop. The next
      // _onLayerLoaded / _resnapshotAll cycle will retry.
      if (genAtStart !== this._snapshotGen) return;
      this._frameMotion[fi] = null;
    });
  }

  // Handle a layer's Leaflet 'load' event by snapshotting just that
  // layer and recomputing the motion vectors for the two pairs it
  // participates in (the transition INTO it, and the transition OUT
  // of it to the next-newer frame). Per-layer rather than a debounced
  // global sweep because Leaflet's 'load' fires the moment THIS
  // layer's visible tiles are decoded, which is precisely when its
  // pixel buffer is consistent. A global sweep timer can fire while
  // a slower layer is still decoding, leaving a partial snapshot
  // whose vector then drags the smoothed motion for that frame off
  // course — visible as a jittery patch midway through the loop
  // after a pan, zoom, or resize.
  private _onLayerLoaded = async (layer: FetchTileLayer | FetchWmsTileLayer): Promise<void> => {
    if (!this._cfg.motion_compensation) return;
    const fi = this._radarImage.indexOf(layer);
    if (fi < 0) return;
    // Await capture — the decode race in fetch-tile-layer.ts means
    // tile pixels may not be drawable when 'load' fires. See the
    // doc-block on _captureFrameSnapshot.
    await this._captureFrameSnapshot(fi);
    // Layer might have been replaced (e.g. by _updateRadar) during
    // the decode wait. _captureFrameSnapshot returns silently in
    // that case, leaving snapshot[fi] stale or unchanged — either
    // way, recomputing motion off it is meaningless.
    if (this._radarImage[fi] !== layer) return;
    this._computeMotionForFrame(fi);
    if (fi + 1 < this._frameSnapshot.length) {
      this._computeMotionForFrame(fi + 1);
    }
  };

  // Median-of-5 smoothing for the motion vector at frame fi. Reduces
  // visible "stepping" at tick boundaries when adjacent transitions
  // produce significantly different LK vectors — without this, the
  // slide animation honestly renders every per-tick speed change as
  // a perceptible step. With it, the per-tick vector applied to the
  // slide is the median of the window centered on fi, robustly
  // ignoring single-tick outliers (e.g. a brief moment of bad
  // gradient signal producing a 3× spike).
  //
  // Confidence inherits from the centre transition since the median
  // is structural rather than statistical — averaging confidence
  // would mask the actual signal quality of THIS transition.
  //
  // O(window²) time per call. With window=5 (radius 2) and per-tick
  // invocation, this is single-digit operations — negligible.
  private _smoothedMotion(fi: number): MotionVector | null {
    if (fi < 0 || fi >= this._frameMotion.length) return null;
    const raw = this._frameMotion[fi];
    // Bypass smoothing when raw is near-zero. These come from frame
    // pairs where the source served byte-identical snapshots
    // (publication-cycle quirks on RainViewer / DWD / NOAA produce
    // periodic duplicate frames when the requested stride is finer
    // than the source's true unique-frame interval). LK correctly
    // reports zero motion for these — but the median smoothing would
    // replace the zero with the bulk neighbor vector, sliding the
    // new layer from translate(-d_neighbor) to translate(0) over the
    // tick. Since the actual frame content is identical to the
    // previous frame, the rain visually JUMPS BACKWARD by d_neighbor
    // at the tick start, then slides forward to its starting
    // position. That's the periodic "step back" artifact.
    //
    // Threshold of 0.5 canvas-px = ~2 screen-px on a typical viewport
    // — well below visual significance, so anything below it is
    // either noise or a true duplicate-frame zero.
    if (raw && Math.hypot(raw.dx, raw.dy) < 0.5) return raw;
    const radius = RadarPlayer.MOTION_SMOOTH_RADIUS;
    const dxs: number[] = [];
    const dys: number[] = [];
    for (let k = -radius; k <= radius; k++) {
      const j = fi + k;
      if (j < 0 || j >= this._frameMotion.length) continue;
      const v = this._frameMotion[j];
      if (!v) continue;
      dxs.push(v.dx);
      dys.push(v.dy);
    }
    if (dxs.length === 0) return null;
    const median = (vs: number[]): number => {
      const sorted = vs.slice().sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
    };
    return {
      dx: median(dxs),
      dy: median(dys),
      confidence: this._frameMotion[fi]?.confidence ?? 0,
    };
  }

  // Detect frames that are byte-identical to their predecessor and
  // remove them from the playback loop, compacting every per-frame
  // array. Caused by source-side publication-cycle quirks. The
  // canonical producer was NOAA's legacy eventdriven WMS (snaps any
  // TIME within a ~6-7 min publication window to the same physical
  // frame, and its metadata endpoints refuse browsers so the true
  // cadence couldn't be discovered) — since the opengeo frame-listing
  // switch, NOAA frames are unique by construction and this runs as
  // belt-and-braces there (still primary for the legacy fallback path
  // and for any grid-computed source landing on a stale slot).
  //
  // Detection criterion: consecutive snapshots with identical nz
  // (non-zero pixel count). When two snapshots have the same number
  // of rain pixels AND we know they were captured from the same
  // tile set (loaded sequentially in _initRadar), they're byte-
  // identical with overwhelming probability — coincidental nz
  // collision on random different frames is theoretically possible
  // but vanishingly rare for any real radar scene.
  //
  // After compaction, _loadedSlots becomes the trivial [0, 1, …,
  // n-1] (slot index == fi), every per-frame array is sized to the
  // unique count, _configFrameCount reflects the actual displayed
  // count, and the progress bar is rebuilt to match. _currentSlot
  // and _prev1Slot are remapped to keep showing the same frame
  // content across the compaction.
  //
  // Synchronous — atomic update relative to any tick callbacks
  // (JavaScript single-threaded). Caller is responsible for
  // bumping _loopGen via _stopLoop first so any in-flight
  // setTimeout from before the dedup bails out on its gen check
  // (the cancelled timer's captured n/isLoopBack would be stale
  // after dedup).
  private _dedupFrames(): void {
    if (this._loadedSlots.length <= 1) return;
    // Walk _loadedSlots in order; mark frames whose nz matches the
    // PREVIOUSLY-KEPT frame (not the previous in _loadedSlots — a
    // chain of 3 duplicates should all collapse to one, not zigzag).
    const isDuplicate: boolean[] = new Array(this._loadedSlots.length).fill(false);
    let lastKeptFi = this._loadedSlots[0];
    for (let i = 1; i < this._loadedSlots.length; i++) {
      const fi = this._loadedSlots[i];
      const nz = this._frameSnapshotNz[fi];
      const prevNz = this._frameSnapshotNz[lastKeptFi];
      if (nz > 0 && nz === prevNz) {
        isDuplicate[i] = true;
      } else {
        lastKeptFi = fi;
      }
    }
    const droppedCount = isDuplicate.filter(Boolean).length;
    if (droppedCount === 0) return;

    // Capture the fi values for the currently-visible slot and the
    // most-recent prev1 slot BEFORE we compact, so we can remap
    // those pointers afterward to keep showing the same content.
    const currentFi = this._loadedSlots[this._currentSlot];
    const prev1Fi = this._prev1Slot >= 0
      ? this._loadedSlots[this._prev1Slot]
      : -1;

    // Build the kept-fi list in slot order (oldest → newest).
    const keptFi: number[] = [];
    for (let i = 0; i < this._loadedSlots.length; i++) {
      if (!isDuplicate[i]) keptFi.push(this._loadedSlots[i]);
    }

    // Tear down EVERY radar layer not being kept — not just the
    // duplicates. The arrays can hold entries for frames that never
    // made it into _loadedSlots (a frame that failed mid-init, or one
    // whose tiles were still settling when init was superseded). The
    // compaction below maps the arrays through keptFi, so anything not
    // in keptFi vanishes from our tracking — if it isn't removed from
    // the map HERE, no later sweep (_clearLayers iterates the tracked
    // arrays) can ever find it again. That was a real leak: every init
    // cycle orphaned the layers of its not-loaded frames into the
    // radar pane. (The DWD coverage mask is a single shared layer now
    // and isn't touched by dedup at all.)
    const keptSet = new Set(keptFi);
    const removeLayer = (l: unknown): void => {
      if (l && (l as { remove?: () => void }).remove) {
        (l as { remove: () => void }).remove();
      }
    };
    for (let fi = 0; fi < this._radarImage.length; fi++) {
      if (keptSet.has(fi)) continue;
      removeLayer(this._radarImage[fi]);
    }

    // Compact every per-frame array. New index == position in
    // keptFi, which IS the new fi value since _loadedSlots becomes
    // trivial [0..n-1] below.
    this._radarImage = keptFi.map((fi) => this._radarImage[fi]);
    this._radarTime = keptFi.map((fi) => this._radarTime[fi]);
    this._radarPaths = keptFi.map((fi) => this._radarPaths[fi]);
    this._frameSnapshot = keptFi.map((fi) => this._frameSnapshot[fi]);
    this._frameSnapshotNz = keptFi.map((fi) => this._frameSnapshotNz[fi]);
    this._frameMotion = keptFi.map((fi) => this._frameMotion[fi]);

    // _loadedSlots becomes the identity mapping; _configFrameCount
    // reflects what's actually displayed.
    this._loadedSlots = Array.from({ length: keptFi.length }, (_, i) => i);
    this._configFrameCount = keptFi.length;

    // Remap _currentSlot / _prev1Slot to the new fi positions so
    // playback resumes on the same content.
    const newCurrent = keptFi.indexOf(currentFi);
    // Fall back to nearest-to-now, not "newest" — for a forecast-heavy
    // config (issue #246) "current" is normally "now", nowhere near the
    // newest/farthest-future frame, so falling back to newest here would
    // silently jump playback across the whole forecast window if the
    // displayed frame happens to be the one deduped away.
    this._currentSlot = newCurrent >= 0 ? newCurrent : nearestFrameIndex(this._radarPaths, Date.now() / 1000);
    if (prev1Fi >= 0) {
      const newPrev1 = keptFi.indexOf(prev1Fi);
      this._prev1Slot = newPrev1 >= 0 ? newPrev1 : this._currentSlot;
    }

    // Rebuild the progress bar at the new (correct) length. All
    // remaining frames are loaded by this point, so seed every
    // segment to 'loaded' rather than 'empty'.
    this._buildSegments();
    for (let i = 0; i < this._loadedSlots.length; i++) {
      this._setSegment(i, 'loaded');
    }
    // Recompute the "now" marker against the new (compacted)
    // _radarPaths and re-highlight the currently-visible segment.
    this._computeNowFrameIndex();
    this._applyNowMarker();
    this._highlightSegment(this._currentSlot);

    // Diagnostic: what cadence did we infer? Surfacing this once
    // makes it easy for users to choose `frame_stride_minutes` in
    // YAML if they want to skip the discovery overhead entirely.
    const range = getEffectiveTimeRange(this._cfg);
    const originalCount = keptFi.length + droppedCount;
    const inferredCadenceMin = (originalCount * range.strideMin) / keptFi.length;
    const dataSource = this._cfg.data_source ?? 'RainViewer';
    console.info(
      `[weather-radar-card] ${dataSource} cadence inferred: ~${inferredCadenceMin.toFixed(1)} min (dropped ${droppedCount} of ${originalCount} frames as duplicates).`,
    );
  }

  // Snapshot every currently attached radar layer and compute every
  // adjacent-pair motion vector. Called after view changes (pan, zoom,
  // resize) where Leaflet's 'load' event may not fire because the
  // necessary tiles are already cached and only reposition. Per-layer
  // 'load' still handles the case where new tiles do load and gives
  // a fresher snapshot.
  private async _resnapshotAll(): Promise<void> {
    if (!this._cfg.motion_compensation) return;
    // Capture all snapshots in parallel (each awaits its own tiles'
    // decode internally). Once all snapshots resolve, recompute every
    // adjacent-pair motion vector with the fresh data.
    await Promise.all(
      this._radarImage.map((layer, fi) =>
        layer ? this._captureFrameSnapshot(fi) : Promise.resolve(),
      ),
    );
    for (let fi = 1; fi < this._frameSnapshot.length; fi++) {
      this._computeMotionForFrame(fi);
    }
  }

  // ── Config helpers ───────────────────────────────────────────────────────

  // low_power_mode (#279): snap transitions and no motion compensation, the
  // heaviest per-frame paths after DWD's pixel filter (skipped separately).
  // Derived once per config object — Lovelace replaces it on every edit.
  private _cfgSource?: WeatherRadarCardConfig;
  private _cfgEffective?: WeatherRadarCardConfig;
  private get _cfg(): WeatherRadarCardConfig {
    const c = this._getConfig();
    if (c !== this._cfgSource) {
      this._cfgSource = c;
      this._cfgEffective = c.low_power_mode
        ? { ...c, animated_transitions: false, motion_compensation: false }
        : c;
    }
    return this._cfgEffective!;
  }
  private get _hass(): HomeAssistant | undefined { return this._getHass?.(); }
  // Effective per-frame delay = configured frame_delay divided by the user's
  // playback-speed multiplier. Multiplier > 1 plays faster, < 1 plays slower.
  // Defaults to 1× (unchanged) when the user hasn't touched the speed button.
  private _speedMultiplier = 1;
  private get _timeout(): number {
    const base = this._cfg.frame_delay ?? 500;
    return Math.round(base / this._speedMultiplier);
  }

  /**
   * Adjust playback speed at runtime. Effective on the next tick — the
   * currently scheduled setTimeout fires at the previous interval and the
   * one it schedules picks up the new value. Out-of-range values fall back
   * to 1× so the playback never silently freezes.
   */
  setSpeedMultiplier(m: number): void {
    this._speedMultiplier = Number.isFinite(m) && m > 0 ? m : 1;
  }
  private get _restartDelay(): number { return this._cfg.restart_delay ?? 1000; }
  // Crossfade timing per tick. Returns:
  //   fadeMs   — duration of each layer's fade (in or out)
  //   delayMs  — delay before the cushion's fade-out starts, measured
  //              from the new layer's fade-in start
  //
  // Two modes:
  //
  // Regular (smooth_animation: false): sequential. Fade-out starts AT
  // fade-in completion (delayMs == fadeMs). Cushion holds at full
  // opacity throughout fade-in, then fades. Cycle is 2 × fadeMs
  // followed by single-layer idle until the next tick. No alpha-dip,
  // but the cushion is visibly "held" before it starts fading.
  //
  // Smooth (smooth_animation: true): tunable overlap via the
  // `smooth_overlap` config. The cushion's fade-out starts partway
  // through the new layer's fade-in:
  //   smooth_overlap = 0   → sequential (delay == fade), cycle 2×fade
  //   smooth_overlap = 0.5 → 50% overlap, cycle 1.5×fade
  //   smooth_overlap = 1   → simultaneous (delay == 0), cycle == fade
  //                          (default — true crossfade)
  // Fade duration is auto-calibrated so the full cycle equals
  // frame_delay regardless of overlap setting:
  //   cycle = (1 - overlap) × fade + fade = (2 - overlap) × fade
  //   fade  = frame_delay / (2 - overlap)
  //
  // Animations off: returns zeros — caller treats as snap mode.
  private _crossfadeTiming(): { fadeMs: number; delayMs: number } {
    if (this._cfg.animated_transitions === false) return { fadeMs: 0, delayMs: 0 };
    if (this._cfg.smooth_animation) {
      const overlap = Math.max(0, Math.min(1, this._cfg.smooth_overlap ?? 1));
      const fade = Math.floor(this._timeout / (2 - overlap));
      const delay = Math.floor(fade * (1 - overlap));
      return { fadeMs: fade, delayMs: delay };
    }
    const fade = this._cfg.transition_time ?? Math.floor(this._timeout * 0.4);
    return { fadeMs: fade, delayMs: fade };
  }
  // Resolved radar_opacity, clamped to [0, 1] and normalised to a CSS
  // opacity string. Applied at the radar pane level (see
  // _ensureRadarPane) so every individual radar layer can crossfade
  // between fully-transparent and fully-opaque without compounding the
  // alpha of the layer underneath.
  private get _activeOpacity(): string {
    const v = this._cfg.radar_opacity;
    if (typeof v !== 'number' || !isFinite(v)) return '1';
    return String(Math.max(0, Math.min(1, v)));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Start loading radar frames for the current map view. */
  async start(frameCount: number): Promise<void> {
    this._requestedFrameCount = frameCount;
    this._configFrameCount = frameCount;
    await this._initRadar();
  }

  /** Tear down all layers and cancel pending async work. */
  clear(): void {
    this._stopLoop();
    this._clearLayers();
    this._pathsAbortCtrl?.abort();
    this._pathsAbortCtrl = null;
    this._map?.off('zoomend', this._onZoomEnd);
    this._map?.off('moveend', this._onMoveEnd);
    this._map?.off('resize', this._onResize);
    if (this._rateLimitTimer) { clearTimeout(this._rateLimitTimer); this._rateLimitTimer = null; }
    if (this._initRetryTimer) { clearTimeout(this._initRetryTimer); this._initRetryTimer = null; }
    // Cancel the armed periodic-update timer before terminating the
    // worker — for the setTimeout-fallback path the worker teardown
    // wouldn't kill it, and a post-clear() fire would act on a player
    // the card has already discarded.
    this._cancelScheduledUpdate?.();
    this._cancelScheduledUpdate = null;
    if (this._viewRefreshTimer) { clearTimeout(this._viewRefreshTimer); this._viewRefreshTimer = null; }
    this._worker?.terminate();
    this._worker = null;
    this._workerCallbacks.clear();
    if (this._workerBlobUrl) { URL.revokeObjectURL(this._workerBlobUrl); this._workerBlobUrl = null; }
    // Bump generation so any in-flight LK promises bail out on resolve.
    this._snapshotGen++;
    this._lkClient?.dispose();
    this._lkClient = null;
    this._frameSnapshot = [];
    this._frameSnapshotNz = [];
    this._frameMotion = [];
    this._frameStatuses = [];
    this._updateLoadingSpinner();
  }

  // ── Navigation / visibility pause ────────────────────────────────────────

  onNavPaused(): void {
    this.navPaused = true;
    this._stopLoop();
  }

  async onNavSettled(frameCount: number): Promise<void> {
    this.navPaused = false;

    // An init is currently loading frames and the request shape hasn't
    // changed → let it finish. Without this guard, any moveend while
    // `_radarReady` is still false tore down the in-flight init and
    // started over — and on configs that pan programmatically (tracked
    // device markers re-centre on every GPS jitter), that loop is
    // self-sustaining: a DWD+forecast init loads ~48 frames
    // sequentially and needs the first two before _radarReady flips,
    // the restart makes the connection pool more saturated and thus
    // the next attempt slower, and the next pan lands before that.
    // Observed live as continuous tile requests + the mask pane
    // re-filling on every cycle. The in-flight init handles the new
    // viewport on its own — its layers are attached, so Leaflet
    // fetches tiles for wherever the map now points.
    if (this._initInFlight && !this._radarReady
        && this._requestedFrameCount === frameCount) {
      return;
    }

    // Full re-init only when state needs rebuilding: initial load not yet
    // complete, or the REQUESTED frame_count changed (i.e. the user edited
    // past_minutes / stride / source). Compared against
    // _requestedFrameCount, not _configFrameCount — the displayed count
    // legitimately diverges from the request (API returned fewer frames
    // than asked; _dedupFrames pruned duplicates), and comparing against
    // the displayed count made every pan/zoom take this full
    // teardown + refetch branch forever once they diverged. Pan, zoom,
    // and programmatic view changes leave layers attached — Leaflet
    // fetches only the tiles entering the new viewport.
    if (!this._radarReady || this._requestedFrameCount !== frameCount) {
      this._clearLayers();
      this._requestedFrameCount = frameCount;
      this._configFrameCount = frameCount;
      await this._initRadar();
      return;
    }

    // Resume without re-showing the current slot. _stopLoop already left
    // the displayed layer at active opacity via _settleVisibility; routing
    // through _showSlot would snap it to 0 and fade back in, producing a
    // visible flash on every move.
    if (this.run) {
      this._loopGen++;
      this._scheduleNext(this._loopGen);
    }

    // _scheduleUpdate's timer keeps running through the pause; if it fired
    // while navPaused was true it set _doRadarUpdate. Pick that up now, after
    // the resume: _updateRadar restarts the loop only when it shifts a new
    // frame in, so a refresh that found nothing newer left it stopped.
    if (this._doRadarUpdate) {
      this._doRadarUpdate = false;
      void this._updateRadar();
    }
  }

  onVisibilityHidden(): void {
    this.viewPaused = true;
    this._stopLoop();
  }

  onVisibilityVisible(): void {
    if (!this.viewPaused) return;
    this.viewPaused = false;
    // Stale-frame detection on resume. The scheduled _updateRadar uses
    // _workerTimeout, which mostly keeps firing while the tab is just
    // hidden but stops dead when the device sleeps — and even when it
    // does fire, _doRadarUpdate is a single bit ("a refresh is owed")
    // that doesn't distinguish "owed one update" from "owed twelve".
    // A single _updateRadar only freshens the newest frame; older
    // frames in the loop stay stuck at whatever timestamps they were
    // initialised with. After a long hidden / sleep window, the entire
    // loop is many cycles outdated and one update isn't enough.
    //
    // Heuristic: if more than 2× the refresh period has elapsed since
    // the last successful path-fetch (10 min for most sources, 4 min for
    // a 2-min NOAA loop), scrap the loop entirely and let _initRadar
    // refetch every slot from scratch. Shorter gaps fall through to the
    // existing _doRadarUpdate-driven single-frame path (or a loop resume).
    // Threshold tracks the source's actual refresh cadence (NOAA's 2-min
    // stride → 4-min threshold; others → 10 min) so a fast source isn't
    // judged "fresh" for the full 10 min after a long hide.
    const STALE_THRESHOLD_MS = 2 * this._refreshPeriodMs();
    const ageMs = this._lastFrameRefreshAt > 0
      ? Date.now() - this._lastFrameRefreshAt
      : 0;
    if (this._radarReady && ageMs > STALE_THRESHOLD_MS) {
      this._doRadarUpdate = false;
      this._clearLayers();
      void this._initRadar();
      return;
    }
    if (!this._radarReady) return;
    // Resume first, then refresh: _updateRadar restarts the loop only when
    // it shifts a new frame in, so a refresh that found nothing newer (about
    // every other tick) left the loop stopped, frozen on one frame with the
    // toolbar showing "playing".
    if (this.run) this._startLoop();
    if (this._doRadarUpdate) {
      this._doRadarUpdate = false;
      this._updateRadar();
    }
  }

  // ── Playback controls ────────────────────────────────────────────────────

  togglePlay(): void {
    this.run = !this.run;
    if (this.run) this._startLoop();
    else this._stopLoop();
  }

  get frameCount(): number { return this._configFrameCount; }

  /** Move to a specific frame index without restarting the loop timer. */
  scrubTo(fi: number): void {
    const slot = this._loadedSlots.indexOf(fi);
    if (slot === -1) return;
    this._stopLoop();
    this._currentSlot = slot;
    this._showSlot(slot);
  }

  /** Called when a scrub gesture ends — resumes playback if it was running. */
  scrubEnd(): void {
    if (this.run && !this.navPaused && !this.viewPaused) {
      this._startLoop(this._currentSlot);
    }
  }

  skipNext(): void {
    if (!this._radarReady) return;
    const n = this._loadedSlots.length;
    if (n < 2) return;
    this._currentSlot = (this._currentSlot + 1) % n;
    this._showSlot(this._currentSlot);
    this._stopLoop();
    this.run = false;
    this.toolbar?.setPlaying(false);
  }

  skipBack(): void {
    if (!this._radarReady) return;
    const n = this._loadedSlots.length;
    if (n < 2) return;
    this._currentSlot = (this._currentSlot - 1 + n) % n;
    this._showSlot(this._currentSlot);
    this._stopLoop();
    this.run = false;
    this.toolbar?.setPlaying(false);
  }

  // ── Frame loop ───────────────────────────────────────────────────────────

  private _stopLoop(): void {
    this._loopGen++;
    // Force a clean single-layer-visible state. The cushion-cleanup
    // transitionend listener registered by _showSlot may not fire (or
    // may fire after the user has paused), so we snap here too: the
    // current slot at active opacity, every other slot at 0.
    this._settleVisibility();
    // Nothing is mid-fade now, so held-back forecast swaps can all land.
    this._swapStagedFrames(this._currentSlot, false);
  }

  // Snap to a clean state where only _prev1Slot (the most-recently-
  // shown frame) is visible. Used when pausing the loop so the user
  // doesn't see the cushion `prev1` of the previous tick still at
  // opacity 1 underneath the current.
  //
  // Layer opacity is 0 or 1 — radar_opacity is applied at the pane
  // level (see _ensureRadarPane), so individual layers always
  // transition between fully transparent and fully opaque.
  private _settleVisibility(): void {
    const current = this._prev1Slot;
    for (let s = 0; s < this._loadedSlots.length; s++) {
      const fi = this._loadedSlots[s];
      const layer = this._radarImage[fi];
      const el = layer && (layer as any).getContainer?.() as HTMLElement | undefined;
      if (!el) continue;
      el.style.transition = 'none';
      el.style.opacity = (s === current) ? '1' : '0';
      // Reset any mid-transition translate so a paused-then-resumed
      // playback doesn't show the current frame still offset by the
      // outgoing slide of the previous tick.
      el.style.transform = '';
    }
  }

  /** Start (or restart) the frame loop, optionally jumping to a specific slot. */
  private _startLoop(startSlot?: number): void {
    this._loopGen++;
    const gen = this._loopGen;
    if (startSlot !== undefined) this._currentSlot = startSlot;
    this._showSlot(this._currentSlot);
    this._scheduleNext(gen);
  }

  private _scheduleNext(gen: number): void {
    if (!this.run || this.navPaused || this.viewPaused) return;
    const n = this._loadedSlots.length;
    if (n < 2) return;
    // delay is fixed at schedule time — if _loadedSlots grows before
    // this timer fires (the init loop's forward leg appends new frames
    // at the true tail while the loop is already animating; see
    // buildLoadOrder), a delay chosen for "this is the last frame"
    // can end up longer than it needed to be for one tick. Cosmetic
    // and self-correcting on the very next tick; not worth the timer
    // cancel/reschedule plumbing a fully-live recompute would need.
    const delay = this._currentSlot === n - 1
      ? this._timeout + this._restartDelay
      : this._timeout;
    setTimeout(() => {
      if (gen !== this._loopGen) return;
      // Re-read _loadedSlots.length fresh rather than closing over `n`
      // — unlike `delay` above, isLoopBack only affects which transition
      // style renders on THIS tick, so there's no reason not to use the
      // current, correct value.
      const freshN = this._loadedSlots.length;
      const isLoopBack = this._currentSlot === freshN - 1;
      this._currentSlot = (this._currentSlot + 1) % freshN;
      // Snap (no fade) when wrapping from the last frame back to the
      // first — the restart-delay pause already breaks the perceived
      // continuity of the animation, so a smooth crossfade across the
      // loop reads as "time went backwards" instead of "loop reset".
      this._showSlot(this._currentSlot, { snap: isLoopBack });
      this._scheduleNext(gen);
    }, delay);
  }

  /**
   * Bring `slot` to the top of the z-stack, fading it in over the previous
   * frame while the frame BEFORE that fades out.
   *
   * `opts.snap` skips all transitions (instant in/out). Used at the loop
   * boundary — after the restart pause, jumping from the last frame back
   * to the first looks wrong as a smooth crossfade because the user just
   * watched time pause. A clean snap reads as "the loop restarted".
   */
  private _showSlot(slot: number, opts?: { snap?: boolean }): void {
    const n = this._loadedSlots.length;
    if (n === 0 || slot < 0 || slot >= n) return;
    // Recompute each tick so the marker doesn't drift between 5-min refreshes.
    this._computeNowFrameIndex();
    this._applyNowMarker();
    const timing = opts?.snap
      ? { fadeMs: 0, delayMs: 0 }
      : this._crossfadeTiming();
    const fade = timing.fadeMs;
    const fadeOutDelay = timing.delayMs;
    // Linear opacity easing (rather than ease-in-out) so the fade
    // curve matches the slide's linear timing. ease-in-out's slow
    // start / slow end creates a perceptual "settling" at each fade
    // boundary that reads as extra stepping when consecutive ticks
    // are stitched together. Linear keeps the brightness change rate
    // constant throughout the cycle, eliminating that artifact.
    const transition = fade > 0 ? `opacity ${fade}ms linear` : 'none';

    // Two-slot animation model. Per-layer opacity transitions between 0
    // and 1; radar_opacity is applied at the pane level (see
    // _ensureRadarPane). With opaque layers, the alpha-over composite
    // during the overlap window stays at α=1 inside the pane — no
    // brightness bump from two semi-transparent layers stacking, which
    // was the cause of the "shadow clouds" / flicker seen at
    // radar_opacity < 1 prior to the pane refactor.
    //
    //   - `slot` (new): snaps to opacity 0 at the new highest z-index,
    //     then fades 0 → 1 over `fade` ms.
    //   - `prev1` (the previous current, captured below): kicks off a
    //     DELAYED fade-out — `transition-delay: fade` ms means it stays
    //     at 1 for `fade` ms (covering transparent pixels of the new
    //     layer during its fade-in), then fades 1 → 0 over `fade` ms.
    //   - Older slots: trusted to be already at 0 (or finishing their
    //     own delayed fade-out from a previous tick, which we don't
    //     interrupt — letting it complete keeps motion smooth even when
    //     transition_time approaches frame_delay).
    //
    // Cycle behaviour:
    //   - During the first `fade` ms of a tick: new fading in, prev1
    //     held at 1. Two visible layers, but composite stays opaque
    //     within the pane.
    //   - During the next `fade` ms: new fully on top, prev1 fading out.
    //     Two visible layers (one fading).
    //   - From `2*fade` ms until the next tick: only the new is visible.
    //     Single layer for `frame_delay - 2*fade` ms.
    //
    // When fade is 0 (animations off / snap mode), there's no transition
    // to delay, so the chain logic collapses: snap new to 1, snap
    // all others to 0. Single layer always visible.
    this._zCounter++;
    const newZ = Z_RADAR_BASE + this._zCounter;
    const prev1 = this._prev1Slot;
    const useChain = fade > 0;

    // Motion compensation: slide layers in the rain-drift direction
    // over the full transition window (frame_delay). The incoming
    // layer starts at translate(-dx, -dy) — where its rain WOULD
    // have been at the previous frame's time — and slides to (0, 0).
    // The outgoing layer starts at (0, 0) and slides to (+dx, +dy) —
    // where its rain WOULD be at the new frame's time. At any t the
    // two layers' rain positions overlap, so the composite reads as
    // one drifting field rather than two crossfading ones.
    //
    // Linear easing keeps the perceived drift speed constant.
    //
    // _frameMotion[fi] is the vector from frame fi-1 INTO frame fi —
    // so for THIS tick we want _frameMotion[newFi]. Disabled when:
    //   - opts.snap (loop-restart): a slide across the loop reads
    //     wrong because the user just watched time pause
    //   - useChain is false (animations off): no transition to slide on
    //   - motion_compensation config is off
    //   - vector unavailable (snapshot pending, low confidence, etc.)
    const newFi = this._loadedSlots[slot];
    // Read the smoothed vector rather than the raw one — see
    // _smoothedMotion's doc-block. The raw LK output for adjacent
    // transitions can vary by 3× in magnitude on real radar data,
    // which the slide animation would honestly render as a visible
    // speed change at every tick boundary. Median-of-5 across the
    // window centered on this frame collapses outliers and keeps the
    // perceived rain speed consistent across the loop.
    const motion = (!opts?.snap && useChain && this._cfg.motion_compensation && newFi !== undefined)
      ? this._smoothedMotion(newFi)
      : null;
    const motionTransition = motion ? `, transform ${this._timeout}ms linear` : '';

    for (let s = 0; s < n; s++) {
      const fi = this._loadedSlots[s];
      const layer = this._radarImage[fi];
      const el = layer && (layer as any).getContainer?.() as HTMLElement | undefined;
      if (!el) continue;

      if (s === slot) {
        // New: snap to 0 at the new highest z, then fade (or snap) in.
        el.style.zIndex = String(newZ);
        el.style.transition = 'none';
        el.style.opacity = '0';
        // Stage the starting translate before the reflow so the
        // transform transition has a "from" position to animate from.
        // No motion: clear any stale translate left over from this
        // layer's previous role as prev1 in an earlier tick.
        el.style.transform = motion ? `translate(${-motion.dx}px, ${-motion.dy}px)` : '';
        // Forced reflow before re-assigning — without this the browser
        // coalesces the two opacity writes and skips the transition.
        void el.offsetHeight;
        el.style.transition = transition + motionTransition;
        el.style.opacity = '1';
        if (motion) el.style.transform = 'translate(0px, 0px)';
      } else if (useChain && s === prev1) {
        // Just-promoted previous current: delayed fade-out. The
        // `transition-delay` (the second time value) holds the layer
        // at opacity 1 until the delay elapses, then begins the
        // fade-out. In regular mode delay == fade duration so the
        // fade-out starts AT fade-in completion (sequential). In smooth
        // mode delay is 75% of fade duration — the fade-out starts
        // before fade-in finishes, creating a brief overlap window
        // where the brightness composite stays close to constant.
        // The transform animation runs the full window (no delay) so
        // the slide ends in sync with the fade-out completing.
        // Linear opacity easing here too — matches the slot
        // layer's linear easing set above. Previously ease-in-out,
        // which created an asymmetric brightness curve during the
        // crossfade (slot fading in linearly while prev faded out
        // along an S-curve) that read as a "settling pause" mid-
        // transition. Symmetric linear keeps the perceived rate of
        // change constant.
        el.style.transition = `opacity ${fade}ms linear ${fadeOutDelay}ms${motionTransition}`;
        el.style.opacity = '0';
        if (motion) el.style.transform = `translate(${motion.dx}px, ${motion.dy}px)`;
      } else if (!useChain) {
        // Snap mode / fade=0: every non-current slot snaps to 0
        // immediately so we never see two layers at opacity 1.
        el.style.transition = 'none';
        el.style.opacity = '0';
        el.style.transform = '';
      }
      // useChain && older: don't touch. Their delayed fade-out from a
      // previous tick is either still finishing or already at 0.
    }

    this._prev1Slot = slot;

    // The DWD coverage mask is a single always-visible shared layer
    // (see _coverageMask) — nothing to switch per tick.

    const fi = this._loadedSlots[slot];
    if (fi !== undefined) {
      this._setTimestamp(fi);
      this._highlightSegment(fi);
    }

    // Refreshed forecast frames waiting for their frame to leave the screen.
    // A fade was just started (even on a manual step while paused).
    this._swapStagedFrames(slot, true);
  }

  // ── Progress bar ─────────────────────────────────────────────────────────

  // Cached segment elements, rebuilt by _buildSegments. The per-tick
  // paths (_applyNowMarker / _highlightSegment via _showSlot) used to do
  // a getElementById per segment per tick — at 4× speed with a 48-frame
  // DWD loop that was ~770 shadow-DOM lookups+writes per second for
  // state that almost never changes. The cache plus the changed-only
  // updates below reduce that to a handful of writes per tick.
  private _segEls: HTMLElement[] = [];
  private _lastNowMarkerIndex = -1;
  private _lastHighlightFi = -1;

  private _buildSegments(): void {
    const track = this._shadowRoot.getElementById('div-progress-track');
    if (!track) return;
    track.innerHTML = '';
    this._segEls = [];
    this._lastNowMarkerIndex = -1;
    this._lastHighlightFi = -1;
    this._frameStatuses = new Array(this._configFrameCount).fill('empty') as FrameStatus[];
    for (let i = 0; i < this._configFrameCount; i++) {
      const seg = document.createElement('div');
      seg.id = `seg-${i}`;
      seg.style.cssText = 'flex:1;height:100%';
      track.appendChild(seg);
      this._segEls.push(seg);
      this._paintSegment(i, false);
    }
    this._updateLoadingSpinner();
  }

  // Every segment paint goes through here: status colour, plus hatching on
  // frames after "now" so forecast reads as forecast on the bar itself.
  private _paintSegment(fi: number, isCurrent: boolean): void {
    const seg = this._segEls[fi];
    if (!seg) return;
    seg.style.backgroundColor = this._segColor(this._frameStatuses[fi] ?? 'empty', isCurrent);
    const forecast = this._nowFrameIndex >= 0 && fi > this._nowFrameIndex;
    const stripe = this._barIsDark() ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.22)';
    seg.style.backgroundImage = forecast
      ? `repeating-linear-gradient(135deg, ${stripe} 0 2px, transparent 2px 5px)`
      : '';
  }

  private _barIsDark(): boolean {
    return isDarkBasemapStyle(this._getMapStyle?.() ?? this._cfg.map_style, this._cfg.custom_tile_theme);
  }

  private _segColor(status: FrameStatus, isCurrent: boolean): string {
    const cfg = this._cfg;
    // "At rest" (empty/loaded) is the cosmetic part of the palette a user
    // would theme — loading/failed stay hardcoded since they're status
    // signals (still fetching / fetch failed), not decoration.
    const atRest = status === 'empty' || status === 'loaded';
    if (atRest) {
      const override = isCurrent ? cfg.progress_bar_active_color : cfg.progress_bar_background_color;
      if (override) return override;
    }
    const map = this._barIsDark()
      ? { empty: '#444', loading: '#aa7700', loaded: 'steelblue', failed: '#aa1111',
          cur_empty: '#666', cur_loading: '#cc9900', cur_loaded: '#6baed6', cur_failed: '#cc3333' }
      : { empty: '#e0e0e0', loading: '#ffcc00', loaded: '#ccf2ff', failed: '#ff4444',
          cur_empty: '#c0c0c0', cur_loading: '#ffe566', cur_loaded: '#66d9ff', cur_failed: '#ff8888' };
    return isCurrent ? ((map as any)[`cur_${status}`] ?? map.cur_empty) : ((map as any)[status] ?? map.empty);
  }

  private _setSegment(fi: number, status: FrameStatus): void {
    this._frameStatuses[fi] = status;
    this._paintSegment(fi, fi === this._lastHighlightFi);
    this._updateLoadingSpinner();
  }

  private _updateLoadingSpinner(): void {
    const spinner = this._shadowRoot.getElementById('loading-spinner');
    if (!spinner) return;
    const enabled = this._cfg.show_loading_spinner !== false;
    // _frameStatuses covers initial load and periodic refresh;
    // _tilePending catches pan/zoom on attached layers, where edge-tile
    // fetches don't go through _setSegment(loading).
    const segLoading = this._frameStatuses.some(s => s === 'loading');
    const tileLoading = this._radarImage.some(l => (l?._tilePending ?? 0) > 0);
    const isLoading = enabled && (segLoading || tileLoading);
    spinner.style.display = isLoading ? '' : 'none';
  }

  /** Pick the frame whose timestamp is closest to wall-clock now. */
  private _computeNowFrameIndex(): void {
    this._nowFrameIndex = nearestFrameIndex(this._radarPaths, Date.now() / 1000);
  }

  private _applyNowMarker(): void {
    // Touch only the segments whose now-state changed (the previous
    // marker holder and the new one) — this runs every tick.
    if (this._nowFrameIndex === this._lastNowMarkerIndex) return;
    const apply = (i: number, isNow: boolean): void => {
      const seg = this._segEls[i];
      if (!seg) return;
      seg.title = isNow ? localize('ui.now_tooltip') : '';
      // boxShadow (not backgroundColor) so _segColor doesn't clobber it on each tick.
      const nowColor = this._cfg.progress_bar_now_color || 'var(--warning-color, #ff9800)';
      seg.style.boxShadow = isNow ? `inset 0 2px 0 0 ${nowColor}` : '';
    };
    if (this._lastNowMarkerIndex >= 0) apply(this._lastNowMarkerIndex, false);
    if (this._nowFrameIndex >= 0) apply(this._nowFrameIndex, true);
    this._lastNowMarkerIndex = this._nowFrameIndex;
    // The forecast hatching starts after "now", so it moved too.
    for (let i = 0; i < this._segEls.length; i++) this._paintSegment(i, i === this._lastHighlightFi);
  }

  /**
   * Update the timestamp text — appends a localized "(now)" suffix when
   * the displayed frame is the now-frame. Renders the date and time as
   * separate spans (.ts-date / .ts-time) so a container query in the
   * card's CSS can hide the date half on narrow cards (≤ 397 px) and
   * leave only the time. Uses createElement / textContent rather than
   * innerHTML to keep this XSS-safe even though the inputs are all
   * Intl-formatted strings + a localized "(now)" — defensive habit
   * for anything writing user-visible HTML.
   */
  // HA's UI language, for Intl formatting the way HA's own frontend does it.
  private _locale(): string {
    const hass = this._hass as (HomeAssistant & { locale?: { language?: string } }) | undefined;
    return hass?.locale?.language ?? hass?.language ?? navigator.language ?? 'en';
  }

  // Re-render the timestamp of the frame on screen (its tags can change
  // without a frame change).
  private _refreshTimestamp(): void {
    const fi = this._loadedSlots[this._currentSlot];
    if (fi !== undefined) this._setTimestamp(fi);
  }

  private _setTimestamp(fi: number): void {
    const ts = this._shadowRoot.getElementById('timestamp');
    if (!ts) return;
    ts.textContent = '';  // wipe previous render
    const t = this._radarTime[fi];
    if (!t) return;
    const tag = (className: string, text: string): void => {
      const span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      ts.appendChild(span);
    };
    const nowMs = Date.now();
    const frameMs = (this._radarPaths[fi]?.time ?? 0) * 1000;
    // Relative to the frame on screen: "(latest)", "1:20 ago", "Forecast
    // +0:25". A dwd_time_override loop is anchored in the past, so "ago"
    // would only measure the override.
    const relative = fi === this._nowFrameIndex || !this._cfg.dwd_time_override;
    // Narrow cards (CSS container query) keep only the relative part; the
    // clock time stays when there's no relative label to replace it.
    tag('ts-date', `${t.date} `);
    tag(relative ? 'ts-time ts-time-optional' : 'ts-time', t.time);
    if (fi === this._nowFrameIndex) {
      tag('ts-now', ` ${localize('ui.now')}`);
    } else if (relative) {
      tag('ts-sep', ' · ');
      const rel = relativeTimeText(frameMs - nowMs, this._locale());
      if (frameMs > nowMs) {
        tag('ts-forecast', localize('ui.forecast_offset', '{time}', rel));
        if (this._catchUpPending) tag('ts-updating', ` · ${localize('ui.updating')}`);
      } else {
        tag('ts-ago', rel);
      }
    }
    const age = this._staleAgeMin(nowMs);
    if (age !== null) tag('ts-stale', ` ⚠ ${localize('ui.data_age', '{minutes}', String(age))}`);
  }

  /**
   * Minutes since the newest radar data, when that's longer than the source
   * should ever lag (an outage, a failing run list, a card that slept), else
   * null. DWD's frame times come from the clock, so its age is the newest
   * nowcast run's; the listed sources use their newest past frame.
   */
  private _staleAgeMin(nowMs: number): number | null {
    if (this._cfg.dwd_time_override) return null;
    const source = this._cfg.data_source ?? 'RainViewer';
    let newestMs: number | null = null;
    if (source === 'DWD') {
      newestMs = this._dwdLatestRun !== null ? this._dwdLatestRun * 1000 : null;
    } else {
      for (const f of this._radarPaths) {
        const t = f.time * 1000;
        if (t <= nowMs && (newestMs === null || t > newestMs)) newestMs = t;
      }
    }
    if (newestMs === null) return null;
    const age = Math.floor((nowMs - newestMs) / 60_000);
    const caps = getSourceCaps(source);
    // A listed source's newest frame waits for the next slot of its stride
    // (stride-phase.ts), so a stride longer than the threshold allows for adds to it.
    const sizedFor = Math.max(caps.intervalMin, ...(caps.strideChoices ?? []));
    const slack = source === 'DWD' ? 0 : Math.max(0, getEffectiveTimeRange(this._cfg).strideMin - sizedFor);
    return age > caps.staleAfterMin + slack ? age : null;
  }

  private _highlightSegment(fi: number): void {
    // Repaint only the segment losing the highlight and the one gaining
    // it — this runs every tick, and segment STATUS changes repaint
    // through _setSegment independently.
    if (fi === this._lastHighlightFi) return;
    const paint = (j: number, isCurrent: boolean): void => this._paintSegment(j, isCurrent);
    if (this._lastHighlightFi >= 0) paint(this._lastHighlightFi, false);
    paint(fi, true);
    this._lastHighlightFi = fi;
  }

  // ── Rate limit banner ────────────────────────────────────────────────────
  // The 10s-later full reinit is a fallback for the case where nothing
  // ever recovers on its own; _onTileRecovered (below) normally clears
  // the banner and cancels this timer well before it fires, the instant
  // any tile succeeds again, so the reinit doesn't fire redundantly on
  // top of an already-healthy loop.

  private _showRateLimitBanner(show: boolean): void {
    const banner = this._shadowRoot.getElementById('rate-limit-banner');
    if (banner) banner.style.display = show ? 'block' : 'none';
  }

  private _onRateLimited(): void {
    if (this._isRateLimited) return;
    this._isRateLimited = true;
    this._showRateLimitBanner(true);
    // A confirmed server error (below) already explains what's going on
    // and is already patiently backing off per-tile — don't ALSO arm the
    // aggressive full-reinit fallback on top of it, which would tear
    // down a loop mid-outage and add load to a server that's struggling.
    // The banner above still shows (this condition is real either way).
    if (this._isServerError) return;
    if (this._rateLimitTimer) clearTimeout(this._rateLimitTimer);
    this._rateLimitTimer = setTimeout(() => this._retryAfterRateLimit(), 10_000);
  }

  private _retryAfterRateLimit(): void {
    this._isRateLimited = false;
    this._rateLimitTimer = null;
    this._showRateLimitBanner(false);
    this._clearLayers();
    this._initRadar();
  }

  // opengeo answered a tile LayerNotDefined: a regional mosaic is gone, and
  // with it every tile of the request. Rebuild without it. It names only the
  // first missing layer, so another shows up on the next round; late
  // failures from the old layers find the loop already rebuilt.
  private _onNoaaLayerMissing(name: string): void {
    dropMissingNoaaLayer(name);
    const layers = noaaOpengeoLayers();
    if (layers === this._noaaLayersBuilt) return;
    console.warn(`[weather-radar-card] NOAA layer ${name || '(unnamed)'} is missing on opengeo; drawing radar without it.`);
    this._noaaLayersBuilt = layers;
    this._clearLayers();
    void this._initRadar();
  }

  // ── Server error banner ──────────────────────────────────────────────────

  // Distinct from the rate-limit banner above: a 5xx means the source's
  // server is up but struggling, not that we've hit our own pacing limit.
  // Tile-level retries (fetch-tile-layer.ts) handle recovery on their own
  // with a capped backoff; this just reflects that state in the UI.

  private _showServerErrorBanner(show: boolean): void {
    const banner = this._shadowRoot.getElementById('server-error-banner');
    if (banner) banner.style.display = show ? 'block' : 'none';
  }

  private _onServerError(): void {
    if (!this._isServerError) {
      this._isServerError = true;
      this._showServerErrorBanner(true);
    }
    // A confirmed 5xx is better information than "presumed rate limit
    // from a statusless failure" — cancel any pending forced reinit
    // (armed by an earlier _onRateLimited) so we don't tear down a loop
    // that's already correctly backing off per-tile. Runs on every call,
    // not just the first: _onRateLimited can re-arm the timer from a
    // different tile after this fires once.
    if (this._rateLimitTimer) { clearTimeout(this._rateLimitTimer); this._rateLimitTimer = null; }
  }

  // ── Tile recovery ────────────────────────────────────────────────────────
  // Fired on every successful tile load (see fetch-tile-layer.ts's
  // onTileRecovered). Clears whichever error banner(s) are currently up
  // and, for rate-limiting, cancels the pending fallback reinit — a tile
  // succeeding is direct evidence we're no longer limited, so there's
  // nothing left for that timer to fix.
  private _onTileRecovered(): void {
    if (this._isServerError) {
      this._isServerError = false;
      this._showServerErrorBanner(false);
    }
    if (this._isRateLimited) {
      this._isRateLimited = false;
      this._showRateLimitBanner(false);
      if (this._rateLimitTimer) { clearTimeout(this._rateLimitTimer); this._rateLimitTimer = null; }
    }
  }

  // ── Layer helpers ────────────────────────────────────────────────────────

  private _setLayerZ(layer: L.TileLayer, z: number): void {
    const el = (layer as any).getContainer?.() as HTMLElement | undefined;
    if (el) el.style.zIndex = String(z);
  }

  private _clearLayers(): void {
    this._frameGeneration++;
    this._radarReady = false;
    for (const layer of this._radarImage) {
      if (layer && (layer as any).remove) (layer as any).remove();
    }
    this._radarImage = [];
    this._radarTime = [];
    this._loadedSlots = [];
    // Reset crossfade state — stale prev/z counters would point at slots
    // that no longer exist after a teardown + re-init.
    this._prev1Slot = -1;
    this._zCounter = 0;
    // Reset motion-compensation state too. _snapshotGen++ invalidates
    // any LK results still in flight from the previous frame set.
    this._snapshotGen++;
    this._frameSnapshot = [];
    this._frameSnapshotNz = [];
    this._frameMotion = [];
    this._clearCoverageMask();
    // Forecast refresh layers still loading or waiting to swap. A loading
    // batch that settles later sees the bumped generation and discards itself.
    for (const layer of this._forecastLoading) layer.remove();
    this._forecastLoading = [];
    for (const { layer } of this._stagedForecast.values()) layer.remove();
    this._stagedForecast.clear();
    this._lastForecastRefreshAt = 0;
    this._dwdLatestRun = null;
    this._catchUpRun = null;
    this._catchUpPending = false;
    this._noaaListingRegion = null;
    this._stridePhaseSec = null;
  }

  // Resolve the DWD WMS layer the player is currently using: Niederschlagsradar
  // by default, and with forecast hours the analysis+nowcast layer. Both
  // carry the +2 h nowcast (checked 2026-10-08); forecast configs have
  // always used the latter.
  private _dwdLayerName(): string {
    const wantsForecast = (this._cfg.forecast_minutes ?? 0) > 0;
    const autoSwap = wantsForecast && this._cfg.dwd_layer === undefined;
    const name = this._cfg.dwd_layer
      ?? (wantsForecast ? 'Radar_wn-product_1x1km_ger' : DWD_WMS_LAYER_DEFAULT);
    if (autoSwap && !this._dwdSwapLogged) {
      console.info(
        `[weather-radar-card] forecast_minutes > 0; switched DWD layer ${DWD_WMS_LAYER_DEFAULT} (mm/h) → ${name} (dBZ) for nowcast frames. Set dwd_layer to override.`,
      );
      this._dwdSwapLogged = true;
    }
    return name;
  }

  // Dedicated Leaflet pane for the coverage overlay. z-index 350 sits
  // above the basemap + radar tiles (tilePane = 200) and below SVG
  // overlays / markers (overlayPane = 400).
  private _ensureDwdMaskPane(): void {
    if (this._dwdMaskPaneCreated || !this._map) return;
    const pane = this._map.createPane('dwd-coverage-mask');
    pane.style.zIndex = '350';
    pane.style.pointerEvents = 'none';
    this._dwdMaskPaneCreated = true;
  }

  // Pane for radar tile layers. The pane's CSS opacity carries
  // radar_opacity, so the per-layer crossfade can transition between 0
  // and 1 (always opaque) without producing the alpha-over composite
  // brightness bump that two semi-transparent stacked layers cause.
  // Idempotent — safe to call from _initRadar on every re-init; opacity
  // is re-applied in case radar_opacity changed in the new config.
  private _ensureRadarPane(): void {
    if (!this._map) return;
    let pane = this._map.getPane(RADAR_PANE_NAME);
    if (!pane) {
      pane = this._map.createPane(RADAR_PANE_NAME);
      pane.style.zIndex = String(RADAR_PANE_Z_INDEX);
      pane.style.pointerEvents = 'none';
    }
    pane.style.opacity = this._activeOpacity;
  }

  // Cache the theme colours per init so 48 frames don't each call
  // getComputedStyle.
  private _refreshDwdMaskColors(): void {
    const cs = getComputedStyle(this._shadowRoot.host as HTMLElement);
    this._dwdDimRgba = parseCssColor(cs.getPropertyValue('--dwd-coverage-dim-color'))
      ?? [0, 0, 0, 255];
    this._dwdOutlineRgba = parseCssColor(cs.getPropertyValue('--dwd-coverage-outline-color'))
      ?? [255, 0, 255, 255];
  }

  // Returns null if both theme colours are fully transparent — that's a
  // valid opt-out from CSS, no need to make WMS requests for a layer
  // that would render nothing.
  private _createDwdMaskLayer(frame: RadarFrame, layerName: string): FetchWmsTileLayer | null {
    const dim = this._dwdDimRgba;
    const outline = this._dwdOutlineRgba;
    if (!dim || !outline) return null;
    if (dim[3] === 0 && outline[3] === 0) return null;
    this._ensureDwdMaskPane();
    const isoTime = new Date(frame.time * 1000).toISOString().split('.')[0] + 'Z';
    const { size: tileSize, zoomOffset } = this._radarTileSize();
    // Same TIME, tile grid and zoom pin as the anchor frame's own layer, so
    // the URLs are identical and tile-cache shares one download between the
    // two (#279) — the mask only needs a different pixel filter.
    return new FetchWmsTileLayer(DWD_WMS_URL, {
      layers: layerName,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      TIME: isoTime,
      ...this._dwdRunParam(frame),
      tileSize,
      zoomOffset,
      minNativeZoom: this._pinnedNativeZoom,
      maxNativeZoom: 8 + Math.max(0, -zoomOffset),
      rateLimiter: this._dwdLimiter,
      on429: () => this._onRateLimited(),
      on5xx: () => this._onServerError(),
      onTileRecovered: () => this._onTileRecovered(),
      animationOwnsOpacity: true,
      tileCache: this._tileCachePolicy(frame),
      pane: 'dwd-coverage-mask',
      pixelFilter: makeDwdMaskOnlyFilter(layerName, dim, outline),
    } as any);
  }

  private _clearCoverageMask(): void {
    this._coverageMask?.remove();
    this._coverageMask = null;
    this._clearCoverageClip();
  }

  // Remove the pane clip — non-DWD sources and teardown must leave the
  // radar pane unclipped.
  private _clearCoverageClip(): void {
    const pane = this._map?.getPane(RADAR_PANE_NAME);
    if (!pane) return;
    pane.style.clipPath = '';
  }

  // Build / refresh the clip-path that confines the radar pane to the
  // coverage region. Captures the shared coverage-mask layer's tiles
  // into a half-resolution canvas covering the viewport plus a 25%
  // margin on each side (so interactive pans don't reveal unclipped
  // edges before the moveend rebuild), then converts the interior into
  // scanline-run rectangles via coverageClipPath and applies them as
  // `clip-path: path(...)` on the radar pane, in layer-point
  // coordinates so the clip stays glued to geography while Leaflet
  // translates the map pane.
  //
  // Re-run on: coverage-mask 'load' (tiles arrived/refreshed), and
  // moveend / zoomend / resize (viewport changed — same events that
  // already invalidate motion-comp snapshots). _snapshotGen guards
  // against a stale async capture applying after the view changed.
  private async _updateCoverageClip(): Promise<void> {
    const mask = this._coverageMask;
    if (!mask || !this._map) return;
    const container = (mask as { getContainer?: () => HTMLElement | null }).getContainer?.();
    if (!container) return;
    const tiles = container.querySelectorAll<HTMLImageElement>('img.leaflet-tile');
    if (tiles.length === 0) return;
    const genAtStart = this._snapshotGen;
    await Promise.all(Array.from(tiles).map((t) => {
      if (t.complete && t.naturalWidth > 0) return Promise.resolve();
      return t.decode().catch(() => { /* broken tile; skipped at draw */ });
    }));
    if (genAtStart !== this._snapshotGen) return;
    if (this._coverageMask !== mask) return;

    const size = this._map.getSize();
    // 25% margin each side: Leaflet keeps a buffer ring of loaded tiles
    // around the viewport, so the captured area beyond the viewport is
    // usually real data; areas with no tile read as alpha-0 → interior
    // → unclipped, which fails open (rain visible) rather than black.
    const padX = Math.ceil(size.x / 4);
    const padY = Math.ceil(size.y / 4);
    const fullW = size.x + 2 * padX;
    const fullH = size.y + 2 * padY;
    const w = Math.max(1, Math.ceil(fullW / 2));
    const h = Math.max(1, Math.ceil(fullH / 2));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const mapRect = this._map.getContainer().getBoundingClientRect();
    const xScale = w / fullW;
    const yScale = h / fullH;
    for (const tileImg of Array.from(tiles)) {
      if (!tileImg.complete || tileImg.naturalWidth === 0) continue;
      const tr = tileImg.getBoundingClientRect();
      try {
        ctx.drawImage(
          tileImg,
          (tr.left - mapRect.left + padX) * xScale,
          (tr.top - mapRect.top + padY) * yScale,
          tr.width * xScale,
          tr.height * yScale,
        );
      } catch { /* tainted/broken tile — skip */ }
    }
    const imgData = ctx.getImageData(0, 0, w, h);

    const pane = this._map.getPane(RADAR_PANE_NAME);
    if (!pane) return;
    // Canvas (0,0) corresponds to container point (-padX, -padY);
    // express it in layer-point space (the pane's coordinate system).
    const origin = this._map.containerPointToLayerPoint([-padX, -padY]);
    const path = coverageClipPath(
      imgData.data, w, h,
      fullW / w, fullH / h,
      origin.x, origin.y,
    );
    // Empty path = no interior pixel anywhere in the captured area
    // (viewport fully outside coverage). Hide the pane's rain — there
    // is no valid radar data to show there anyway.
    pane.style.clipPath = path ? `path("${path}")` : 'inset(100%)';
  }

  // Create the single shared coverage mask. Uses the newest PAST
  // frame's TIME: a past timestamp is guaranteed to exist on the
  // server, whereas the newest nowcast frame may not have been
  // published yet at request time.
  //
  // Deliberate approximation: the coverage geometry is NOT strictly
  // identical across nowcast lead times — probing real WN tiles
  // showed the no-data boundary shifting slightly and the wash area
  // growing with lead time (outline pixel count 1104 → 1006 from
  // analysis to +120 min). The old per-frame mask design rendered
  // each frame's own boundary and snap-switched between them, which
  // made the boundary visibly wobble during the forecast segment of
  // the loop. Pinning one analysis-frame boundary for the whole loop
  // trades a marginal coverage inaccuracy on forecast frames for a
  // rock-steady outline — and cuts ~N redundant mask WMS layers down
  // to one (at 12 h history that was ~900 tile requests per init).
  // Always visible from creation; it lives alone in its own pane, so
  // there is no crossfade interplay and nothing to switch per tick.
  private _ensureCoverageMask(frames: RadarFrame[], layerName: string): void {
    this._clearCoverageMask();
    const nowSec = Date.now() / 1000;
    // Newest frame at-or-before "now", else the oldest frame we have
    // (all-forecast configs are not currently possible, but be safe).
    // Pinned frames are still forecast for their run even when past by the
    // clock (runs publish 3–8 min late), so they're skipped; with refresh
    // off nothing is pinned.
    const pastFrames = frames.filter((f) => f.time <= nowSec && f.run === undefined);
    const anchor = pastFrames.length > 0 ? pastFrames[pastFrames.length - 1] : frames[0];
    if (!anchor) return;
    const mask = this._createDwdMaskLayer(anchor, layerName);
    if (!mask) return;
    this._coverageMask = mask;
    // Rebuild the radar-pane clip whenever the mask's tiles settle —
    // initial load and any pan/zoom refetches alike.
    mask.on('load', () => { void this._updateCoverageClip(); });
    if (this._map) mask.addTo(this._map);
  }

  // ── Radar fetching ───────────────────────────────────────────────────────

  private async _fetchPaths(): Promise<RadarFrame[]> {
    const dataSource = this._cfg.data_source ?? 'RainViewer';
    const range = getEffectiveTimeRange(this._cfg);
    const strideMs = range.strideMin * 60_000;
    const forecastMs = range.forecastMin * 60_000;
    const frameCount = range.frameCount;

    if (dataSource === 'NOAA') {
      // forecast_minutes is irrelevant for NOAA (maxForecastMin: 0) so
      // the anchor is just the latest past frame.
      //
      // Primary path: fetch the opengeo frame-time listing and snap an
      // ideal stride grid to the server's ACTUAL scan times — every
      // frame is real and unique, the newest is ~2 min behind wall
      // clock, and the loop honours past_minutes exactly. (_dedupFrames
      // stays armed downstream as belt-and-braces, but duplicates can
      // no longer occur by construction.)
      try {
        this._pathsAbortCtrl?.abort();
        this._pathsAbortCtrl = new AbortController();
        if (this._noaaListingRegion === null) {
          const c = this._map?.getCenter?.();
          this._noaaListingRegion = c ? noaaRegionAt(c.lat, c.lng) : 'conus';
        }
        const listed = await fetchNoaaFrameTimes(this._pathsAbortCtrl.signal, this._noaaListingRegion);
        const times = listed.length === 0 ? [] : pickFrameTimes(
          listed, range.pastMin, range.strideMin, this._stridePhase('NOAA', listed[listed.length - 1], range),
        );
        if (times.length > 0) {
          this._noaaLegacyMode = false;
          return times.map((t) => ({ time: t, path: '' }));
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        // Keep the actual error visible: this catch is deliberately
        // broad (any failure falls through to the legacy grid so radar
        // keeps working), but logging the cause means a real defect —
        // e.g. a TypeError from a future parse/snap refactor — surfaces
        // instead of masquerading silently as "listing unavailable".
        console.warn('[weather-radar-card] NOAA frame listing fetch/parse failed; falling back to legacy eventdriven grid:', e);
        // _noaaLegacyMode is set unconditionally below — both this caught
        // path and the empty-listing fall-through land there.
      }
      // Fallback: legacy eventdriven server with a blind 10-min grid
      // behind its measured 15-min availability lag. Stale but correct;
      // recovers automatically — the next refresh cycle retries the
      // listing. The fixed legacy stride deliberately ignores the
      // user's stride choice: the legacy server snaps finer requests
      // to duplicates of the same physical frame. (Also reached when the
      // listing was fetched but empty — times.length === 0 — hence the
      // _noaaLegacyMode set here too, not only in the catch.)
      this._noaaLegacyMode = true;
      const legacyStrideMs = NOAA_LEGACY_STRIDE_MIN * 60_000;
      const snap = Math.trunc((Date.now() - NOAA_LEGACY_LAG_MS) / legacyStrideMs) * legacyStrideMs;
      const legacyCount = Math.max(1, Math.floor(range.pastMin / NOAA_LEGACY_STRIDE_MIN) + 1);
      const frames: RadarFrame[] = [];
      for (let i = legacyCount - 1; i >= 0; i--) {
        frames.push({ time: (snap - i * legacyStrideMs) / 1000, path: '', legacy: true });
      }
      return frames;
    }
    if (dataSource === 'DWD') {
      const override = this._cfg.dwd_time_override;
      let base = Date.now() - DWD_LAG_MS;
      if (override) {
        const parsed = new Date(override).getTime();
        if (Number.isNaN(parsed)) {
          console.warn(
            `[weather-radar-card] Invalid dwd_time_override "${override}"; expected ISO 8601. Using current time instead.`,
          );
        } else {
          base = parsed;
        }
      }
      // anchor = newest frame timestamp = "now" + forecast window. Snap
      // to the stride grid so frame timestamps align with what the WMS
      // actually serves.
      const anchor = base + forecastMs;
      const snap = Math.trunc(anchor / strideMs) * strideMs;
      const frames: RadarFrame[] = [];
      for (let i = frameCount - 1; i >= 0; i--) {
        frames.push({ time: (snap - i * strideMs) / 1000, path: '' });
      }
      return frames;
    }
    this._pathsAbortCtrl?.abort();
    const ctrl = new AbortController();
    this._pathsAbortCtrl = ctrl;
    let data: { host?: string; radar?: { past?: unknown[] } };
    try {
      const res = await fetch('https://api.rainviewer.com/public/weather-maps.json', {
        signal: ctrl.signal,
      });
      data = await res.json();
    } catch (err) {
      // Aborted by a fresh _fetchPaths or by teardown — the caller's
      // generation check will discard the empty result we return below.
      if ((err as Error)?.name === 'AbortError') return [];
      throw err;
    } finally {
      if (this._pathsAbortCtrl === ctrl) this._pathsAbortCtrl = null;
    }
    const host: string = data.host ?? 'https://tilecache.rainviewer.com';
    const past: RadarFrame[] = (data?.radar?.past ?? []).map((f: any) => ({
      time: f.time, path: f.path, host,
    }));
    if (past.length === 0) return [];
    const phase = this._stridePhase('RainViewer', past[past.length - 1].time, range);
    return pickRainViewerFrames(past, range.pastMin, range.strideMin, phase);
  }

  // The loop's stride grid phase: on its first listing, the phase cards on
  // this source and stride last used if that was under half the window ago,
  // else the newest frame's. Each listing marks it as used.
  private _stridePhase(source: string, newestSec: number, range: { pastMin: number; strideMin: number }): number {
    const strideSec = Math.round(range.strideMin * 60);
    const now = Date.now();
    if (this._stridePhaseSec === null) {
      this._stridePhaseSec = recallStridePhase(source, strideSec, now, range.pastMin * 30_000)
        ?? gridPhase(newestSec, strideSec);
    }
    rememberStridePhase(source, strideSec, this._stridePhaseSec, now);
    return this._stridePhaseSec;
  }

  // WMS params pinning a DWD forecast frame to its run. Leaflet WMS turns
  // unrecognised options into query params, so this lands on the GetMap URL.
  private _dwdRunParam(frame: RadarFrame): { DIM_REFERENCE_TIME?: string } {
    return frame.run !== undefined ? { DIM_REFERENCE_TIME: dwdIsoTime(frame.run) } : {};
  }

  // forecast_refresh_minutes in effect: 0 unless DWD with a forecast window.
  // Ticks run every 5 min, so that's the floor.
  private _forecastRefreshMin(): number {
    if (!this._isDwd()) return 0;
    if (getEffectiveTimeRange(this._cfg).forecastMin <= 0) return 0;
    const m = this._cfg.forecast_refresh_minutes ?? 0;
    return m > 0 ? Math.max(5, m) : 0;
  }

  private _radarTileSize(): RadarTileSize {
    return pickRadarTileSize(this._map ? Math.max(this._map.getSize().x, this._map.getSize().y) : 600);
  }

  // Tile reuse policy for one frame's tiles: always shared/memoised, and
  // persisted only if the frame's content is already final (finalUpToMs)
  // when the layer is built — before any of its tiles are requested, so a
  // DWD run read from the run list was published before the server
  // answered them (see TileCachePolicy).
  private _tileCachePolicy(frame: RadarFrame): TileCachePolicy {
    if (frame.run !== undefined) return pinnedForecastPolicy(frame.time * 1000, frame.run * 1000);
    const source = this._cfg.data_source ?? 'RainViewer';
    const { pastMin, strideMin } = getEffectiveTimeRange(this._cfg);
    const finalUpTo = finalUpToMs(source, Date.now(), strideMin, this._dwdLatestRun);
    return { persistUntil: persistUntilFor(frame.time * 1000, finalUpTo, pastMin) };
  }

  private _isDwd(): boolean {
    return (this._cfg.data_source ?? 'RainViewer') === 'DWD';
  }

  // DWD with forecast frames in the loop: they're pinned to a run whenever
  // one is known, with forecast refresh on or off.
  private _dwdForecastActive(): boolean {
    return this._isDwd() && getEffectiveTimeRange(this._cfg).forecastMin > 0;
  }

  private _createLayer(frame: RadarFrame): FetchTileLayer | FetchWmsTileLayer {
    const dataSource = this._cfg.data_source ?? 'RainViewer';
    const { size: tileSize, zoomOffset } = this._radarTileSize();
    // Drive the spinner from each layer's load events, so pan/zoom edge
    // fetches on attached layers light it up too (not just frame status).
    // The same 'load' event drives the spinner AND the motion-comp
    // snapshot refresh. Leaflet fires it once a layer's visible tiles
    // are all decoded, which is exactly the right moment to read
    // pixels for the LK input. Per-layer rather than a debounced
    // global sweep, because a debounce timer can fire while ONE
    // late-loading layer is still decoding, leaving a partial
    // snapshot whose vector then drags the motion for that frame off
    // course — visible as a jittery patch midway through the loop.
    const wireSpinner = (l: FetchTileLayer | FetchWmsTileLayer): typeof l => {
      l.on('loading load', () => this._updateLoadingSpinner());
      l.on('load', () => this._onLayerLoaded(l));
      return l;
    };
    if (dataSource === 'NOAA') {
      const isoTime = new Date(frame.time * 1000).toISOString().split('.')[0] + 'Z';
      // Endpoint follows the mode _fetchPaths resolved: opengeo when the
      // frame listing worked (frame.time is then an exact listed scan
      // time), legacy eventdriven when it didn't (frame.time is a blind
      // grid slot the legacy server snaps internally).
      const url = this._noaaLegacyMode ? NOAA_LEGACY_WMS_URL : NOAA_OPENGEO_WMS_URL;
      const layer = this._noaaLegacyMode ? NOAA_LEGACY_WMS_LAYER : noaaOpengeoLayers();
      if (!this._noaaLegacyMode) this._noaaLayersBuilt = layer;
      return wireSpinner(new FetchWmsTileLayer(url, {
        layers: layer,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        TIME: isoTime,
        // NOAA WMS renders to whatever width/height we ask. Bigger tiles
        // mean fewer requests for the same coverage on large maps.
        tileSize,
        zoomOffset,
        minNativeZoom: this._pinnedNativeZoom,
        // Both endpoints serve ~1 km MRMS-derived mosaics but the
        // rendering is smooth past zoom 7 anyway; cap to keep the
        // upscaled appearance consistent with the legacy behaviour.
        maxNativeZoom: 7 + Math.max(0, -zoomOffset),
        rateLimiter: this._noaaLimiter,
        on429: () => this._onRateLimited(),
        on5xx: () => this._onServerError(),
        onTileRecovered: () => this._onTileRecovered(),
        ...(this._noaaLegacyMode ? {} : { onLayerNotDefined: (name: string) => this._onNoaaLayerMissing(name) }),
        animationOwnsOpacity: true,
        // Legacy slots are snapped server-side to the nearest published
        // frame, so a later frame can change what an old URL returns:
        // memory only, never persisted.
        tileCache: this._noaaLegacyMode ? {} : this._tileCachePolicy(frame),
        pane: RADAR_PANE_NAME,
      } as any));
    }
    if (dataSource === 'DWD') {
      const isoTime = new Date(frame.time * 1000).toISOString().split('.')[0] + 'Z';
      const layerName = this._dwdLayerName();
      return wireSpinner(new FetchWmsTileLayer(DWD_WMS_URL, {
        layers: layerName,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        TIME: isoTime,
        ...this._dwdRunParam(frame),
        // DWD's geoserver renders any size; bigger tiles cut request
        // count proportionally — see _radarTileSize() for the picker.
        tileSize,
        zoomOffset,
        minNativeZoom: this._pinnedNativeZoom,
        // DWD's 1 km grid supports zoom 8; bump for larger tiles.
        maxNativeZoom: 8 + Math.max(0, -zoomOffset),
        rateLimiter: this._dwdLimiter,
        on429: () => this._onRateLimited(),
        on5xx: () => this._onServerError(),
        onTileRecovered: () => this._onTileRecovered(),
        animationOwnsOpacity: true,
        // Low power: show DWD's tiles as drawn (its own grey wash and outline
        // in every frame) — the filter's per-tile canvas work dominated load
        // time on slow tablets. Snap transitions keep the wash from pulsing.
        ...(this._cfg.low_power_mode ? {} : { pixelFilter: makeDwdMaskFilter(layerName) }),
        tileCache: this._tileCachePolicy(frame),
        pane: RADAR_PANE_NAME,
      } as any));
    }
    const snow = this._cfg.show_snow ? 1 : 0;
    const host = frame.host ?? 'https://tilecache.rainviewer.com';
    // RainViewer encodes tile size as a path segment (256/512/1024/2048).
    // Build the URL with whichever size we picked for this map.
    return wireSpinner(new FetchTileLayer(`${host}${frame.path}/${tileSize}/{z}/{x}/{y}/2/1_${snow}.png`, {
      detectRetina: false,
      tileSize,
      zoomOffset,
      minNativeZoom: this._pinnedNativeZoom,
      // RainViewer publishes tiles up to native zoom 7 at 256px;
      // higher native zoom available with bigger tiles.
      maxNativeZoom: 7 + Math.max(0, -zoomOffset),
      rateLimiter: this._rainviewerLimiter,
      on429: () => this._onRateLimited(),
      on5xx: () => this._onServerError(),
      onTileRecovered: () => this._onTileRecovered(),
      animationOwnsOpacity: true,
      tileCache: this._tileCachePolicy(frame),
      pane: RADAR_PANE_NAME,
    } as any));
  }

  // Format date and time as separate parts. The bottom-row template
  // wraps each in its own span so a container query can hide the date
  // when the card is narrow (~< 398 px) and only the time stays
  // visible. Date stays on the browser's ambient locale (day/month
  // naming — not what was reported wrong). Time defers to HA's own
  // time_format setting (Settings > General) via custom-card-helpers'
  // formatTime, the same helper HA's own frontend uses — the browser's
  // ambient locale is an unreliable signal for 12h/24h specifically:
  // many users run an en-US browser/OS language regardless of where
  // they live, and even an explicit OS 24-hour override often isn't
  // honoured by Intl's locale resolution. Falls back to the previous
  // browser-locale behaviour when hass/locale isn't available.
  private _getTimeString(epochMs: number): { date: string; time: string } {
    const d = new Date(epochMs);
    const locale = this._hass?.locale;
    return {
      date: new Intl.DateTimeFormat(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
      }).format(d),
      time: locale
        ? formatTime(d, locale)
        : new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d),
    };
  }

  // ── Radar init ───────────────────────────────────────────────────────────

  // An init that ends with no frames (listing fetch failed, empty listing,
  // every frame failed) used to leave the card blank until a pan or a
  // reload: nothing was armed, and the visibility handler needs _radarReady.
  // A tablet booting before its Wi-Fi, or a source outage outlasting the
  // tile retries, sat on an empty map indefinitely. Backoff 30 s → 5 min;
  // a later successful init resets it.
  private _scheduleInitRetry(): void {
    if (this._initRetryTimer) clearTimeout(this._initRetryTimer);
    const gen = this._frameGeneration;
    // Counted per retry that fired, not per failed init: a card's setup can
    // run two inits in quick succession (a resize or move during start), and
    // counting both doubled the first real retry to 60 s.
    const delay = Math.min(30_000 * 2 ** this._initRetries, 5 * 60_000);
    this._initRetryTimer = setTimeout(() => {
      this._initRetryTimer = null;
      // A teardown or another init took over: that generation owns retries.
      if (gen !== this._frameGeneration || !this._map) return;
      if (this.viewPaused && this._cfg.preload_while_hidden !== true) {
        // Hidden: try again later rather than loading into an unseen card.
        this._scheduleInitRetry();
        return;
      }
      this._initRetries++;
      this._clearLayers();
      void this._initRadar();
    }, delay);
  }

  private async _initRadar(): Promise<void> {
    // Increment generation before the first await so any concurrently-running
    // _initRadar call (same-gen double-start) aborts at its next gen check.
    this._stopLoop();
    this._frameGeneration++;
    const myGen = this._frameGeneration;
    // Mark this init as in flight for onNavSettled's churn guard. The
    // generation-scoped clear in the finally means a superseded init
    // can't clear the flag out from under its successor.
    this._initFlightGen = myGen;
    try {
      await this._initRadarBody(myGen);
    } finally {
      if (this._initFlightGen === myGen) this._initFlightGen = -1;
    }
  }

  /** True while an _initRadar belonging to the CURRENT generation is loading. */
  private get _initInFlight(): boolean {
    return this._initFlightGen === this._frameGeneration && this._initFlightGen !== -1;
  }

  private async _initRadarBody(myGen: number): Promise<void> {
    this._loadedSlots = [];
    this._currentSlot = 0;

    // Make sure the dedicated radar pane exists and reflects the current
    // radar_opacity. Layer constructors below pass `pane: RADAR_PANE_NAME`
    // so each tile layer's container is appended into this pane.
    this._ensureRadarPane();

    // DWD's newest run decides which frames are final enough to persist
    // (_tileCachePolicy) and, with forecast refresh on, which to pin.
    const runPromise = this._isDwd() ? fetchLatestRun(this._dwdLayerName()) : Promise.resolve(null);
    let pastFrames: RadarFrame[];
    try {
      pastFrames = await this._fetchPaths();
    } catch {
      // Network/parse error (or aborted by a teardown: the gen check tells).
      if (myGen === this._frameGeneration) this._scheduleInitRetry();
      return;
    }
    if (myGen !== this._frameGeneration) return;
    if (pastFrames.length === 0) { this._scheduleInitRetry(); return; } // API returned no frames
    // Awaited before any layer exists, so every tile is requested after the
    // run it's judged against was published (_tileCachePolicy). Costs one
    // small round trip on DWD load; null on failure (15-min fallback).
    const run = await runPromise;
    if (myGen !== this._frameGeneration) return;
    if (run !== null) {
      this._dwdLatestRun = run;
      if (this._dwdForecastActive()) {
        // Pin forecast frames to one run from the start, refresh on or off:
        // every tile of a frame then comes from one run, the tiles can be
        // cached (pinnedForecastPolicy), and a refresh can tell whether
        // anything newer exists. A run used in the last 30 min is reused so
        // its cached tiles show at once; the newest replaces it once the
        // first load is done (_catchUpRun). Without a run frames load
        // unpinned and the first refresh pins them.
        const layerName = this._dwdLayerName();
        const startRun = chooseStartRun(run, recalledRun(layerName), Date.now(), FORECAST_REUSE_MAX_AGE_MS);
        pastFrames = pinToRun(pastFrames, startRun);
        rememberRun(layerName, startRun);
        this._catchUpRun = startRun < run ? run : null;
        this._lastForecastRefreshAt = Date.now();
      }
    } else if (this._forecastRefreshMin() > 0) {
      // No run: frames DWD may still answer with a forecast load unpinned and
      // marked, and the first refresh with a known run refetches them.
      const { strideMin } = getEffectiveTimeRange(this._cfg);
      pastFrames = markUnverified(pastFrames, finalUpToMs('DWD', Date.now(), strideMin, null));
    }
    this._radarPaths = pastFrames;
    this._lastFrameRefreshAt = Date.now();
    const frameCount = pastFrames.length;
    this._configFrameCount = frameCount;
    this._listedFrameCount = frameCount;
    this._computeNowFrameIndex();

    this._buildSegments();
    this._applyNowMarker();

    // Low power has no coverage layer: the outline is already in DWD's tiles.
    if (this._isDwd() && !this._cfg.low_power_mode) {
      this._refreshDwdMaskColors();
      // ONE shared coverage mask for the whole loop — the no-data
      // geometry is identical in every frame, so per-frame masks were
      // pure waste (at 12 h history: ~144 extra WMS layers ≈ ~900
      // redundant tile requests per init).
      this._ensureCoverageMask(pastFrames, this._dwdLayerName());
    }

    // Initialise motion-compensation state for the fresh set of
    // frames. _captureFrameSnapshot writes into these as each frame's
    // tile-settle completes below.
    this._frameSnapshot = new Array(frameCount).fill(null);
    this._frameSnapshotNz = new Array(frameCount).fill(0);
    this._frameMotion = new Array(frameCount).fill(null);

    // Collected snapshot promises so we can await all captures before
    // running _dedupFrames at the end of this init. The dedup needs
    // every snapshot's nz to be populated before it can identify
    // duplicate frames; without the await it would run while
    // half the captures are still in their decode-wait.
    const snapshotPromises: Promise<void>[] = [];

    let firstShown = false;

    // "Now" first, then forward through any forecast frames, then
    // backward through any past frames — see buildLoadOrder's doc-block.
    // For a past-only config this is exactly the old descending
    // frameCount-1..0 sequence (nowIndex is already frameCount-1 there).
    const order = buildLoadOrder(frameCount, this._nowFrameIndex);

    for (let idx = 0; idx < order.length; idx++) {
      const fi = order[idx];
      if (myGen !== this._frameGeneration || !this._map) return;

      this._setSegment(fi, 'loading');
      const layer = this._createLayer(this._radarPaths[fi]);
      this._radarImage[fi] = layer;
      this._radarTime[fi] = this._getTimeString(this._radarPaths[fi].time * 1000);
      layer.addTo(this._map);
      this._setLayerZ(layer, fi + 1);
      const el = (layer as any).getContainer?.() as HTMLElement | undefined;
      if (el) el.style.opacity = '0';

      const status = await layerSettled(layer);
      if (myGen !== this._frameGeneration) return;

      this._setSegment(fi, status);

      if (status === 'loaded') {
        const insertPos = insertSorted(this._loadedSlots, fi);

        // Motion-comp prep: snapshot this frame, then compute the motion
        // vector(s) we now have enough data for. _computeMotionForFrame
        // no-ops (sets null, doesn't compute garbage) when the adjacent
        // snapshot isn't captured yet, so this is safe regardless of
        // load order — and _onLayerLoaded's own 'load' listener (wired
        // in _createLayer before layerSettled's listener) independently
        // redoes the same computation as each layer settles, so this is
        // largely a fire-and-forget head start rather than the only path.
        //
        // Fire and forget: _captureFrameSnapshot awaits each tile's
        // decode() so we don't want to block this loop on it. The
        // motion computation chains off the snapshot completion via
        // .then() so it picks up fresh snapshot data, and a generation
        // guard in _computeMotionForFrame discards stale results if
        // _frameGeneration bumps mid-flight.
        if (this._cfg.motion_compensation) {
          const myGenInner = myGen;
          snapshotPromises.push(
            this._captureFrameSnapshot(fi).then(() => {
              if (myGenInner !== this._frameGeneration) return;
              this._computeMotionForFrame(fi);
              if (fi + 1 < this._frameSnapshot.length) {
                this._computeMotionForFrame(fi + 1);
              }
            }),
          );
        }

        if (!firstShown) {
          // Show the first-loaded frame ("now", per the load order
          // above) as a static preview before the loop starts. Layer
          // opacity is 1 — radar_opacity is carried by the radar pane
          // (see _ensureRadarPane). The shared coverage mask is already
          // visible (always on), so the preview has its coverage
          // overlay from the start.
          firstShown = true;
          if (el) el.style.opacity = '1';
          this._setTimestamp(fi);
          this._highlightSegment(fi);
          // Track this as the visible slot so _settleVisibility (called
          // from _stopLoop on every pan / zoom / hide) can restore the
          // correct layer's opacity. In static mode (frameCount = 1)
          // _startLoop is never called — it requires ≥ 2 loaded slots —
          // so _prev1Slot would otherwise stay at its initial -1 and
          // _settleVisibility would set the only visible layer to
          // opacity 0 on the first pan.
          this._prev1Slot = this._loadedSlots.indexOf(fi);
        }

        this._afterFrameInserted(insertPos);
      } else {
        const next = resumeIndexAfterFailure(order, idx);
        this._markRemainingFailed(order, idx + 1, next === -1 ? order.length : next);
        if (next === -1) break;
        idx = next - 1;   // the loop's increment lands on the first forecast frame
      }
    }

    if (myGen !== this._frameGeneration) return;

    // Wait for snapshot captures to finish, then dedup duplicate
    // frames out of the playback loop. Done at this point so the
    // user has been watching the un-deduped loop for a few seconds
    // already (the loop starts after 2 frames load) — the dedup
    // tightens the loop without making them wait for it on first
    // paint. _stopLoop bumps _loopGen so any in-flight tick whose
    // captured (delay, isLoopBack) state is stale after compaction
    // bails on its gen check; we restart immediately after dedup
    // **regardless of whether the dedup actually dropped any frames**
    // — _stopLoop killed the loop unconditionally, so we have to
    // restart unconditionally too. (Skipping the restart when no
    // duplicates were found leaves the loop dead, which manifests
    // for sources like RainViewer where the configured intervalMin
    // already matches the native cadence — no duplicates ever exist
    // to trigger the restart-on-dedup path.)
    if (this._cfg.motion_compensation && snapshotPromises.length > 0) {
      await Promise.all(snapshotPromises);
      if (myGen !== this._frameGeneration) return;
      const wasRunning = this.run && this._radarReady && this._loadedSlots.length >= 2;
      if (wasRunning) this._stopLoop();
      this._dedupFrames();
      if (wasRunning && this._loadedSlots.length >= 2) {
        this._startLoop(this._currentSlot);
      }
    }

    if (this._loadedSlots.length > 0) {
      this._initRetries = 0;
      this._radarReady = true;
      this._scheduleUpdate();
    } else {
      this._scheduleInitRetry();
    }

    // Started from a cached older run: move to the newest now the loop is
    // up, whatever the refresh setting. With refresh off the frames then
    // keep that run, as they would have without the cache.
    if (this._catchUpRun !== null) {
      const latest = this._catchUpRun;
      this._catchUpRun = null;
      this._lastForecastRefreshAt = 0;
      this._catchUpPending = this._refreshForecast(latest);
      this._refreshTimestamp();
    }
  }

  // Record a successfully-loaded frame's effect on playback bootstrap
  // state, once it's been inserted into _loadedSlots at `insertPos`
  // (see insertSorted). Frames no longer always load in strict
  // newest-to-oldest order (see buildLoadOrder), so a new frame can
  // land at any position, not just the front — inserting at `insertPos`
  // only shifts existing positions >= insertPos up by one.
  private _afterFrameInserted(insertPos: number): void {
    if (this._loadedSlots.length < 2) return;
    this._radarReady = true;
    // The insert above already happened, so length-1 is the count
    // before it — i.e. whether this is the 2nd frame ever (bootstrap
    // the loop) or a later one (shift the existing positions).
    const prevSlotCount = this._loadedSlots.length - 1;
    if (prevSlotCount >= 2) {
      if (insertPos <= this._currentSlot) this._currentSlot++;
      if (this._prev1Slot >= 0 && insertPos <= this._prev1Slot) this._prev1Slot++;
    } else {
      // First time reaching 2 loaded frames: show "now" and start the
      // loop. "now" is guaranteed already loaded here — it's always the
      // first frame attempted (see buildLoadOrder), and a failure on it
      // aborts the whole init immediately (see _markRemainingFailed's
      // caller) — so indexOf never misses. _startLoop sets _currentSlot,
      // calls _showSlot (which sets _prev1Slot), then _scheduleNext —
      // which returns immediately when !this.run, so this works for
      // both playing and paused (start_paused) states without a
      // separate branch.
      this._startLoop(this._loadedSlots.indexOf(this._nowFrameIndex));
    }
  }

  // Mark the frames of `order` from `fromIdx` up to (not including) `toIdx`
  // as failed: the ones the init loop skips after a failure (see
  // resumeIndexAfterFailure for which). `order` isn't a contiguous numeric
  // range once loading walks outward from "now" (see buildLoadOrder), so
  // this can't be a simple counting loop over frame indices.
  private _markRemainingFailed(order: number[], fromIdx: number, toIdx: number = order.length): void {
    for (let k = fromIdx; k < toIdx; k++) this._setSegment(order[k], 'failed');
  }

  // ── Periodic update ──────────────────────────────────────────────────────

  // Periodic-refresh cadence (ms). _updateRadar shifts in at most ONE
  // new frame per cycle, so the period must not exceed the source's
  // frame spacing or the loop silently degrades to refresh-period
  // spacing. Only NOAA's selectable 2-min stride goes below the 5-min
  // default (its opengeo listing publishes ~every 2 min); floor at 2 min
  // to stay polite to the capabilities endpoint, cap at 5 min so coarser
  // strides still refresh on the standard cadence. Shared by the
  // scheduler and the visibility-resume staleness check so both track
  // the same cadence (a 2-min NOAA loop must not be judged "fresh" for a
  // full 10 min after a tab-hide).
  private _refreshPeriodMs(): number {
    const isNoaa = (this._cfg.data_source ?? 'RainViewer') === 'NOAA';
    if (!isNoaa) return 300_000;
    const strideMs = getEffectiveTimeRange(this._cfg).strideMin * 60_000;
    return Math.max(120_000, Math.min(300_000, strideMs));
  }

  private _scheduleUpdate(): void {
    // Single-chain invariant: exactly one armed update timer at any
    // time. Several paths can arm a fresh chain while an old timer is
    // still pending (rate-limit retry → _initRadar → _scheduleUpdate;
    // sleep/wake → stale re-init → _scheduleUpdate), and without
    // cancellation each survivor kept firing — every parallel chain
    // doubled the refresh rate and, before the newness guard, the rate
    // of destructive duplicate-shifts too. Cancel-before-arm plus the
    // generation check below makes forking impossible.
    this._cancelScheduledUpdate?.();
    // _updateRadar shifts in at most ONE new frame per cycle, so the
    // refresh period must not exceed the frame spacing or the loop
    // silently degrades to refresh-period spacing.
    const isNoaa = (this._cfg.data_source ?? 'RainViewer') === 'NOAA';
    const framePeriod = this._refreshPeriodMs();
    // RainViewer publishes ~1 min after the timestamp; DWD ~1–3 min;
    // NOAA's newest listed frame is itself the publication signal.
    const lag = isNoaa ? 0 : 60_000;
    const genAtArm = this._frameGeneration;
    this._cancelScheduledUpdate = this._workerTimeout(() => {
      this._cancelScheduledUpdate = null;
      // A teardown / re-init happened after this timer was armed. The
      // re-init path arms its own chain; acting here would fork.
      if (genAtArm !== this._frameGeneration) return;
      // navPaused (mid pan/zoom gesture) always defers — unrelated to
      // hidden-card preloading. viewPaused defers too UNLESS
      // preload_while_hidden opts out of that: _updateRadar() re-arms
      // this chain at its own tail, so allowing it through here keeps
      // fetching on the normal cadence while hidden instead of going
      // silent after one no-op tick. It's still safe to call while
      // hidden — _showSlot/_startLoop only touch invisible DOM/opacity,
      // and _scheduleNext (inside _startLoop) independently refuses to
      // animate while viewPaused is true.
      const viewBlocksUpdate = this.viewPaused && this._cfg.preload_while_hidden !== true;
      if (this._radarReady && !this.navPaused && !viewBlocksUpdate) {
        this._updateRadar();
      } else {
        this._doRadarUpdate = true;
      }
    }, framePeriod + lag);
  }

  private async _updateRadar(): Promise<void> {
    if (!this._map) return;
    const myGen = this._frameGeneration;
    const runPromise = this._isDwd() ? fetchLatestRun(this._dwdLayerName()) : Promise.resolve(null);
    let pastFrames: RadarFrame[];
    try {
      pastFrames = await this._fetchPaths();
    } catch {
      // Torn down or re-inited while fetching: that generation arms its own
      // chain, and a timer armed here would outlive the player.
      if (myGen !== this._frameGeneration) return;
      this._scheduleUpdate(); // retry on next cycle
      return;
    }
    const latestRun = await runPromise;
    if (myGen !== this._frameGeneration) return; // torn down while fetching
    if (pastFrames.length === 0) { this._scheduleUpdate(); return; } // no frames from API
    // NOAA's listing is back after the loop took frames from the legacy
    // 10-min grid: rebuild at the configured stride. Shifting in the new
    // frames kept the 10-min frames until they aged out, and a loop that
    // started in fallback kept its frame count (a 60-min loop covered 12).
    // RainViewer: a skipped 10-min slot entering or leaving the window
    // changes how many frames it holds, which shifting (one in, one out)
    // can't follow. Rebuild — the tiles come from the cache.
    const rainViewerRecount = (this._cfg.data_source ?? 'RainViewer') === 'RainViewer'
      && this._listedFrameCount > 0 && pastFrames.length !== this._listedFrameCount;
    if ((!this._noaaLegacyMode && this._radarPaths.some((f) => f.legacy)) || rainViewerRecount) {
      this._doRadarUpdate = false;
      this._clearLayers();
      void this._initRadar();
      return;
    }
    // A failed fetch keeps the last known run: still a valid "final up to",
    // and still a valid pin. Never step back to an older run — a lagging
    // server node would otherwise re-pin observed frames to an old forecast.
    if (latestRun !== null) this._dwdLatestRun = Math.max(this._dwdLatestRun ?? latestRun, latestRun);
    const refreshing = this._forecastRefreshMin() > 0;
    const pinRun = this._dwdForecastActive() ? this._dwdLatestRun : null;
    const refreshRun = refreshing ? pinRun : null;
    if (pinRun !== null) {
      pastFrames = pinToRun(pastFrames, pinRun);
      rememberRun(this._dwdLayerName(), pinRun);
    } else if (refreshing) {
      pastFrames = markUnverified(pastFrames, finalUpToMs('DWD', Date.now(), getEffectiveTimeRange(this._cfg).strideMin, null));
    }

    // Newness guard: only shift the loop when the source actually
    // published a frame newer than what we hold. The refresh cycle
    // can be faster than the source's publication cadence (RainViewer
    // 10 min vs 6-min refresh; DWD's locally computed timestamps can
    // land on the same grid slot) — so roughly every other refresh
    // used to fetch the SAME newest frame, append it as a duplicate,
    // and destroy a real historical frame at slot 0. On a long-running
    // dashboard the loop monotonically filled with adjacent duplicate
    // pairs while its time span shrank. For RainViewer and NOAA the
    // timestamps come from the source's own frame listing
    // (weather-maps.json / opengeo GetCapabilities), so this
    // comparison is exactly "did the listing gain a new entry"; for
    // DWD the computed timestamps serve the same role.
    const currentNewestTime = this._radarPaths[this._radarPaths.length - 1]?.time ?? 0;
    // Every frame newer than the newest held, oldest first. DWD's frames come
    // from the clock on a 5-min grid while this runs every 6 min, so about
    // every fifth tick finds two; shifting in only the newest left a 10-min
    // gap that stayed for the whole window. Listed sources can publish two
    // between ticks as well.
    const newFrames = pastFrames.filter((f) => f.time > currentNewestTime);
    if (newFrames.length === 0) {
      // Nothing new published. The fetch itself succeeded, so the data
      // is verifiably current — bump the freshness clock so the
      // visibility-resume staleness heuristic doesn't trigger a full
      // re-init just because the source was slow to publish.
      this._lastFrameRefreshAt = Date.now();
      this._doRadarUpdate = false;
      if (refreshRun !== null) this._refreshForecast(refreshRun);
      // A paused card shows no new frame, but its age tag can change.
      this._refreshTimestamp();
      this._scheduleUpdate();
      return;
    }
    const frameCount = this._configFrameCount;

    // Stop the loop before renumbering frame indices below — otherwise an
    // already-armed animation tick can fire mid-shift against a
    // temporarily-shrunk _loadedSlots (frameCount -> frameCount-1 until
    // the new frame settles) using a now-stale _currentSlot, landing on
    // an arbitrary wrapped position instead of continuing smoothly.
    // _stopLoop's _settleVisibility runs first, against the still-valid
    // pre-shift state. _startLoop() below re-arms a fresh generation
    // once the new frame is ready.
    this._stopLoop();

    for (const frame of newFrames.slice(-frameCount)) this._shiftInFrame(frame, myGen);

    // After the shift, so the plan sees this tick's frame indices.
    if (refreshRun !== null) this._refreshForecast(refreshRun);
    this._doRadarUpdate = false;
    this._scheduleUpdate();
  }

  // Append one frame, dropping the oldest. Its tiles load in the background;
  // the loop restarts at the newest loaded frame once they arrive.
  private _shiftInFrame(frame: RadarFrame, myGen: number): void {
    if (!this._map) return;
    const frameCount = this._configFrameCount;
    const newLayer = this._createLayer(frame);
    newLayer.addTo(this._map);
    const newTime = this._getTimeString(frame.time * 1000);
    // The DWD coverage mask is a single shared layer — nothing to
    // create or shift on refresh; the no-data geometry doesn't change.

    this._radarImage[0]?.remove();
    // _loadedSlots holds raw frame indices; if frame 0 was loaded it's
    // about to be dropped below, and every position after it shifts down
    // by one — track that so _currentSlot/_prev1Slot keep pointing at
    // the same frame instead of going stale.
    const droppedOldest = this._loadedSlots[0] === 0;
    // _radarPaths shifts alongside the others because nearestFrameIndex() reads .time off it.
    for (let i = 0; i < frameCount - 1; i++) {
      this._radarImage[i] = this._radarImage[i + 1];
      this._radarTime[i] = this._radarTime[i + 1];
      this._radarPaths[i] = this._radarPaths[i + 1];
      this._frameStatuses[i] = this._frameStatuses[i + 1];
    }
    this._radarImage[frameCount - 1] = newLayer;
    this._radarTime[frameCount - 1] = newTime;
    this._radarPaths[frameCount - 1] = frame;
    this._lastFrameRefreshAt = Date.now();
    this._loadedSlots = this._loadedSlots.map(fi => fi - 1).filter(fi => fi >= 0);
    if (droppedOldest) {
      this._currentSlot = Math.max(0, this._currentSlot - 1);
      if (this._prev1Slot >= 0) this._prev1Slot = Math.max(0, this._prev1Slot - 1);
    }
    // Shift motion-compensation state alongside the radar frames.
    // The old frame 0 is dropped, so old motion[1] (which described
    // the 0→1 transition) is also dropped — its predecessor no
    // longer exists. All later motion vectors stay valid because the
    // pair they describe (old fi-1, old fi) survives intact as
    // (new fi-2, new fi-1).
    for (let i = 0; i < frameCount - 1; i++) {
      this._frameSnapshot[i] = this._frameSnapshot[i + 1] ?? null;
      this._frameSnapshotNz[i] = this._frameSnapshotNz[i + 1] ?? 0;
      this._frameMotion[i] = i === 0 ? null : (this._frameMotion[i + 1] ?? null);
    }
    this._frameSnapshot[frameCount - 1] = null;
    this._frameSnapshotNz[frameCount - 1] = 0;
    this._frameMotion[frameCount - 1] = null;
    this._computeNowFrameIndex();
    this._applyNowMarker();

    for (let i = 0; i < frameCount - 1; i++) this._paintSegment(i, i === this._lastHighlightFi);
    this._setSegment(frameCount - 1, 'loading');

    newLayer.once('load', () => {
      if (myGen !== this._frameGeneration) return; // torn down before tiles finished
      // A later shift in the same update may have moved it down a slot.
      const fi = this._radarImage.indexOf(newLayer);
      if (fi < 0) return;
      for (let i = 0; i < frameCount; i++) {
        const l = this._radarImage[i];
        if (l) this._setLayerZ(l, i + 1);
      }
      const newStatus: FrameStatus = newLayer._tileFailed > 0 ? 'failed' : 'loaded';
      this._setSegment(fi, newStatus);
      if (newStatus === 'loaded') {
        insertSorted(this._loadedSlots, fi);
        // Snapshot the freshly loaded newest frame so its transition
        // into view picks up motion compensation from the previous
        // frame. _onLayerLoaded would handle this too on the next
        // 'load' fire, but doing it here makes the very first
        // post-refresh transition compensated rather than waiting
        // a tile-cycle. Fire-and-forget — see the equivalent
        // call in _initRadar for the gen-guard rationale.
        if (this._cfg.motion_compensation) {
          const myGenInner = myGen;
          void this._captureFrameSnapshot(fi).then(() => {
            if (myGenInner !== this._frameGeneration) return;
            this._computeMotionForFrame(fi);
          });
        }
      }
      // Restart loop at newest frame so new data shows immediately.
      // Guarded on length: if the newest frame has now failed to load
      // for enough consecutive refresh cycles that _loadedSlots (which
      // drops one frame every cycle regardless, via droppedOldest above)
      // has drained to empty, there's nothing to show — leave state as
      // is and let the next successful refresh repopulate it, rather
      // than setting _currentSlot to -1.
      if (this._loadedSlots.length > 0) {
        this._currentSlot = this._loadedSlots.length - 1;
        this._startLoop();
      }
    });
  }

  // Refetch frames per planForecastRefresh: forecast frames pinned to the
  // newer run, and frames the run now covers as observed radar (unpinned).
  // Replacements load hidden alongside the loop and swap in via
  // _swapStagedFrames once loaded; a replacement that fails keeps the old
  // frame rather than showing holes.
  private _refreshForecast(latestRun: number): boolean {
    if (!this._map || this._forecastLoading.length > 0) return false;
    const plan = planForecastRefresh(
      this._radarPaths, latestRun, this._lastForecastRefreshAt, this._forecastRefreshMin(), Date.now(),
    );
    if (plan.forecast.length > 0) {
      this._lastForecastRefreshAt = Date.now();
      rememberRun(this._dwdLayerName(), latestRun);
    }
    const jobs: RadarFrame[] = [];
    for (const f of this._radarPaths) {
      if (plan.observed.includes(f.time)) jobs.push({ ...f, run: undefined, unverified: undefined });
      else if (plan.forecast.includes(f.time)) jobs.push({ ...f, run: latestRun, unverified: undefined });
    }
    if (jobs.length === 0) return false;
    const gen = this._frameGeneration;
    const staged = jobs.map((frame) => {
      const layer = this._createLayer(frame) as FetchWmsTileLayer;
      layer.addTo(this._map!);
      const el = (layer as any).getContainer?.() as HTMLElement | undefined;
      if (el) el.style.opacity = '0';
      return { frame, layer };
    });
    this._forecastLoading = staged.map((s) => s.layer);
    void Promise.all(staged.map((s) => layerSettled(s.layer))).then((statuses) => {
      if (gen !== this._frameGeneration) {
        staged.forEach((s) => s.layer.remove());
        return;
      }
      this._forecastLoading = [];
      staged.forEach((s, i) => {
        if (statuses[i] !== 'loaded') { s.layer.remove(); return; }
        this._stagedForecast.get(s.frame.time)?.layer.remove();
        this._stagedForecast.set(s.frame.time, s);
      });
      this._swapStagedFrames();
    });
    return true;
  }

  // Put loaded replacements in place of their frames' layers, taking over
  // the old container's z-index and opacity so the swap is invisible. Frames
  // on screen or mid-fade wait for a later tick (called from _showSlot).
  // holdBusy: true right after a fade starts, false once visibility is
  // settled, undefined to infer it from whether the loop is running.
  private _swapStagedFrames(currentSlot = this._currentSlot, holdBusy?: boolean): void {
    if (this._stagedForecast.size === 0) { this._endCatchUpIfDone(); return; }
    const indexOf = new Map<number, number>();
    for (const time of this._stagedForecast.keys()) {
      const fi = this._radarPaths.findIndex((f) => f.time === time);
      if (fi < 0) {
        // Slid out of the window while loading.
        this._stagedForecast.get(time)?.layer.remove();
        this._stagedForecast.delete(time);
      } else {
        indexOf.set(fi, time);
      }
    }
    const hold = holdBusy ?? (this.run && !this.navPaused && !this.viewPaused && this._loadedSlots.length >= 2);
    for (const fi of swappableFrames([...indexOf.keys()], this._loadedSlots, currentSlot, hold)) {
      const time = indexOf.get(fi)!;
      const staged = this._stagedForecast.get(time)!;
      this._stagedForecast.delete(time);
      const old = this._radarImage[fi];
      const oldEl = (old as any)?.getContainer?.() as HTMLElement | undefined;
      const newEl = (staged.layer as any).getContainer?.() as HTMLElement | undefined;
      if (newEl) {
        newEl.style.transition = 'none';
        newEl.style.zIndex = oldEl?.style.zIndex ?? '';
        newEl.style.transform = oldEl?.style.transform ?? '';
        newEl.style.opacity = oldEl?.style.opacity ?? '0';
      }
      this._radarImage[fi] = staged.layer;
      this._radarPaths[fi] = staged.frame;
      old?.remove();
      // The frame failed to load before, so it was never in the loop; its
      // replacement loaded, so let it play.
      if (!this._loadedSlots.includes(fi)) {
        this._afterFrameInserted(insertSorted(this._loadedSlots, fi));
        this._setSegment(fi, 'loaded');
      }
      // The frame's pixels changed: drop its snapshot and the motion vectors
      // into and out of it, then rebuild them from the new tiles.
      this._frameSnapshot[fi] = null;
      this._frameSnapshotNz[fi] = 0;
      this._frameMotion[fi] = null;
      if (fi + 1 < this._frameMotion.length) this._frameMotion[fi + 1] = null;
      void this._onLayerLoaded(staged.layer);
    }
    this._endCatchUpIfDone();
  }

  // The catch-up is over once nothing is loading or waiting to swap —
  // including when every replacement failed and the cached frames stay.
  private _endCatchUpIfDone(): void {
    if (!this._catchUpPending || this._stagedForecast.size > 0 || this._forecastLoading.length > 0) return;
    this._catchUpPending = false;
    this._refreshTimestamp();
  }

  // ── Web worker timer ─────────────────────────────────────────────────────

  private _startWorker(): void {
    const code = `
      var t={};
      self.onmessage=function(e){
        if(e.data.type==='setTimeout'){
          t[e.data.id]=setTimeout(function(){delete t[e.data.id];self.postMessage({type:'timeout',id:e.data.id});},e.data.delay);
        } else if(e.data.type==='clearTimeout'){
          clearTimeout(t[e.data.id]);delete t[e.data.id];
        }
      };
    `;
    // Guarded like createLkWorker in lk-worker.ts: strict CSPs block
    // blob: workers, and an unguarded throw here aborts the
    // RadarPlayer constructor mid-_initMap, killing the whole card.
    // On failure _worker stays null and _workerTimeout's setTimeout
    // fallback takes over — timers then throttle in hidden tabs, but
    // the stale-resume re-init covers that case.
    try {
      this._workerBlobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
      this._worker = new Worker(this._workerBlobUrl);
      this._worker.onmessage = (e) => {
        const cb = this._workerCallbacks.get(e.data.id);
        if (cb) { this._workerCallbacks.delete(e.data.id); cb(); }
      };
    } catch {
      if (this._workerBlobUrl) { URL.revokeObjectURL(this._workerBlobUrl); this._workerBlobUrl = null; }
      this._worker = null;
    }
  }

  /**
   * Arm a timer (worker-side when available so it keeps ticking in
   * throttled background tabs; setTimeout fallback otherwise). Returns
   * a cancel function — both paths support cancellation so callers can
   * maintain a single-armed-timer invariant.
   */
  private _workerTimeout(cb: () => void, delay: number): () => void {
    if (!this._worker) {
      const handle = setTimeout(cb, delay);
      return () => clearTimeout(handle);
    }
    const id = this._workerNextId++;
    this._workerCallbacks.set(id, cb);
    this._worker.postMessage({ type: 'setTimeout', id, delay });
    return () => {
      this._workerCallbacks.delete(id);
      this._worker?.postMessage({ type: 'clearTimeout', id });
    };
  }
}
