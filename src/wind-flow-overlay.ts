// Animated wind streamlines (à la earth.nullschool.net / DWD WarnWetter app).
// Spawns N particles, advances each one along the local wind vector each frame,
// trails them on a Canvas2D layer with alpha-fade. Density of trails ends up
// reflecting wind speed because faster cells carry particles further per frame.
//
// Why Canvas2D and not WebGL? At 1500 particles in a 500×500 card the math is
// trivial and Canvas2D `stroke()` is plenty fast (~5ms/frame on integrated
// graphics). WebGL would only matter at 50k+ particles, full-screen.
import * as L from 'leaflet';
import { windGridFetcher, sampleWindGridBilinear, type WindGrid } from './wind-grid-fetcher';

const ICON_GRID_DEG = 0.25;
// No cell cap here — the fetcher's adaptive WCS Scaling downsamples
// large bboxes server-side instead of skipping. Continental and global
// views come back at a coarser grid; smaller bboxes get native resolution.
// Particle population is tuned per-area so dense viewports don't starve and tiny
// ones don't render too many. ~1 particle per 220 px² ≈ 1500 particles at 500×600.
const PARTICLE_DENSITY = 1 / 220;
const PARTICLE_CAP = 3500;
// Target streak length in pixels — tuned per refresh so the visible ribbon
// stays roughly constant across zoom levels even though the particle's
// pixel speed varies with zoom. Without this compensation, low-zoom streaks
// shrink to a few pixels and fail to show up against the basemap.
const TARGET_STREAK_PX = 40;
// Frame-rate throttle. requestAnimationFrame normally fires at the
// display rate (typically 60 Hz); we cap actual draws to 15 Hz so per-
// second CPU load drops ~4× and the trail buffer represents more
// wall-clock time. Particle motion is scaled per actual elapsed-ms so
// wall-clock head speed stays consistent with the 30 fps calibration
// the per-frame `pxPerMpsPerFrame` constants were originally tuned
// against — at 15 fps each frame represents twice the wall-clock motion,
// so visible streak length doubles too.
const TARGET_FPS = 15;
const TARGET_FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const MOTION_REFERENCE_FRAME_MS = 1000 / 30; // pxPerMpsPerFrame was calibrated for ~30 fps
// Calibration wind for the streak-length math. Real winds vary; this is the
// "typical" speed used to set particle lifetime. Faster winds make slightly
// longer streaks, calmer winds shorter — that's a feature.
const TYPICAL_MPS_FOR_STREAK = 5;
// Bounds: particle lifetime in frames. Floor keeps streaks visible at
// extreme zooms; ceiling keeps trails from accumulating into a smudge
// when particles barely move.
const MIN_PARTICLE_LIFETIME_FRAMES = 30;
// Cap on particle lifetime in frames. After this many frames a particle
// respawns at a new random position. With the explicit-trail rendering
// model the lifetime mostly governs how often particles "rotate"
// through the viewport — the trail itself is bounded by TRAIL_LENGTH.
const MAX_PARTICLE_LIFETIME_FRAMES = 120;
// Number of frames at the end of a particle's life over which its
// trail's alpha decreases from full to zero. At 15 fps target this is
// ~1 sec of soft fade-out. Implemented as a per-particle alpha
// multiplier in the draw pass — no separate "dying" state machine.
// The particle keeps moving during the fade.
const FADE_OUT_FRAMES = 15;
// Number of past positions to retain per particle in a ring buffer.
// Defines the visible trail length: streak_px = TRAIL_LENGTH × velocity_px_per_frame
// Each frame we redraw all trails from scratch (no canvas accumulation),
// so when a particle dies its trail vanishes instantly — no fade tail.
// 60 = 2 seconds of motion history at 30 fps; long enough for a visible
// streamer at moderate-to-high zoom, short enough to keep per-frame
// segment count manageable (60 buckets × particle_count stroke calls).
const TRAIL_LENGTH = 60;
// Zoom-based detail scaling. Applied to BOTH particle lifetime AND particle
// count. Without it, low zooms looked over-busy in two ways: trails lingered
// ~20 sec ("ghost ribbons") and the constant per-pixel particle density
// (which at z3 covers a continental area) painted the whole canvas in
// uniform streaks. The slope is calibrated so f(z4) ≈ 0.23 (down ~30%
// from a flat-1.0 baseline at low zoom) and f(z10) ≈ 1.08 (up ~30% at
// high zoom — denser, more vibrant streaks at city level). Below LOW
// returns LOW; above REFERENCE returns the high cap.
const LOW_ZOOM_DETAIL_MULT = 0.09;
const HIGH_ZOOM_DETAIL_MULT = 1.37;
const LOW_DETAIL_ZOOM = 3;
const REFERENCE_DETAIL_ZOOM = 12;
// Visual speed exaggeration, zoom-aware. The naive constant-pixel-speed
// path made low zoom look much faster than high zoom: at z=4 a 10 m/s wind
// raced across the continent each second; at z=12 it crawled. We compute
// pixels-per-(m/s) per refresh from the current map's pixels-per-meter,
// so motion stays roughly proportional to actual ground speed.
//
// Calibration: at zoom 8 / lat 50, pxPerMeter ≈ 0.00255 → 0.1 px/(m/s)/frame
// puts a 10 m/s wind at ~3 px/sec there, which reads as gentle drift across
// city-region zooms. Cap on top zoom keeps particles from flying off-screen
// at street level. Floor keeps continental views perceptible — combined
// with the streak-length compensation below, even floored speeds render
// as visibly drifting ribbons.
const REFERENCE_PX_PER_M = 0.00255;
const REFERENCE_PX_PER_MPS_PER_FRAME = 0.1;
const MAX_PX_PER_MPS_PER_FRAME = 0.3;
const MIN_PX_PER_MPS_PER_FRAME = 0.01;
// Refresh anchored to the top of each clock hour. Our "current" time is
// already hour-bucketed (Math.trunc(timeMs / 3_600_000)), so the displayed
// data only changes when a new hour rolls in or DWD publishes a fresher
// ICON-D2 run for the same hour. Top-of-hour catches both cases at the
// instant they happen — polling more often returns identical data.
// 30 sec offset gives DWD a window to publish if a new model run lands at HH:00.
const HOURLY_REFRESH_OFFSET_MS = 30_000;

