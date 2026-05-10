/* eslint-disable @typescript-eslint/no-explicit-any */
// Animated wind streamlines (à la earth.nullschool.net / DWD WarnWetter app).
// Spawns N particles, advances each one along the local wind vector each frame,
// trails them on a Canvas2D layer with alpha-fade. Density of trails ends up
// reflecting wind speed because faster cells carry particles further per frame.
//
// Why Canvas2D and not WebGL? At 1500 particles in a 500×500 card the math is
// trivial and Canvas2D `stroke()` is plenty fast (~5ms/frame on integrated
// graphics). WebGL would only matter at 50k+ particles, full-screen.
import * as L from 'leaflet';

const WMS_URL = 'https://maps.dwd.de/geoserver/dwd/wms';
const WMS_LAYER = 'Icon_reg025_fd_sl_UV10M';
const ICON_GRID_DEG = 0.25;
// Hard cap on the U/V grid we fetch each refresh — bilinear interpolation between
// these points feeds the per-particle wind sample. Keeps the GetFeatureInfo burst
// bounded even on tall viewports at low zoom.
const MAX_GRID_POINTS = 400;
// Particle population is tuned per-area so dense viewports don't starve and tiny
// ones don't render too many. ~1 particle per 220 px² ≈ 1500 particles at 500×600.
const PARTICLE_DENSITY = 1 / 220;
const PARTICLE_CAP = 3500;
const PARTICLE_LIFETIME_FRAMES = 60;   // ~2s at 30fps
const FADE_PER_FRAME = 0.04;           // 4% alpha decay → trails persist ~25 frames
// Visual speed exaggeration. Real m/s × this → screen pixels per frame.
// 0.4 puts a 10 m/s wind at ~4 px/frame across zooms — roughly the DWD app pace.
const PARTICLE_SPEED_PX_PER_MPS = 0.4;

export interface WindFlowOverlayOptions {
  /** Anchor time in epoch ms. Snapped to the hourly ICON boundary. Omit for "current". */
  timeMs?: number;
  /** Stroke for new line segments. Defaults to a neutral grey that reads on light or dark maps. */
  particleColor?: string;
}

interface GridCell { u: number; v: number; }

export class WindFlowOverlay {
  private _map: L.Map;
  private _canvas: HTMLCanvasElement;
  private _ctx: CanvasRenderingContext2D;
  private _grid: GridCell[][] = [];
  private _gridStep = ICON_GRID_DEG;
  private _gridLatMin = 0;
  private _gridLonMin = 0;
  private _gridRows = 0;
  private _gridCols = 0;
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
  private _onMoveEnd: () => void;
  private _onResize: () => void;
  // prefers-reduced-motion: spinning particles 30×/s on lower-end devices is
  // exactly the kind of work the OS-level setting asks us to skip. We watch
  // the media query so toggling it in System Settings takes effect without
  // a card reload.
  private _reducedMotionMql: MediaQueryList | null = null;
  private _onReducedMotionChange: ((e: MediaQueryListEvent) => void) | null = null;

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

    this._onMoveStart = (): void => this._stopLoop();
    this._onMoveEnd = (): void => { void this._restart(); };
    this._onResize = (): void => { void this._restart(); };
    map.on('movestart zoomstart', this._onMoveStart);
    map.on('moveend zoomend', this._onMoveEnd);
    map.on('resize', this._onResize);

    if (typeof window !== 'undefined' && window.matchMedia) {
      this._reducedMotionMql = window.matchMedia('(prefers-reduced-motion: reduce)');
      this._onReducedMotionChange = (): void => { void this._restart(); };
      this._reducedMotionMql.addEventListener('change', this._onReducedMotionChange);
    }

