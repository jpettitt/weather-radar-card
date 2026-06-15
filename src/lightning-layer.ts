/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { LIGHTNING_BOLT_PATH, LIGHTNING_PLUS_PATH } from './marker-icon';
import { localize } from './localize/localize';
import { haversineKm, formatDistance } from './geo-utils';
import { escapeHtml } from './string-utils';
import {
  BOLT_DURATION_SEC,
  DEFAULT_BLITZORTUNG_MAX_AGE_SEC,
  bearingCardinal,
  colorForAge,
  formatBlitzortungUrl,
  relativeTime,
} from './lightning-helpers';

// Lightning overlay — renders Blitzortung integration's per-strike
// geo_location entities onto a single canvas, fill-coloured by age.
// See docs/lightning-feature-design.md for the full design.
//
// CANVAS, not DOM markers. The original implementation built two DOM
// markers with inline SVG per strike (fill + outline on separate panes);
// during an active storm with a long max-age that's hundreds-to-thousands
// of nodes, which made pan/zoom heavy and froze editor-open for seconds
// (two simultaneous full builds: re-attached card + preview). One canvas
// repainted per change is O(strikes) draw calls but O(1) DOM — the
// structural fix for the per-datapoint DOM ceiling (see docs/todo.md).
//
// What canvas gives up vs. DOM markers, and how each is recovered:
//  - Leaflet marker hit-testing → DIY hit test on map click: the MOST
//    RECENT strike within HIT_TOLERANCE_PX wins (user decision: when
//    strikes overlap, the fresh one is the one being reacted to —
//    recency beats distance).
//  - The two-pane stacked-outline trick → two-pass painting: all black
//    + outlines first, then all colour fills, newest last. Same visual
//    result (stacked outlines merge harmlessly underneath, topmost
//    colour stays clean) without any pane juggling.
//  - The CSS one-shot pulse on fresh bolts → a short rAF-driven scale
//    animation drawn into the same canvas.
//
// No external HTTP from this file. The Blitzortung integration owns the
// data plumbing (WebSocket polling, distance/age filter); we just diff
// hass.states for new/gone strikes and repaint.

const DEFAULT_ICON_SIZE_PX = 14;
// Bolts render at 1.3× the + size — the "happening now" indicator
// reads better when it's visibly larger than the steady-state markers
// it sits among.
const BOLT_SIZE_RATIO = 1.3;
// Default card-side max-age cap. The Blitzortung integration commonly
// keeps strikes for 120 min; rendering them all turns busy storms into
// noise. 30 min surfaces just the meaningful lifetime of an active
// cell. Configurable via cfg.lightning_max_age_minutes.
const DEFAULT_MAX_AGE_MIN = 30;
// 30 s recompute of the age-derived fill — the design doc's chosen
// cadence. Each repaint derives colour from current age, so the timer
// only needs to trigger expiry + a repaint.
const AGE_REFRESH_MS = 30 * 1000;
// Click / hover hit-test tolerance. ~10 px ≈ a comfortable touch slop
// around a 14 px glyph.
const HIT_TOLERANCE_PX = 10;
// Matches the old CSS keyframe duration (scale 2 → 1 over 600 ms).
const PULSE_MS = 600;
// Canvas margin beyond the viewport on each side, as a fraction of the
// viewport dimension. Strikes inside the margin are already painted
// when a pan reveals them; the moveend repaint re-centres the margin.
const CANVAS_PAD_FRACTION = 0.5;

// Custom Leaflet pane between the default overlayPane (400, radar tiles
// + hazard polygons) and the default markerPane (600, home / person /
// device-tracker markers): lightning is visible over an alert polygon,
// and the home marker stays on top of any strike at the same point.
const LIGHTNING_PANE = 'wrc-lightning';
const LIGHTNING_PANE_Z = 500;

