import { describe, it, expect, vi } from 'vitest';
import {
  parseWcsTextGrid,
  parseNdfdWcsGrid,
  fetchWindGrid,
  sampleWindGridNearest,
  sampleWindGridBilinear,
  WindGridFetcher,
  buildWindGridUrl,
  resolveSourceForBbox,
  DEFAULT_WIND_COVERAGE,
  type WindGrid,
  type FetchWindGridOptions,
} from '../src/wind-grid-fetcher';
import { DEFAULT_WIND_SOURCE } from '../src/wind-source-caps';

// ── parseWcsTextGrid ───────────────────────────────────────────────────────
//
// Real-shape fixture captured from a live DWD WCS GetCoverage call:
//   bbox lat ∈ [49.875, 51.875], lon ∈ [10.125, 12.125], step 0.25°
//   so 8 rows × 8 cols. The numbers below are abbreviated for readability —
//   the parser only cares about layout, the test pins specific cell values
//   to lock the row-flip and band-split logic.

const FIXTURE_8x8 = `Grid bounds: GeneralBounds[(10.125, 49.875), (12.125, 51.875)]
Grid CRS: GEOGCS["WGS84(DD)",
  DATUM["WGS84",
    SPHEROID["WGS84", 6378137.0, 298.257223563]],
  PRIMEM["Greenwich", 0.0],
  UNIT["degree", 0.017453292519943295],
  AXIS["Geodetic longitude", EAST],
  AXIS["Geodetic latitude", NORTH],
  AUTHORITY["EPSG","4326"]]
Grid range: GridEnvelope2D[761..768, 153..160]
Grid to world: PARAM_MT["Affine",
  PARAMETER["num_row", 3],
  PARAMETER["num_col", 3],
  PARAMETER["elt_0_0", 0.25],
  PARAMETER["elt_0_2", -180.0],
  PARAMETER["elt_1_1", -0.25],
  PARAMETER["elt_1_2", 90.0]]
Contents:
Band 0:
-1.0 -1.1 -1.2 -1.3 -1.4 -1.5 -1.6 -1.7
-2.0 -2.1 -2.2 -2.3 -2.4 -2.5 -2.6 -2.7
-3.0 -3.1 -3.2 -3.3 -3.4 -3.5 -3.6 -3.7
-4.0 -4.1 -4.2 -4.3 -4.4 -4.5 -4.6 -4.7
-5.0 -5.1 -5.2 -5.3 -5.4 -5.5 -5.6 -5.7
-6.0 -6.1 -6.2 -6.3 -6.4 -6.5 -6.6 -6.7
-7.0 -7.1 -7.2 -7.3 -7.4 -7.5 -7.6 -7.7
-8.0 -8.1 -8.2 -8.3 -8.4 -8.5 -8.6 -8.7
Band 1:
1.0 1.1 1.2 1.3 1.4 1.5 1.6 1.7
2.0 2.1 2.2 2.3 2.4 2.5 2.6 2.7
3.0 3.1 3.2 3.3 3.4 3.5 3.6 3.7
4.0 4.1 4.2 4.3 4.4 4.5 4.6 4.7
5.0 5.1 5.2 5.3 5.4 5.5 5.6 5.7
6.0 6.1 6.2 6.3 6.4 6.5 6.6 6.7
7.0 7.1 7.2 7.3 7.4 7.5 7.6 7.7
8.0 8.1 8.2 8.3 8.4 8.5 8.6 8.7
`;

