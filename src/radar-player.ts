/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { WeatherRadarCardConfig } from './types';
import { RateLimiter } from './rate-limiter';
import { FetchTileLayer, FetchWmsTileLayer, layerSettled } from './fetch-tile-layer';
import { RadarToolbar } from './radar-toolbar';

// ── Types ────────────────────────────────────────────────────────────────────

export type FrameStatus = 'empty' | 'loading' | 'loaded' | 'failed';
export interface RadarFrame { time: number; path: string; host?: string; }

const NOAA_WMS_URL =
  'https://mapservices.weather.noaa.gov/eventdriven/services/radar/radar_base_reflectivity_time/ImageServer/WMSServer';
const NOAA_WMS_LAYER = 'radar_base_reflectivity_time';

const DWD_WMS_URL = 'https://maps.dwd.de/geoserver/dwd/wms';
const DWD_WMS_LAYER_DEFAULT = 'Niederschlagsradar';
const DWD_FRAME_INTERVAL_MS = 5 * 60 * 1000;
// Frames usually appear 1–3 min after their timestamp; 5 min is safely past the lag.
const DWD_LAG_MS = 5 * 60 * 1000;

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

  private _radarImage: (FetchTileLayer | FetchWmsTileLayer)[] = [];
  private _radarTime: string[] = [];
  private _radarPaths: RadarFrame[] = [];
  private _loadedSlots: number[] = [];
  private _frameStatuses: FrameStatus[] = [];
  private _radarReady = false;
  private _frameGeneration = 0;
  private _configFrameCount = 5;
  private _doRadarUpdate = false;

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

  constructor(opts: RadarPlayerOptions) {
    this._map = opts.map;
    this._shadowRoot = opts.shadowRoot;
    this._getConfig = opts.getConfig;
    this._rainviewerLimiter = opts.rainviewerLimiter;
    this._noaaLimiter = opts.noaaLimiter;
    this._dwdLimiter = opts.dwdLimiter;
    this._startWorker();
  }

  // ── Config helpers ───────────────────────────────────────────────────────

  private get _cfg(): WeatherRadarCardConfig { return this._getConfig(); }
  private get _timeout(): number { return this._cfg.frame_delay ?? 500; }
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
  private get _activeOpacity(): string {
    const v = this._cfg.radar_opacity;
    if (typeof v !== 'number' || !isFinite(v)) return '1';
    return String(Math.max(0, Math.min(1, v)));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Start loading radar frames for the current map view. */
  async start(frameCount: number): Promise<void> {
    this._configFrameCount = frameCount;
    await this._initRadar();
  }

  /** Tear down all layers and cancel pending async work. */
  clear(): void {
    this._stopLoop();
    this._clearLayers();
    if (this._rateLimitTimer) { clearTimeout(this._rateLimitTimer); this._rateLimitTimer = null; }
    this._worker?.terminate();
    this._worker = null;
    this._workerCallbacks.clear();
    if (this._workerBlobUrl) { URL.revokeObjectURL(this._workerBlobUrl); this._workerBlobUrl = null; }
  }

  // ── Navigation / visibility pause ────────────────────────────────────────

  onNavPaused(): void {
    this.navPaused = true;
    this._stopLoop();
    for (let i = 0; i < this._configFrameCount; i++) this._setSegment(i, 'empty');
    this._showRateLimitBanner(false);
  }

  async onNavSettled(frameCount: number): Promise<void> {
    this.navPaused = false;
    this._clearLayers();
    this._configFrameCount = frameCount;
    await this._initRadar();
  }

  onVisibilityHidden(): void {
    this.viewPaused = true;
    this._stopLoop();
  }

  onVisibilityVisible(): void {
    if (!this.viewPaused) return;
    this.viewPaused = false;
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
  // shown frame) is visible at the user's radar_opacity. Used when
  // pausing the loop so the user doesn't see the cushion `prev1` of
  // the previous tick still at opacity 1 underneath the current.
  private _settleVisibility(): void {
    const current = this._prev1Slot;
    const active = this._activeOpacity;
    for (let s = 0; s < this._loadedSlots.length; s++) {
      const fi = this._loadedSlots[s];
      const layer = this._radarImage[fi];
      const el = layer && (layer as any).getContainer?.() as HTMLElement | undefined;
      if (!el) continue;
      el.style.transition = 'none';
      el.style.opacity = (s === current) ? active : '0';
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
    const timing = opts?.snap
      ? { fadeMs: 0, delayMs: 0 }
      : this._crossfadeTiming();
    const fade = timing.fadeMs;
    const fadeOutDelay = timing.delayMs;
    const transition = fade > 0 ? `opacity ${fade}ms ease-in-out` : 'none';
    const active = this._activeOpacity;

    // Two-slot animation model:
    //   - `slot` (new): snaps to opacity 0 at the new highest z-index,
    //     then fades 0 → active over `fade` ms.
    //   - `prev1` (the previous current, captured below): kicks off a
    //     DELAYED fade-out — `transition-delay: fade` ms means it stays
    //     at active for `fade` ms (covering transparent pixels of the
    //     new layer during its fade-in), then fades 1 → 0 over `fade` ms.
    //   - Older slots: trusted to be already at 0 (or finishing their
    //     own delayed fade-out from a previous tick, which we don't
    //     interrupt — letting it complete keeps motion smooth even when
    //     transition_time approaches frame_delay).
    //
    // Cycle behaviour:
    //   - During the first `fade` ms of a tick: new fading in, prev1
    //     held at active. Two visible layers (no alpha dip — z-stack).
    //   - During the next `fade` ms: new fully on top, prev1 fading out.
    //     Two visible layers (one fading).
    //   - From `2*fade` ms until the next tick: only the new is visible.
    //     Single layer for `frame_delay - 2*fade` ms.
    //
    // When fade is 0 (animations off / snap mode), there's no transition
    // to delay, so the chain logic collapses: snap new to active, snap
    // all others to 0. Single layer always visible.
    this._zCounter++;
    const newZ = 100 + this._zCounter;
    const prev1 = this._prev1Slot;
    const useChain = fade > 0;

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
        // Forced reflow before re-assigning — without this the browser
        // coalesces the two opacity writes and skips the transition.
        // eslint-disable-next-line @typescript-eslint/no-unused-expressions
        void el.offsetHeight;
        el.style.transition = transition;
        el.style.opacity = active;
      } else if (useChain && s === prev1) {
        // Just-promoted previous current: delayed fade-out. The
        // `transition-delay` (the second time value) holds the layer
        // at active opacity until the delay elapses, then begins the
        // fade-out. In regular mode delay == fade duration so the
        // fade-out starts AT fade-in completion (sequential). In smooth
        // mode delay is 75% of fade duration — the fade-out starts
        // before fade-in finishes, creating a brief overlap window
        // where the brightness composite stays close to constant.
        el.style.transition = `opacity ${fade}ms ease-in-out ${fadeOutDelay}ms`;
        el.style.opacity = '0';
      } else if (!useChain) {
        // Snap mode / fade=0: every non-current slot snaps to 0
        // immediately so we never see two layers at opacity 1.
        el.style.transition = 'none';
        el.style.opacity = '0';
      }
      // useChain && older: don't touch. Their delayed fade-out from a
      // previous tick is either still finishing or already at 0.
    }

    this._prev1Slot = slot;

    const fi = this._loadedSlots[slot];
    if (fi !== undefined) {
      const ts = this._shadowRoot.getElementById('timestamp');
      if (ts) ts.textContent = this._radarTime[fi] ?? '';
      this._highlightSegment(fi);
    }
  }

  // ── Progress bar ─────────────────────────────────────────────────────────

  private _buildSegments(): void {
    const bar = this._shadowRoot.getElementById('div-progress-bar');
    if (!bar) return;
    bar.innerHTML = '';
    this._frameStatuses = new Array(this._configFrameCount).fill('empty') as FrameStatus[];
    for (let i = 0; i < this._configFrameCount; i++) {
      const seg = document.createElement('div');
      seg.id = `seg-${i}`;
      seg.style.cssText = `flex:1;height:100%;background-color:${this._segColor('empty', false)}`;
      bar.appendChild(seg);
    }
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
    const seg = this._shadowRoot.getElementById(`seg-${fi}`);
    if (seg) seg.style.backgroundColor = this._segColor(status, false);
  }

  private _highlightSegment(fi: number): void {
    for (let j = 0; j < this._configFrameCount; j++) {
      const seg = this._shadowRoot.getElementById(`seg-${j}`);
      if (seg) seg.style.backgroundColor = this._segColor(this._frameStatuses[j] ?? 'empty', j === fi);
    }
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
  }

  // ── Radar fetching ───────────────────────────────────────────────────────

  private async _fetchPaths(): Promise<RadarFrame[]> {
    const dataSource = this._cfg.data_source ?? 'RainViewer';
    if (dataSource === 'NOAA') {
      const now = Date.now();
      const lag = 15 * 60 * 1000;
      const step = 5 * 60 * 1000;
      const snap = Math.trunc((now - lag) / step) * step;
      const frames: RadarFrame[] = [];
      for (let i = this._configFrameCount - 1; i >= 0; i--) {
        frames.push({ time: (snap - i * step) / 1000, path: '' });
      }
      return frames;
    }
    if (dataSource === 'DWD') {
      const override = this._cfg.dwd_time_override;
      const forecastMs = (this._cfg.dwd_forecast_hours ?? 0) * 3_600_000;
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
      const anchor = base + forecastMs;
      const snap = Math.trunc(anchor / DWD_FRAME_INTERVAL_MS) * DWD_FRAME_INTERVAL_MS;
      const frames: RadarFrame[] = [];
      for (let i = this._configFrameCount - 1; i >= 0; i--) {
        frames.push({ time: (snap - i * DWD_FRAME_INTERVAL_MS) / 1000, path: '' });
      }
      return frames;
    }
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    const data = await res.json();
    const host: string = data.host ?? 'https://tilecache.rainviewer.com';
    const past: RadarFrame[] = (data?.radar?.past ?? []).map((f: any) => ({
      time: f.time, path: f.path, host,
    }));
    return past.slice(-Math.min(this._configFrameCount, 13));
  }

  private _createLayer(frame: RadarFrame): FetchTileLayer | FetchWmsTileLayer {
    const dataSource = this._cfg.data_source ?? 'RainViewer';
    if (dataSource === 'NOAA') {
      const isoTime = new Date(frame.time * 1000).toISOString().split('.')[0] + 'Z';
      return new FetchWmsTileLayer(NOAA_WMS_URL, {
        layers: NOAA_WMS_LAYER,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        TIME: isoTime,
        maxNativeZoom: 7,
        rateLimiter: this._noaaLimiter,
        on429: () => this._onRateLimited(),
        animationOwnsOpacity: true,
      } as any);
    }
    if (dataSource === 'DWD') {
      const isoTime = new Date(frame.time * 1000).toISOString().split('.')[0] + 'Z';
      // Niederschlagsradar (default) is past-only. When the user has asked for forecast
      // hours, switch to the analysis+nowcast layer which carries +2h frames too.
      const wantsForecast = (this._cfg.dwd_forecast_hours ?? 0) > 0;
      const autoSwap = wantsForecast && this._cfg.dwd_layer === undefined;
      const layerName = this._cfg.dwd_layer ?? (wantsForecast ? 'Radar_wn-product_1x1km_ger' : DWD_WMS_LAYER_DEFAULT);
      if (autoSwap && !this._dwdSwapLogged) {
        console.info(
          `[weather-radar-card] dwd_forecast_hours > 0; switched DWD layer ${DWD_WMS_LAYER_DEFAULT} (mm/h) → ${layerName} (dBZ) for nowcast frames. Set dwd_layer to override.`,
        );
        this._dwdSwapLogged = true;
      }
      return new FetchWmsTileLayer(DWD_WMS_URL, {
        layers: layerName,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        TIME: isoTime,
        // 512x512 tiles instead of the default 256x256 cuts the request
        // count by 4x for the same coverage (one big tile vs four small).
        // DWD's geoserver renders any size; the small extra payload is a
        // good trade for fewer round-trips during pan/zoom bursts.
        tileSize: 512,
        // DWD's 1 km grid supports zoom 8; NOAA's 4 km MRMS is capped at 7.
        maxNativeZoom: 8,
        rateLimiter: this._dwdLimiter,
        on429: () => this._onRateLimited(),
        animationOwnsOpacity: true,
      } as any);
    }
    const snow = this._cfg.show_snow ? 1 : 0;
    const host = frame.host ?? 'https://tilecache.rainviewer.com';
    return new FetchTileLayer(`${host}${frame.path}/512/{z}/{x}/{y}/2/1_${snow}.png`, {
      detectRetina: false,
      tileSize: 512,
      zoomOffset: -1,
      maxNativeZoom: 7,
      rateLimiter: this._rainviewerLimiter,
      on429: () => this._onRateLimited(),
      animationOwnsOpacity: true,
    } as any);
  }

  private _getTimeString(epochMs: number): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'short', day: 'numeric', month: 'short',
      hour: 'numeric', minute: '2-digit',
    }).format(new Date(epochMs));
  }

  // ── Radar init ───────────────────────────────────────────────────────────

  private async _initRadar(): Promise<void> {
    // Increment generation before the first await so any concurrently-running
    // _initRadar call (same-gen double-start) aborts at its next gen check.
    this._stopLoop();
    this._frameGeneration++;
    const myGen = this._frameGeneration;
    this._loadedSlots = [];
    this._currentSlot = 0;

    let pastFrames: RadarFrame[];
    try {
      pastFrames = await this._fetchPaths();
    } catch {
      return; // network/parse error — card stays blank until next nav or reload
    }
    if (myGen !== this._frameGeneration) return;
    if (pastFrames.length === 0) return; // API returned no frames
    this._radarPaths = pastFrames;
    const frameCount = pastFrames.length;
    this._configFrameCount = frameCount;

    this._buildSegments();

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

        if (!newestShown) {
          // Show newest frame as a static preview before the loop starts
          newestShown = true;
          if (el) el.style.opacity = this._activeOpacity;
          const ts = this._shadowRoot.getElementById('timestamp');
          if (ts) ts.textContent = this._radarTime[fi];
          this._highlightSegment(fi);
        }

        if (this._loadedSlots.length >= 2) {
          this._radarReady = true;
          if (prevSlotCount >= 2) {
            // A new older frame was prepended; shift _currentSlot to keep the
            // same frame (newest) showing — the running timer continues unaffected.
            this._currentSlot++;
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
    if (this._loadedSlots.length > 0) {
      this._radarReady = true;
      this._scheduleUpdate();
    }
  }

  // ── Periodic update ──────────────────────────────────────────────────────

  private _scheduleUpdate(): void {
    const framePeriod = 300_000;
    // RainViewer publishes ~1 min after the timestamp; DWD ~1–3 min; NOAA's lag is already baked in.
    const lag = (this._cfg.data_source ?? 'RainViewer') === 'NOAA' ? 0 : 60_000;
    this._workerTimeout(() => {
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
    const latestFrame = pastFrames[pastFrames.length - 1];
    const frameCount = this._configFrameCount;

    const newLayer = this._createLayer(latestFrame);
    newLayer.addTo(this._map);
    const newTime = this._getTimeString(latestFrame.time * 1000);

    this._radarImage[0]?.remove();
    for (let i = 0; i < frameCount - 1; i++) {
      this._radarImage[i] = this._radarImage[i + 1];
      this._radarTime[i] = this._radarTime[i + 1];
      this._frameStatuses[i] = this._frameStatuses[i + 1];
    }
    this._radarImage[frameCount - 1] = newLayer;
    this._radarTime[frameCount - 1] = newTime;
    this._loadedSlots = this._loadedSlots.map(fi => fi - 1).filter(fi => fi >= 0);

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
      if (newStatus === 'loaded') this._loadedSlots.push(frameCount - 1);
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
    this._workerBlobUrl = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
    this._worker = new Worker(this._workerBlobUrl);
    this._worker.onmessage = (e) => {
      const cb = this._workerCallbacks.get(e.data.id);
      if (cb) { this._workerCallbacks.delete(e.data.id); cb(); }
    };
  }

  private _workerTimeout(cb: () => void, delay: number): void {
    if (!this._worker) { setTimeout(cb, delay); return; }
    const id = this._workerNextId++;
    this._workerCallbacks.set(id, cb);
    this._worker.postMessage({ type: 'setTimeout', id, delay });
  }
}
