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
// Calibration wind for the streak-length math. Real winds vary; this is the
// "typical" speed used to set particle lifetime. Faster winds make slightly
// longer streaks, calmer winds shorter — that's a feature.
const TYPICAL_MPS_FOR_STREAK = 5;
// Bounds: particle lifetime in frames. Floor keeps streaks visible at
// extreme zooms; ceiling keeps trails from accumulating into a smudge
// when particles barely move.
const MIN_PARTICLE_LIFETIME_FRAMES = 30;
const MAX_PARTICLE_LIFETIME_FRAMES = 600;
// Bounds: per-frame alpha decay. Floor avoids ghost trails that outlast
// the wind they represent; ceiling avoids instant flash + disappear.
const MIN_FADE_PER_FRAME = 0.005;
const MAX_FADE_PER_FRAME = 0.15;
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
  private _particleCount = 0;
  private _animFrame = 0;
  private _gen = 0;
  private _running = false;
  private _timeIso: string | null = null;
  private _color: string;
  private _onMoveStart: () => void;
  private _onMove: () => void;
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
  private _fadePerFrame = 0.04;

  constructor(map: L.Map, opts: WindFlowOverlayOptions = {}) {
    this._map = map;
    this._color = opts.particleColor ?? 'rgba(60,60,80,0.55)';
    if (opts.timeMs != null) {
      const snapped = Math.trunc(opts.timeMs / 3_600_000) * 3_600_000;
      this._timeIso = new Date(snapped).toISOString().split('.')[0] + 'Z';
    }

    this._canvas = L.DomUtil.create('canvas', 'wrc-wind-flow') as HTMLCanvasElement;
    Object.assign(this._canvas.style, {
      position: 'absolute',
      pointerEvents: 'none',
      left: '0',
      top: '0',
      zIndex: '500',                    // above tilePane (200), below markerPane (600)
    } satisfies Partial<CSSStyleDeclaration>);
    map.getContainer().appendChild(this._canvas);
    this._ctx = this._canvas.getContext('2d')!;

    // Drag tracking via manual transform mirroring. The canvas lives outside
    // mapPane (in map.getContainer) so Leaflet's per-frame transform doesn't
    // reach it; we read mapPane's CSS position on every 'move' and apply the
    // same translate3d so streaks visibly drift with the cursor instead of
    // freezing until moveend "jumps" them. Zoom is handled separately —
    // pinch/scroll changes the projection entirely, so we hide during the
    // zoom animation and rebuild on zoomend.
    //
    // Layering caveat: this places the canvas above mapPane and therefore
    // above markers/popups. An earlier attempt to put the canvas inside
    // overlayPane (the natural fix) produced a position offset bug — the
    // streak content rendered shifted by roughly half the viewport. Until
    // that's understood, the visual layering trade-off stays.
    this._onMoveStart = (): void => this._stopLoop();
    this._onMove = (): void => {
      if (this._isZooming) return;
      const pos = L.DomUtil.getPosition(this._map.getPanes().mapPane);
      this._canvas.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    };
    this._onMoveEnd = (): void => {
      if (this._isZooming) return; // zoomend handles the redraw
      this._canvas.style.transform = '';
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
      this._canvas.style.transform = '';
      void this._restart();
    };
    this._onResize = (): void => { void this._restart(); };
    map.on('movestart', this._onMoveStart);
    map.on('move', this._onMove);
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
    this._map.off('move', this._onMove);
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

    const size = this._map.getSize();
    this._canvas.width = size.x;
    this._canvas.height = size.y;
    this._ctx.clearRect(0, 0, size.x, size.y);
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
    // Fade chosen so a segment painted at frame 0 has decayed to ~5%
    // alpha by the time the particle dies — the ribbon then has a
    // smooth full-to-faint gradient end-to-end. Math.pow(0.05, 1/N) is
    // the per-frame multiplier; (1 - that) is the destination-out alpha.
    const targetFade = 1 - Math.pow(0.05, 1 / this._particleLifetimeFrames);
    this._fadePerFrame = Math.max(MIN_FADE_PER_FRAME, Math.min(MAX_FADE_PER_FRAME, targetFade));

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
    // Same low-zoom detail multiplier we use for lifetime: thinning the
    // particle population at low zoom is what stops the canvas getting
    // painted-over by uniform streaks when each particle covers a wide
    // ground area.
    const density = PARTICLE_DENSITY * this._zoomDetailMultiplier();
    const count = Math.min(PARTICLE_CAP, Math.round(w * h * density));
    this._particleCount = count;
    this._particles = new Float32Array(count * 3);
    for (let p = 0; p < count; p++) {
      this._particles[p * 3] = Math.random() * w;
      this._particles[p * 3 + 1] = Math.random() * h;
      // Stagger initial ages so particles don't all respawn on the same frame.
      this._particles[p * 3 + 2] = Math.random() * this._particleLifetimeFrames;
    }
  }

  private _interpolate(lat: number, lon: number): { u: number; v: number } {
    return sampleWindGridBilinear(this._grid, lat, lon);
  }

  private _tick = (): void => {
    if (!this._running) return;
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;

    // Decay existing trails — destination-out drops alpha regardless of colour,
    // so this works on any basemap.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${this._fadePerFrame})`;
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = this._color;
    ctx.lineWidth = 1;
    ctx.beginPath();

    for (let p = 0; p < this._particleCount; p++) {
      const idx = p * 3;
      const x = this._particles[idx];
      const y = this._particles[idx + 1];
      let age = this._particles[idx + 2];

      const ll = this._map.containerPointToLatLng(L.point(x, y));
      const wind = this._interpolate(ll.lat, ll.lng);

      const nx = x + wind.u * this._pxPerMpsPerFrame;
      const ny = y - wind.v * this._pxPerMpsPerFrame; // pixel y goes down; v is northward

      if (Math.abs(wind.u) + Math.abs(wind.v) > 0.05) {
        ctx.moveTo(x, y);
        ctx.lineTo(nx, ny);
      }

      age++;
      if (age > this._particleLifetimeFrames || nx < 0 || nx > w || ny < 0 || ny > h) {
        this._particles[idx] = Math.random() * w;
        this._particles[idx + 1] = Math.random() * h;
        this._particles[idx + 2] = 0;
      } else {
        this._particles[idx] = nx;
        this._particles[idx + 1] = ny;
        this._particles[idx + 2] = age;
      }
    }

    ctx.stroke();
    this._animFrame = requestAnimationFrame(this._tick);
  };
}