describe('parseWcsTextGrid', () => {
  it('parses bounds, step, and dimensions from the header', () => {
    const g = parseWcsTextGrid(FIXTURE_8x8);
    expect(g.latMin).toBeCloseTo(49.875, 6);
    expect(g.lonMin).toBeCloseTo(10.125, 6);
    expect(g.step).toBeCloseTo(0.25, 6);
    expect(g.rows).toBe(8);
    expect(g.cols).toBe(8);
  });

  it('flips rows so cells[0] is the SOUTH row (file is top-down, output is bottom-up)', () => {
    // File row 0 = north (lat 51.75 cell centre); file row 7 = south (lat 50.0).
    // After flip, cells[0] = south row = file row 7 = "-8.0 …" / "8.0 …".
    const g = parseWcsTextGrid(FIXTURE_8x8);
    expect(g.cells[0][0]).toEqual({ u: -8.0, v: 8.0 });
    expect(g.cells[7][0]).toEqual({ u: -1.0, v: 1.0 });
  });

  it('preserves col ordering (col 0 = west, col 7 = east)', () => {
    const g = parseWcsTextGrid(FIXTURE_8x8);
    // South row, west to east: file row 7 columns 0..7 = "-8.0 -8.1 … -8.7"
    for (let c = 0; c < 8; c++) {
      expect(g.cells[0][c].u).toBeCloseTo(-8.0 - c * 0.1, 6);
      expect(g.cells[0][c].v).toBeCloseTo(8.0 + c * 0.1, 6);
    }
  });

  it('splits Band 0 (U) and Band 1 (V) correctly', () => {
    const g = parseWcsTextGrid(FIXTURE_8x8);
    // North row, west cell: file row 0 col 0 → (-1.0, 1.0)
    expect(g.cells[7][0].u).toBe(-1.0);
    expect(g.cells[7][0].v).toBe(1.0);
  });

  it('throws on missing Grid bounds line', () => {
    expect(() => parseWcsTextGrid('Contents:\nBand 0:\n0\n')).toThrow(/Grid bounds/);
  });

  it('throws on missing affine elt_0_0', () => {
    const broken = FIXTURE_8x8.replace('"elt_0_0", 0.25', '"elt_X_X", 0.25');
    expect(() => parseWcsTextGrid(broken)).toThrow(/elt_0_0/);
  });

  it('throws when a band has fewer rows than expected', () => {
    // Drop two of the Band 0 rows — should fail before we even look at Band 1.
    const broken = FIXTURE_8x8.replace(
      '-7.0 -7.1 -7.2 -7.3 -7.4 -7.5 -7.6 -7.7\n-8.0 -8.1 -8.2 -8.3 -8.4 -8.5 -8.6 -8.7\n',
      '',
    );
    expect(() => parseWcsTextGrid(broken)).toThrow(/Band 0:.*rows/);
  });

  it('throws when a row has fewer cols than expected', () => {
    const broken = FIXTURE_8x8.replace(
      '-1.0 -1.1 -1.2 -1.3 -1.4 -1.5 -1.6 -1.7',
      '-1.0 -1.1 -1.2',
    );
    expect(() => parseWcsTextGrid(broken)).toThrow(/cols/);
  });

  it('handles non-square cells where lon step ≠ lat step (the WCS-Scaling case)', () => {
    // When WCS Scaling fits a requested scaleSize across a non-square
    // bbox, the resulting grid has DIFFERENT lon and lat steps. Using
    // one step for both row and col counts produced an off-by-one row
    // count and the parser threw "Band 0: has N rows, expected N+1".
    // Bounds (lon -180..180, lat -90..90) with a 4×2 grid → lon step
    // 90, lat step 90 (equal here, but the affine carries them as two
    // distinct PARAMETER entries that the parser must read separately).
    // Mismatched-step variant: lon step 0.5, lat step 0.4 over a small bbox.
    const body = `Grid bounds: GeneralBounds[(10.0, 50.0), (12.0, 50.8)]
Grid CRS: …
Grid to world: PARAM_MT["Affine",
  PARAMETER["elt_0_0", 0.5],
  PARAMETER["elt_1_1", -0.4]]
Contents:
Band 0:
1 2 3 4
5 6 7 8
Band 1:
9 10 11 12
13 14 15 16
`;
    const g = parseWcsTextGrid(body);
    // 2° lon span / 0.5° lon step = 4 cols.
    // 0.8° lat span / 0.4° lat step = 2 rows.
    expect(g.cols).toBe(4);
    expect(g.rows).toBe(2);
    // Row-flip still holds: cells[0] is the south row.
    expect(g.cells[0]).toEqual([
      { u: 5, v: 13 }, { u: 6, v: 14 }, { u: 7, v: 15 }, { u: 8, v: 16 },
    ]);
  });

  it('handles a single-cell 1×1 grid', () => {
    const tiny = `Grid bounds: GeneralBounds[(10.0, 50.0), (10.25, 50.25)]
Grid CRS: …
Grid to world: PARAM_MT["Affine",
  PARAMETER["elt_0_0", 0.25],
  PARAMETER["elt_1_1", -0.25]]
Contents:
Band 0:
3.5
Band 1:
-1.25
`;
    const g = parseWcsTextGrid(tiny);
    expect(g.rows).toBe(1);
    expect(g.cols).toBe(1);
    expect(g.cells[0][0]).toEqual({ u: 3.5, v: -1.25 });
  });
});

// ── sampleWindGridNearest ─────────────────────────────────────────────────

describe('sampleWindGridNearest', () => {
  const grid: WindGrid = parseWcsTextGrid(FIXTURE_8x8);

  it('returns the south-west corner cell for a point inside the first cell', () => {
    // South row, west col: cells[0][0] = (-8.0, 8.0). Cell extent
    // lat ∈ [49.875, 50.125), lon ∈ [10.125, 10.375). Sample at (50.0, 10.2).
    expect(sampleWindGridNearest(grid, 50.0, 10.2)).toEqual({ u: -8.0, v: 8.0 });
  });

  it('returns (0, 0) for a point outside the bbox', () => {
    expect(sampleWindGridNearest(grid, 60.0, 10.5)).toEqual({ u: 0, v: 0 });
    expect(sampleWindGridNearest(grid, 50.5, 5.0)).toEqual({ u: 0, v: 0 });
  });

  it('walks rows north as latitude rises', () => {
    // (50.5, 10.2) → row 2 (lat 50.5 ∈ [50.375, 50.625)).
    // cells[2] = file row 5 = "-6.0 -6.1 …" / "6.0 6.1 …"
    expect(sampleWindGridNearest(grid, 50.5, 10.2)).toEqual({ u: -6.0, v: 6.0 });
  });

  it('walks cols east as longitude rises', () => {
    // (50.0, 11.2) → row 0, col 4 (lon 11.2 ∈ [11.125, 11.375)).
    // cells[0][4] = -8.0 - 0.4 = -8.4, 8.0 + 0.4 = 8.4
    expect(sampleWindGridNearest(grid, 50.0, 11.2)).toEqual({ u: -8.4, v: 8.4 });
  });
});

