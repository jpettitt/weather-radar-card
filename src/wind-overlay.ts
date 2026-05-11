/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { windGridFetcher, sampleWindGridBilinear, type WindGrid } from './wind-grid-fetcher';

const ICON_GRID_DEG = 0.25;
const MAX_POINTS = 400;
// No cell cap here — the fetcher's adaptive WCS Scaling downsamples
// large bboxes server-side instead of skipping.
// Min step sizes (in ICON grid units) per zoom — keeps screen density roughly constant
// at density=1. Higher density divides this; lower multiplies it. Native floor is 1.
const MIN_STEP_BY_ZOOM: Record<number, number> = {
  3: 8, 4: 4, 5: 2, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1,
};
const BASE_ICON_PX = 22;
const MIN_ICON_PX = 10;
// Short debounce on map move — long enough to coalesce a flurry of pointer
// events into one refetch, short enough that the wind WCS request fires
// BEFORE the radar player's 100 ms post-moveend tile-burst saturates the
// browser's per-origin connection pool. (The bulk fetcher's request cache
// dedupes anything redundant the debounce would otherwise filter.)
const MOVE_DEBOUNCE_MS = 50;
// Refresh anchored to the top of each clock hour. Our "current" time is
// hour-bucketed already, so the displayed data only changes at the hour
// rollover or when DWD publishes a fresher ICON-D2 run for the same hour
// — top-of-hour catches both. 30 sec offset gives DWD a publish window.
const HOURLY_REFRESH_OFFSET_MS = 30_000;

export type WindStyle = 'barbs' | 'arrows';

export interface WindOverlayOptions {
  style: WindStyle;
  /** 1.0 = default. Higher = denser grid (more arrows on screen). Independent of icon size. */
  density?: number;
  /** 1.0 = default 22px. Range 0.5–2. Independent of density. */
  size?: number;
  /** Anchor time in epoch ms. Snapped to the hourly ICON boundary. Omit for "current". */
  timeMs?: number;
}

export class WindOverlay {
  private _map: L.Map;
  private _layer: L.LayerGroup;
  private _style: WindStyle;
  private _density: number;
  private _sizeMult: number;
  private _timeIso: string | null;
  private _gen = 0;
  private _moveHandler: () => void;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(map: L.Map, opts: WindOverlayOptions) {
    this._map = map;
    this._style = opts.style;
    // Sanitise density: NaN, 0, negative, and Infinity all fall back to the
    // default 1. NaN propagates through Math.max/min and would freeze the
    // grid step loop in _gridPoints (NaN > 64 is false, NaN *= 2 stays NaN).
    const d = Number(opts.density);
    this._density = Number.isFinite(d) && d > 0 ? Math.max(0.25, Math.min(4, d)) : 1;
    const s = Number(opts.size);
    this._sizeMult = Number.isFinite(s) && s > 0 ? Math.max(0.5, Math.min(2, s)) : 1;
    if (opts.timeMs != null) {
      // Snap to the hourly ICON boundary; DWD rejects off-boundary timestamps.
      const snapped = Math.trunc(opts.timeMs / 3_600_000) * 3_600_000;
      this._timeIso = new Date(snapped).toISOString().split('.')[0] + 'Z';
    } else {
      this._timeIso = null;
    }
    this._layer = L.layerGroup().addTo(map);
    this._moveHandler = (): void => {
      if (this._debounceTimer) clearTimeout(this._debounceTimer);
      this._debounceTimer = setTimeout(() => this._refresh(), MOVE_DEBOUNCE_MS);
    };
    map.on('moveend', this._moveHandler);
    this._scheduleHourlyRefresh();
    void this._refresh();
  }

  destroy(): void {
    if (this._debounceTimer) clearTimeout(this._debounceTimer);
    if (this._refreshTimer) { clearTimeout(this._refreshTimer); this._refreshTimer = null; }
    this._map.off('moveend', this._moveHandler);
    this._layer.remove();
    this._gen++;
  }

