import * as L from 'leaflet';
import { HomeAssistant, formatDateTime } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { Z_EARTHQUAKES } from './const';
import { localize } from './localize/localize';
import { haversineKm, lngNear } from './geo-utils';
import { escapeHtml } from './string-utils';
import { onMapQuiet } from './map-quiet';
import { hideElementWhileZooming } from './hide-while-zooming';
import { refreshOverrideMs } from './refresh-override';
import { DATA_TIMEOUT_MS, withTimeout } from './fetch-timeout';
import { lightningCanvasDpr, lightningCanvasPad } from './lightning-layer';
import { agoText, formatCount } from './popup-format';

// Earthquake overlay: USGS real-time summary feeds, drawn on one canvas.
// See docs/earthquake-feature-design.md.
//
// Feeds, not the FDSN query: USGS asks automated applications to use the
// feeds, and every card asks for the same feed URLs, which stay in the USGS
// CDN cache. A query with each card's own area and start time misses it.
//
// Canvas in its own pane, as for lightning (lightning-layer.ts has the
// reasons): the month feed with all magnitudes holds about 10,000 events,
// too many DOM markers, and a second Leaflet canvas renderer over the shared
// one would take the clicks meant for alert and fire outlines. The pane
// ignores pointer events; a map click hit-tests the drawn events.

const FEED_BASE = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const DOCS_EARTHQUAKES_URL = 'https://github.com/jpettitt/weather-radar-card/blob/main/docs/overlays.md#earthquakes';
const TSUNAMI_URL = 'https://www.tsunami.gov';

export const EARTHQUAKE_PERIODS = ['hour', 'day', 'week', 'month'] as const;
export type EarthquakePeriod = typeof EARTHQUAKE_PERIODS[number];
export const DEFAULT_MIN_MAGNITUDE = 2.5;
export const DEFAULT_PERIOD: EarthquakePeriod = 'day';

// Feed levels, highest first. USGS puts an event in a level's feed when its
// magnitude rounded to one decimal is at least the level: 2.46 is in
// 2.5_week, 0.95 in 1.0_week (probed 2026-11-24).
const FEED_LEVELS: ReadonlyArray<readonly [number, string]> = [[4.5, '4.5'], [2.5, '2.5'], [1, '1.0']];

// The feeds change every minute (max-age=60), so a shorter refresh gets
// nothing new.
const DEFAULT_REFRESH_MS = 5 * 60_000;
const MIN_REFRESH_MS = 60_000;
const MAX_RETRY_MS = 60 * 60_000;

// Marker style of the USGS Latest Earthquakes map, read from its code
// (main bundle, 2026-11-24). Values measured from a screenshot of its legend
// were wrong: the screenshot was at 2x and colour-managed.
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// Age classes past hour, day, week, month, older; an age equal to a limit
// is still in that class.
const AGE_LIMITS_MS = [HOUR_MS, DAY_MS, 7 * DAY_MS, 30 * DAY_MS];
export const AGE_COLORS = ['#ff0000', '#ff9900', '#ffff00', '#ffffff', '#cccccc'];
const OUTLINE_LIGHT_MAP = '#000000';
const OUTLINE_WIDTH_PX = 0.5;
// USGS draws black on every map; on a dark map that disappears.
const OUTLINE_DARK_MAP = '#e0e0e0';
// Diameters for magnitude classes 0, 1, … 7+, one table for each zoom band.
const MAG_DIAMETERS_LOW_ZOOM = [5, 7, 9, 11, 13, 17, 21, 25];      // zoom < 5
const MAG_DIAMETERS_MID_ZOOM = [8, 10, 12, 14, 17, 22, 27, 32];    // 5 <= zoom < 8
const MAG_DIAMETERS_HIGH_ZOOM = [12, 13, 15, 17, 19, 24, 30, 36];  // zoom >= 8
// Touch slop for the small markers.
const MIN_HIT_RADIUS_PX = 10;
// A setTimeout over 2^31-1 ms fires at once; the age repaint never waits
// longer than this.
const MAX_AGE_WAIT_MS = HOUR_MS;