// ── sampleWindGridBilinear ─────────────────────────────────────────────────
//
// The old per-point GetFeatureInfo path went through GeoServer's default
// raster sampler (bilinear). To keep visual parity for barb/arrow icon
// placement after the WCS switch, the static-overlay path uses bilinear too.
// Cell centres are at (latMin + step/2 + r*step, lonMin + step/2 + c*step).

describe('sampleWindGridBilinear', () => {
  // 2×2 grid spanning lat ∈ [50, 50.5], lon ∈ [10, 10.5], step 0.25.
  // Cell centres: (50.125, 10.125), (50.125, 10.375),
  //               (50.375, 10.125), (50.375, 10.375).
  // U values laid out so each axis varies independently:
  //   col=0 (west)  → u=10           col=1 (east) → u=20
  //   row=0 (south) → v=0            row=1 (north) → v=4
  const grid: WindGrid = {
    rows: 2, cols: 2, latMin: 50, lonMin: 10, step: 0.25,
    cells: [
      [{ u: 10, v: 0 }, { u: 20, v: 0 }],   // south row
      [{ u: 10, v: 4 }, { u: 20, v: 4 }],   // north row
    ],
  };

  it('returns the cell value when sampled exactly at a cell centre', () => {
    expect(sampleWindGridBilinear(grid, 50.125, 10.125)).toEqual({ u: 10, v: 0 });
    expect(sampleWindGridBilinear(grid, 50.375, 10.375)).toEqual({ u: 20, v: 4 });
  });

  it('linearly blends along the lon axis halfway between cell centres', () => {
    // (50.125, 10.25) is on the lon midpoint between west (u=10) and east (u=20).
    const got = sampleWindGridBilinear(grid, 50.125, 10.25);
    expect(got.u).toBeCloseTo(15, 6);
    expect(got.v).toBeCloseTo(0, 6);
  });

  it('linearly blends along the lat axis halfway between cell centres', () => {
    // (50.25, 10.125) is on the lat midpoint between south (v=0) and north (v=4).
    const got = sampleWindGridBilinear(grid, 50.25, 10.125);
    expect(got.u).toBeCloseTo(10, 6);
    expect(got.v).toBeCloseTo(2, 6);
  });

  it('blends across both axes simultaneously', () => {
    // Centre of the 4 cells: equal weights → u = (10+20+10+20)/4 = 15, v = (0+0+4+4)/4 = 2.
    const got = sampleWindGridBilinear(grid, 50.25, 10.25);
    expect(got.u).toBeCloseTo(15, 6);
    expect(got.v).toBeCloseTo(2, 6);
  });

  it('clamps to the nearest cell centre for samples between bbox edge and edge cell centre', () => {
    // (50, 10) is the SW corner of the bbox — between bbox edge and cell (50.125, 10.125)'s centre.
    // The clamp keeps us at the SW cell value rather than going to (0, 0).
    expect(sampleWindGridBilinear(grid, 50, 10)).toEqual({ u: 10, v: 0 });
  });

  it('returns (0, 0) for samples clearly outside the bbox', () => {
    expect(sampleWindGridBilinear(grid, 49, 10.25)).toEqual({ u: 0, v: 0 });
    expect(sampleWindGridBilinear(grid, 50.25, 9)).toEqual({ u: 0, v: 0 });
    expect(sampleWindGridBilinear(grid, 60, 10.25)).toEqual({ u: 0, v: 0 });
  });

  it('returns (0, 0) on an empty grid', () => {
    const empty: WindGrid = { rows: 0, cols: 0, latMin: 0, lonMin: 0, step: 0.25, cells: [] };
    expect(sampleWindGridBilinear(empty, 0, 0)).toEqual({ u: 0, v: 0 });
  });

  it('wraps lon outside [-180, 180] to the equivalent in-range cell (dateline crossing)', () => {
    // The 8x8 fixture spans lon 10.125 to 12.125. Sampling at lon=370.2
    // (which is 10.2 mod 360) should hit the same cell as lon=10.2.
    // Used by particles in dateline-crossing viewports where Leaflet
    // returns lon values past ±180.
    const fixtureGrid = parseWcsTextGrid(FIXTURE_8x8);
    const wrapped = sampleWindGridBilinear(fixtureGrid, 50.5, 370.2);
    const direct = sampleWindGridBilinear(fixtureGrid, 50.5, 10.2);
    expect(wrapped).toEqual(direct);
  });

  it('wraps negative lon past -180 to its [-180, 180] equivalent', () => {
    // Fetcher expands to full-world for wrap-prone bboxes; sampler then
    // gets called with lon=-200 (= 160 in wrapped coords). For a
    // world-spanning grid the value at lon=160 should come back.
    const worldGrid: WindGrid = {
      rows: 1, cols: 4, latMin: 50, lonMin: -180, step: 90,
      cells: [
        // -180..-90, -90..0, 0..90, 90..180
        [{ u: 1, v: 0 }, { u: 2, v: 0 }, { u: 3, v: 0 }, { u: 4, v: 0 }],
      ],
    };
    // lon=-200 wraps to lon=160 → cell at index 3 (90..180 range).
    const got = sampleWindGridNearest(worldGrid, 50.1, -200);
    expect(got).toEqual({ u: 4, v: 0 });
  });
});