  // Self-rescheduling timer that wakes shortly after each clock hour to
  // pick up the new hour bucket / model run. Independent of map events.
  private _scheduleHourlyRefresh(): void {
    const now = Date.now();
    const nextHour = Math.ceil(now / 3_600_000) * 3_600_000;
    const delay = nextHour - now + HOURLY_REFRESH_OFFSET_MS;
    this._refreshTimer = setTimeout(() => {
      void this._refresh();
      this._scheduleHourlyRefresh();
    }, delay);
  }

  private get _iconSize(): number {
    return Math.max(MIN_ICON_PX, Math.round(BASE_ICON_PX * this._sizeMult));
  }

  private async _refresh(): Promise<void> {
    const myGen = ++this._gen;
    const points = this._gridPoints();
    if (points.length === 0) {
      this._layer.clearLayers();
      return;
    }

    // One bulk WCS fetch for the whole visible bbox; each visual icon
    // position is then a local table lookup. Replaces N parallel
    // GetFeatureInfo calls (one per icon).
    const b = this._map.getBounds();
    const pad = ICON_GRID_DEG;
    const south = b.getSouth() - pad;
    const north = b.getNorth() + pad;
    const west = b.getWest() - pad;
    const east = b.getEast() + pad;
    let grid: WindGrid;
    try {
      grid = await windGridFetcher.fetch({
        south, west, north, east,
        timeIso: this._timeIso,
      });
    } catch (err) {
      console.warn('WindOverlay: WCS fetch failed, skipping refresh', err);
      return;
    }
    if (myGen !== this._gen) return;

    this._layer.clearLayers();
    const size = this._iconSize;
    for (const p of points) {
      // Bilinear-sample to match what the old per-point GetFeatureInfo
      // path produced (GeoServer interpolates server-side by default), so
      // dense icon grids stay smooth across cell boundaries instead of
      // stepping discretely. (0, 0) means the point fell outside the
      // fetched grid; arrowIcon already suppresses calm, barbIcon draws
      // a calm-circle.
      const s = sampleWindGridBilinear(grid, p.lat, p.lon);
      const speed = Math.hypot(s.u, s.v);
      const icon = this._style === 'barbs' ? barbIcon(s.u, s.v, speed, size) : arrowIcon(s.u, s.v, speed, size);
      if (!icon) continue;
      const marker = L.marker([p.lat, p.lon], { icon, interactive: false, keyboard: false });
      this._layer.addLayer(marker);
    }
  }

  private _gridPoints(): { lat: number; lon: number }[] {
    const b = this._map.getBounds();
    const z = this._map.getZoom();
    const minStepCells = MIN_STEP_BY_ZOOM[z] ?? (z < 3 ? 12 : 1);
    // Scale step inversely with density (higher density → smaller step), floor at 1 cell (native).
    const scaledFloor = Math.max(1, Math.round(minStepCells / this._density));
    const latSpan = b.getNorth() - b.getSouth();
    const lonSpan = b.getEast() - b.getWest();
    let stepCells = scaledFloor;
    for (;;) {
      const step = ICON_GRID_DEG * stepCells;
      const rows = Math.floor(latSpan / step) + 1;
      const cols = Math.floor(lonSpan / step) + 1;
      if (rows * cols <= MAX_POINTS) break;
      stepCells *= 2;
      if (stepCells > 64) break;
    }
    const step = ICON_GRID_DEG * stepCells;
    const south = Math.ceil(b.getSouth() / step) * step;
    const north = Math.floor(b.getNorth() / step) * step;
    const west = Math.ceil(b.getWest() / step) * step;
    const east = Math.floor(b.getEast() / step) * step;
    const points: { lat: number; lon: number }[] = [];
    for (let lat = south; lat <= north + 1e-9; lat += step) {
      for (let lon = west; lon <= east + 1e-9; lon += step) {
        points.push({ lat, lon });
      }
    }
    return points;
  }

}

function arrowIcon(u: number, v: number, speed: number, size: number): L.DivIcon | null {
  if (speed < 0.3) return null; // suppress calm cells for arrows
  const angleDeg = (Math.atan2(u, v) * 180) / Math.PI;
  const colour = speedColour(speed);
  const stroke = Math.max(1.1, size / 12);
  const html = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${angleDeg}deg);overflow:visible">
    <path d="M12 3 L12 19 M7 8 L12 3 L17 8" fill="none" stroke="${colour}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return L.divIcon({
    html,
    className: 'wrc-wind-arrow',
    iconSize: [size, size] as L.PointExpression,
    iconAnchor: [size / 2, size / 2] as L.PointExpression,
  });
}

