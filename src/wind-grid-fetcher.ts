// Single-call fetch + parse for wind U/V grids from one of several sources
// (see wind-source-caps.ts for the registry).
//
// Replaces N parallel WMS GetFeatureInfo calls (one per grid cell) with a
// single WCS GetCoverage call returning the whole bbox at native resolution
// as text/plain. text/plain is chosen over GeoTIFF/NetCDF because it carries
// the affine transform inline and parses without any external dep.
//
// Source dispatch happens inside fetchWindGrid: each source supplies its
// own WCS endpoint, coverage ID, CRS, and band semantics (some sources
// publish U/V components directly, others publish wind speed and
// direction which we convert to U/V client-side before storing).
//
// Phase-2 layer: WindGridFetcher coalesces concurrent requests for the same
// (source, bbox, time) so wind-overlay and wind-flow-overlay share one fetch
// when both are active on the same map.

import {
  type WindSource,
  DEFAULT_WIND_SOURCE,
  getWindSourceCaps,
  bboxInUsCoverage,
} from './wind-source-caps';

// Re-exported for callers that don't need the full caps lookup. Equivalent to
// `getWindSourceCaps('dwd_icon').coverageId`.
export const DEFAULT_WIND_COVERAGE = 'dwd__Icon_reg025_fd_sl_UV10M';

// Web Mercator (EPSG:3857) earth radius. Used by the NDFD source whose
// coverage publishes axes in metres rather than lat/lon degrees.
const MERCATOR_R = 6378137;
const MERCATOR_MAX_M = Math.PI * MERCATOR_R;  // ±20037508.34, ±85.05113°

function lonToMercatorX(lon: number): number {
  return (lon * Math.PI / 180) * MERCATOR_R;
}
function latToMercatorY(lat: number): number {
  const clamped = Math.max(-85.05113, Math.min(85.05113, lat));
  return Math.log(Math.tan(Math.PI / 4 + (clamped * Math.PI / 180) / 2)) * MERCATOR_R;
}
function mercatorXToLon(x: number): number {
  return (x / MERCATOR_R) * 180 / Math.PI;
}
function mercatorYToLat(y: number): number {
  return (2 * Math.atan(Math.exp(y / MERCATOR_R)) - Math.PI / 2) * 180 / Math.PI;
}

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
  /** Wind source registry id (see wind-source-caps.ts). Defaults to
   * 'dwd_icon' (ICON-D2 10 m global). The source determines endpoint,
   * coverage id, CRS, and band semantics. */
  source?: WindSource;
  /** Override the default coverage id for the chosen source. Currently
   * only used by tests; production callers should rely on the source
   * registry's canonical coverageId. */
  coverageId?: string;
  /** Override the source's native cell step. Only used by tests / for
   * sources whose native resolution differs by region. */
  nativeStep?: number;
  /** If native-resolution cells would exceed this, ask the WCS server to
   * downsample via the Scaling extension. Default 50 000 cells (~400 KB
   * text response). Continental and global views fall back to coarser
   * grids; smaller bboxes get native resolution. */
  maxCells?: number;
  /** Test seam: alternative fetch implementation. */
  fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_CELLS = 50_000;

// ── parser ─────────────────────────────────────────────────────────────────
//
// WCS text/plain output looks like:
//
//   Grid bounds: GeneralBounds[(axis0Min, axis1Min), (axis0Max, axis1Max)]
//   Grid CRS: GEOGCS[…] or PROJCS[…]
//   Grid range: GridEnvelope2D[colStart..colEnd, rowStart..rowEnd]
//   Grid to world: PARAM_MT["Affine",
//     PARAMETER["elt_0_0", axis0Step], …,
//     PARAMETER["elt_1_1", -axis1Step], …]
//   Contents:
//   Band 0:
//   <row 0 of band-0 values, top-down>
//   <row 1>
//   …
//   Band 1:
//   <row 0 of band-1 values, top-down>
//   …
//
// What axes 0/1 mean and what the bands carry depends on the source —
// for DWD ICON-D2 axes are (lon, lat) degrees and bands are (U, V) m/s,
// for NDFD axes are (X, Y) EPSG:3857 metres and bands are (speed m/s,
// direction °). parseRawWcsGrid extracts the geometry + raw bands
// without interpretation; the source-specific finalizers below convert
// to the canonical lat/lon WindGrid.

