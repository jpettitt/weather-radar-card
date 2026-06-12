/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { WeatherRadarCardConfig } from './types';
import { Z_RADAR_BASE } from './const';
import { RateLimiter } from './rate-limiter';
import { FetchTileLayer, FetchWmsTileLayer, layerSettled } from './fetch-tile-layer';
import { RadarToolbar } from './radar-toolbar';
import { localize } from './localize/localize';
import { getEffectiveTimeRange } from './source-caps';
import {
  fetchNoaaFrameTimes, pickFrameTimes, NOAA_OPENGEO_WMS_URL, NOAA_OPENGEO_LAYER,
} from './noaa-frame-list';
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

// ── Types ────────────────────────────────────────────────────────────────────

export type FrameStatus = 'empty' | 'loading' | 'loaded' | 'failed';
export interface RadarFrame { time: number; path: string; host?: string; }

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
// refuses browser metadata requests, so its frames are computed on a
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
  if (r === g && g === b) return 'grey';
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
  private _radarPaneCreated = false;
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
      for (const layer of this._radarImage) {
        if (layer) (layer.options as any).minNativeZoom = newPin;
      }
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
    this._currentSlot = newCurrent >= 0 ? newCurrent : (keptFi.length - 1);
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

  private get _cfg(): WeatherRadarCardConfig { return this._getConfig(); }
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

    // _scheduleUpdate's timer keeps running through the pause; if it fired
    // while navPaused was true it set _doRadarUpdate. Pick that up now;
    // _updateRadar restarts the loop from its load callback.
    if (this._doRadarUpdate) {
      this._doRadarUpdate = false;
      void this._updateRadar();
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
    // Heuristic: if more than 2× the refresh period (= 10 min) has
    // elapsed since the last successful path-fetch, scrap the loop
    // entirely and let _initRadar refetch every slot from scratch.
    // Shorter gaps fall through to the existing _doRadarUpdate-driven
    // single-frame path (or just a loop resume).
    const FRAME_PERIOD_MS = 300_000;
    const STALE_THRESHOLD_MS = 2 * FRAME_PERIOD_MS;
    const ageMs = this._lastFrameRefreshAt > 0
      ? Date.now() - this._lastFrameRefreshAt
      : 0;
    if (this._radarReady && ageMs > STALE_THRESHOLD_MS) {
      this._doRadarUpdate = false;
      this._clearLayers();
      void this._initRadar();
      return;
    }
    if (this._doRadarUpdate && this._radarReady) {
      this._doRadarUpdate = false;
      this._updateRadar();
    } else if (this.run && this._radarReady) {
      this._startLoop();
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
    const delay = this._currentSlot === n - 1
      ? this._timeout + this._restartDelay
      : this._timeout;
    const isLoopBack = this._currentSlot === n - 1;
    setTimeout(() => {
      if (gen !== this._loopGen) return;
      this._currentSlot = (this._currentSlot + 1) % this._loadedSlots.length;
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
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
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
      seg.style.cssText = `flex:1;height:100%;background-color:${this._segColor('empty', false)}`;
      track.appendChild(seg);
      this._segEls.push(seg);
    }
    this._updateLoadingSpinner();
  }

  private _segColor(status: FrameStatus, isCurrent: boolean): string {
    const cfg = this._cfg;
    const mapStyle = cfg.map_style?.toLowerCase() ?? '';
    const dark = mapStyle === 'dark' || mapStyle === 'satellite';
    const map = dark
      ? { empty: '#444', loading: '#aa7700', loaded: 'steelblue', failed: '#aa1111',
          cur_empty: '#666', cur_loading: '#cc9900', cur_loaded: '#6baed6', cur_failed: '#cc3333' }
      : { empty: '#e0e0e0', loading: '#ffcc00', loaded: '#ccf2ff', failed: '#ff4444',
          cur_empty: '#c0c0c0', cur_loading: '#ffe566', cur_loaded: '#66d9ff', cur_failed: '#ff8888' };
    return isCurrent ? ((map as any)[`cur_${status}`] ?? map.cur_empty) : ((map as any)[status] ?? map.empty);
  }

  private _setSegment(fi: number, status: FrameStatus): void {
    this._frameStatuses[fi] = status;
    const seg = this._segEls[fi];
    if (seg) seg.style.backgroundColor = this._segColor(status, fi === this._lastHighlightFi);
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
      seg.style.boxShadow = isNow ? 'inset 0 2px 0 0 var(--warning-color, #ff9800)' : '';
    };
    if (this._lastNowMarkerIndex >= 0) apply(this._lastNowMarkerIndex, false);
    if (this._nowFrameIndex >= 0) apply(this._nowFrameIndex, true);
    this._lastNowMarkerIndex = this._nowFrameIndex;
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
  private _setTimestamp(fi: number): void {
    const ts = this._shadowRoot.getElementById('timestamp');
    if (!ts) return;
    ts.textContent = '';  // wipe previous render
    const t = this._radarTime[fi];
    if (!t) return;
    const dateSpan = document.createElement('span');
    dateSpan.className = 'ts-date';
    dateSpan.textContent = `${t.date} `;
    ts.appendChild(dateSpan);
    const timeSpan = document.createElement('span');
    timeSpan.className = 'ts-time';
    timeSpan.textContent = t.time;
    ts.appendChild(timeSpan);
    if (fi === this._nowFrameIndex) {
      const nowSpan = document.createElement('span');
      nowSpan.className = 'ts-now';
      nowSpan.textContent = ` ${localize('ui.now')}`;
      ts.appendChild(nowSpan);
    }
  }

  private _highlightSegment(fi: number): void {
    // Repaint only the segment losing the highlight and the one gaining
    // it — this runs every tick, and segment STATUS changes repaint
    // through _setSegment independently.
    if (fi === this._lastHighlightFi) return;
    const paint = (j: number, isCurrent: boolean): void => {
      const seg = this._segEls[j];
      if (seg) seg.style.backgroundColor = this._segColor(this._frameStatuses[j] ?? 'empty', isCurrent);
    };
    if (this._lastHighlightFi >= 0) paint(this._lastHighlightFi, false);
    paint(fi, true);
    this._lastHighlightFi = fi;
  }

  // ── Rate limit banner ────────────────────────────────────────────────────

  private _showRateLimitBanner(show: boolean): void {
    const banner = this._shadowRoot.getElementById('rate-limit-banner');
    if (banner) banner.style.display = show ? 'block' : 'none';
  }

  private _onRateLimited(): void {
    if (this._isRateLimited) return;
    this._isRateLimited = true;
    this._showRateLimitBanner(true);
    if (this._rateLimitTimer) clearTimeout(this._rateLimitTimer);
    this._rateLimitTimer = setTimeout(() => this._retryAfterRateLimit(), 10_000);
  }

  private _retryAfterRateLimit(): void {
    this._isRateLimited = false;
    this._rateLimitTimer = null;
    this._clearLayers();
    this._initRadar();
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
  }

  // Resolve the DWD WMS layer the player is currently using. Niederschlagsradar
  // (the default) is past-only; when the user requests forecast hours, switch
  // to the analysis+nowcast layer which carries +2h frames too.
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
      this._radarPaneCreated = true;
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
    return new FetchWmsTileLayer(DWD_WMS_URL, {
      layers: layerName,
      format: 'image/png',
      transparent: true,
      version: '1.3.0',
      TIME: isoTime,
      tileSize,
      zoomOffset,
      maxNativeZoom: 8 + Math.max(0, -zoomOffset),
      rateLimiter: this._dwdLimiter,
      on429: () => this._onRateLimited(),
      animationOwnsOpacity: true,
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
    const pastFrames = frames.filter((f) => f.time <= nowSec);
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
        const listed = await fetchNoaaFrameTimes(this._pathsAbortCtrl.signal);
        const times = pickFrameTimes(listed, range.pastMin, range.strideMin);
        if (times.length > 0) {
          this._noaaLegacyMode = false;
          return times.map((t) => ({ time: t, path: '' }));
        }
      } catch (e) {
        if ((e as Error)?.name === 'AbortError') throw e;
        // fall through to the legacy grid below
      }
      // Fallback: legacy eventdriven server with a blind 10-min grid
      // behind its measured 15-min availability lag. Stale but correct;
      // recovers automatically — the next refresh cycle retries the
      // listing. The fixed legacy stride deliberately ignores the
      // user's stride choice: the legacy server snaps finer requests
      // to duplicates of the same physical frame.
      // eslint-disable-next-line no-console
      console.warn('[weather-radar-card] NOAA frame listing unavailable; falling back to legacy eventdriven grid');
      this._noaaLegacyMode = true;
      const legacyStrideMs = NOAA_LEGACY_STRIDE_MIN * 60_000;
      const snap = Math.trunc((Date.now() - NOAA_LEGACY_LAG_MS) / legacyStrideMs) * legacyStrideMs;
      const legacyCount = Math.max(1, Math.floor(range.pastMin / NOAA_LEGACY_STRIDE_MIN) + 1);
      const frames: RadarFrame[] = [];
      for (let i = legacyCount - 1; i >= 0; i--) {
        frames.push({ time: (snap - i * legacyStrideMs) / 1000, path: '' });
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
    // RainViewer returns at most 13 past frames at fixed 10-min spacing.
    // Take the last `frameCount` — already capped by getEffectiveTimeRange
    // against maxPastMin (120 min = 12 native frames + the "now" frame).
    // Stride > 10 min (an unusual YAML override) is honoured by skipping
    // intermediate frames in the slice.
    const stridedFrames = strideMs > 10 * 60_000
      ? past.filter((_, i) => (past.length - 1 - i) % Math.round(strideMs / (10 * 60_000)) === 0)
      : past;
    return stridedFrames.slice(-Math.min(frameCount, 13));
  }

  // Pick the tile size that fits the map best. Aim for ~6 tiles across
  // the larger map dimension — fewer requests when the map is large
  // (panel view, fullscreen), regular 512 for typical card-sized maps.
  // Quantised to powers of 2 because all three radar sources speak the
  // size as { 256, 512, 1024, 2048 }: RainViewer encodes it in the URL
  // path, NOAA/DWD WMS render server-side to whatever width/height we
  // pass. zoomOffset compensates so the on-screen scale stays constant.
  private _radarTileSize(): { size: 256 | 512 | 1024 | 2048; zoomOffset: number } {
    const px = this._map ? Math.max(this._map.getSize().x, this._map.getSize().y) : 600;
    if (px > 2400) return { size: 2048, zoomOffset: -3 };
    if (px > 1200) return { size: 1024, zoomOffset: -2 };
    if (px > 600)  return { size: 512,  zoomOffset: -1 };
    return                { size: 256,  zoomOffset:  0 };
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
      const layer = this._noaaLegacyMode ? NOAA_LEGACY_WMS_LAYER : NOAA_OPENGEO_LAYER;
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
        animationOwnsOpacity: true,
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
        // DWD's geoserver renders any size; bigger tiles cut request
        // count proportionally — see _radarTileSize() for the picker.
        tileSize,
        zoomOffset,
        minNativeZoom: this._pinnedNativeZoom,
        // DWD's 1 km grid supports zoom 8; bump for larger tiles.
        maxNativeZoom: 8 + Math.max(0, -zoomOffset),
        rateLimiter: this._dwdLimiter,
        on429: () => this._onRateLimited(),
        animationOwnsOpacity: true,
        pixelFilter: makeDwdMaskFilter(layerName),
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
      animationOwnsOpacity: true,
      pane: RADAR_PANE_NAME,
    } as any));
  }

  // Format date and time as separate parts. The bottom-row template
  // wraps each in its own span so a container query can hide the date
  // when the card is narrow (~< 398 px) and only the time stays
  // visible. Uses the user's browser locale via Intl.DateTimeFormat.
  private _getTimeString(epochMs: number): { date: string; time: string } {
    const d = new Date(epochMs);
    return {
      date: new Intl.DateTimeFormat(undefined, {
        weekday: 'short', day: 'numeric', month: 'short',
      }).format(d),
      time: new Intl.DateTimeFormat(undefined, {
        hour: 'numeric', minute: '2-digit',
      }).format(d),
    };
  }

  // ── Radar init ───────────────────────────────────────────────────────────

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

    let pastFrames: RadarFrame[];
    try {
      pastFrames = await this._fetchPaths();
    } catch {
      return; // network/parse error — card stays blank until next nav or reload
    }
    if (myGen !== this._frameGeneration) return;
    if (pastFrames.length === 0) return; // API returned no frames
    this._radarPaths = pastFrames;
    this._lastFrameRefreshAt = Date.now();
    const frameCount = pastFrames.length;
    this._configFrameCount = frameCount;
    this._computeNowFrameIndex();

    this._buildSegments();
    this._applyNowMarker();

    const dwdActive = (this._cfg.data_source ?? 'RainViewer') === 'DWD';
    const dwdLayerName = dwdActive ? this._dwdLayerName() : '';
    if (dwdActive) {
      this._refreshDwdMaskColors();
      // ONE shared coverage mask for the whole loop — the no-data
      // geometry is identical in every frame, so per-frame masks were
      // pure waste (at 12 h history: ~144 extra WMS layers ≈ ~900
      // redundant tile requests per init).
      this._ensureCoverageMask(pastFrames, dwdLayerName);
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

    let newestShown = false;

    for (let fi = frameCount - 1; fi >= 0; fi--) {
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
        const prevSlotCount = this._loadedSlots.length;
        this._loadedSlots.unshift(fi);

        // Motion-comp prep: snapshot this frame, then compute the
        // motion vector(s) we now have enough data for. Frames load
        // newest first, so after fi snapshots we may be able to
        // compute motion FROM fi INTO fi+1 (snapshotted last
        // iteration). motion[fi] itself needs fi-1, which arrives
        // next iteration.
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

        if (!newestShown) {
          // Show newest frame as a static preview before the loop starts.
          // Layer opacity is 1 — radar_opacity is carried by the radar
          // pane (see _ensureRadarPane). The shared coverage mask is
          // already visible (always on), so the preview has its
          // coverage overlay from the start.
          newestShown = true;
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

        if (this._loadedSlots.length >= 2) {
          this._radarReady = true;
          if (prevSlotCount >= 2) {
            // A new older frame was prepended; shift _currentSlot to keep the
            // same frame (newest) showing — the running timer continues unaffected.
            this._currentSlot++;
            // _prev1Slot is also an index into _loadedSlots, and that array
            // just grew at the front, so the previously shown slot is now
            // one step up. Without this shift the next _showSlot tries to
            // fade out the wrong layer (the freshly loaded one, already at
            // 0) and the previously visible frame stays orphaned at active
            // opacity until the loop wraps to slot 0, where snap mode
            // resets every other layer. That's the ghost trail of stacked
            // frames visible while later frames are still loading.
            if (this._prev1Slot >= 0) this._prev1Slot++;
          } else {
            // Two frames ready: start the loop at the newest slot.
            this._startLoop(this._loadedSlots.length - 1);
          }
        }
      } else {
        for (let j = fi - 1; j >= 0; j--) this._setSegment(j, 'failed');
        break;
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
      this._radarReady = true;
      this._scheduleUpdate();
    }
  }

  // ── Periodic update ──────────────────────────────────────────────────────

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
    // silently degrades to refresh-period spacing. Only NOAA's 2-min
    // stride goes below the 5-min default (its opengeo listing
    // publishes ~every 2 min); floor at 2 min to stay polite to the
    // capabilities endpoint.
    const isNoaa = (this._cfg.data_source ?? 'RainViewer') === 'NOAA';
    const strideMs = getEffectiveTimeRange(this._cfg).strideMin * 60_000;
    const framePeriod = isNoaa ? Math.max(120_000, Math.min(300_000, strideMs)) : 300_000;
    // RainViewer publishes ~1 min after the timestamp; DWD ~1–3 min;
    // NOAA's newest listed frame is itself the publication signal.
    const lag = isNoaa ? 0 : 60_000;
    const genAtArm = this._frameGeneration;
    this._cancelScheduledUpdate = this._workerTimeout(() => {
      this._cancelScheduledUpdate = null;
      // A teardown / re-init happened after this timer was armed. The
      // re-init path arms its own chain; acting here would fork.
      if (genAtArm !== this._frameGeneration) return;
      if (this._radarReady && !this.navPaused && !this.viewPaused) {
        this._updateRadar();
      } else {
        this._doRadarUpdate = true;
      }
    }, framePeriod + lag);
  }

  private async _updateRadar(): Promise<void> {
    if (!this._map) return;
    const myGen = this._frameGeneration;
    let pastFrames: RadarFrame[];
    try {
      pastFrames = await this._fetchPaths();
    } catch {
      this._scheduleUpdate(); // retry on next cycle
      return;
    }
    if (myGen !== this._frameGeneration) return; // torn down while fetching
    if (pastFrames.length === 0) { this._scheduleUpdate(); return; } // no frames from API

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
    const latestFrame = pastFrames[pastFrames.length - 1];
    if (latestFrame.time <= currentNewestTime) {
      // Nothing new published. The fetch itself succeeded, so the data
      // is verifiably current — bump the freshness clock so the
      // visibility-resume staleness heuristic doesn't trigger a full
      // re-init just because the source was slow to publish.
      this._lastFrameRefreshAt = Date.now();
      this._doRadarUpdate = false;
      this._scheduleUpdate();
      return;
    }
    const frameCount = this._configFrameCount;

    const newLayer = this._createLayer(latestFrame);
    newLayer.addTo(this._map);
    const newTime = this._getTimeString(latestFrame.time * 1000);
    // The DWD coverage mask is a single shared layer — nothing to
    // create or shift on refresh; the no-data geometry doesn't change.

    this._radarImage[0]?.remove();
    // _radarPaths shifts alongside the others because nearestFrameIndex() reads .time off it.
    for (let i = 0; i < frameCount - 1; i++) {
      this._radarImage[i] = this._radarImage[i + 1];
      this._radarTime[i] = this._radarTime[i + 1];
      this._radarPaths[i] = this._radarPaths[i + 1];
      this._frameStatuses[i] = this._frameStatuses[i + 1];
    }
    this._radarImage[frameCount - 1] = newLayer;
    this._radarTime[frameCount - 1] = newTime;
    this._radarPaths[frameCount - 1] = latestFrame;
    this._lastFrameRefreshAt = Date.now();
    this._loadedSlots = this._loadedSlots.map(fi => fi - 1).filter(fi => fi >= 0);
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

    for (let i = 0; i < frameCount - 1; i++) {
      const seg = this._shadowRoot.getElementById(`seg-${i}`);
      if (seg) seg.style.backgroundColor = this._segColor(this._frameStatuses[i] ?? 'empty', false);
    }
    this._setSegment(frameCount - 1, 'loading');

    newLayer.once('load', () => {
      if (myGen !== this._frameGeneration) return; // torn down before tiles finished
      for (let i = 0; i < frameCount; i++) {
        const l = this._radarImage[i];
        if (l) this._setLayerZ(l, i + 1);
      }
      const newStatus: FrameStatus = newLayer._tileFailed > 0 ? 'failed' : 'loaded';
      this._setSegment(frameCount - 1, newStatus);
      if (newStatus === 'loaded') {
        this._loadedSlots.push(frameCount - 1);
        // Snapshot the freshly loaded newest frame so its transition
        // into view picks up motion compensation from the previous
        // frame. _onLayerLoaded would handle this too on the next
        // 'load' fire, but doing it here makes the very first
        // post-refresh transition compensated rather than waiting
        // a tile-cycle. Fire-and-forget — see the equivalent
        // call in _initRadar for the gen-guard rationale.
        if (this._cfg.motion_compensation) {
          const myGenInner = myGen;
          void this._captureFrameSnapshot(frameCount - 1).then(() => {
            if (myGenInner !== this._frameGeneration) return;
            this._computeMotionForFrame(frameCount - 1);
          });
        }
      }
      // Restart loop at newest frame so new data shows immediately
      this._currentSlot = this._loadedSlots.length - 1;
      this._startLoop();
    });

    this._doRadarUpdate = false;
    this._scheduleUpdate();
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