interface Strike {
  ts: number;        // epoch ms when the strike occurred / was first seen
  lat: number;
  lon: number;
  // Epoch ms until which the fresh-bolt pulse animation runs. 0 = no
  // pulse (strike discovered already past its bolt window, pulses
  // disabled, or prefers-reduced-motion).
  pulseUntil: number;
}

export class LightningLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;

  private _strikes: Map<string, Strike> = new Map();

  private _canvas: HTMLCanvasElement | null = null;
  // Container-pixel padding the canvas extends beyond the viewport on
  // each side. Recomputed from the map size on every reposition.
  private _padX = 0;
  private _padY = 0;
  // The layer point the canvas's top-left is pinned to (what
  // DomUtil.setPosition was last given). All painting is done relative
  // to THIS, in layer coordinates — never container coordinates. Layer
  // points are drag-stable: during a pan Leaflet translates the pane
  // (carrying the canvas), so a repaint mid-drag (hass tick adding a
  // strike, pulse animation frame) must NOT also include the drag
  // delta. Painting at container coordinates did exactly that — the
  // delta applied twice and strikes moved at 2× drag speed until
  // moveend repositioned the canvas.
  private _originLayerPoint = { x: 0, y: 0 };
  // Single-flight flag for the rAF repaint. Multiple invalidations per
  // frame (hass tick + moveend + age timer) collapse into one paint.
  private _redrawQueued = false;

  // Offscreen buffer holding every SETTLED strike (older than the bolt
  // window at build time), so the common repaint is one drawImage blit
  // plus a handful of live bolts instead of O(strikes) glyph draws.
  // This is load-bearing at storm scale: every arriving strike runs a
  // 600 ms pulse animation = ~36 full repaints, and with thousands of
  // strikes on the map the un-buffered version repainted the whole set
  // continuously — observed live as a saturated, unresponsive main
  // thread under a 5000-strike stress config.
  //
  // Partition rule is pure timestamp arithmetic, no bookkeeping set:
  // the buffer contains strikes with ts <= _bufferMaxTs (computed as
  // build-time-now − BOLT_DURATION, so everything buffered is already
  // in its + phase); everything newer is drawn live on top each frame.
  // A strike that crosses the bolt→plus boundary simply keeps drawing
  // live (as a +) until the next rebuild folds it in — no visual gap.
  private _buffer: HTMLCanvasElement | null = null;
  private _bufferDirty = true;
  private _bufferMaxTs = 0;

  private _ageTimer: ReturnType<typeof setInterval> | null = null;
  // Set in pause(), cleared in resume(). Differs from the wildfire/alerts
  // pattern: there's no fetch to reschedule, just the age-recompute timer.
  private _pausedAt: number | null = null;

  // True while the container cursor is overridden to 'pointer' because
  // the mouse is over a strike. Tracked so we only touch style on change.
  private _hoverActive = false;
  private _hoverQueued = false;

  // Bound handlers kept as fields so clear() can detach exactly what
  // start() attached.
  private _onViewChange = (): void => this._repositionAndRedraw();
  private _onMapClick = (e: L.LeafletMouseEvent): void => this._handleClick(e);
  private _onMapMouseMove = (e: L.LeafletMouseEvent): void => this._handleMouseMove(e);

  constructor(
    map: L.Map,
    getConfig: () => WeatherRadarCardConfig,
    hass?: HomeAssistant,
  ) {
    this._map = map;
    this._getConfig = getConfig;
    this._hass = hass;
  }

  start(): void {
    this._ensurePane();
    this._ensureCanvas();
    // moveend covers pan AND zoom (Leaflet fires it after zoomend); the
    // explicit zoomend listener repaints one frame earlier so the
    // glyphs snap to their post-zoom positions as soon as the zoom
    // animation lands. resize re-pads the canvas for the new viewport.
    this._map.on('moveend', this._onViewChange);
    this._map.on('zoomend', this._onViewChange);
    this._map.on('resize', this._onViewChange);
    this._map.on('click', this._onMapClick);
    this._map.on('mousemove', this._onMapMouseMove);
    this._refreshFromHass();
    this._ageTimer = setInterval(() => this._refreshAges(), AGE_REFRESH_MS);
  }

  // Idempotent — Leaflet panes are sticky for the map's lifetime.
  // pointer-events stays 'none': all interaction goes through map-level
  // click/mousemove + the DIY hit test, so the canvas never intercepts
  // clicks meant for markers or hazard polygons.
  private _ensurePane(): void {
    if (this._map.getPane(LIGHTNING_PANE)) return;
    const pane = this._map.createPane(LIGHTNING_PANE);
    pane.style.zIndex = String(LIGHTNING_PANE_Z);
    pane.style.pointerEvents = 'none';
  }

  private _ensureCanvas(): void {
    if (this._canvas) return;
    const pane = this._map.getPane(LIGHTNING_PANE);
    if (!pane) return;
    this._canvas = document.createElement('canvas');
    this._canvas.style.position = 'absolute';
    pane.appendChild(this._canvas);
    this._repositionAndRedraw();
  }

  clear(): void {
    if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
    this._map.off('moveend', this._onViewChange);
    this._map.off('zoomend', this._onViewChange);
    this._map.off('resize', this._onViewChange);
    this._map.off('click', this._onMapClick);
    this._map.off('mousemove', this._onMapMouseMove);
    if (this._hoverActive) {
      this._hoverActive = false;
      this._map.getContainer().style.cursor = '';
    }
    this._canvas?.remove();
    this._canvas = null;
    this._buffer = null;
    this._bufferDirty = true;
    this._bufferMaxTs = 0;
    this._strikes.clear();
  }

  // Stop the age timer while the host card is hidden. The painted canvas
  // stays as-is (it'll repaint on the next visible tick). The strike-set
  // diff still runs on hass updates because the card's
  // IntersectionObserver doesn't gate updateHass calls — but a hidden
  // card receives few hass-update render passes anyway, so this is not
  // worth defensive guarding.
  pause(): void {
    if (this._pausedAt != null) return;
    this._pausedAt = Date.now();
    if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
  }

  // Resume after a pause. Always run an age pass immediately (the
  // painted strikes have aged during the hidden interval) and restart
  // the timer.
  resume(): void {
    if (this._pausedAt == null) return;
    this._pausedAt = null;
    this._refreshAges();
    if (!this._ageTimer) {
      this._ageTimer = setInterval(() => this._refreshAges(), AGE_REFRESH_MS);
    }
  }

  // Diff incoming hass against the current strike set. Hass updates fire
  // on every state change in the system — frequent — so a no-op tick
  // must be cheap: when nothing changed we never touch the canvas.
  updateHass(hass: HomeAssistant): void {
    this._hass = hass;
    this._refreshFromHass();
  }

  private _refreshFromHass(): void {
    const current = this._collectStrikes();
    let changed = false;

    for (const [id, strike] of current) {
      if (this._strikes.has(id)) continue;
      this._strikes.set(id, strike);
      changed = true;
      // A fresh strike (ts past the buffer cutoff) draws live — no
      // buffer rebuild. Only a strike that belongs IN the buffer
      // (discovered already old, e.g. backlog on card mount) dirties
      // it. This is what keeps steady-state storm cost flat: arrivals
      // don't trigger full-set repaints.
      if (strike.ts <= this._bufferMaxTs) this._bufferDirty = true;
    }

    // Removals: strikes we tracked that hass no longer has (integration
    // dropped them past its max-age cap). Removed strikes may be baked
    // into the buffer, so removals always rebuild it.
    for (const id of Array.from(this._strikes.keys())) {
      if (!current.has(id)) {
        this._strikes.delete(id);
        changed = true;
        this._bufferDirty = true;
      }
    }

    if (changed) this._scheduleRedraw();
  }

  // Walk hass.states once. Only entity_ids matching geo_location.* with
  // attributes.source === 'blitzortung' are strikes — the same entity
  // domain is used for earthquakes, fire perimeters, etc. so the source
  // attribute is the disambiguator. Strikes already past the
  // display-cap are filtered out at this stage so a freshly-mounted
  // card doesn't track strikes it would immediately drop.
  private _collectStrikes(): Map<string, Strike> {
    const out = new Map<string, Strike>();
    if (!this._hass?.states) return out;
    const maxAgeSec = this._displayMaxAgeSec();
    const now = Date.now();
    const pulseOk = this._getConfig().lightning_pulse !== false && !prefersReducedMotion();
    // for-in with an early prefix test rather than Object.entries: this
    // runs on EVERY hass tick (any state change in the whole install),
    // and Object.entries allocates a [key, value] pair array for
    // potentially thousands of entities each time. for-in touches only
    // the keys until the prefix matches — scales with installation
    // size, which entity-heavy installs hit several times per second.
    const states = this._hass.states as Record<string, unknown>;
    for (const id in states) {
      if (!id.startsWith('geo_location.')) continue;
      const st = states[id];
      const attrs = (st as any)?.attributes;
      if (!attrs || attrs.source !== 'blitzortung') continue;
      const lat = attrs.latitude;
      const lon = attrs.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      const ts = parseStrikeTimestamp(st);
      const ageSec = (now - ts) / 1000;
      if (ageSec > maxAgeSec) continue;
      // Pulse only for strikes still fresh at discovery — a strike we
      // first see well past its bolt window (card just mounted with
      // strikes already present) renders straight as a + with no flash.
      const pulseUntil = pulseOk && ageSec < BOLT_DURATION_SEC ? now + PULSE_MS : 0;
      out.set(id, { ts, lat, lon, pulseUntil });
    }
    return out;
  }

  // ── repaint pipeline ────────────────────────────────────────────────

  private _scheduleRedraw(): void {
    if (this._redrawQueued) return;
    this._redrawQueued = true;
    const raf: (cb: () => void) => void =
      typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => void setTimeout(cb, 16);
    raf(() => {
      this._redrawQueued = false;
      this._redraw();
    });
  }

  // Re-pad + re-position the canvas for the current viewport, then
  // repaint. Called on moveend/zoomend/resize; the canvas itself rides
  // the pane transform during the gesture, so mid-pan strikes stay
  // visually glued to geography and only the margin needs re-centring
  // here.
  private _repositionAndRedraw(): void {
    const canvas = this._canvas;
    if (!canvas) return;
    const size = this._map.getSize();
    if (size.x === 0 || size.y === 0) return;
    this._padX = Math.round(size.x * CANVAS_PAD_FRACTION);
    this._padY = Math.round(size.y * CANVAS_PAD_FRACTION);
    const w = size.x + 2 * this._padX;
    const h = size.y + 2 * this._padY;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    // Resizing a canvas clears it, so only touch the backing store when
    // the dimensions actually changed (repaint follows either way).
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    // Pin the canvas's top-left to the layer point that currently sits
    // at container point (-padX, -padY). DomUtil.setPosition is what
    // Leaflet's own canvas renderer uses — it survives the pane
    // transforms applied during pan/zoom animations.
    const origin = this._map.containerPointToLayerPoint([-this._padX, -this._padY]);
    this._originLayerPoint = { x: origin.x, y: origin.y };
    L.DomUtil.setPosition(canvas as unknown as HTMLElement, origin);
    this._bufferDirty = true;   // projected positions changed
    this._scheduleRedraw();
  }

  private _redraw(): void {
    const canvas = this._canvas;
    if (!canvas || canvas.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = (typeof devicePixelRatio === 'number' && devicePixelRatio > 0) ? devicePixelRatio : 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

    if (this._strikes.size === 0) return;

    const now = Date.now();
    const maxAgeSec = this._displayMaxAgeSec();
    const cfg = this._getConfig();
    const plusSize = cfg.lightning_icon_size ?? DEFAULT_ICON_SIZE_PX;
    const boltSize = Math.round(plusSize * BOLT_SIZE_RATIO);
    const wCss = canvas.width / dpr;
    const hCss = canvas.height / dpr;

    // Paint order: oldest → newest within each pass, so newer strikes
    // land on top — same convention the DOM markers achieved with
    // ts-derived zIndexOffset, matching Blitzortung's own web map.
    const ordered = this._drawOrder(now, maxAgeSec, wCss, hCss, boltSize);

    const plusPath = getPath2D(LIGHTNING_PLUS_PATH);
    const boltPath = getPath2D(LIGHTNING_BOLT_PATH);
    if (!plusPath || !boltPath) return;   // no Path2D (ancient browser) → skip painting

    // Rebuild the settled-strike buffer when invalidated (add-to-
    // backlog, removal, view change, age pass). Everything at or below
    // the cutoff is in its + phase by construction, so the buffer only
    // ever needs the two + passes.
    if (this._bufferDirty || !this._buffer
        || this._buffer.width !== canvas.width || this._buffer.height !== canvas.height) {
      this._buffer ??= document.createElement('canvas');
      this._buffer.width = canvas.width;     // resizing also clears
      this._buffer.height = canvas.height;
      const bctx = this._buffer.getContext('2d');
      if (bctx) {
        bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        this._bufferMaxTs = now - BOLT_DURATION_SEC * 1000;
        const settled = ordered.filter((d) => d.ts <= this._bufferMaxTs);
        this._paintPlusPasses(bctx, settled, plusPath, plusSize, maxAgeSec);
        this._bufferDirty = false;
      }
    }

    // Blit the settled set, then draw the live tail (strikes newer than
    // the buffer cutoff) on top. drawImage in CSS units undoes the
    // buffer's dpr scaling exactly.
    ctx.drawImage(this._buffer, 0, 0, wCss, hCss);
    const live = ordered.filter((d) => d.ts > this._bufferMaxTs);

    // Live + glyphs first (strikes that crossed bolt→plus since the
    // last rebuild), then bolts: a fresh strike always tops the stack.
    this._paintPlusPasses(ctx, live.filter((d) => !d.isBolt), plusPath, plusSize, maxAgeSec);

    // Bolts (first 30 s): white fill + red stroke, with a shadow halo
    // for contrast — affordable here because bolts are few (≤30 s old).
    // The pulse scales the glyph 2× → 1× over PULSE_MS, ease-out.
    let pulseActive = false;
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    ctx.shadowColor = '#000';
    ctx.shadowBlur = 2;
    ctx.fillStyle = '#fff';
    for (const d of live) {
      if (!d.isBolt) continue;
      let scale = 1;
      if (d.pulseUntil > now) {
        pulseActive = true;
        const t = 1 - (d.pulseUntil - now) / PULSE_MS;   // 0 → 1 over the pulse
        scale = 1 + (1 - t) * (1 - t);                   // 2 → 1, ease-out
      }
      this._drawGlyph(ctx, boltPath, d.x, d.y, boltSize, scale, 'both');
    }
    ctx.shadowBlur = 0;

    // A live pulse needs continuous frames until it lands; the
    // single-flight flag makes this a plain rAF animation loop that
    // stops itself when the last pulse expires. Each of those frames is
    // now a blit + the live tail, NOT a full-set repaint.
    if (pulseActive) this._scheduleRedraw();
  }

  // The two-pass + painter: all black outlines first, then all colour
  // fills, so that when many strikes pile up at one screen location the
  // outlines stack and merge harmlessly UNDER every colour fill — the
  // canvas equivalent of the old two-pane DOM split. No shadow halo:
  // with thousands of strikes per buffer build, canvas shadow blur is
  // the single most expensive state, and the solid black stroke already
  // separates the fills from any basemap.
  private _paintPlusPasses(
    ctx: CanvasRenderingContext2D,
    items: ReadonlyArray<{ x: number; y: number; ageSec: number }>,
    plusPath: Path2D,
    plusSize: number,
    maxAgeSec: number,
  ): void {
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1.5;   // viewBox units — context is scaled per-glyph below
    ctx.lineJoin = 'miter';
    for (const d of items) {
      this._drawGlyph(ctx, plusPath, d.x, d.y, plusSize, 1, 'stroke');
    }
    for (const d of items) {
      ctx.fillStyle = colorForAge(d.ageSec, maxAgeSec);
      this._drawGlyph(ctx, plusPath, d.x, d.y, plusSize, 1, 'fill');
    }
  }

  // Project every live strike to canvas pixels, drop the off-canvas
  // ones, and return them sorted oldest-first (painters algorithm:
  // newest ends up on top). Projection goes through LAYER points
  // relative to the canvas's pinned origin — see _originLayerPoint for
  // why container points are wrong here. @internal — exposed for
  // tests, which feed a stubbed map projection.
  _drawOrder(now: number, maxAgeSec: number, wCss: number, hCss: number, cullMarginPx: number):
    Array<{ x: number; y: number; ts: number; ageSec: number; isBolt: boolean; pulseUntil: number }> {
    const out: Array<{ x: number; y: number; ts: number; ageSec: number; isBolt: boolean; pulseUntil: number }> = [];
    for (const s of this._strikes.values()) {
      const ageSec = Math.max(0, (now - s.ts) / 1000);
      if (ageSec > maxAgeSec) continue;
      const lp = this._map.latLngToLayerPoint([s.lat, s.lon]);
      const x = lp.x - this._originLayerPoint.x;
      const y = lp.y - this._originLayerPoint.y;
      // Guard against a non-finite projection (bad integration lat/lon
      // near ±90, or a redraw before the map CRS is ready): NaN passes
      // every cull comparison below (all NaN comparisons are false) and
      // would reach ctx.translate(NaN, …), so drop the point here.
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < -cullMarginPx || y < -cullMarginPx || x > wCss + cullMarginPx || y > hCss + cullMarginPx) continue;
      out.push({ x, y, ts: s.ts, ageSec, isBolt: ageSec < BOLT_DURATION_SEC, pulseUntil: s.pulseUntil });
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  // Draw one 24×24-viewBox glyph centred at (x, y) at `size` CSS px,
  // optionally pulse-scaled. The context scale maps viewBox units to
  // pixels, so stroke widths set in viewBox units render identically
  // to the old SVG markers at any icon size.
  private _drawGlyph(
    ctx: CanvasRenderingContext2D,
    path: Path2D,
    x: number, y: number,
    sizePx: number, pulseScale: number,
    mode: 'fill' | 'stroke' | 'both',
  ): void {
    const s = (sizePx * pulseScale) / 24;
    ctx.save();
    ctx.translate(x - (sizePx * pulseScale) / 2, y - (sizePx * pulseScale) / 2);
    ctx.scale(s, s);
    if (mode !== 'stroke') ctx.fill(path);
    if (mode !== 'fill') ctx.stroke(path);
    ctx.restore();
  }

  // ── interaction ─────────────────────────────────────────────────────

  /**
   * Hit-test a container point against the live strikes: the MOST
   * RECENT strike within tolerance wins, not the nearest. User decision
   * — when several strikes overlap at storm density, the fresh strike
   * is the one the user is reacting to. @internal — exposed for tests.
   */
  _hitTest(pt: { x: number; y: number }, tolerancePx: number = HIT_TOLERANCE_PX): string | null {
    const tol2 = tolerancePx * tolerancePx;
    let bestId: string | null = null;
    let bestTs = -Infinity;
    for (const [id, s] of this._strikes) {
      const p = this._map.latLngToContainerPoint([s.lat, s.lon]);
      const dx = p.x - pt.x;
      const dy = p.y - pt.y;
      if (dx * dx + dy * dy > tol2) continue;
      if (s.ts > bestTs) { bestTs = s.ts; bestId = id; }
    }
    return bestId;
  }

  private _handleClick(e: L.LeafletMouseEvent): void {
    const id = this._hitTest(e.containerPoint);
    if (!id) return;
    const strike = this._strikes.get(id);
    if (!strike) return;
    // Anchored at the strike, not the click point, so the popup tail
    // points at the glyph the user hit. openOn closes any other open
    // popup (Leaflet's one-popup convention), matching marker behaviour.
    L.popup({ autoPan: true, autoPanPadding: L.point(12, 12), maxHeight: this._popupMaxHeight() } as any)
      .setLatLng([strike.lat, strike.lon])
      .setContent(this._popupHtml(strike))
      .openOn(this._map);
  }

  // Pointer-cursor affordance over strikes — what the DOM markers got
  // for free from CSS. rAF-throttled: mousemove can fire faster than
  // frames, and each test projects every strike.
  private _handleMouseMove(e: L.LeafletMouseEvent): void {
    if (this._hoverQueued) return;
    this._hoverQueued = true;
    const pt = e.containerPoint;
    const raf: (cb: () => void) => void =
      typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => void setTimeout(cb, 16);
    raf(() => {
      this._hoverQueued = false;
      if (!this._canvas) return;   // cleared while queued
      const over = this._hitTest(pt) != null;
      if (over === this._hoverActive) return;
      this._hoverActive = over;
      // Inline style wins over Leaflet's grab-cursor classes and is
      // cleared (not set to a value) when leaving, so dragging cursors
      // behave normally everywhere off-strike.
      this._map.getContainer().style.cursor = over ? 'pointer' : '';
    });
  }

  // Expire strikes past the display cap and repaint (the repaint itself
  // recomputes every fill colour from current age). The Blitzortung
  // integration may still hold the underlying entities — its own
  // max-age is the upper bound; we just stop rendering.
  private _refreshAges(): void {
    const max = this._displayMaxAgeSec();
    const now = Date.now();
    for (const [id, strike] of this._strikes) {
      if ((now - strike.ts) / 1000 > max) this._strikes.delete(id);
    }
    // Always rebuild: buffered fill colours age (30 s gradient steps)
    // and strikes that crossed bolt→plus since the last build get
    // folded into the buffer here.
    this._bufferDirty = true;
    this._scheduleRedraw();
  }

  // Build the popup HTML. Inline-styled because Leaflet's popup container
  // lives outside the card's shadow root, so the card's CSS doesn't apply.
  // Built fresh per click so distance + relative time are current.
  private _popupHtml(strike: Strike): string {
    const center = this._map.getCenter();
    const distKm = haversineKm(center.lat, center.lng, strike.lat, strike.lon);
    const bearing = bearingCardinal(center.lat, center.lng, strike.lat, strike.lon);
    const ageSec = Math.max(0, (Date.now() - strike.ts) / 1000);
    const rel = relativeTime(ageSec);

    const distLabel = `${formatDistance(distKm, this._hass?.config?.unit_system?.length)} ${localize(`ui.lightning.bearing.${bearing}`)}`;
    const relLabel = rel.key === 'just_now'
      ? localize('ui.lightning.relative.just_now')
      : localize(`ui.lightning.relative.${rel.key}`).replace('{n}', String(rel.n));

    const url = formatBlitzortungUrl(this._map.getZoom(), strike.lat, strike.lon);

    return `
      <div style="font:12px/1.5 'Helvetica Neue',Arial,sans-serif;min-width:160px">
        <div style="font-weight:bold;font-size:13px;margin-bottom:4px">${escapeHtml(localize('ui.lightning.popup_title'))}</div>
        <div>${escapeHtml(distLabel)}</div>
        <div>${escapeHtml(relLabel)}</div>
        <div style="margin-top:6px;font-size:10px;color:#666">${escapeHtml(localize('ui.lightning.source_label'))}</div>
        <div style="margin-top:4px"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize('ui.lightning.more_info'))}</a></div>
      </div>
    `;
  }

  private _popupMaxHeight(): number {
    return Math.max(160, Math.floor(this._map.getSize().y * 0.8));
  }

  // The effective max-age the card uses for both filtering (don't
  // render past this) and the colour gradient denominator. Returns
  // min(card cap, integration max). The card cap defaults to 30 min;
  // overridable via cfg.lightning_max_age_minutes. We never EXCEED
  // the integration's max-age — there's no point pretending strikes
  // exist that the integration has already dropped from hass.states.
  private _displayMaxAgeSec(): number {
    const cfg = this._getConfig();
    const cardCapMin = cfg.lightning_max_age_minutes ?? DEFAULT_MAX_AGE_MIN;
    // Floor at 1 min to keep the gradient meaningful and avoid silly
    // configs like 0 or negative values blanking the layer entirely.
    const cardCapSec = Math.max(60, cardCapMin * 60);
    return Math.min(cardCapSec, this._maxAgeSec());
  }

  // Try to pull the user's actual configured Blitzortung max-age out of
  // the integration's distance sensor's attributes. The integration
  // exposes a few config knobs there in some versions; if not present
  // we fall back to the integration's current default. See Open
  // Question 1 in docs/lightning-feature-design.md.
  private _maxAgeSec(): number {
    const dist = this._hass?.states?.['sensor.blitzortung_lightning_distance'];
    const attrs = (dist as any)?.attributes;
    // The integration historically exposed a 'window' attribute on this
    // sensor; newer versions may not. Be permissive and accept any of
    // the plausible names without committing to a specific schema.
    const candidates = [attrs?.window, attrs?.max_age, attrs?.max_age_seconds];
    for (const v of candidates) {
      if (typeof v === 'number' && v > 0) return v;
    }
    return DEFAULT_BLITZORTUNG_MAX_AGE_SEC;
  }
}

// Path2D objects compiled once from the same SVG path strings the DOM
// markers used (Path2D accepts SVG path data directly). Cached at module
// level; null where Path2D is unavailable (no modern browser lacks it,
// but jsdom-ish test environments might).
const path2dCache = new Map<string, Path2D | null>();
function getPath2D(svgPath: string): Path2D | null {
  let p = path2dCache.get(svgPath);
  if (p === undefined) {
    p = typeof Path2D === 'function' ? new Path2D(svgPath) : null;
    path2dCache.set(svgPath, p);
  }
  return p;
}

// Cache the MediaQueryList — matchMedia allocates per call and this is
// consulted on every hass tick that carries a new strike.
let reducedMotionMql: MediaQueryList | null | undefined;
function prefersReducedMotion(): boolean {
  if (reducedMotionMql === undefined) {
    reducedMotionMql = typeof matchMedia === 'function'
      ? matchMedia('(prefers-reduced-motion: reduce)')
      : null;
  }
  return reducedMotionMql?.matches ?? false;
}

// Pull the strike's first-seen timestamp out of the entity state. The
// Blitzortung integration writes a publication_date attribute; if it's
// absent (older versions / future schema changes), fall back to the
// state's last_changed which is set when HA first saw the entity. The
// resolved value is epoch ms.
function parseStrikeTimestamp(state: any): number {
  const pub = state?.attributes?.publication_date;
  if (typeof pub === 'string') {
    const t = Date.parse(pub);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof pub === 'number') {
    // Heuristic: if the number is in seconds (10 digits), promote to ms.
    return pub < 1e12 ? pub * 1000 : pub;
  }
  const lc = state?.last_changed;
  if (typeof lc === 'string') {
    const t = Date.parse(lc);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
