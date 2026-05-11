// Single-call fetch + parse for DWD's wind U/V grid.
//
// Replaces N parallel WMS GetFeatureInfo calls (one per grid cell) with a
// single WCS GetCoverage call returning the whole bbox at native resolution
// as text/plain. text/plain is chosen over GeoTIFF/NetCDF because it carries
// the affine transform inline and parses without any external dep.
//
// Phase-2 layer: WindGridFetcher coalesces concurrent requests for the same
// (bbox, time, layer) so wind-overlay and wind-flow-overlay share one fetch
// when both are active on the same map.

const WCS_URL = 'https://maps.dwd.de/geoserver/dwd/wcs';
export const DEFAULT_WIND_COVERAGE = 'dwd__Icon_reg025_fd_sl_UV10M';

export interface WindGrid {
  /** Number of cell rows (latitudes). Row 0 is the SOUTHERNMOST. */
  rows: number;
  /** Number of cell cols (longitudes). Col 0 is the WESTERNMOST. */
  cols: number;
  /** Latitude of the south edge of row 0 (cell origin, not centre). */
  latMin: number;
  /** Longitude of the west edge of col 0. */
  lonMin: number;
  /** Cell size in degrees. For native ICON-D2 fetches this is 0.25° on
   * both axes. Under WCS Scaling the per-axis steps may differ slightly —
   * the parser stores the lon step here as the canonical sampling step
   * since lon dominates particle horizontal motion and the resulting
   * vertical interpolation offset is well below visible perception. */
  step: number;
  /** [row][col] U/V samples. (u, v) = m/s eastward, m/s northward. */
  cells: ReadonlyArray<ReadonlyArray<{ u: number; v: number }>>;
}