interface RawWcsGrid {
  rows: number;
  cols: number;
  /** [axis0Min, axis1Min] — units depend on the source CRS. */
  axisMin: [number, number];
  /** [axis0Max, axis1Max]. */
  axisMax: [number, number];
  /** Step along axis 0 per column. Positive. */
  step0: number;
  /** Step along axis 1 per row. Positive. */
  step1: number;
  /** [row][col] in file order (rows top-down). */
  band0: number[][];
  band1: number[][];
}

function parseRawWcsGrid(body: string): RawWcsGrid {
  const boundsMatch = body.match(/Grid bounds:\s*GeneralBounds\[\(([-\d.eE+]+),\s*([-\d.eE+]+)\),\s*\(([-\d.eE+]+),\s*([-\d.eE+]+)\)\]/);
  if (!boundsMatch) throw new Error('parseWcsTextGrid: missing Grid bounds line');
  const axis0Min = Number(boundsMatch[1]);
  const axis1Min = Number(boundsMatch[2]);
  const axis0Max = Number(boundsMatch[3]);
  const axis1Max = Number(boundsMatch[4]);

  // Affine: elt_0_0 = step along axis 0 per column, elt_1_1 = -step along
  // axis 1 per row (negative because the file walks rows from high to low
  // axis 1 — i.e., north-first for lat, top-first for Mercator Y). With
  // WCS Scaling these two are NOT equal: GeoServer fits the requested
  // scaleSize per-axis with whatever step makes the bounds match. Read
  // both and use each on its own axis — using one step for both rows and
  // cols produced an off-by-one row count and the parser rejected the grid.
  const step0Match = body.match(/PARAMETER\["elt_0_0",\s*([-\d.eE+]+)\]/);
  const step1Match = body.match(/PARAMETER\["elt_1_1",\s*([-\d.eE+]+)\]/);
  if (!step0Match) throw new Error('parseWcsTextGrid: missing affine elt_0_0');
  if (!step1Match) throw new Error('parseWcsTextGrid: missing affine elt_1_1');
  const step0 = Math.abs(Number(step0Match[1]));
  const step1 = Math.abs(Number(step1Match[1]));
  if (!Number.isFinite(step0) || step0 <= 0) {
    throw new Error(`parseWcsTextGrid: invalid axis 0 step ${step0Match[1]}`);
  }
  if (!Number.isFinite(step1) || step1 <= 0) {
    throw new Error(`parseWcsTextGrid: invalid axis 1 step ${step1Match[1]}`);
  }

  // Cell counts derived from bounds + per-axis step. We trust the bounds
  // (GeoServer snaps to grid edges) over the GridEnvelope2D — the latter
  // uses absolute grid indices that don't help us locally.
  const rows = Math.round((axis1Max - axis1Min) / step1);
  const cols = Math.round((axis0Max - axis0Min) / step0);
  if (rows <= 0 || cols <= 0) {
    throw new Error(`parseWcsTextGrid: degenerate grid ${rows}×${cols}`);
  }

  const band0 = parseBand(body, 'Band 0:', rows, cols);
  const band1 = parseBand(body, 'Band 1:', rows, cols);

  return {
    rows, cols,
    axisMin: [axis0Min, axis1Min],
    axisMax: [axis0Max, axis1Max],
    step0, step1,
    band0, band1,
  };
}

/** DWD ICON-D2 finalizer: axes are (lon, lat) degrees, bands are (U, V) m/s.
 * Flips file rows (top-down) to bottom-up so cells[0] is the south row.
 * Kept as the public `parseWcsTextGrid` for back-compat with existing tests
 * and any downstream consumer that hard-codes the DWD source. */