const EARTHQUAKE_PANE = 'wrc-earthquakes';

export interface Quake {
  id: string;
  lat: number;
  lon: number;
  depthKm: number | null;
  mag: number;
  time: number;            // origin time, ms since the epoch
  type: string;            // 'earthquake', 'quarry blast', 'explosion', …
  place: string | null;
  url: string | null;      // the USGS event page
  felt: number | null;     // "Did You Feel It?" reports
  alert: string | null;    // PAGER level: green, yellow, orange, red
  tsunami: boolean;
  status: string | null;   // automatic or reviewed
}

/** The config's magnitude and period, with the defaults for missing or bad values. */
export function earthquakeSettings(cfg: WeatherRadarCardConfig): { minMagnitude: number; period: EarthquakePeriod } {
  const m = cfg.earthquake_min_magnitude;
  const p = cfg.earthquake_period;
  return {
    minMagnitude: typeof m === 'number' && Number.isFinite(m) ? m : DEFAULT_MIN_MAGNITUDE,
    period: (EARTHQUAKE_PERIODS as readonly string[]).includes(p as string) ? p as EarthquakePeriod : DEFAULT_PERIOD,
  };
}

/** The smallest USGS feed that holds every event at or above `minMagnitude`. */
export function earthquakeFeedUrl(minMagnitude: number, period: EarthquakePeriod): string {
  const level = FEED_LEVELS.find(([m]) => minMagnitude >= m)?.[1] ?? 'all';
  return `${FEED_BASE}${level}_${period}.geojson`;
}

/** The feeds' own test, so that a 2.46 in the 2.5 feed is kept at 2.5. */
export function meetsMinMagnitude(mag: number, minMagnitude: number): boolean {
  return Math.round(mag * 10) / 10 >= minMagnitude;
}

/** 0 hour, 1 day, 2 week, 3 month, 4 older. */
export function ageClass(ageMs: number): number {
  const i = AGE_LIMITS_MS.findIndex((limit) => ageMs <= limit);
  return i === -1 ? AGE_LIMITS_MS.length : i;
}