export interface WindFlowOverlayOptions {
  /** Anchor time in epoch ms. Snapped to the hourly ICON boundary. Omit for "current". */
  timeMs?: number;
  /** Stroke for new line segments. Defaults to a neutral grey that reads on light or dark maps. */
  particleColor?: string;
}

export class WindFlowOverlay {
  private _map: L.Map;
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;
  // Holds the latest fetched grid in its full WindGrid shape so we can
  // sample with the cell-centre-anchored sampleWindGridBilinear helper.
  // Empty grid (rows=0) is the "no data yet / fetch failed" sentinel.
  private _grid: WindGrid = {
    rows: 0, cols: 0, latMin: 0, lonMin: 0, step: ICON_GRID_DEG, cells: [],
  };
  // Particles are stored as a flat Float32Array — [x, y, age, x, y, age, …].
  // Cheaper to update than an Array of objects when we touch it 30×/sec.
  private _particles = new Float32Array(0);
  // Per-particle ring buffer of past positions: [x_0, y_0, x_1, y_1, ...,
  // x_(TL-1), y_(TL-1), <next particle>]. Indexed via _trailHeads which
  // point to each particle's most recent slot. Used by the explicit-
  // trail rendering model to draw streamers without canvas accumulation.
  private _trails = new Float32Array(0);
  private _trailHeads = new Uint8Array(0);
  private _particleCount = 0;
  private _animFrame = 0;
  // Throttle bookkeeping: timestamp of the last actual draw frame.
  private _lastDrawMs = 0;
  private _gen = 0;
  private _running = false;
  private _timeIso: string | null = null;
  private _color: string;
  private _onMoveStart: () => void;
  private _onMoveEnd: () => void;
  private _onZoomStart: () => void;
  private _onZoomEnd: () => void;
  private _onResize: () => void;
  private _isZooming = false;
  // prefers-reduced-motion: spinning particles 30×/s on lower-end devices is
  // exactly the kind of work the OS-level setting asks us to skip. We watch
  // the media query so toggling it in System Settings takes effect without
  // a card reload.
  private _reducedMotionMql: MediaQueryList | null = null;
  private _onReducedMotionChange: ((e: MediaQueryListEvent) => void) | null = null;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  // Recomputed per refresh from the map's current zoom/centre so a single
  // wind speed renders proportionally across the zoom range.
  private _pxPerMpsPerFrame = REFERENCE_PX_PER_MPS_PER_FRAME;
  // Recomputed per refresh to keep visible streak length ~constant as the
  // pixel speed varies with zoom. See _restart for the derivation.
  private _particleLifetimeFrames = 60;