export interface FetchWindGridOptions {
  /** WGS84 bbox to fetch. WCS will snap outward to native cell boundaries. */
  south: number;
  west: number;
  north: number;
  east: number;
  /** Optional time anchor (ISO 8601). Omit for "current". */
  timeIso?: string | null;
  /** Defaults to DEFAULT_WIND_COVERAGE (ICON-D2 10 m wind). */
  coverageId?: string;
  /** Native grid step in degrees — used to estimate native cell count for
   * adaptive scaling. ICON-D2 is 0.25°. */
  nativeStep?: number;
  /** If native-resolution cells would exceed this, ask the WCS server to
   * downsample via the Scaling extension. Default 50 000 cells (~400 KB
   * text response). Continental and global views fall back to coarser
   * grids; smaller bboxes get native resolution. */
  maxCells?: number;
  /** Test seam: alternative fetch implementation. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_NATIVE_STEP = 0.25;
const DEFAULT_MAX_CELLS = 50_000;

// ── parser ─────────────────────────────────────────────────────────────────
//
// WCS text/plain output looks like:
//
//   Grid bounds: GeneralBounds[(lonMin, latMin), (lonMax, latMax)]
//   Grid CRS: GEOGCS[…]
//   Grid range: GridEnvelope2D[colStart..colEnd, rowStart..rowEnd]
//   Grid to world: PARAM_MT["Affine",
//     PARAMETER["elt_0_0", lonStep], …,
//     PARAMETER["elt_1_1", -latStep], …]
//   Contents:
//   Band 0:
//   <row 0 of U values, top-down>
//   <row 1>
//   …
//   Band 1:
//   <row 0 of V values, top-down>
//   …
//
// The rows in the file are top-down (north-first, image convention). We
// flip them so cells[0] is the SOUTH row, matching the bilinearUV layout
// used downstream and the existing per-point fetch code.
export function parseWcsTextGrid(body: string): WindGrid {
  const boundsMatch = body.match(/Grid bounds:\s*GeneralBounds\[\(([-\d.eE+]+),\s*([-\d.eE+]+)\),\s*\(([-\d.eE+]+),\s*([-\d.eE+]+)\)\]/);
  if (!boundsMatch) throw new Error('parseWcsTextGrid: missing Grid bounds line');
  const lonMin = Number(boundsMatch[1]);
  const latMin = Number(boundsMatch[2]);
  const lonMax = Number(boundsMatch[3]);
  const latMax = Number(boundsMatch[4]);

  // Affine: elt_0_0 = lon step (east per col), elt_1_1 = -lat step
  // (negative because the file walks rows N→S). With WCS Scaling these
  // two are NOT equal: GeoServer fits the requested scaleSize per-axis
  // with whatever step makes the bounds match, so a 316×158 scaled grid
  // over a non-square bbox gives different lon/lat steps. Read both and
  // use each on its own axis — using one step for both rows and cols
  // produced an off-by-one row count and the parser rejected the grid.
  const lonStepMatch = body.match(/PARAMETER\["elt_0_0",\s*([-\d.eE+]+)\]/);
  const latStepMatch = body.match(/PARAMETER\["elt_1_1",\s*([-\d.eE+]+)\]/);
  if (!lonStepMatch) throw new Error('parseWcsTextGrid: missing affine elt_0_0');
  if (!latStepMatch) throw new Error('parseWcsTextGrid: missing affine elt_1_1');
  const lonStep = Math.abs(Number(lonStepMatch[1]));
  const latStep = Math.abs(Number(latStepMatch[1]));
  if (!Number.isFinite(lonStep) || lonStep <= 0) {
    throw new Error(`parseWcsTextGrid: invalid lon step ${lonStepMatch[1]}`);
  }
  if (!Number.isFinite(latStep) || latStep <= 0) {
    throw new Error(`parseWcsTextGrid: invalid lat step ${latStepMatch[1]}`);
  }
  // Downstream WindGrid carries a single step (it's used for nearest-cell
  // and bilinear sampling on a regular grid). Where lon and lat steps
  // diverge slightly under scaling, the lon step is the safer pick: lon
  // dominates particle horizontal motion and arrow placement; the
  // resulting tiny vertical offset is well below visible perception.
  const step = lonStep;

  // Cell counts derived from bounds + per-axis step. We trust the bounds
  // (GeoServer snaps to grid edges) over the GridEnvelope2D — the latter
  // uses absolute grid indices that don't help us locally.
  const rows = Math.round((latMax - latMin) / latStep);
  const cols = Math.round((lonMax - lonMin) / lonStep);
  if (rows <= 0 || cols <= 0) {
    throw new Error(`parseWcsTextGrid: degenerate grid ${rows}×${cols}`);
  }

  const band0 = parseBand(body, 'Band 0:', rows, cols);
  const band1 = parseBand(body, 'Band 1:', rows, cols);

  // File order is top-down; flip to bottom-up so cells[0] is the south row.
  const cells: { u: number; v: number }[][] = [];
  for (let r = 0; r < rows; r++) {
    const fileRow = rows - 1 - r;
    const row: { u: number; v: number }[] = [];
    for (let c = 0; c < cols; c++) {
      row.push({ u: band0[fileRow][c], v: band1[fileRow][c] });
    }
    cells.push(row);
  }

  return { rows, cols, latMin, lonMin, step, cells };
}

function parseBand(body: string, header: string, rows: number, cols: number): number[][] {
  const idx = body.indexOf(header);
  if (idx < 0) throw new Error(`parseWcsTextGrid: missing ${header}`);
  // Slice from the byte after the header newline. Stop at the next "Band " or EOF.
  const after = body.slice(idx + header.length);
  const nextBand = after.search(/\nBand \d+:/);
  const slice = nextBand >= 0 ? after.slice(0, nextBand) : after;
  const lines = slice.split('\n').map(s => s.trim()).filter(Boolean);
  if (lines.length < rows) {
    throw new Error(`parseWcsTextGrid: ${header} has ${lines.length} rows, expected ${rows}`);
  }
  const out: number[][] = [];
  for (let r = 0; r < rows; r++) {
    const tokens = lines[r].split(/\s+/);
    if (tokens.length < cols) {
      throw new Error(`parseWcsTextGrid: ${header} row ${r} has ${tokens.length} cols, expected ${cols}`);
    }
    const row: number[] = [];
    for (let c = 0; c < cols; c++) row.push(Number(tokens[c]));
    out.push(row);
  }
  return out;
}

// ── network ────────────────────────────────────────────────────────────────

export async function fetchWindGrid(opts: FetchWindGridOptions): Promise<WindGrid> {
  // Clamp to the layer's valid WGS84 extent. Leaflet's getBounds() at low
  // zoom on a wide viewport readily returns lon/lat values OUTSIDE
  // [-180, 180] / [-90, 90] (the map view wraps the world). DWD's WCS
  // doesn't accept those — it returns an HTTP 200 with an XML exception
  // body ("Failed to read the coverage"), the parser fails, and the
  // overlay silently shows nothing. Clamping costs us the wrapped
  // portion at the edge but keeps the visible map populated.
  const south = Math.max(-90, Math.min(90, opts.south));
  const north = Math.max(-90, Math.min(90, opts.north));
  const west = Math.max(-180, Math.min(180, opts.west));
  const east = Math.max(-180, Math.min(180, opts.east));

  const params = new URLSearchParams({
    service: 'WCS',
    version: '2.0.1',
    request: 'GetCoverage',
    coverageId: opts.coverageId ?? DEFAULT_WIND_COVERAGE,
    format: 'text/plain',
  });
  // WCS 2.0 multi-subset: append separately so URLSearchParams keeps both keys.
  params.append('subset', `Lat(${south},${north})`);
  params.append('subset', `Long(${west},${east})`);
  if (opts.timeIso) {
    // WCS 2.0 wants the time literal quoted: subset=time("2026-05-10T12:00:00Z")
    params.append('subset', `time("${opts.timeIso}")`);
  }

  // Adaptive downsample. If the native-resolution grid would exceed maxCells
  // (e.g., world view at low zoom = ~1M cells), ask GeoServer's WCS Scaling
  // extension to render the bbox at a coarser grid that fits. Aspect-preserving
  // scale factor: cells along each axis ≈ native × sqrt(maxCells/nativeCells).
  const nativeStep = opts.nativeStep ?? DEFAULT_NATIVE_STEP;
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS;
  const nativeRows = Math.max(1, Math.ceil((north - south) / nativeStep));
  const nativeCols = Math.max(1, Math.ceil((east - west) / nativeStep));
  const nativeCells = nativeRows * nativeCols;
  if (nativeCells > maxCells) {
    const scale = Math.sqrt(maxCells / nativeCells);
    const targetRows = Math.max(2, Math.floor(nativeRows * scale));
    const targetCols = Math.max(2, Math.floor(nativeCols * scale));
    // WCS axis names use full OGC URIs; i = column (lon), j = row (lat).
    params.append(
      'scaleSize',
      `http://www.opengis.net/def/axis/OGC/1/i(${targetCols}),`
        + `http://www.opengis.net/def/axis/OGC/1/j(${targetRows})`,
    );
  }

  const f = opts.fetchImpl ?? fetch;
  const res = await f(`${WCS_URL}?${params.toString()}`);
  if (!res.ok) throw new Error(`fetchWindGrid: HTTP ${res.status}`);
  const body = await res.text();
  // GeoServer returns HTTP 200 with an ows:ExceptionReport XML body for
  // recoverable errors (out-of-bounds subset, invalid scaleSize, …).
  // Detect that explicitly so the caller's log line points at the real
  // cause instead of a downstream "missing Grid bounds line" parse fail.
  if (body.startsWith('<?xml') || body.includes('ExceptionReport')) {
    const msg = body.match(/<ows:ExceptionText>([\s\S]+?)<\/ows:ExceptionText>/)?.[1]?.trim();
    throw new Error(`fetchWindGrid: WCS returned exception — ${msg ?? 'see response body'}`);
  }
  return parseWcsTextGrid(body);
}

// ── sampling helpers ──────────────────────────────────────────────────────
//
// Pure: given a parsed WindGrid, look up or interpolate the U/V at a point.
// Used by both overlays after the bulk fetch lands.

/** Snap a (lat, lon) to its WindGrid cell and return the U/V there.
 * Returns (0, 0) for points outside the grid bbox. */
export function sampleWindGridNearest(
  grid: WindGrid,
  lat: number,
  lon: number,
): { u: number; v: number } {
  const r = Math.floor((lat - grid.latMin) / grid.step);
  const c = Math.floor((lon - grid.lonMin) / grid.step);
  if (r < 0 || r >= grid.rows || c < 0 || c >= grid.cols) return { u: 0, v: 0 };
  return grid.cells[r][c];
}

/** Bilinear-sample a WindGrid at (lat, lon). Matches what the old per-point
 * GetFeatureInfo path was returning (GeoServer's default raster sampler is
 * bilinear), so visual barb/arrow positions stay smooth across cell edges
 * instead of stepping discretely. The grid stores values at cell *centres*
 * spaced `step` apart, with cells[0][0] centred at (latMin + step/2,
 * lonMin + step/2). For a sample exactly at a cell centre this returns
 * that cell's value; off-centre samples blend the four neighbours. */
export function sampleWindGridBilinear(
  grid: WindGrid,
  lat: number,
  lon: number,
): { u: number; v: number } {
  if (grid.rows === 0 || grid.cols === 0) return { u: 0, v: 0 };
  // Convert (lat, lon) to fractional row/col where (0, 0) is the SW cell centre.
  const fr = (lat - grid.latMin) / grid.step - 0.5;
  const fc = (lon - grid.lonMin) / grid.step - 0.5;
  // Clamp the index pair so points just inside the bbox edge still hit
  // the nearest cell rather than degenerating to (0, 0). Out-of-bbox is
  // a deliberate "no data".
  if (fr < -0.5 || fr > grid.rows - 0.5 || fc < -0.5 || fc > grid.cols - 0.5) {
    return { u: 0, v: 0 };
  }
  const r0 = Math.max(0, Math.min(grid.rows - 2, Math.floor(fr)));
  const c0 = Math.max(0, Math.min(grid.cols - 2, Math.floor(fc)));
  const dr = Math.max(0, Math.min(1, fr - r0));
  const dc = Math.max(0, Math.min(1, fc - c0));
  const a = grid.cells[r0][c0];
  const b = grid.cells[r0][c0 + 1];
  const c = grid.cells[r0 + 1][c0];
  const d = grid.cells[r0 + 1][c0 + 1];
  const u = (1 - dr) * ((1 - dc) * a.u + dc * b.u) + dr * ((1 - dc) * c.u + dc * d.u);
  const v = (1 - dr) * ((1 - dc) * a.v + dc * b.v) + dr * ((1 - dc) * c.v + dc * d.v);
  return { u, v };
}

// ── coalescing fetcher (Phase 2) ───────────────────────────────────────────
//
// Both wind overlays are typically refreshed on the same map events
// (moveend, zoom, hass tick). Without coalescing they each fire their own
// WCS request, doubling the load on DWD and the network. The fetcher
// caches in-flight + recently-completed requests by (coverage, time, bbox)
// so a second concurrent caller piggybacks on the first.
//
// Cache TTL: short enough that "pan and re-pan to the same area" still
// gets fresh data, long enough that two overlays calling within a few
// seconds share. 60s is the sweet spot for ICON-D2 (updates hourly).

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  promise: Promise<WindGrid>;
  /** Wall-clock ms when this entry expires (for resolved requests). */
  expiresAt: number;
}