// ── fetchWindGrid ──────────────────────────────────────────────────────────

describe('fetchWindGrid', () => {
  it('builds the WCS GetCoverage URL with multi-subset params', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(FIXTURE_8x8, { status: 200 });
    }) as any;

    await fetchWindGrid({
      south: 49.5, west: 10.0, north: 52.0, east: 12.5,
      timeIso: '2026-05-10T12:00:00Z',
      // Pin the source explicitly so this test still passes if
      // DEFAULT_WIND_SOURCE changes — it's a DWD-shape regression test,
      // not a "default source" test.
      source: 'dwd_icon',
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).toContain('service=WCS');
    expect(capturedUrl).toContain('version=2.0.1');
    expect(capturedUrl).toContain('request=GetCoverage');
    expect(capturedUrl).toContain(`coverageId=${encodeURIComponent(DEFAULT_WIND_COVERAGE)}`);
    expect(capturedUrl).toContain('format=text%2Fplain');
    expect(capturedUrl).toContain('subset=Lat%2849.5%2C52%29');
    expect(capturedUrl).toContain('subset=Long%2810%2C12.5%29');
    // time must be quoted per WCS 2.0
    expect(capturedUrl).toContain('subset=time%28%222026-05-10T12%3A00%3A00Z%22%29');
  });

  it('does NOT add a scaleSize parameter when the native grid fits maxCells', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(FIXTURE_8x8, { status: 200 });
    }) as any;

    // 4° × 4° bbox at 0.25° native = 16 × 16 = 256 cells, well under default cap.
    await fetchWindGrid({
      south: 50, west: 10, north: 54, east: 14,
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).not.toContain('scaleSize');
  });

  it('adds scaleSize to downsample when the native grid exceeds maxCells', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(FIXTURE_8x8, { status: 200 });
    }) as any;

    // World bbox: native = 720 × 1440 = 1 036 800 cells. With maxCells = 50 000
    // and aspect-preserving scale, we expect i ≈ 316, j ≈ 158 (within ±2).
    await fetchWindGrid({
      south: -90, west: -180, north: 90, east: 180,
      maxCells: 50_000,
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).toContain('scaleSize');
    // scaleSize=...i(N),...j(M) — both N and M must look reasonable.
    const m = decodeURIComponent(capturedUrl).match(/i\((\d+)\),http[^)]+j\((\d+)\)/);
    expect(m).not.toBeNull();
    const i = Number(m![1]);
    const j = Number(m![2]);
    // Aspect ratio matches bbox aspect (2:1 lon:lat for the world).
    expect(i / j).toBeCloseTo(2, 0);
    expect(i * j).toBeLessThanOrEqual(50_000);
    expect(i * j).toBeGreaterThan(40_000); // close to the budget
  });

  it('omits the time subset when timeIso is null', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(FIXTURE_8x8, { status: 200 });
    }) as any;

    await fetchWindGrid({
      south: 50, west: 10, north: 51, east: 11,
      timeIso: null,
      fetchImpl: fakeFetch,
    });

    expect(capturedUrl).not.toContain('subset=time');
  });

  it('throws on non-2xx responses', async () => {
    const fakeFetch = vi.fn(async () => new Response('error', { status: 500 })) as any;
    await expect(
      fetchWindGrid({ south: 50, west: 10, north: 51, east: 11, fetchImpl: fakeFetch }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws a descriptive error when WCS returns an XML exception with HTTP 200', async () => {
    // GeoServer returns 200 + ExceptionReport XML for recoverable errors
    // like out-of-bounds bbox. Without the explicit detection in
    // fetchWindGrid, parseWcsTextGrid would just say "missing Grid bounds
    // line" — useless for diagnosis.
    const xml = `<?xml version="1.0" encoding="UTF-8"?><ows:ExceptionReport xmlns:ows="http://www.opengis.net/ows/2.0" version="2.0.0"><ows:Exception exceptionCode="NoApplicableCode"><ows:ExceptionText>Failed to read the coverage</ows:ExceptionText></ows:Exception></ows:ExceptionReport>`;
    const fakeFetch = vi.fn(async () => new Response(xml, { status: 200 })) as any;
    await expect(
      fetchWindGrid({ south: 50, west: 10, north: 51, east: 11, fetchImpl: fakeFetch }),
    ).rejects.toThrow(/WCS returned exception.*Failed to read the coverage/);
  });

  it('clamps lat to [-90, 90] before sending the WCS subset', async () => {
    // Lat is just clamped — there's no geographically valid wraparound
    // for latitude (the map clips at the poles).
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(FIXTURE_8x8, { status: 200 });
    }) as any;

    await fetchWindGrid({
      south: -120, west: 10, north: 120, east: 11,
      fetchImpl: fakeFetch,
    });

    expect(decodeURIComponent(capturedUrl)).toContain('subset=Lat(-90,90)');
  });

  it('expands the lon subset to the full world when the bbox wraps the dateline', async () => {
    // Leaflet's getBounds() on a Pacific-centred low-zoom map readily
    // returns west/east values past ±180 (e.g., west=-250). Earlier
    // versions clamped to [-180, 180] which lost the wrapped strip
    // entirely; now we fetch the whole world so the sampler can wrap
    // lon during lookup.
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(FIXTURE_8x8, { status: 200 });
    }) as any;

    await fetchWindGrid({
      south: 30, west: -250, north: 60, east: -110,
      fetchImpl: fakeFetch,
    });

    expect(decodeURIComponent(capturedUrl)).toContain('subset=Long(-180,180)');
  });

  it('does NOT expand to the full world when the bbox stays inside [-180, 180]', async () => {
    let capturedUrl = '';
    const fakeFetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response(FIXTURE_8x8, { status: 200 });
    }) as any;

    await fetchWindGrid({
      south: 50, west: 10, north: 51, east: 11,
      fetchImpl: fakeFetch,
    });

    expect(decodeURIComponent(capturedUrl)).toContain('subset=Long(10,11)');
    expect(decodeURIComponent(capturedUrl)).not.toContain('Long(-180,180)');
  });

  it('returns the parsed grid on success', async () => {
    const fakeFetch = vi.fn(async () => new Response(FIXTURE_8x8, { status: 200 })) as any;
    const g = await fetchWindGrid({
      south: 49.5, west: 10.0, north: 52.0, east: 12.5, fetchImpl: fakeFetch,
    });
    expect(g.rows).toBe(8);
    expect(g.cols).toBe(8);
  });
});