export function parseWcsTextGrid(body: string): WindGrid {
  const raw = parseRawWcsGrid(body);
  const cells: { u: number; v: number }[][] = [];
  for (let r = 0; r < raw.rows; r++) {
    const fileRow = raw.rows - 1 - r;
    const row: { u: number; v: number }[] = [];
    for (let c = 0; c < raw.cols; c++) {
      row.push({ u: raw.band0[fileRow][c], v: raw.band1[fileRow][c] });
    }
    cells.push(row);
  }
  // Where lon and lat steps diverge slightly under scaling, the axis-0
  // (lon) step is the safer canonical pick: lon dominates particle
  // horizontal motion and arrow placement; the resulting tiny vertical
  // offset is well below visible perception.
  return {
    rows: raw.rows,
    cols: raw.cols,
    latMin: raw.axisMin[1],
    lonMin: raw.axisMin[0],
    step: raw.step0,
    cells,
  };
}

/** NDFD finalizer: axes are (X, Y) in EPSG:3857 metres, bands are (wind
 * speed m/s, wind direction degrees, meteorological "from"). Converts
 * the bbox bounds to lat/lon, picks a representative degree step at the
 * bbox centre latitude, and converts speed/direction to U/V components.
 *
 * Mercator → degree step approximation: a regular Mercator grid is NOT a
 * regular lat/lon grid (latitude spacing varies with cos(lat) due to
 * Mercator stretch). For the typical card bbox (a few degrees of lat
 * span at most), the variation is small (~%) and acceptable for a smooth
 * decorative visualization. Both downstream samplers consume the
 * canonical lat/lon WindGrid unchanged. */