// USGS puts a magnitude of exactly 0, and negative ones, in class 1; the card
// keeps every magnitude below 1 in class 0.
export function markerDiameter(mag: number, zoom: number): number {
  const table = zoom < 5 ? MAG_DIAMETERS_LOW_ZOOM : zoom < 8 ? MAG_DIAMETERS_MID_ZOOM : MAG_DIAMETERS_HIGH_ZOOM;
  return table[Math.min(table.length - 1, Math.max(0, Math.floor(mag)))];
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
// Feed data goes into an href: only https links, never javascript: or data:.
const httpsUrl = (v: unknown): string | null => (typeof v === 'string' && /^https:\/\//i.test(v) ? v : null);

/** The usable events of a USGS GeoJSON feed. An event without a position, magnitude or time is left out. */
export function parseQuakes(data: unknown): Quake[] {
  const features = (data as { features?: unknown } | null)?.features;
  if (!Array.isArray(features)) return [];
  const out: Quake[] = [];
  type RawFeature = { id?: unknown; geometry?: { type?: unknown; coordinates?: unknown }; properties?: Record<string, unknown> };
  for (const f of features as Array<RawFeature | null>) {
    const g = f?.geometry;
    const p = f?.properties;
    if (g?.type !== 'Point' || !Array.isArray(g.coordinates) || !p) continue;
    const [lon, lat, depth] = g.coordinates as unknown[];
    const { mag, time } = p;
    if (!isNum(lon) || !isNum(lat) || !isNum(mag) || !isNum(time)) continue;
    const id = str(f?.id);
    if (!id) continue;
    out.push({
      id, lat, lon,
      depthKm: isNum(depth) ? depth : null,
      mag,
      time,
      type: str(p.type) ?? 'earthquake',
      place: str(p.place),
      url: httpsUrl(p.url),
      felt: isNum(p.felt) ? p.felt : null,
      alert: str(p.alert),
      tsunami: p.tsunami === 1,
      status: str(p.status),
    });
  }
  return out;
}

// When the next drawn event moves to an older age class, or null.
function nextAgeChange(quakes: readonly Quake[], now: number): number | null {
  let soonest = Infinity;
  for (const q of quakes) {
    const limit = AGE_LIMITS_MS.find((l) => now - q.time <= l);
    if (limit !== undefined) soonest = Math.min(soonest, q.time + limit + 1);
  }
  return Number.isFinite(soonest) ? soonest : null;
}

interface Drawn {
  q: Quake;
  d: number;   // diameter, CSS px
}

export class EarthquakeLayer {
  private _quakes: Quake[] = [];
  // What the last paint drew, bottom to top: the hit test takes the topmost.
  private _drawn: Drawn[] = [];

  private _canvas: HTMLCanvasElement | null = null;
  private _padX = 0;
  private _padY = 0;
  // The layer point the canvas's top-left is pinned to; see the same field
  // in lightning-layer.ts for why painting uses layer points.
  private _originLayerPoint = { x: 0, y: 0 };
  private _redrawQueued = false;
  private _popup: L.Popup | null = null;
  private _hoverActive = false;
  private _hoverQueued = false;

  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _ageTimer: ReturnType<typeof setTimeout> | null = null;
  // Set while the card is hidden. The armed fetch keeps only its due time.
  private _pausedAt: number | null = null;
  // When the armed fetch is due, kept across a pause; null while one runs.
  private _dueAt: number | null = null;
  // A response from an older generation (superseded or torn down) is dropped.
  private _gen = 0;
  private _failureCount = 0;
  private _abortCtrl: AbortController | null = null;
  private _disposeQuiet: (() => void) | null = null;
  private _disposeHide: (() => void) | null = null;

  private _onViewChange = (): void => this._repositionAndRedraw();
  // A same-zoom jump past the map size resets the pixel origin without a
  // zoomstart; hide the old view's pixels until the quiet repaint shows them.
  private _onViewReset = (): void => { if (this._canvas) this._canvas.style.display = 'none'; };
  private _onMapClick = (e: L.LeafletMouseEvent): void => this._handleClick(e);
  private _onMapMouseMove = (e: L.LeafletMouseEvent): void => this._handleMouseMove(e);

  constructor(
    private readonly _map: L.Map,
    private readonly _getConfig: () => WeatherRadarCardConfig,
    private readonly _getHass: () => HomeAssistant | undefined,
    private readonly _isDarkMap: () => boolean,
  ) {}

  start(): void {
    this._ensurePane();
    this._ensureCanvas();
    // The repaint waits until the map has been still for a second, and the
    // canvas leaves the page while the map zooms (iPhone memory; see
    // map-quiet.ts and hide-while-zooming.ts).
    this._disposeQuiet = onMapQuiet(this._map, this._onViewChange);
    this._disposeHide = hideElementWhileZooming(this._map, () => this._canvas ?? undefined);
    this._map.on('viewreset', this._onViewReset);
    this._map.on('resize', this._onViewChange);
    this._map.on('click', this._onMapClick);
    this._map.on('mousemove', this._onMapMouseMove);
    void this._fetch();
  }

  clear(): void {
    this._gen++;
    this._dueAt = null;
    this._abortCtrl?.abort();
    this._abortCtrl = null;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._ageTimer) { clearTimeout(this._ageTimer); this._ageTimer = null; }
    if (this._popup) { this._map.closePopup(this._popup); this._popup = null; }
    this._disposeQuiet?.();
    this._disposeQuiet = null;
    this._disposeHide?.();
    this._disposeHide = null;
    this._map.off('viewreset', this._onViewReset);
    this._map.off('resize', this._onViewChange);
    this._map.off('click', this._onMapClick);
    this._map.off('mousemove', this._onMapMouseMove);
    if (this._hoverActive) {
      this._hoverActive = false;
      this._map.getContainer().style.cursor = '';
    }
    this._canvas?.remove();
    this._canvas = null;
    this._quakes = [];
    this._drawn = [];
  }

  // While the card is hidden: no fetches and no age repaints. With
  // preload_while_hidden the fetches go on, as for wildfires and alerts.
  pause(): void {
    if (this._getConfig().preload_while_hidden) return;
    if (this._pausedAt != null) return;
    this._pausedAt = Date.now();
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._ageTimer) { clearTimeout(this._ageTimer); this._ageTimer = null; }
  }

  // Fetch now if the next refresh came due while hidden, else wait only what
  // is left of it. Restarting the full interval at each show starved the
  // refresh when the card was hidden and shown more often (PR 336 review).
  resume(): void {
    if (this._pausedAt == null) return;
    this._pausedAt = null;
    // The events have aged, and the view may have moved.
    this._scheduleRedraw();
    // null: a fetch is in flight, and its end arms the next one.
    if (this._dueAt === null) return;
    const left = this._dueAt - Date.now();
    if (left <= 0) void this._fetch();
    else this._timer = setTimeout(() => void this._fetch(), left);
  }

  private async _fetch(): Promise<void> {
    const myGen = ++this._gen;
    this._dueAt = null;
    this._abortCtrl?.abort();
    const ctrl = new AbortController();
    this._abortCtrl = ctrl;
    const { minMagnitude, period } = earthquakeSettings(this._getConfig());
    let quakes: Quake[] | null;
    try {
      // Default HTTP caching: the feed's max-age=60 is never longer than the
      // refresh floor. A time limit rejects with TimeoutError, not
      // AbortError, so a request that never answers takes the retry path.
      const data = await withTimeout(DATA_TIMEOUT_MS, ctrl.signal, async (signal) => {
        const res = await fetch(earthquakeFeedUrl(minMagnitude, period), { signal });
        if (!res.ok) throw new Error(`USGS feed ${res.status}`);
        return await res.json() as unknown;
      });
      quakes = parseQuakes(data).filter((q) => meetsMinMagnitude(q.mag, minMagnitude));
    } catch (err) {
      // Superseded or torn down: whoever aborted owns what comes next.
      if ((err as Error)?.name === 'AbortError') return;
      console.warn('Earthquake layer: USGS feed fetch failed', err);
      quakes = null;
    }
    if (myGen !== this._gen) return;
    if (this._abortCtrl === ctrl) this._abortCtrl = null;
    if (quakes === null) {
      // Keep what is drawn, and back off: 1x, 2x, 4x the interval, up to 1 h.
      this._failureCount++;
      this._arm(Math.min(this._refreshMs() * 2 ** Math.min(this._failureCount - 1, 10), MAX_RETRY_MS));
      return;
    }
    this._failureCount = 0;
    this._quakes = quakes;
    this._scheduleRedraw();
    this._arm(this._refreshMs());
  }

  private _refreshMs(): number {
    return refreshOverrideMs(this._getConfig().earthquake_refresh_minutes, 60_000, MIN_REFRESH_MS) ?? DEFAULT_REFRESH_MS;
  }

  // Arm the next fetch. While paused only its due time is kept: a fetch in
  // flight when pause() ran ends here, and resume() arms what is left.
  private _arm(ms: number): void {
    this._dueAt = Date.now() + ms;
    if (this._pausedAt != null) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => void this._fetch(), ms);
  }

  // ── canvas ────────────────────────────────────────────────────────────

  // Idempotent: Leaflet panes last as long as the map.
  private _ensurePane(): void {
    if (this._map.getPane(EARTHQUAKE_PANE)) return;
    const pane = this._map.createPane(EARTHQUAKE_PANE);
    pane.style.zIndex = String(Z_EARTHQUAKES);
    pane.style.pointerEvents = 'none';
  }

  private _ensureCanvas(): void {
    if (this._canvas) return;
    const pane = this._map.getPane(EARTHQUAKE_PANE);
    if (!pane) return;
    this._canvas = document.createElement('canvas');
    this._canvas.style.position = 'absolute';
    pane.appendChild(this._canvas);
    this._repositionAndRedraw();
  }

  private _scheduleRedraw(): void {
    if (this._redrawQueued || this._pausedAt != null) return;
    this._redrawQueued = true;
    const raf: (cb: () => void) => void = typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(cb)
      : (cb) => void setTimeout(cb, 16);
    raf(() => {
      this._redrawQueued = false;
      this._redraw();
    });
  }

  // Re-pad and re-pin the canvas for the current view, then repaint. The
  // same steps as LightningLayer._repositionAndRedraw.
  private _repositionAndRedraw(): void {
    const canvas = this._canvas;
    if (!canvas) return;
    const size = this._map.getSize();
    if (size.x === 0 || size.y === 0) return;
    const pad = lightningCanvasPad((navigator.maxTouchPoints ?? 0) > 0);
    this._padX = Math.round(size.x * pad);
    this._padY = Math.round(size.y * pad);
    const w = size.x + 2 * this._padX;
    const h = size.y + 2 * this._padY;
    const dpr = lightningCanvasDpr(typeof devicePixelRatio === 'number' ? devicePixelRatio : undefined);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    const origin = this._map.containerPointToLayerPoint([-this._padX, -this._padY]);
    this._originLayerPoint = { x: origin.x, y: origin.y };
    L.DomUtil.setPosition(canvas as unknown as HTMLElement, origin);
    this._scheduleRedraw();
  }

  private _redraw(): void {
    const canvas = this._canvas;
    if (!canvas || canvas.width === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = lightningCanvasDpr(typeof devicePixelRatio === 'number' ? devicePixelRatio : undefined);
    const wCss = canvas.width / dpr;
    const hCss = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, wCss, hCss);

    const now = Date.now();
    const drawn = this._drawOrder();
    const centreLng = this._map.getCenter().lng;
    ctx.lineWidth = OUTLINE_WIDTH_PX;
    ctx.strokeStyle = this._isDarkMap() ? OUTLINE_DARK_MAP : OUTLINE_LIGHT_MAP;
    const kept: Drawn[] = [];
    for (const item of drawn) {
      // The world copy in view, not the feed's -180..180 one.
      const lp = this._map.latLngToLayerPoint([item.q.lat, lngNear(item.q.lon, centreLng)]);
      const x = lp.x - this._originLayerPoint.x;
      const y = lp.y - this._originLayerPoint.y;
      const r = item.d / 2;
      // A non-finite projection passes every comparison below as false.
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (x < -r || y < -r || x > wCss + r || y > hCss + r) continue;
      ctx.fillStyle = AGE_COLORS[ageClass(now - item.q.time)];
      ctx.beginPath();
      if (item.q.type === 'earthquake') {
        ctx.arc(x, y, r, 0, Math.PI * 2);
      } else {
        // The USGS map's shape for other events: a diamond.
        ctx.moveTo(x, y - r);
        ctx.lineTo(x + r, y);
        ctx.lineTo(x, y + r);
        ctx.lineTo(x - r, y);
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke();
      kept.push(item);
    }
    this._drawn = kept;
    this._armAgeRepaint(now);
  }

  // Bottom to top: large under small, so a small event inside a large one's
  // circle stays visible; then older under newer. Applies the radius filter.
  // @internal: exposed for tests.
  _drawOrder(): Drawn[] {
    const r = this._getConfig().earthquake_radius_km;
    const radiusKm = isNum(r) && r > 0 ? r : null;
    const centre = radiusKm !== null ? this._map.getCenter() : null;
    const zoom = this._map.getZoom();
    const out: Drawn[] = [];
    for (const q of this._quakes) {
      if (centre && radiusKm !== null && haversineKm(centre.lat, centre.lng, q.lat, q.lon) > radiusKm) continue;
      out.push({ q, d: markerDiameter(q.mag, zoom) });
    }
    out.sort((a, b) => b.d - a.d || a.q.time - b.q.time);
    return out;
  }

  // Repaint when the next event changes colour.
  private _armAgeRepaint(now: number): void {
    if (this._ageTimer) { clearTimeout(this._ageTimer); this._ageTimer = null; }
    if (this._pausedAt != null) return;
    const next = nextAgeChange(this._quakes, now);
    if (next === null) return;
    const wait = Math.min(MAX_AGE_WAIT_MS, Math.max(1000, next - now));
    this._ageTimer = setTimeout(() => {
      this._ageTimer = null;
      this._scheduleRedraw();
    }, wait);
  }

  // ── interaction ───────────────────────────────────────────────────────

  /**
   * The largest drawn event under a container point; the newer one on a
   * tie. Owner decision: small markers are drawn over large ones, and
   * "topmost wins" opened an M1.0 for a click on the centre of an M5.
   * @internal: exposed for tests.
   */
  _hitTest(pt: { x: number; y: number }): Quake | null {
    let best: Quake | null = null;
    const centreLng = this._map.getCenter().lng;
    for (const { q, d } of this._drawn) {
      const p = this._map.latLngToContainerPoint([q.lat, lngNear(q.lon, centreLng)]);
      const r = Math.max(d / 2 + 1, MIN_HIT_RADIUS_PX);
      if ((p.x - pt.x) ** 2 + (p.y - pt.y) ** 2 > r * r) continue;
      if (!best || q.mag > best.mag || (q.mag === best.mag && q.time > best.time)) best = q;
    }
    return best;
  }

  // The popup is not bound to a drawn shape, so a refresh or repaint never
  // closes it. Its text is built when it opens.
  private _handleClick(e: L.LeafletMouseEvent): void {
    const q = this._hitTest(e.containerPoint);
    if (!q) return;
    this._popup = L.popup({
      autoPan: true,
      autoPanPadding: L.point(12, 12),
      maxHeight: Math.max(200, Math.floor(this._map.getSize().y * 0.8)),
    })
      .setLatLng([q.lat, lngNear(q.lon, this._map.getCenter().lng)])
      .setContent(buildPopupHtml(q, this._getHass()))
      .openOn(this._map);
  }

  // Pointer cursor over an event, rAF-throttled as in lightning-layer.ts.
  private _handleMouseMove(e: L.LeafletMouseEvent): void {
    if (this._hoverQueued) return;
    this._hoverQueued = true;
    const pt = e.containerPoint;
    const raf: (cb: () => void) => void = typeof requestAnimationFrame === 'function'
      ? (cb) => requestAnimationFrame(cb)
      : (cb) => void setTimeout(cb, 16);
    raf(() => {
      this._hoverQueued = false;
      if (!this._canvas) return;
      const over = this._hitTest(pt) != null;
      if (over === this._hoverActive) return;
      this._hoverActive = over;
      this._map.getContainer().style.cursor = over ? 'pointer' : '';
    });
  }
}