// ── WindGridFetcher (Phase 2 coalescing) ──────────────────────────────────

describe('WindGridFetcher coalescing', () => {
  function makeStubGrid(seed: number): WindGrid {
    return {
      rows: 1, cols: 1, latMin: 50, lonMin: 10, step: 0.25,
      cells: [[{ u: seed, v: seed }]],
    };
  }

  it('coalesces concurrent fetches with the same key into one upstream call', async () => {
    let calls = 0;
    let resolveFn!: (g: WindGrid) => void;
    const upstream = vi.fn(async () => {
      calls++;
      return new Promise<WindGrid>(r => { resolveFn = r; });
    });

    const fetcher = new WindGridFetcher({ fetchImpl: upstream });
    const opts: FetchWindGridOptions = { south: 50, west: 10, north: 51, east: 11 };
    const p1 = fetcher.fetch(opts);
    const p2 = fetcher.fetch(opts);
    expect(calls).toBe(1); // only one upstream call

    resolveFn(makeStubGrid(42));
    const [g1, g2] = await Promise.all([p1, p2]);
    expect(g1).toBe(g2); // exact same Promise, exact same resolved object
    expect(g1.cells[0][0].u).toBe(42);
  });

  it('serves a cached result for repeat fetches inside the TTL window', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => {
      calls++;
      return makeStubGrid(7);
    });
    let nowMs = 1_000_000;
    const fetcher = new WindGridFetcher({
      fetchImpl: upstream,
      ttlMs: 60_000,
      now: () => nowMs,
    });
    const opts: FetchWindGridOptions = { south: 50, west: 10, north: 51, east: 11 };
    await fetcher.fetch(opts);
    nowMs += 30_000; // half a TTL later
    await fetcher.fetch(opts);
    expect(calls).toBe(1);
  });

  it('refetches once the TTL window has expired', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => {
      calls++;
      return makeStubGrid(calls);
    });
    let nowMs = 1_000_000;
    const fetcher = new WindGridFetcher({
      fetchImpl: upstream,
      ttlMs: 60_000,
      now: () => nowMs,
    });
    const opts: FetchWindGridOptions = { south: 50, west: 10, north: 51, east: 11 };
    await fetcher.fetch(opts);
    nowMs += 60_001; // past TTL
    await fetcher.fetch(opts);
    expect(calls).toBe(2);
  });

  it('treats different bboxes as different cache keys', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => { calls++; return makeStubGrid(0); });
    const fetcher = new WindGridFetcher({ fetchImpl: upstream });
    await fetcher.fetch({ south: 50, west: 10, north: 51, east: 11 });
    await fetcher.fetch({ south: 50, west: 10, north: 52, east: 11 });
    expect(calls).toBe(2);
  });

  it('treats different timeIso as different cache keys', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => { calls++; return makeStubGrid(0); });
    const fetcher = new WindGridFetcher({ fetchImpl: upstream });
    const bbox = { south: 50, west: 10, north: 51, east: 11 };
    await fetcher.fetch({ ...bbox, timeIso: '2026-05-10T12:00:00Z' });
    await fetcher.fetch({ ...bbox, timeIso: '2026-05-10T13:00:00Z' });
    expect(calls).toBe(2);
  });

  it('snaps bbox to the 0.25° grid so jittery viewport changes share a cache entry', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => { calls++; return makeStubGrid(0); });
    const fetcher = new WindGridFetcher({ fetchImpl: upstream });
    // 50.01 and 49.99 both snap to 50.00 at 0.25° granularity.
    await fetcher.fetch({ south: 50.01, west: 10, north: 51, east: 11 });
    await fetcher.fetch({ south: 49.99, west: 10, north: 51, east: 11 });
    expect(calls).toBe(1);
  });

  it('drops the cache entry on rejection so the next caller retries', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return makeStubGrid(99);
    });
    const fetcher = new WindGridFetcher({ fetchImpl: upstream });
    const opts: FetchWindGridOptions = { south: 50, west: 10, north: 51, east: 11 };
    await expect(fetcher.fetch(opts)).rejects.toThrow(/boom/);
    const g = await fetcher.fetch(opts); // retries upstream
    expect(g.cells[0][0].u).toBe(99);
    expect(calls).toBe(2);
  });

  it('treats different sources as different cache keys (no DWD/NDFD collision)', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => { calls++; return makeStubGrid(0); });
    const fetcher = new WindGridFetcher({ fetchImpl: upstream });
    const bbox = { south: 40, west: -100, north: 41, east: -99 };
    await fetcher.fetch({ ...bbox, source: 'dwd_icon' });
    await fetcher.fetch({ ...bbox, source: 'ndfd_wind' });
    expect(calls).toBe(2);
  });
});

