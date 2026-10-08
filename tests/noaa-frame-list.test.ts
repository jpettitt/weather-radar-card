// NOAA opengeo frame-list discovery: GetCapabilities time-dimension
// parsing and ideal-grid-to-listing snapping. This replaced the blind
// 10-min grid + 15-min lag of the eventdriven server (whose metadata
// refused browsers) — frame times now come from the server's own
// listing, so every frame is real and unique by construction.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseTimeDimension, pickFrameTimes, fetchNoaaFrameTimes, noaaRegionAt,
  NOAA_OPENGEO_WMS_URL, noaaOpengeoLayers, dropMissingNoaaLayer, _resetMissingNoaaLayersForTests,
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
  it('request every regional mosaic through the global endpoint, CONUS last (drawn on top)', () => {
    expect(NOAA_OPENGEO_WMS_URL).toBe('https://opengeo.ncep.noaa.gov/geoserver/ows');
    expect(noaaOpengeoLayers()).toBe(
      'hawaii:hawaii_bref_qcd,alaska:alaska_bref_qcd,carib:carib_bref_qcd,guam:guam_bref_qcd,conus:conus_bref_qcd',
    );
  });

  it("reads a region's own listing", async () => {
    const fn = vi.fn(async () => ({ ok: true, text: async () => '' }));
    vi.stubGlobal('fetch', fn);
    await fetchNoaaFrameTimes(undefined, 'hawaii');
    expect(String((fn.mock.calls[0] as unknown[])[0])).toBe(
      'https://opengeo.ncep.noaa.gov/geoserver/hawaii/hawaii_bref_qcd/ows?service=WMS&version=1.3.0&request=GetCapabilities',
    );
    vi.unstubAllGlobals();
  });
});

// One missing layer fails every tile of the request (LayerNotDefined), so a
// layer opengeo reports missing is left out for the rest of the page load.
describe('dropMissingNoaaLayer', () => {
  beforeEach(() => _resetMissingNoaaLayersForTests());
  afterEach(() => _resetMissingNoaaLayersForTests());

  it('leaves out the layer opengeo named, with or without its workspace', () => {
    dropMissingNoaaLayer('guam:guam_bref_qcd');
    dropMissingNoaaLayer('carib_bref_qcd');
    expect(noaaOpengeoLayers()).toBe('hawaii:hawaii_bref_qcd,alaska:alaska_bref_qcd,conus:conus_bref_qcd');
  });

  it('keeps only CONUS when the report names none of our layers', () => {
    dropMissingNoaaLayer('');
    expect(noaaOpengeoLayers()).toBe('conus:conus_bref_qcd');
    _resetMissingNoaaLayersForTests();
    dropMissingNoaaLayer('nope:other_layer');
    expect(noaaOpengeoLayers()).toBe('conus:conus_bref_qcd');
  });

  it('never leaves no layer at all', () => {
    dropMissingNoaaLayer('');
    dropMissingNoaaLayer('conus:conus_bref_qcd');
    expect(noaaOpengeoLayers()).toBe('conus:conus_bref_qcd');
  });
});

describe('noaaRegionAt', () => {
  it.each([
    ['Honolulu', 21.31, -157.86, 'hawaii'],
    ['Anchorage', 61.22, -149.9, 'alaska'],
    ['San Juan', 18.47, -66.11, 'carib'],
    ['Guam', 13.44, 144.79, 'guam'],
    ['Miami (CONUS and Caribbean overlap: CONUS wins)', 25.76, -80.19, 'conus'],
    ['Kansas City', 39.1, -94.58, 'conus'],
    ['Berlin (outside every region)', 52.52, 13.4, 'conus'],
    ['Honolulu one world-wrap east', 21.31, -157.86 + 360, 'hawaii'],
  ])('%s → %s', (_name, lat, lon, region) => {
    expect(noaaRegionAt(lat, lon)).toBe(region);
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

  it('leaves out slots before the listing starts', () => {
    // Newest 1360, 5 min back => ideals 1060..1360; 1240 snaps to 1300 (60 s),
    // and 1060..1180 are more than 90 s before the oldest listed time.
    expect(pickFrameTimes([1300, 1360], 5, 1)).toEqual([1300, 1360]);
  });

  // The grid stays where the loop started (stride-phase.ts): re-anchoring on
  // the newest scan at every 5-min refresh turned a 10-min loop into a 5-min one.
  describe('on a fixed grid phase', () => {
    const scans = (fromMin: number, toMin: number): number[] =>
      Array.from({ length: (toMin - fromMin) / 2 + 1 }, (_, i) => t0 + (fromMin + i * 2) * 60 + 3);
    const atLoad = scans(0, 60);
    const phase = atLoad[atLoad.length - 1]; // newest scan at load: t0 + 60 min + 3 s

    it('adds no frame until a scan reaches the next slot', () => {
      const before = pickFrameTimes(atLoad, 60, 10, phase);
      expect(pickFrameTimes(scans(4, 66), 60, 10, phase).at(-1)).toBe(before.at(-1));
      expect(pickFrameTimes(scans(10, 70), 60, 10, phase).at(-1)).toBe(phase + 600);
    });

    it('matches anchoring on the newest scan when the phase is that scan', () => {
      expect(pickFrameTimes(atLoad, 60, 10, phase)).toEqual(pickFrameTimes(atLoad, 60, 10));
    });

    it('takes a scan up to 90 s from its slot, and no further', () => {
      const sparse = Array.from({ length: 7 }, (_, i) => t0 + i * 600);
      const newest = sparse[6];
      expect(pickFrameTimes(sparse, 60, 10, newest - 80)).toEqual(sparse);
      // The slot 80 s after the newest scan isn't settled, so that scan waits for it.
      expect(pickFrameTimes(sparse, 60, 10, newest + 80)).toEqual(sparse.slice(0, 6));
      expect(pickFrameTimes(sparse, 60, 10, newest + 100)).toEqual([]);
    });

    it('leaves out a slot with no scan within 90 s (an outage)', () => {
      const gap = scans(0, 60).filter((t) => t < t0 + 25 * 60 || t > t0 + 35 * 60);
      const out = pickFrameTimes(gap, 60, 10, phase);
      expect(out).not.toContain(t0 + 30 * 60 + 3);
      expect(out).toHaveLength(6);
    });
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