  constructor(map: L.Map, opts: WindFlowOverlayOptions = {}) {
    this._map = map;
    this._color = opts.particleColor ?? 'rgba(60,60,80,0.55)';
    if (opts.timeMs != null) {
      const snapped = Math.trunc(opts.timeMs / 3_600_000) * 3_600_000;
      this._timeIso = new Date(snapped).toISOString().split('.')[0] + 'Z';
    }

    // Canvas lives in a custom Leaflet pane between tilePane (200) and
    // overlayPane (400) so streaks sit directly on top of the radar /
    // basemap and EVERYTHING else (wildfire perimeters, NWS polygons,
    // marker shadows, markers, popups) renders above them. The pane is a
    // child of mapPane, so the canvas inherits Leaflet's per-frame drag
    // transform automatically: no manual translate-mirroring needed.
    //
    // Critical positioning detail: mapPane has a translate3d offset of
    // roughly (W/2, H/2) — the layer-point coordinate system anchors at
    // the map centre, not at viewport (0, 0). A canvas at left:0,top:0
    // inside any pane therefore renders shifted by +W/2,+H/2 (only the
    // bottom-right quadrant visible) — the bug we hit in two earlier
    // in-pane attempts. The fix matches what L.Canvas does for shape
    // rendering: setPosition the canvas to containerPointToLayerPoint(0,0),
    // which is approximately (-W/2, -H/2). That cancels mapPane's offset
    // and the canvas's own (0, 0) lands at viewport (0, 0).
    const PANE_NAME = 'wrcWindFlow';
    let pane = map.getPane(PANE_NAME);
    if (!pane) {
      pane = map.createPane(PANE_NAME);
      pane.style.zIndex = '250';
      pane.style.pointerEvents = 'none';
    }
    this._canvas = L.DomUtil.create('canvas', 'wrc-wind-flow') as HTMLCanvasElement;
    this._canvas.style.pointerEvents = 'none';
    pane.appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d')!;

    this._onMoveStart = (): void => this._stopLoop();
    this._onMoveEnd = (): void => {
      if (this._isZooming) return; // zoomend handles the redraw
      void this._restart();
    };
    this._onZoomStart = (): void => {
      this._isZooming = true;
      this._stopLoop();
      this._canvas.style.opacity = '0';
    };
    this._onZoomEnd = (): void => {
      this._isZooming = false;
      this._canvas.style.opacity = '';
      void this._restart();
    };
    this._onResize = (): void => { void this._restart(); };
    map.on('movestart', this._onMoveStart);
    map.on('moveend', this._onMoveEnd);
    map.on('zoomstart', this._onZoomStart);
    map.on('zoomend', this._onZoomEnd);
    map.on('resize', this._onResize);

    if (typeof window !== 'undefined' && window.matchMedia) {
      this._reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._onReducedMotionChange = (): void => { void this._restart(); };
      this._reducedMotionMql.addEventListener('change', this._onReducedMotionChange);
    }

    this._scheduleHourlyRefresh();
    void this._restart();
  }

  // Self-rescheduling timer that wakes shortly after each clock hour to
  // pick up the new hour bucket / model run. Independent of map events.
  private _scheduleHourlyRefresh(): void {
    const now = Date.now();
    const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
    const delay = nextHour - now + HOURLY_REFRESH_OFFSET_MS;
    this._refreshTimer = setTimeout(() => {
      void this._restart();
      this._scheduleHourlyRefresh();
    }, delay);
  }