export function parseNdfdWcsGrid(body: string): WindGrid {
  const raw = parseRawWcsGrid(body);

  // Convert Mercator bbox metres → degrees.
  const xMin = raw.axisMin[0];
  const yMin = raw.axisMin[1];
  const xMax = raw.axisMax[0];
  const lonMin = mercatorXToLon(xMin);
  const lonMax = mercatorXToLon(xMax);
  const latMin = mercatorYToLat(yMin);

  // Characteristic step in degrees: take the lon step (linear in
  // Mercator) at any latitude — uniform — and use it as the canonical
  // step. Lat step at the bbox centre is approximately equal in degrees
  // to the lon step thanks to the conformal property of Mercator (a
  // square cell in Mercator metres maps to a near-square cell in
  // degrees at any single latitude, just at varying scale).
  const stepLon = (lonMax - lonMin) / raw.cols;

  // Speed/direction → U/V. NDFD direction is meteorological — the
  // direction the wind is coming FROM, in degrees clockwise from north.
  // Eastward (U) and northward (V) wind components for a wind coming
  // from direction θ at speed s are:
  //   u = -s × sin(θ)   v = -s × cos(θ)
  // (negative because direction is "from", U/V are velocity vector
  // pointing the direction it's going).
  // No-data sentinel handling. NDFD's GeoServer publishes 9999.0 for
  // both bands in cells outside CONUS / AK / HI / PR coverage. The
  // value is *finite* so it passes Number.isFinite, but feeding it
  // through speed × sin(dir) produces huge U/V values that teleport
  // streamline particles across the canvas in one frame, drawing
  // spurious long diagonal segments out of legit-looking trail
  // endpoints (the particle that just exited a valid region got one
  // 9999-sampled tick before respawn). Bilinear interpolation makes
  // it worse: a sample near a coverage edge mixes valid and 9999,
  // giving an interpolated value that's still in the thousands.
  //
  // Any wind speed above ~150 m/s is well past Category 5 / strong
  // tornado peaks (~145 m/s); 200 is a comfortable cutoff for
  // distinguishing real values from the sentinel without false
  // positives. Direction outside [0, 360] is also a clear sentinel
  // signal. Either condition → treat the cell as calm.
  const SPEED_SENTINEL_THRESHOLD = 200;
  const cells: { u: number; v: number }[][] = [];
  for (let r = 0; r < raw.rows; r++) {
    const fileRow = raw.rows - 1 - r;
    const row: { u: number; v: number }[] = [];
    for (let c = 0; c < raw.cols; c++) {
      const speed = raw.band0[fileRow][c];
      const direction = raw.band1[fileRow][c];
      if (!Number.isFinite(speed) || !Number.isFinite(direction)
        || Math.abs(speed) >= SPEED_SENTINEL_THRESHOLD
        || direction < 0 || direction > 360) {
        row.push({ u: 0, v: 0 });
        continue;
      }
      const rad = direction * Math.PI / 180;
      row.push({
        u: -speed * Math.sin(rad),
        v: -speed * Math.cos(rad),
      });
    }
    cells.push(row);
  }

  return {
    rows: raw.rows,
    cols: raw.cols,
    latMin,
    lonMin,
    step: stepLon,
    cells,
  };
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

// One-shot diagnostic — first time a session falls back, log once so the
// behaviour is observable in DevTools without spamming the console on
// every refetch. Module-level state is fine: WindGridFetcher is a
// singleton in practice, and the only consequence of "more than once
// per page session" if someone constructs another fetcher is one extra
// log line.
let _fallbackLogged = false;

export async function fetchWindGrid(opts: FetchWindGridOptions): Promise<WindGrid> {
  const configured = opts.source ?? DEFAULT_WIND_SOURCE;
  const source = resolveSourceForBbox(opts);
  if (source !== configured && !_fallbackLogged) {
    _fallbackLogged = true;
    console.info(
      `[weather-radar-card] Wind viewport outside NDFD coverage — auto-falling back to ${source} for global fill. The configured wind_source '${configured}' resumes when the view returns to CONUS / AK / HI / PR.`,
    );
  }
  const caps = getWindSourceCaps(source);
  const url = buildWindGridUrl({ ...opts, source }, caps);

  const f = opts.fetchImpl ?? fetch;
  const res = await f(url);
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
  // Source-specific finalizer: DWD axes/bands are already lat/lon + U/V;
  // NDFD needs Mercator → degrees + speed/direction → U/V conversion.
  return caps.bands === 'speed_dir' ? parseNdfdWcsGrid(body) : parseWcsTextGrid(body);
}

/** Resolve the effective source for this fetch given the bbox. Pure —
 * the caller (fetchWindGrid) handles the one-shot diagnostic when the
 * resolved source differs from the configured one. Exported for unit
 * tests and for the cache-key calculation.
 *
 * NDFD is US-only; the GeoServer returns mostly-zero / fill-sentinel for
 * cells outside CONUS / AK / HI / PR. Worse, when the requested bbox is
 * downsampled via WCS Scaling (continental and world-scale views), a
 * single coarse output cell can straddle the CONUS coast and average
 * real wind into ocean / European cells — that's the "streamlines over
 * the UK" artifact users hit at low zoom with NDFD selected.
 *
 * When the bbox centre falls outside US coverage, swap to the global
 * default source (DEFAULT_WIND_SOURCE — currently 'dwd_aicon') so the
 * overlay shows real wind everywhere. Centre-based: pan east until the
 * centre crosses the coast, source flips on the next refetch. The
 * user-configured `wind_source` is unchanged in their config — this is
 * purely a per-fetch dispatch decision. */
export function resolveSourceForBbox(opts: FetchWindGridOptions): WindSource {
  const configured = opts.source ?? DEFAULT_WIND_SOURCE;
  if (configured !== 'ndfd_wind') return configured;
  if (bboxInUsCoverage(opts.south, opts.west, opts.north, opts.east)) return configured;
  return DEFAULT_WIND_SOURCE;
}

/** Build the WCS GetCoverage URL for `opts` against `caps`. Exported for
 * unit-testing the per-source URL shape (axes, scaleSize, time format). */
export function buildWindGridUrl(opts: FetchWindGridOptions, caps = getWindSourceCaps(opts.source)): string {
  // Lat is just clamped to layer extent.
  const south = Math.max(-90, Math.min(90, opts.south));
  const north = Math.max(-90, Math.min(90, opts.north));

  // Lon needs more care: Leaflet's getBounds() at low zoom on a wide
  // viewport readily returns values OUTSIDE [-180, 180] when the map
  // wraps the dateline (e.g., a Pacific-centred view at z3 returns
  // west=-250, east=-110). The WCS server doesn't accept those — it
  // returns HTTP 200 with an XML exception body, the parser fails,
  // and the overlay silently shows nothing. If the requested bbox
  // wraps, we expand to the full world; the sampler wraps lon during
  // lookup so coordinates outside [-180, 180] still find the right
  // cell. Costs more on the wire (server downsamples via adaptive
  // scaling), but wrap-prone viewports are already at low zoom where
  // the user has a coarse grid anyway.
  let west: number;
  let east: number;
  if (opts.west < -180 || opts.east > 180) {
    west = -180;
    east = 180;
  } else {
    west = opts.west;
    east = opts.east;
  }

  const params = new URLSearchParams({
    service: 'WCS',
    version: '2.0.1',
    request: 'GetCoverage',
    coverageId: opts.coverageId ?? caps.coverageId,
    format: 'text/plain',
  });

  // Subset axes depend on the source CRS. WCS 2.0 multi-subset: append
  // separately so URLSearchParams keeps both keys.
  if (caps.crs === 'EPSG:3857') {
    // Convert lat/lon bbox to Web Mercator metres and clamp to world bounds.
    const xMin = Math.max(-MERCATOR_MAX_M, lonToMercatorX(west));
    const xMax = Math.min(MERCATOR_MAX_M, lonToMercatorX(east));
    const yMin = Math.max(-MERCATOR_MAX_M, latToMercatorY(south));
    const yMax = Math.min(MERCATOR_MAX_M, latToMercatorY(north));
    params.append('subset', `X(${xMin},${xMax})`);
    params.append('subset', `Y(${yMin},${yMax})`);
  } else {
    params.append('subset', `Lat(${south},${north})`);
    params.append('subset', `Long(${west},${east})`);
  }
  if (opts.timeIso) {
    // WCS 2.0 wants the time literal quoted: subset=time("2026-05-10T12:00:00Z")
    params.append('subset', `time("${opts.timeIso}")`);
  }

  // Adaptive downsample. If the native-resolution grid would exceed maxCells
  // (e.g., world view at low zoom), ask GeoServer's WCS Scaling extension to
  // render the bbox at a coarser grid that fits. Aspect-preserving scale
  // factor: cells along each axis ≈ native × sqrt(maxCells/nativeCells).
  const nativeStep = opts.nativeStep ?? caps.nativeStep;
  const maxCells = opts.maxCells ?? DEFAULT_MAX_CELLS;
  // Native cell count uses the source's CRS units. For EPSG:4326 nativeStep
  // is in degrees and we use lat/lon span. For EPSG:3857 nativeStep is in
  // metres and we use the Mercator span — same spatial dimension, just in
  // the source's native units so the cell-count estimate is correct.
  let nativeRows: number;
  let nativeCols: number;
  if (caps.crs === 'EPSG:3857') {
    const xSpan = Math.abs(lonToMercatorX(east) - lonToMercatorX(west));
    const ySpan = Math.abs(latToMercatorY(north) - latToMercatorY(south));
    nativeRows = Math.max(1, Math.ceil(ySpan / nativeStep));
    nativeCols = Math.max(1, Math.ceil(xSpan / nativeStep));
  } else {
    nativeRows = Math.max(1, Math.ceil((north - south) / nativeStep));
    nativeCols = Math.max(1, Math.ceil((east - west) / nativeStep));
  }
  const nativeCells = nativeRows * nativeCols;
  if (nativeCells > maxCells) {
    const scale = Math.sqrt(maxCells / nativeCells);
    const targetRows = Math.max(2, Math.floor(nativeRows * scale));
    const targetCols = Math.max(2, Math.floor(nativeCols * scale));
    // WCS axis names use full OGC URIs; i = column (axis 0), j = row (axis 1).
    params.append(
      'scaleSize',
      `http://www.opengis.net/def/axis/OGC/1/i(${targetCols}),`
        + `http://www.opengis.net/def/axis/OGC/1/j(${targetRows})`,
    );
  }

  return `${caps.wcsUrl}?${params.toString()}`;
}

// ── sampling helpers ──────────────────────────────────────────────────────
//
// Pure: given a parsed WindGrid, look up or interpolate the U/V at a point.
// Used by both overlays after the bulk fetch lands.

/** Wrap a longitude to its [-180, 180] equivalent. Particles in dateline-
 * crossing viewports get lon coords outside that range from Leaflet's
 * containerPointToLatLng (e.g., -210 for the wrapped Pacific). The
 * fetcher in those cases pulls the whole world, and this wrap lets the
 * sampler find the cell at the equivalent in-range longitude. */
function wrapLon(lon: number): number {
  return ((lon + 180) % 360 + 360) % 360 - 180;
}

/** Snap a (lat, lon) to its WindGrid cell and return the U/V there.
 * Returns (0, 0) for points outside the grid bbox. */
export function sampleWindGridNearest(
  grid: WindGrid,
  lat: number,
  lon: number,
): { u: number; v: number } {
  const wlon = wrapLon(lon);
  const r = Math.floor((lat - grid.latMin) / grid.step);
  const c = Math.floor((wlon - grid.lonMin) / grid.step);
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
  const wlon = wrapLon(lon);
  // Convert (lat, lon) to fractional row/col where (0, 0) is the SW cell centre.
  const fr = (lat - grid.latMin) / grid.step - 0.5;
  const fc = (wlon - grid.lonMin) / grid.step - 0.5;
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

    // Sweep expired entries. Without this, an expired entry was only
    // ever REPLACED when its exact key was requested again — panning
    // around after TTL expiry accreted resolved promises each holding
    // a WindGrid of up to 50k {u,v} objects (single-digit MB per
    // entry) for the life of the page, since the module-level
    // singleton never goes away. The map stays small (a handful of
    // keys), so an O(n) sweep per fetch is effectively free.
    for (const [k, entry] of this._cache) {
      if (entry.expiresAt <= now) this._cache.delete(k);
    }

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
    // Round bbox to native grid step so jittery viewport changes that
    // snap to the same WCS cells share a cache entry. ICON-D2 native
    // is 0.25° (snap to ¼°). Finer-resolution sources (NDFD ~2.5 km
    // ≈ 0.025°) snap to a tighter grid via the per-source factor.
    //
    // Cache by the RESOLVED source (post-bbox-fallback), not the
    // configured one. Two reasons: (a) panning from CONUS to Europe
    // changes the resolved source from NDFD to AICON, and the AICON
    // fetch should cache distinctly so panning back to CONUS doesn't
    // serve stale AICON tiles; (b) two cards with different
    // wind_source configs but the same actual fetch (e.g. both
    // resolved to AICON outside the US) can share the result.
    const source = resolveSourceForBbox(opts);
    const caps = getWindSourceCaps(source);
    const snapFactor = caps.crs === 'EPSG:3857' ? 40 : 4;  // 0.025° vs 0.25°
    const snap = (v: number): number => Math.round(v * snapFactor) / snapFactor;
    return [
      source,
      opts.coverageId ?? caps.coverageId,
      opts.timeIso ?? '',
      snap(opts.south), snap(opts.west), snap(opts.north), snap(opts.east),
    ].join('|');
  }
}

// Module-level singleton: both wind overlays share this instance so their
// concurrent fetches coalesce. Callers don't need to construct their own.
export const windGridFetcher = new WindGridFetcher();