// ── popup ───────────────────────────────────────────────────────────────

const STATUS_KEYS: Record<string, string> = {
  automatic: 'ui.earthquake.status_automatic',
  reviewed: 'ui.earthquake.status_reviewed',
};
const ALERT_KEYS: Record<string, string> = {
  green: 'ui.earthquake.alert_green',
  yellow: 'ui.earthquake.alert_yellow',
  orange: 'ui.earthquake.alert_orange',
  red: 'ui.earthquake.alert_red',
};
const ALERT_SWATCH: Record<string, string> = {
  green: '#2e7d32', yellow: '#f9a825', orange: '#ef6c00', red: '#c62828',
};

const KM_TO_MILES = 0.621371;

function formatDepth(km: number, lengthUnit: string | undefined, lang: string): string {
  const miles = lengthUnit === 'mi';
  let n: string;
  try {
    n = new Intl.NumberFormat(lang, { maximumFractionDigits: 1 }).format(miles ? km * KM_TO_MILES : km);
  } catch {
    n = (miles ? km * KM_TO_MILES : km).toFixed(1);
  }
  return `${n} ${miles ? 'mi' : 'km'}`;
}

export function buildPopupHtml(q: Quake, hass: HomeAssistant | undefined, nowMs = Date.now()): string {
  const locale = hass?.locale;
  const lang = locale?.language ?? navigator.language;
  const row = (labelKey: string, value: string): string =>
    `<div><b>${escapeHtml(localize(labelKey))}:</b> ${escapeHtml(value)}</div>`;

  const date = new Date(q.time);
  const when = `${locale ? formatDateTime(date, locale) : date.toLocaleString()} (${agoText(q.time, nowMs, lang)})`;
  // Own keys only: a feed value such as 'constructor' finds an inherited
  // member (see src/localize/EGM.md).
  const statusKey = q.status && Object.hasOwn(STATUS_KEYS, q.status) ? STATUS_KEYS[q.status] : undefined;
  const alert = q.alert && Object.hasOwn(ALERT_KEYS, q.alert) ? q.alert : null;
  // Feed text other than 'earthquake' is shown as sent, first letter up.
  const typeText = q.type === 'earthquake' ? '' : ` · ${q.type.charAt(0).toUpperCase()}${q.type.slice(1)}`;

  const rows = [
    row('ui.earthquake.time', when),
    q.depthKm !== null ? row('ui.earthquake.depth', formatDepth(q.depthKm, hass?.config?.unit_system?.length, lang)) : '',
    q.status ? row('ui.earthquake.status', statusKey ? localize(statusKey) : q.status) : '',
    q.felt ? row('ui.earthquake.felt', formatCount(q.felt, lang)) : '',
    alert
      ? `<div><b>${escapeHtml(localize('ui.earthquake.alert'))}:</b> <span style="display:inline-block;width:9px;height:9px;border-radius:50%;background:${ALERT_SWATCH[alert]};margin-right:3px"></span>${escapeHtml(localize(ALERT_KEYS[alert]))}</div>`
      : '',
  ].join('');
  // USGS's old definition says "large events in oceanic regions", but the
  // feed also sets it inland (2026-11-24: Pinnacles CA M5.0, Commerce CA
  // M3.9, Carhuamayo Peru M6.7). Say only that USGS links the event to
  // tsunami information; tsunami.gov is the authoritative source.
  const tsunami = q.tsunami
    ? `<div style="margin-top:4px">${escapeHtml(localize('ui.earthquake.tsunami'))} <a href="${TSUNAMI_URL}" target="_blank" rel="noopener noreferrer">tsunami.gov</a></div>`
    : '';
  const link = q.url
    ? `<div style="margin-top:4px"><a href="${escapeHtml(q.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize('ui.earthquake.more_info'))}</a></div>`
    : '';

  // Inline-styled: the popup is outside the card's shadow root.
  return `
    <div style="font:12px/1.4 'Helvetica Neue',Arial,sans-serif;min-width:180px">
      <div style="font-weight:bold;font-size:13px">M ${escapeHtml(q.mag.toFixed(1))}${escapeHtml(typeText)}</div>
      ${q.place ? `<div style="color:#555">${escapeHtml(q.place)}</div>` : ''}
      <div style="margin-top:4px">${rows}</div>
      ${tsunami}
      <div style="margin-top:6px;font-size:10px;color:#666">${escapeHtml(localize('ui.earthquake.disclaimer'))} <a href="${DOCS_EARTHQUAKES_URL}" target="_blank" rel="noopener noreferrer" style="color:#666;text-decoration:underline">${escapeHtml(localize('ui.earthquake.see_readme'))}</a>.</div>
      ${link}
    </div>
  `;
}