  destroy(): void {
    this._stopLoop();
    this._gen++;
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    this._map.off('movestart', this._onMoveStart);
    this._map.off('moveend', this._onMoveEnd);
    this._map.off('zoomstart', this._onZoomStart);
    this._map.off('zoomend', this._onZoomEnd);
    this._map.off('resize', this._onResize);
    if (this._reducedMotionMql && this._onReducedMotionChange) {
      this._reducedMotionMql.removeEventListener('change', this._onReducedMotionChange);
    }
    if (this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
  }

  private _stopLoop(): void {
    this._running = false;
    if (this._animFrame) cancelAnimationFrame(this._animFrame);
    this._animFrame = 0;
  }

  private async _restart(): Promise<void> {
    this._stopLoop();
    const myGen = ++this._gen;
    // Throttle bookkeeping reset — first frame after restart uses the
    // target interval as the dt fallback (see _tick).
    this._lastDrawMs = 0;

    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._ctx.clearRect(0, 0, size.x, size.y);
    // Anchor the canvas to the layer-point coordinate system so its (0, 0)
    // pixel lands at viewport (0, 0) regardless of mapPane's current
    // translate3d offset (which Leaflet sets to roughly (W/2, H/2) so
    // layer-point (0, 0) corresponds to the map centre). Without this,
    // canvas content rendered shifted by half the viewport in each axis.
    L.DomUtil.setPosition(this._canvas, this._map.containerPointToLayerPoint([0, 0]));
    this._pxPerMpsPerFrame = this._computePxPerMps();
    // Streak-length compensation: at slow pixel speeds, particles need to
    // live longer to trace out the same on-screen ribbon, and the fade
    // must slow proportionally so the start of the ribbon is still
    // visible when the particle reaches the end. Then scale by the
    // zoom-based duration multiplier so very low zooms don't produce
    // ribbons that linger absurdly long.
    const naturalLifetime = TARGET_STREAK_PX / (TYPICAL_MPS_FOR_STREAK * this._pxPerMpsPerFrame);
    const scaled = naturalLifetime * this._zoomDetailMultiplier();
    this._particleLifetimeFrames = Math.max(
      MIN_PARTICLE_LIFETIME_FRAMES,
      Math.min(MAX_PARTICLE_LIFETIME_FRAMES, Math.round(scaled)),
    );

    // Honour OS-level reduced-motion. The streamlines layer is purely
    // decorative — barbs/arrows still convey direction & speed — so we
    // disable the animation entirely rather than rendering a static frame.
    if (this._reducedMotionMql?.matches) return;

    await this._fetchGrid();
    if (myGen !== this._gen) return;

    this._spawnParticles(size.x, size.y);
    this._running = true;
    this._tick();
  }

  // Linear ramp from LOW_ZOOM_DETAIL_MULT at LOW_DETAIL_ZOOM to
  // HIGH_ZOOM_DETAIL_MULT at REFERENCE_DETAIL_ZOOM. Below LOW returns
  // LOW; above REFERENCE returns HIGH. Drives both lifetime (short
  // trails at low zoom, longer at high zoom) and density (fewer
  // particles at low zoom, more at high zoom) so continental views
  // don't get painted-over and city views render a vibrant, detailed
  // wind field.
  private _zoomDetailMultiplier(): number {
    const z = this._map.getZoom();
    const t = (z - LOW_DETAIL_ZOOM) / (REFERENCE_DETAIL_ZOOM - LOW_DETAIL_ZOOM);
    const clamped = Math.max(0, Math.min(1, t));
    return LOW_ZOOM_DETAIL_MULT + (HIGH_ZOOM_DETAIL_MULT - LOW_ZOOM_DETAIL_MULT) * clamped;
  }

  // Pixels per (m/s × frame) at the map's current centre + zoom. Sample
  // a 1° lon delta at the centre latitude → pixels, divide by the
  // ground-truth metres in 1° lon at that latitude. Multiply by the
  // reference exaggeration and clamp so streamlines stay perceptible at
  // continental zooms and contained at city zooms.
  private _computePxPerMps(): number {
    const c = this._map.getCenter();
    const p1 = this._map.latLngToContainerPoint([c.lat, c.lng]);
    const p2 = this._map.latLngToContainerPoint([c.lat, c.lng + 1]);
    const pxPerDegLon = Math.abs(p2.x - p1.x);
    const metersPerDegLon = 111_320 * Math.cos((c.lat * Math.PI) / 180);
    if (metersPerDegLon <= 0 || !Number.isFinite(pxPerDegLon) || pxPerDegLon <= 0) {
      return REFERENCE_PX_PER_MPS_PER_FRAME;
    }
    const pxPerMeter = pxPerDegLon / metersPerDegLon;
    const scaled = REFERENCE_PX_PER_MPS_PER_FRAME * (pxPerMeter / REFERENCE_PX_PER_M);
    return Math.max(MIN_PX_PER_MPS_PER_FRAME, Math.min(MAX_PX_PER_MPS_PER_FRAME, scaled));
  }

  private async _fetchGrid(): Promise<void> {
    const b = this._map.getBounds();
    // Pad by one native cell on each side so particles drifting just past
    // the visible edge still find U/V before the next pan triggers a refetch.
    const pad = ICON_GRID_DEG;
    const south = b.getSouth() - pad;
    const north = b.getNorth() + pad;
    const west = b.getWest() - pad;
    const east = b.getEast() + pad;

    try {
      this._grid = await windGridFetcher.fetch({
        south, west, north, east,
        timeIso: this._timeIso,
      });
    } catch (err) {
      console.warn('WindFlowOverlay: WCS fetch failed, skipping refresh', err);
      this._grid = { rows: 0, cols: 0, latMin: 0, lonMin: 0, step: ICON_GRID_DEG, cells: [] };
    }
  }

  private _spawnParticles(w: number, h: number): void {
    // Density takes the lifetime/detail multiplier and applies an
    // EXTRA reduction below z7 (the visually-calibrated reference
    // zoom). Above z7 → no change. Below z7 → linear ramp down to
    // 50% extra reduction at z3. Combined with the inverse line-width
    // scaling in _tick (thicker strokes at low zoom), this keeps the
    // wind field readable at low zoom without the smudge that comes
    // from too many slow-moving particles depositing ink at the same
    // pixel for many frames.
    const z = this._map.getZoom();
    // Linear ramp: 0.5x extra density reduction at z3 (-50%) → 1.0x at z7+
    // (z7 is the visually-calibrated reference; above it stays unchanged).
    const lowZoomDensityFactor = z >= 7 ? 1 : Math.max(0.5, 0.5 + (z - 3) * 0.125);
    const density = PARTICLE_DENSITY * this._zoomDetailMultiplier() * lowZoomDensityFactor;
    const count = Math.min(PARTICLE_CAP, Math.round(w * h * density));
    this._particleCount = count;
    this._particles = new Float32Array(count * 3);
    // Trail ring buffer per particle: TRAIL_LENGTH × (x, y) floats.
    this._trails = new Float32Array(count * TRAIL_LENGTH * 2);
    this._trailHeads = new Uint8Array(count);
    for (let p = 0; p < count; p++) {
      const x = Math.random() * w;
      const y = Math.random() * h;
      this._particles[p * 3] = x;
      this._particles[p * 3 + 1] = y;
      // Stagger initial ages so particles don't all respawn on the same frame.
      this._particles[p * 3 + 2] = Math.random() * this._particleLifetimeFrames;
      // Initialise trail to the spawn point — all slots collapse to the
      // current position, so the particle starts as a single point and
      // its trail extends one segment per subsequent frame.
      const base = p * TRAIL_LENGTH * 2;
      for (let i = 0; i < TRAIL_LENGTH; i++) {
        this._trails[base + i * 2] = x;
        this._trails[base + i * 2 + 1] = y;
      }
      this._trailHeads[p] = 0;
    }
  }

  private _interpolate(lat: number, lon: number): { u: number; v: number } {
    return sampleWindGridBilinear(this._grid, lat, lon);
  }

  private _tick = (): void => {
    if (!this._running) return;
    // Throttle to TARGET_FPS. requestAnimationFrame still runs at the
    // display rate; we just skip the work for frames that come too soon.
    const now = performance.now();
    const elapsedMs = now - this._lastDrawMs;
    if (this._lastDrawMs > 0 && elapsedMs < TARGET_FRAME_INTERVAL_MS - 4) {
      this._animFrame = requestAnimationFrame(this._tick);
      return;
    }
    // First frame: prime _lastDrawMs so the next throttle check works,
    // and use the target interval as the assumed dt for motion math.
    const dtMs = this._lastDrawMs > 0 ? elapsedMs : TARGET_FRAME_INTERVAL_MS;
    this._lastDrawMs = now;
    // Scale per-frame motion so wall-clock head speed stays consistent
    // regardless of the actual throttle rate or display refresh rate.
    // pxPerMpsPerFrame was calibrated for ~30 fps; at our 15 fps target
    // dtMs ≈ 67ms → motionScale ≈ 2.0 → particles move twice the per-
    // frame distance, which combined with the half rate gives the same
    // wall-clock speed AND a 2× longer visible streak per particle.
    const motionScale = dtMs / MOTION_REFERENCE_FRAME_MS;
    const stepPxPerMps = this._pxPerMpsPerFrame * motionScale;

    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;
    const count = this._particleCount;

    // Step 1: clear the entire canvas. No destination-out fade — the
    // explicit per-particle trail buffer means we draw the full visible
    // streak from scratch each frame. When a particle dies, its trail
    // vanishes instantly because we no longer redraw those pixels.
    ctx.clearRect(0, 0, w, h);

    // Step 2: advance every particle. Single state — no separate dying
    // flag. When age reaches lifetime + FADE_OUT_FRAMES the particle
    // respawns at a random position with a wiped trail. The fade-out
    // happens entirely in the draw pass via a per-particle alpha
    // multiplier; here we just keep moving and ageing.
    for (let p = 0; p < count; p++) {
      const idx = p * 3;
      const trailBase = p * TRAIL_LENGTH * 2;
      const x = this._particles[idx];
      const y = this._particles[idx + 1];
      const age = this._particles[idx + 2];

      // Respawn only when the particle has fully aged through its
      // lifetime AND the fade-out window. Off-canvas no longer triggers
      // immediate respawn — the trail's on-canvas portion still draws
      // and we just bump age into the fade window so it dissipates
      // smoothly instead of cutting at the edge.
      if (age >= this._particleLifetimeFrames + FADE_OUT_FRAMES) {
        const rx = Math.random() * w;
        const ry = Math.random() * h;
        this._particles[idx] = rx;
        this._particles[idx + 1] = ry;
        this._particles[idx + 2] = 0;
        for (let i = 0; i < TRAIL_LENGTH; i++) {
          this._trails[trailBase + i * 2] = rx;
          this._trails[trailBase + i * 2 + 1] = ry;
        }
        this._trailHeads[p] = 0;
        continue;
      }

      const ll = this._map.containerPointToLatLng(L.point(x, y));
      const wind = this._interpolate(ll.lat, ll.lng);
      const nx = x + wind.u * stepPxPerMps;
      const ny = y - wind.v * stepPxPerMps; // pixel y goes down; v is northward

      // If the particle just left (or is leaving) the canvas while
      // still in its alive phase, jump age into the fade window so the
      // visible (on-canvas) portion of the trail fades out instead of
      // disappearing instantly.
      let nextAge = age + 1;
      const offCanvas = nx < 0 || nx > w || ny < 0 || ny > h;
      if (offCanvas && nextAge < this._particleLifetimeFrames) {
        nextAge = this._particleLifetimeFrames;
      }

      this._particles[idx] = nx;
      this._particles[idx + 1] = ny;
      this._particles[idx + 2] = nextAge;
      const newHead = (this._trailHeads[p] + 1) % TRAIL_LENGTH;
      this._trails[trailBase + newHead * 2] = nx;
      this._trails[trailBase + newHead * 2 + 1] = ny;
      this._trailHeads[p] = newHead;
    }

    // Step 3: draw all trails. For each particle, compute a per-particle
    // life-fade multiplier:
    //   - 1.0 while age < lifetime
    //   - smoothly drops to 0 over the FADE_OUT_FRAMES tail of life
    //   - eased with cubic so the transition from "fully alive" to
    //     "starting to fade" is imperceptible (early fade frames stay
    //     near full alpha, then accelerate to 0 at the end). This
    //     avoids the perceptual "flash" a linear fade can produce
    //     where the early fade is steep enough to look like a step.
    //
    // Particles split into two groups by their fade multiplier:
    //   - fully alive (multiplier == 1): batched per segment-age (cheap)
    //   - fading (multiplier < 1): per-segment per-particle (~10k
    //     strokes/frame at typical density, fine at 15fps)
    ctx.strokeStyle = this._color;
    const z = this._map.getZoom();
    // Line width compensates for lower density at low zoom — fewer
    // particles, each rendered thicker. Linear ramp 3px (z3) → 1px (z7+).
    ctx.lineWidth = Math.max(1, Math.min(3, 3 - (z - 3) * 0.5));
    // Per-stroke alpha attenuated at low zoom to avoid over-painting
    // the basemap with too many concurrent streaks (cube-root curve).
    const baseAlpha = Math.min(1, Math.pow(this._zoomDetailMultiplier(), 1 / 3));
    const lifetime = this._particleLifetimeFrames;

    // Pass A: fully alive particles batched by segment age.
    for (let segAge = 0; segAge < TRAIL_LENGTH - 1; segAge++) {
      const ageAlpha = (TRAIL_LENGTH - 1 - segAge) / (TRAIL_LENGTH - 1);
      ctx.globalAlpha = ageAlpha * baseAlpha;
      ctx.beginPath();
      for (let p = 0; p < count; p++) {
        if (this._particles[p * 3 + 2] >= lifetime) continue; // fading — separate pass
        const head = this._trailHeads[p];
        const i0 = (head - segAge + TRAIL_LENGTH) % TRAIL_LENGTH;
        const i1 = (head - segAge - 1 + TRAIL_LENGTH) % TRAIL_LENGTH;
        const trailBase = p * TRAIL_LENGTH * 2;
        const x0 = this._trails[trailBase + i0 * 2];
        const y0 = this._trails[trailBase + i0 * 2 + 1];
        const x1 = this._trails[trailBase + i1 * 2];
        const y1 = this._trails[trailBase + i1 * 2 + 1];
        if (x0 === x1 && y0 === y1) continue;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    }

    // Pass B: fading particles — each at their own life-fade alpha.
    for (let p = 0; p < count; p++) {
      const age = this._particles[p * 3 + 2];
      if (age < lifetime) continue;
      // Cubic ease-in: t in [0, 1], lifeFade = 1 - t^3. Stays near 1
      // through most of the fade window, drops sharply at the end.
      const t = Math.min(1, (age - lifetime) / FADE_OUT_FRAMES);
      const lifeFade = 1 - t * t * t;
      if (lifeFade <= 0) continue;
      const head = this._trailHeads[p];
      const trailBase = p * TRAIL_LENGTH * 2;
      for (let segAge = 0; segAge < TRAIL_LENGTH - 1; segAge++) {
        const i0 = (head - segAge + TRAIL_LENGTH) % TRAIL_LENGTH;
        const i1 = (head - segAge - 1 + TRAIL_LENGTH) % TRAIL_LENGTH;
        const x0 = this._trails[trailBase + i0 * 2];
        const y0 = this._trails[trailBase + i0 * 2 + 1];
        const x1 = this._trails[trailBase + i1 * 2];
        const y1 = this._trails[trailBase + i1 * 2 + 1];
        if (x0 === x1 && y0 === y1) continue;
        const ageAlpha = (TRAIL_LENGTH - 1 - segAge) / (TRAIL_LENGTH - 1);
        ctx.globalAlpha = ageAlpha * lifeFade * baseAlpha;
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.stroke();
      }
    }

    ctx.globalAlpha = 1;
    this._animFrame = requestAnimationFrame(this._tick);
  };
}

