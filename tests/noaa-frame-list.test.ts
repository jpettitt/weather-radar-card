// NOAA opengeo frame-list discovery: GetCapabilities time-dimension
// parsing and ideal-grid-to-listing snapping. This replaced the blind
// 10-min grid + 15-min lag of the eventdriven server (whose metadata
// refused browsers) — frame times now come from the server's own
// listing, so every frame is real and unique by construction.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseTimeDimension, pickFrameTimes, fetchNoaaFrameTimes,
  NOAA_OPENGEO_WMS_URL, NOAA_OPENGEO_LAYER,
} from '../src/noaa-frame-list';
import { getEffectiveTimeRange } from '../src/source-caps';

const dim = (content: string, tag = 'Dimension'): string =>
  `<WMS_Capabilities><Layer><${tag} name="time" units="ISO8601" default="x">${content}</${tag}></Layer></WMS_Capabilities>`;

describe('parseTimeDimension', () => {
  it('parses the discrete CSV list form into sorted epoch seconds', () => {
    const xml = dim('2026-06-12T13:58:05.000Z,2026-06-12T13:54:17.000Z,2026-06-12T14:00:10.000Z');
    expect(parseTimeDimension(xml)).toEqual([
      Date.parse('2026-06-12T13:54:17Z') / 1000,
      Date.parse('2026-06-12T13:58:05Z') / 1000,
      Date.parse('2026-06-12T14:00:10Z') / 1000,
    ]);
  });

  it('accepts the WMS 1.1.1 Extent form too', () => {
    const xml = dim('2026-06-12T14:00:10.000Z', 'Extent');
    expect(parseTimeDimension(xml)).toHaveLength(1);
  });

  it('returns [] for the interval form rather than synthesising a grid', () => {
    // Expanding start/end/period would reintroduce guessed timestamps —
    // exactly what this module exists to remove. Caller falls back.
    const xml = dim('2026-06-12T12:00:00Z/2026-06-12T14:00:00Z/PT2M');
    expect(parseTimeDimension(xml)).toEqual([]);
  });

  it('returns [] when no time dimension is present or values are garbage', () => {
    expect(parseTimeDimension('<WMS_Capabilities></WMS_Capabilities>')).toEqual([]);
    expect(parseTimeDimension(dim('not-a-date,also-not'))).toEqual([]);
  });

  it('finds the time dimension when name is not the first attribute, past a non-time Dimension', () => {
    // Real GeoServer capabilities list several dimensions per layer and
    // attribute order isn't fixed; a scanner that only tolerates one
    // char before name="time" would miss this.
    const xml = '<WMS_Capabilities><Layer>'
      + '<Dimension name="elevation" units="EPSG:5030">0</Dimension>'
      + '<Dimension units="ISO8601" default="2026-06-12T14:00:10.000Z" name="time" nearestValue="0">'
      + '2026-06-12T13:58:05.000Z,2026-06-12T14:00:10.000Z</Dimension>'
      + '</Layer></WMS_Capabilities>';
    expect(parseTimeDimension(xml)).toEqual([
      Date.parse('2026-06-12T13:58:05Z') / 1000,
      Date.parse('2026-06-12T14:00:10Z') / 1000,
    ]);
  });

  it('tolerates whitespace and newlines around each CSV entry', () => {
    // Date.parse rejects a value with surrounding whitespace, so each
    // entry must be trimmed or a pretty-printed listing parses to [].
    const xml = dim('\n      2026-06-12T13:58:05.000Z,\n      2026-06-12T14:00:10.000Z\n    ');
    expect(parseTimeDimension(xml)).toEqual([
      Date.parse('2026-06-12T13:58:05Z') / 1000,
      Date.parse('2026-06-12T14:00:10Z') / 1000,
    ]);
  });

  it('returns [] for a mixed list+interval rather than a partial listing', () => {
    // WMS-T allows `t1,start/end/period`. Expanding only the discrete
    // part would hand the caller an incomplete listing that looks valid.
    const xml = dim('2026-06-12T12:00:00Z,2026-06-12T13:00:00Z/2026-06-12T14:00:00Z/PT2M');
    expect(parseTimeDimension(xml)).toEqual([]);
  });
});

describe('fetchNoaaFrameTimes', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  const stubFetch = (res: Partial<Response>) => {
    const fn = vi.fn(async (_url: string, _init?: RequestInit) => res as Response);
    global.fetch = fn as unknown as typeof fetch;
    return fn;
  };

  it('requests the opengeo WMS 1.3.0 GetCapabilities URL, forwarding the abort signal', async () => {
    const fn = stubFetch({ ok: true, text: async () => dim('2026-06-12T14:00:10.000Z') });
    const ctrl = new AbortController();
    await fetchNoaaFrameTimes(ctrl.signal);
    expect(fn).toHaveBeenCalledTimes(1);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe(
      'https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows?service=WMS&version=1.3.0&request=GetCapabilities',
    );
    // Without the signal a superseded refresh can't cancel this request.
    expect(init?.signal).toBe(ctrl.signal);
  });

  it('resolves the parsed, sorted frame times on a 200', async () => {
    stubFetch({
      ok: true,
      text: async () => dim('2026-06-12T14:00:10.000Z,2026-06-12T13:58:05.000Z'),
    });
    expect(await fetchNoaaFrameTimes()).toEqual([
      Date.parse('2026-06-12T13:58:05Z') / 1000,
      Date.parse('2026-06-12T14:00:10Z') / 1000,
    ]);
  });

  it('resolves [] on a 200 with an unparseable body', async () => {
    stubFetch({ ok: true, text: async () => '<html>maintenance</html>' });
    expect(await fetchNoaaFrameTimes()).toEqual([]);
  });

  it('throws with the HTTP status on a non-2xx response', async () => {
    stubFetch({ ok: false, status: 503, text: async () => dim('2026-06-12T14:00:10.000Z') });
    await expect(fetchNoaaFrameTimes()).rejects.toThrow('NOAA capabilities HTTP 503');
  });
});