// ── buildWindGridUrl ───────────────────────────────────────────────────────
// Pin per-source URL shape (axes, scaleSize, time format) so a regression
// in the URL builder doesn't slip through unit-tests just because the
// downstream parser is forgiving.

describe('buildWindGridUrl', () => {
  const bbox = { south: 49, west: 10, north: 51, east: 12 };

  it('DWD: uses Lat/Long subset axes in degrees against the DWD WCS endpoint', () => {
    const url = buildWindGridUrl({ ...bbox, source: 'dwd_icon' });
    expect(url).toContain('https://maps.dwd.de/geoserver/dwd/wcs');
    expect(url).toContain('coverageId=dwd__Icon_reg025_fd_sl_UV10M');
    expect(url).toContain('Lat%2849%2C51%29');
    expect(url).toContain('Long%2810%2C12%29');
    expect(url).toContain('format=text%2Fplain');
  });

  it('NDFD: converts lat/lon to EPSG:3857 metres on X/Y subset axes', () => {
    const url = buildWindGridUrl({ ...bbox, source: 'ndfd_wind' });
    expect(url).toContain('https://mapservices.weather.noaa.gov/geoserver/ndfd/wind/wcs');
    expect(url).toContain('coverageId=ndfd__wind');
    // Mercator: lon 10° ≈ 1113195 m, lon 12° ≈ 1335834 m. Match the
    // X axis prefix; exact value precision can drift with library, so
    // pattern-match the shape, not the digits.
    expect(url).toMatch(/X%28111\d{4,7}/);
    expect(url).toMatch(/Y%2862\d{5,8}/);  // lat 49° ≈ 6275837 m
  });

  it('threads timeIso into the WCS time subset literal', () => {
    const url = buildWindGridUrl({ ...bbox, source: 'dwd_icon', timeIso: '2026-05-15T12:00:00Z' });
    // URLSearchParams encodes the quotes as %22.
    expect(url).toContain('time%28%222026-05-15T12%3A00%3A00Z%22%29');
  });

  it('appends scaleSize when native cells exceed maxCells (DWD)', () => {
    // 360°×180° at 0.25° native ≈ 1 036 800 cells, way over the 50 000 cap.
    const url = buildWindGridUrl({
      south: -90, west: -180, north: 90, east: 180, source: 'dwd_icon',
    });
    expect(url).toContain('scaleSize');
    expect(url).toContain('axis%2FOGC%2F1%2Fi%28');  // i = column
    expect(url).toContain('axis%2FOGC%2F1%2Fj%28');  // j = row
  });

  it('skips scaleSize for small NDFD bboxes that fit under maxCells', () => {
    // 1°×1° at ~1428 m native ≈ ~7000 cells, under cap.
    const url = buildWindGridUrl({
      south: 40, west: -100, north: 41, east: -99, source: 'ndfd_wind',
    });
    expect(url).not.toContain('scaleSize');
  });

  it('expands wrap-prone bboxes to the full world (lon < -180 or > 180)', () => {
    const url = buildWindGridUrl({
      south: -10, west: -250, north: 10, east: -110, source: 'dwd_icon',
    });
    expect(url).toContain('Long%28-180%2C180%29');
  });
});

// ── parseNdfdWcsGrid ───────────────────────────────────────────────────────
// NDFD's text/plain output has the same layout as DWD's, but axes are X/Y
// in EPSG:3857 metres and bands are wind speed (m/s) and wind direction
// (degrees, meteorological "from"). The parser converts both to the
// canonical lat/lon + U/V WindGrid the downstream samplers consume.

// NDFD bounds order is (xMin, yMin) then (xMax, yMax). Mercator Y is
// positive northward so yMax > yMin. Three columns × 1428.6 m step =
// 4286 m span; same for rows.
const NDFD_FIXTURE_3x3 = `Grid bounds: GeneralBounds[(-10800000.0, 4495714.0), (-10795714.0, 4500000.0)]
Grid CRS: PROJCS["WGS 84 / Pseudo-Mercator", AUTHORITY["EPSG","3857"]]
Grid range: GridEnvelope2D[0..2, 0..2]
Grid to world: PARAM_MT["Affine",
  PARAMETER["num_row", 3],
  PARAMETER["num_col", 3],
  PARAMETER["elt_0_0", 1428.6666666666667],
  PARAMETER["elt_0_2", -10799285.71428571],
  PARAMETER["elt_1_1", -1428.6666666666667],
  PARAMETER["elt_1_2", 4499285.71428571]]
Contents:
Band 0:
10.0 10.0 10.0
0.0 0.0 0.0
20.0 20.0 20.0
Band 1:
0.0 0.0 0.0
90.0 90.0 90.0
180.0 180.0 180.0
`;