function barbIcon(u: number, v: number, speedMps: number, size: number): L.DivIcon {
  const knots = speedMps * 1.943844;
  const colour = speedColour(speedMps);
  const stroke = Math.max(1, size / 16);

  // Calm: open circle.
  if (knots < 2.5) {
    const r = Math.max(2.5, size * 0.18);
    const html = `<svg width="${size}" height="${size}" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="${r}" fill="none" stroke="${colour}" stroke-width="${stroke}"/>
    </svg>`;
    return L.divIcon({
      html, className: 'wrc-wind-barb',
      iconSize: [size, size] as L.PointExpression,
      iconAnchor: [size / 2, size / 2] as L.PointExpression,
    });
  }

  // Wind FROM direction: opposite of "to" direction (atan2(u, v) is "to").
  const angleDeg = (Math.atan2(u, v) * 180) / Math.PI + 180;

  const { pennants, fullFeathers, halfFeather } = decomposeBarbKnots(knots);

  // Staff: from origin (12,12) up to (12,2). Feathers attach starting at the tip
  // and walk down the staff. Northern Hemisphere convention puts feathers on the
  // CCW side of the staff when viewed downwind — for an upward staff that's the
  // right side in screen coords (positive x).
  const tipY = 2;
  const staffStartY = 12;
  const featherStep = 2.2; // y-distance between successive glyphs along the staff
  const featherLenFull = 6;
  const pennantH = 2.4; // pennant base width along the staff
  const segments: string[] = [`M12 ${staffStartY} L12 ${tipY}`];
  let y = tipY;
  // Pennants first (closest to tip).
  for (let i = 0; i < pennants; i++) {
    segments.push(`M12 ${y} L${12 + featherLenFull} ${y + pennantH / 2} L12 ${y + pennantH} Z`);
    y += pennantH + 0.6;
  }
  // Full feathers.
  for (let i = 0; i < fullFeathers; i++) {
    segments.push(`M12 ${y} L${12 + featherLenFull} ${y - featherStep * 0.6}`);
    y += featherStep;
  }
  // Half feather.
  if (halfFeather) {
    // If the bare staff has no other feathers yet, push the half feather one step in
    // so it doesn't sit at the very tip (standard convention).
    if (pennants === 0 && fullFeathers === 0) y += featherStep;
    segments.push(`M12 ${y} L${12 + featherLenFull / 2} ${y - featherStep * 0.4}`);
  }

  const html = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${angleDeg}deg);overflow:visible">
    <path d="${segments.join(' ')}" fill="${colour}" stroke="${colour}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
  return L.divIcon({
    html, className: 'wrc-wind-barb',
    iconSize: [size, size] as L.PointExpression,
    iconAnchor: [size / 2, size / 2] as L.PointExpression,
  });
}

export function speedColour(mps: number): string {
  // Beaufort-ish bands: calm/light/moderate/fresh/strong/gale.
  if (mps < 1.5) return '#88a';
  if (mps < 3.5) return '#3a7';
  if (mps < 5.5) return '#1a8';
  if (mps < 8) return '#d80';
  if (mps < 11) return '#c40';
  return '#a00';
}

// Round speed to the nearest 5 kt and decompose into glyph counts. WMO
// convention: pennant = 50 kt, full feather = 10 kt, half feather = 5 kt.
// Pure: speed in → glyph counts out, no DOM, no SVG.
export function decomposeBarbKnots(knots: number): {
  k5: number; pennants: number; fullFeathers: number; halfFeather: 0 | 1;
} {
  const k5 = Math.round(knots / 5) * 5;
  let r = k5;
  const pennants = Math.floor(r / 50); r -= pennants * 50;
  const fullFeathers = Math.floor(r / 10); r -= fullFeathers * 10;
  const halfFeather: 0 | 1 = r >= 5 ? 1 : 0;
  return { k5, pennants, fullFeathers, halfFeather };
}