export class WindGridFetcher {
  private _cache = new Map<string, CacheEntry>();
  private _ttlMs: number;
  private _now: () => number;
  private _fetchImpl: (opts: FetchWindGridOptions) => Promise<WindGrid>;

  constructor(opts: {
    ttlMs?: number;
    /** Test seams. */
    now?: () => number;
    fetchImpl?: (opts: FetchWindGridOptions) => Promise<WindGrid>;
  } = {}) {
    this._ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
    this._now = opts.now ?? (() => Date.now());
    this._fetchImpl = opts.fetchImpl ?? fetchWindGrid;
  }

  fetch(opts: FetchWindGridOptions): Promise<WindGrid> {
    const key = this._cacheKey(opts);
    const now = this._now();
    const existing = this._cache.get(key);
    if (existing && existing.expiresAt > now) return existing.promise;

    const promise = this._fetchImpl(opts);
    // Set expiry now so concurrent calls during the in-flight window all
    // share. On rejection, drop the entry so the next caller retries.
    const entry: CacheEntry = { promise, expiresAt: now + this._ttlMs };
    this._cache.set(key, entry);
    promise.catch(() => {
      if (this._cache.get(key) === entry) this._cache.delete(key);
    });
    return promise;
  }

  /** Drop everything. Used in tests; production callers don't need it. */
  clear(): void {
    this._cache.clear();
  }

  private _cacheKey(opts: FetchWindGridOptions): string {
    // Round bbox to native grid step (0.25°) so jittery viewport changes
    // that snap to the same WCS cells share a cache entry.
    const snap = (v: number): number => Math.round(v * 4) / 4;
    return [
      opts.coverageId ?? DEFAULT_WIND_COVERAGE,
      opts.timeIso ?? '',
      snap(opts.south), snap(opts.west), snap(opts.north), snap(opts.east),
    ].join('|');
  }
}

// Module-level singleton: both wind overlays share this instance so their
// concurrent fetches coalesce. Callers don't need to construct their own.
export const windGridFetcher = new WindGridFetcher();