describe('parseNdfdWcsGrid', () => {
  const grid = parseNdfdWcsGrid(NDFD_FIXTURE_3x3);

  it('decodes Mercator metres → lat/lon degrees', () => {
    // X = -10800000m → lon ≈ -97° (US Plains region; Wichita-ish)
    expect(grid.lonMin).toBeCloseTo(-97.0, 1);
    // Y = 4495714m → lat ≈ 37.4°
    expect(grid.latMin).toBeCloseTo(37.4, 1);
  });

  it('flips file rows so cells[0] is the SOUTH row', () => {
    // File is top-down; band 0 row 0 = 10, row 2 = 20. After flip the
    // SOUTH row (cells[0]) was the LAST row in the file (band 0 = 20,
    // band 1 = 180°).
    // South wind (180°): u = 0, v = -20.
    expect(grid.cells[0][0].u).toBeCloseTo(0, 5);
    expect(grid.cells[0][0].v).toBeCloseTo(20, 5);  // -(-20) since cos(180°)=-1
    // Wait — for direction=180° meteorological ("from south, going north"):
    //   u = -20 × sin(π) = 0
    //   v = -20 × cos(π) = -20 × (-1) = +20  (positive = northward)
  });

  it('zero-speed cells produce zero U/V regardless of direction', () => {
    // Middle file row has speed 0, dir 90. After row-flip cells[1] is
    // the middle row. u = -0 × sin(π/2), v = -0 × cos(π/2). Use
    // toBeCloseTo because Math produces -0 here and Object.is(-0, 0) === false.
    expect(grid.cells[1][0].u).toBeCloseTo(0, 10);
    expect(grid.cells[1][0].v).toBeCloseTo(0, 10);
  });

  it('north wind (direction=0°, meteorological "from north"): u=0, v<0', () => {
    // The TOP file row (band 0 = 10, band 1 = 0°) becomes cells[2]
    // after the south-up flip.
    expect(grid.cells[2][0].u).toBeCloseTo(0, 5);
    expect(grid.cells[2][0].v).toBeCloseTo(-10, 5);  // -10 × cos(0) = -10
  });

  it('treats NaN speed/direction as calm', () => {
    const nanFixture = NDFD_FIXTURE_3x3.replace(
      '10.0 10.0 10.0',
      'NaN 10.0 10.0',
    );
    const g = parseNdfdWcsGrid(nanFixture);
    // The NaN cell is in file row 0 (band 0) which becomes cells[2] after
    // the south-up flip. Column 0.
    expect(g.cells[2][0].u).toBe(0);
    expect(g.cells[2][0].v).toBe(0);
  });

  it('treats NDFD 9999.0 fill sentinel as calm (covers no-data outside CONUS / AK / HI / PR)', () => {
    // Production NDFD returns 9999.0 for both bands in cells outside
    // coverage. The value is finite so Number.isFinite passes it; the
    // sentinel guard is what catches it. Without this guard, particles
    // teleport (speed × sin/cos with speed=9999 produces huge U/V) and
    // draw spurious long diagonal streaks out of legit trail endpoints.
    const fillFixture = NDFD_FIXTURE_3x3
      .replace('10.0 10.0 10.0\n0.0 0.0 0.0\n20.0 20.0 20.0',
        '9999.0 9999.0 9999.0\n9999.0 9999.0 9999.0\n9999.0 9999.0 9999.0')
      .replace('0.0 0.0 0.0\n90.0 90.0 90.0\n180.0 180.0 180.0',
        '9999.0 9999.0 9999.0\n9999.0 9999.0 9999.0\n9999.0 9999.0 9999.0');
    const g = parseNdfdWcsGrid(fillFixture);
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        expect(g.cells[r][c].u).toBe(0);
        expect(g.cells[r][c].v).toBe(0);
      }
    }
  });

  it('treats out-of-range direction (>360) as calm even when speed is plausible', () => {
    // Mixed-sentinel case: NDFD has been observed returning 9999 for
    // direction while speed is a real value (or vice-versa). Either side
    // of the pair being a sentinel triggers the calm fallback.
    const mixedFixture = NDFD_FIXTURE_3x3.replace(
      '0.0 0.0 0.0\n90.0 90.0 90.0\n180.0 180.0 180.0',
      '9999.0 9999.0 9999.0\n90.0 90.0 90.0\n180.0 180.0 180.0',
    );
    const g = parseNdfdWcsGrid(mixedFixture);
    // File row 0 (cells[2] after flip) had direction 9999 → calm.
    expect(g.cells[2][0].u).toBe(0);
    expect(g.cells[2][0].v).toBe(0);
    // File row 2 (cells[0] after flip) had direction 180 → real wind.
    // South wind (180°): u = 0, v = +20 (positive northward).
    expect(g.cells[0][0].v).toBeCloseTo(20, 5);
  });
});