describe('opengeo endpoint constants', () => {
  // A typo here would only show up as blank radar in production.
  it('pin the WMS endpoint and layer the radar tiles are requested from', () => {
    expect(NOAA_OPENGEO_WMS_URL).toBe('https://opengeo.ncep.noaa.gov/geoserver/conus/conus_bref_qcd/ows');
    expect(NOAA_OPENGEO_LAYER).toBe('conus_bref_qcd');
  });
});

describe('pickFrameTimes', () => {
  // Listing every 2 min from t0, slightly irregular like the real server.
  const t0 = Date.parse('2026-06-12T12:00:00Z') / 1000;
  const listed = Array.from({ length: 60 }, (_, i) => t0 + i * 120 + (i % 3) * 7);

  it('anchors at the newest listed time', () => {
    const out = pickFrameTimes(listed, 60, 5);
    expect(out[out.length - 1]).toBe(listed[listed.length - 1]);
  });

  it('honours the past window at the requested stride (60 min / 5 min ≈ 13 frames)', () => {
    const out = pickFrameTimes(listed, 60, 5);
    expect(out.length).toBe(13);
    const newest = out[out.length - 1];
    const oldest = out[0];
    // Window ≈ 60 min, allow snap slop of one native step.
    expect(newest - oldest).toBeGreaterThanOrEqual(60 * 60 - 150);
    expect(newest - oldest).toBeLessThanOrEqual(60 * 60 + 150);
  });

  it('every returned time is one the server listed', () => {
    const set = new Set(listed);
    for (const t of pickFrameTimes(listed, 120, 2)) expect(set.has(t)).toBe(true);
  });

  it('collapses duplicate snaps when stride is finer than the listing', () => {
    // Sparse listing (10-min spacing) with a 2-min stride: adjacent
    // ideal slots snap to the same scan and must dedupe.
    const sparse = Array.from({ length: 7 }, (_, i) => t0 + i * 600);
    const out = pickFrameTimes(sparse, 60, 2);
    expect(out).toEqual(sparse);   // no duplicates, all 7 distinct scans
  });

  it('returns [] for an empty listing', () => {
    expect(pickFrameTimes([], 60, 5)).toEqual([]);
  });

  // Hand-computed snapping (epoch seconds, 1-min stride => 60 s slots).
  it('snaps each ideal slot to the nearest listed time, on either side', () => {
    // Newest 1300, 2 min back => ideals 1180, 1240, 1300.
    // 1180 -> 1100 (80 below vs 120 above), 1240 -> 1300 (60 above vs 140 below).
    expect(pickFrameTimes([1000, 1100, 1300], 2, 1)).toEqual([1100, 1300]);
  });

  it('ties snap to the newer listed time', () => {
    // Newest 1120, ideals 1060 and 1120; 1060 is exactly 60 from both
    // 1000 and 1120.
    expect(pickFrameTimes([1000, 1120], 1, 1)).toEqual([1120]);
  });

  it('clamps to the oldest entry when the window reaches back past the listing', () => {
    // Newest 1360, 5 min back => ideals 1060..1360; those before 1300
    // (the oldest listed time) all snap to it.
    expect(pickFrameTimes([1300, 1360], 5, 1)).toEqual([1300, 1360]);
  });
});

describe('getEffectiveTimeRange with stride choices (NOAA)', () => {
  const base = { type: 'custom:weather-radar-card' } as any;

  it('defaults to the 5-min stride', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'NOAA' });
    expect(r.strideMin).toBe(5);
    expect(r.frameCount).toBe(13);   // 60 min default past / 5 + 1
  });

  it('accepts each offered choice', () => {
    for (const s of [2, 5, 10]) {
      const r = getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: s });
      expect(r.strideMin).toBe(s);
    }
  });

  it('snaps an off-menu YAML stride to the nearest choice', () => {
    expect(getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: 4 }).strideMin).toBe(5);
    expect(getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: 1 }).strideMin).toBe(2);
    expect(getEffectiveTimeRange({ ...base, data_source: 'NOAA', frame_stride_minutes: 60 }).strideMin).toBe(10);
  });

  it('leaves grid sources (DWD multiple-of-native) behaviour unchanged', () => {
    const r = getEffectiveTimeRange({ ...base, data_source: 'DWD', frame_stride_minutes: 15 });
    expect(r.strideMin).toBe(15);   // 3 × native 5
    const r2 = getEffectiveTimeRange({ ...base, data_source: 'DWD', frame_stride_minutes: 3 });
    expect(r2.strideMin).toBe(5);   // below native → native
  });
});