    void this._restart();
  }

  destroy(): void {
    this._stopLoop();
    this._gen++;
    this._map.off('movestart zoomstart', this._onMoveStart);
    this._map.off('moveend zoomend', this._onMoveEnd);
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

  private _stepCellsForZoom(): number {
    const z = this._map.getZoom();
    return z >= 8 ? 1 : z >= 6 ? 2 : z >= 5 ? 4 : 8;
  }

  private async _fetchGrid(): Promise<void> {
    const b = this._map.getBounds();
    const stepCells = this._stepCellsForZoom();
    const step = ICON_GRID_DEG * stepCells;
    // Snap outward + 1 cell padding so off-screen particles still find data.
    const south = Math.floor(b.getSouth() / step) * step - step;
    const north = Math.ceil(b.getNorth() / step) * step + step;
    const west = Math.floor(b.getWest() / step) * step - step;
    const east = Math.ceil(b.getEast() / step) * step + step;

    const lats: number[] = [];
    const lons: number[] = [];
    for (let lat = south; lat <= north + 1e-9; lat += step) lats.push(lat);
    for (let lon = west; lon <= east + 1e-9; lon += step) lons.push(lon);

    if (lats.length * lons.length > MAX_GRID_POINTS) {
      // Belt-and-braces: shouldn't normally hit this with the zoom rules above.
      console.warn('WindFlowOverlay: grid exceeds cap, skipping fetch');
      this._grid = [];
      this._gridRows = this._gridCols = 0;
      return;
    }

    const promises: Promise<GridCell>[] = [];
    for (const lat of lats) {
      for (const lon of lons) {
        promises.push(this._fetchPoint(lat, lon));
      }
    }
    const samples = await Promise.all(promises);

    const grid: GridCell[][] = [];
    let i = 0;
    for (let r = 0; r < lats.length; r++) {
      const row: GridCell[] = [];
      for (let c = 0; c < lons.length; c++) row.push(samples[i++]);
      grid.push(row);
    }

    this._grid = grid;
    this._gridStep = step;
    this._gridLatMin = south;
    this._gridLonMin = west;
    this._gridRows = lats.length;
    this._gridCols = lons.length;
  }

  private async _fetchPoint(lat: number, lon: number): Promise<GridCell> {
    const half = ICON_GRID_DEG / 4;
    const params = new URLSearchParams({
      service: 'WMS', version: '1.3.0', request: 'GetFeatureInfo',
      layers: WMS_LAYER, query_layers: WMS_LAYER, styles: '',
      crs: 'EPSG:4326',
      bbox: `${lat - half},${lon - half},${lat + half},${lon + half}`,
      width: '2', height: '2', i: '1', j: '1',
      info_format: 'application/json',
    });
    if (this._timeIso) params.set('TIME', this._timeIso);
    try {
      const res = await fetch(`${WMS_URL}?${params}`);
      if (!res.ok) return { u: 0, v: 0 };
      const data = await res.json();
      const p = data?.features?.[0]?.properties;
      if (!p || typeof p.u !== 'number') return { u: 0, v: 0 };
      return { u: p.u, v: p.v };
    } catch {
      return { u: 0, v: 0 };
    }
  }

  private _spawnParticles(w: number, h: number): void {
    const count = Math.min(PARTICLE_CAP, Math.round(w * h * PARTICLE_DENSITY));
    this._particleCount = count;
    this._particles = new Float32Array(count * 3);
    for (let p = 0; p < count; p++) {
      this._particles[p * 3] = Math.random() * w;
      this._particles[p * 3 + 1] = Math.random() * h;
      // Stagger initial ages so particles don't all respawn on the same frame.
      this._particles[p * 3 + 2] = Math.random() * PARTICLE_LIFETIME_FRAMES;
    }
  }

  private _interpolate(lat: number, lon: number): { u: number; v: number } {
    return bilinearUV(
      this._grid, this._gridLatMin, this._gridLonMin, this._gridStep,
      this._gridRows, this._gridCols, lat, lon,
    );
  }

  private _tick = (): void => {
    if (!this._running) return;
    const ctx = this._ctx;
    const w = this._canvas.width;
    const h = this._canvas.height;

    // Decay existing trails — destination-out drops alpha regardless of colour,
    // so this works on any basemap.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = `rgba(0,0,0,${FADE_PER_FRAME})`;
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

      const nx = x + wind.u * PARTICLE_SPEED_PX_PER_MPS;
      const ny = y - wind.v * PARTICLE_SPEED_PX_PER_MPS; // pixel y goes down; v is northward

      if (Math.abs(wind.u) + Math.abs(wind.v) > 0.05) {
        ctx.moveTo(x, y);
        ctx.lineTo(nx, ny);
      }

      age++;
      if (age > PARTICLE_LIFETIME_FRAMES || nx < 0 || nx > w || ny < 0 || ny > h) {
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

// Bilinear interpolation of a regular lat/lon U/V grid. Pure: no DOM, no
// Leaflet, no class state — caller passes the grid + axis params + sample
// point. Out-of-grid samples and empty grids return (0,0) so the streamline
// loop draws nothing rather than crashing.
export function bilinearUV(
  grid: ReadonlyArray<ReadonlyArray<{ u: number; v: number }>>,
  latMin: number, lonMin: number, step: number,
  rows: number, cols: number,
  lat: number, lon: number,
): { u: number; v: number } {
  if (rows === 0 || cols === 0) return { u: 0, v: 0 };
  const r = (lat - latMin) / step;
  const c = (lon - lonMin) / step;
  const r0 = Math.floor(r);
  const c0 = Math.floor(c);
  if (r0 < 0 || r0 + 1 >= rows || c0 < 0 || c0 + 1 >= cols) {
    return { u: 0, v: 0 };
  }
  const fr = r - r0;
  const fc = c - c0;
  const a = grid[r0][c0];
  const b = grid[r0][c0 + 1];
  const cc = grid[r0 + 1][c0];
  const d = grid[r0 + 1][c0 + 1];
  const u = (1 - fr) * ((1 - fc) * a.u + fc * b.u) + fr * ((1 - fc) * cc.u + fc * d.u);
  const v = (1 - fr) * ((1 - fc) * a.v + fc * b.v) + fr * ((1 - fc) * cc.v + fc * d.v);
  return { u, v };
}