// ── resolveSourceForBbox (silent fallback) ────────────────────────────────
// When wind_source is 'ndfd_wind' but the requested viewport centre is
// outside CONUS / AK / HI / PR, the fetcher silently falls back to the
// global default source so the user still sees real wind data. This is
// the per-fetch dispatch decision — the user's configured source in the
// card config is unchanged.

describe('resolveSourceForBbox', () => {
  it('NDFD configured + CONUS viewport: stays NDFD', () => {
    // ~Kansas bbox.
    const opts: FetchWindGridOptions = {
      source: 'ndfd_wind', south: 38, west: -100, north: 40, east: -98,
    };
    expect(resolveSourceForBbox(opts)).toBe('ndfd_wind');
  });

  it('NDFD configured + Europe viewport: silent fallback to global default', () => {
    // ~Germany bbox — clearly outside NDFD coverage.
    const opts: FetchWindGridOptions = {
      source: 'ndfd_wind', south: 50, west: 9, north: 52, east: 11,
    };
    expect(resolveSourceForBbox(opts)).toBe(DEFAULT_WIND_SOURCE);
    // Pin the default so a future flip is loud, not silent.
    expect(DEFAULT_WIND_SOURCE).toBe('dwd_aicon');
  });

  it('NDFD configured + Alaska viewport: stays NDFD (AK is in NDFD coverage)', () => {
    const opts: FetchWindGridOptions = {
      source: 'ndfd_wind', south: 61, west: -150, north: 62, east: -149,
    };
    expect(resolveSourceForBbox(opts)).toBe('ndfd_wind');
  });

  it('NDFD + boundary-straddling bbox uses centre to decide', () => {
    // Bbox centred just inside the CONUS east edge (~-66.5° lon) but
    // east edge spills past the bbox. Centre is what matters.
    const insideCentre: FetchWindGridOptions = {
      source: 'ndfd_wind', south: 40, west: -68, north: 41, east: -65,  // centre -66.5
    };
    expect(resolveSourceForBbox(insideCentre)).toBe('ndfd_wind');
    // Same bbox shifted east — centre now -63 → outside CONUS bbox → fall back.
    const outsideCentre: FetchWindGridOptions = {
      source: 'ndfd_wind', south: 40, west: -64, north: 41, east: -62,  // centre -63
    };
    expect(resolveSourceForBbox(outsideCentre)).toBe(DEFAULT_WIND_SOURCE);
  });

  it('AICON / ICON configured: never falls back regardless of bbox', () => {
    // Only NDFD has the US-only constraint. Other sources are global,
    // so the dispatcher must never override a non-NDFD configured source.
    const europe = { south: 50, west: 9, north: 52, east: 11 };
    expect(resolveSourceForBbox({ ...europe, source: 'dwd_aicon' })).toBe('dwd_aicon');
    expect(resolveSourceForBbox({ ...europe, source: 'dwd_icon' })).toBe('dwd_icon');
    const conus = { south: 38, west: -100, north: 40, east: -98 };
    expect(resolveSourceForBbox({ ...conus, source: 'dwd_aicon' })).toBe('dwd_aicon');
  });

  it('source omitted: uses DEFAULT_WIND_SOURCE, no fallback logic triggered', () => {
    // Absent source resolves to DEFAULT (aicon), which is never subject
    // to fallback. CONUS or non-CONUS, the answer is identical.
    const conus: FetchWindGridOptions = { south: 38, west: -100, north: 40, east: -98 };
    const europe: FetchWindGridOptions = { south: 50, west: 9, north: 52, east: 11 };
    expect(resolveSourceForBbox(conus)).toBe(DEFAULT_WIND_SOURCE);
    expect(resolveSourceForBbox(europe)).toBe(DEFAULT_WIND_SOURCE);
  });
});

// Cache-key consequence of the silent fallback: two NDFD fetches for
// bboxes on opposite sides of the US coast must NOT collide. Pinned
// here so a regression that drops the resolved-source from the key is
// caught even without a live network.
describe('WindGridFetcher cache (silent fallback)', () => {
  function makeStubGrid(u = 0): WindGrid {
    return {
      rows: 1, cols: 1, latMin: 0, lonMin: 0, step: 0.25,
      cells: [[{ u, v: 0 }]],
    };
  }

  it('NDFD-configured fetches on opposite sides of the coast cache distinctly', async () => {
    let calls = 0;
    const upstream = vi.fn(async () => { calls++; return makeStubGrid(0); });
    const fetcher = new WindGridFetcher({ fetchImpl: upstream });
    // CONUS bbox: stays NDFD.
    await fetcher.fetch({
      source: 'ndfd_wind', south: 38, west: -100, north: 40, east: -98,
    });
    // Europe bbox with NDFD configured: silent-falls-back to AICON.
    // Different resolved source → must not share a cache slot.
    await fetcher.fetch({
      source: 'ndfd_wind', south: 50, west: 9, north: 52, east: 11,
    });
    expect(calls).toBe(2);
  });
});
