import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  chooseStartRun,
  dwdIsoTime,
  fetchLatestRun,
  markUnverified,
  parseLatestRun,
  pinToRun,
  planForecastRefresh,
  recalledRun,
  rememberRun,
  swappableFrames,
  type RunFrame,
} from '../src/forecast-refresh';

const MIN = 60;
const t = (iso: string): number => Date.parse(iso) / 1000;

// Shape of DWD's per-layer GetCapabilities (trimmed): TIME is a range,
// REFERENCE_TIME a comma list, newest last.
const CAPS = `<?xml version="1.0"?><WMS_Capabilities><Capability><Layer><Layer>
  <Name>Radar_wn-product_1x1km_ger</Name>
  <Dimension name="time" default="current" units="ISO8601">2026-10-01T00:00:00.000Z/2026-10-05T05:25:00.000Z/PT5M</Dimension>
  <Dimension name="REFERENCE_TIME" default="current" units="ISO8601">2026-10-05T03:15:00.000Z,2026-10-05T03:20:00.000Z,2026-10-05T03:25:00.000Z</Dimension>
</Layer></Layer></Capability></WMS_Capabilities>`;

describe('parseLatestRun', () => {
  it('returns the newest REFERENCE_TIME, not the time dimension', () => {
    expect(parseLatestRun(CAPS)).toBe(t('2026-10-05T03:25:00Z'));
  });

  it('takes the end of a start/end/period range', () => {
    const xml = '<Dimension name="REFERENCE_TIME" units="ISO8601">2026-10-05T00:00:00Z/2026-10-05T03:30:00Z/PT5M</Dimension>';
    expect(parseLatestRun(xml)).toBe(t('2026-10-05T03:30:00Z'));
  });

  it('returns null when the layer has no runs or the document is junk', () => {
    expect(parseLatestRun('<Dimension name="time">2026-10-05T00:00:00Z</Dimension>')).toBeNull();
    expect(parseLatestRun('<Dimension name="REFERENCE_TIME">nonsense</Dimension>')).toBeNull();
    expect(parseLatestRun('')).toBeNull();
  });
});

describe('dwdIsoTime', () => {
  it('formats epoch seconds the way DWD accepts them', () => {
    expect(dwdIsoTime(t('2026-10-05T03:25:00Z'))).toBe('2026-10-05T03:25:00Z');
  });
});

describe('pinToRun', () => {
  it('pins only frames the run still forecasts', () => {
    const run = t('2026-10-05T03:25:00Z');
    const frames = [{ time: run - 5 * MIN }, { time: run }, { time: run + 5 * MIN }];
    expect(pinToRun(frames, run)).toEqual([
      { time: run - 5 * MIN },
      { time: run },
      { time: run + 5 * MIN, run },
    ]);
  });
});

describe('planForecastRefresh', () => {
  const run0 = t('2026-10-05T03:20:00Z');
  const run1 = run0 + 5 * MIN;
  const nowMs = (run1 + 4 * MIN) * 1000;
  // Observed frame, two forecast frames pinned to run0.
  const frames = [
    { time: run0 - 5 * MIN },
    { time: run0 + 5 * MIN, run: run0 },
    { time: run0 + 10 * MIN, run: run0 },
  ];

  it('does nothing when no run newer than the one on screen exists — even every 5 min', () => {
    const plan = planForecastRefresh(frames, run0, 0, 5, nowMs);
    expect(plan).toEqual({ forecast: [], observed: [] });
  });

  it('refetches forecast frames from the newer run once the interval has passed', () => {
    const plan = planForecastRefresh(frames, run1, nowMs - 15 * 60_000, 15, nowMs);
    expect(plan.forecast).toEqual([run0 + 10 * MIN]);
  });

  it('turns a forecast frame the newer run now covers into observed radar', () => {
    const plan = planForecastRefresh(frames, run1, nowMs - 15 * 60_000, 15, nowMs);
    expect(plan.observed).toEqual([run0 + 5 * MIN]);
  });

  it('still converts crossed frames when the forecast interval has not passed', () => {
    const plan = planForecastRefresh(frames, run1, nowMs - 5 * 60_000, 15, nowMs);
    expect(plan.forecast).toEqual([]);
    expect(plan.observed).toEqual([run0 + 5 * MIN]);
  });

  it('pins frames that loaded unpinned (run lookup failed at init) on the next due refresh', () => {
    const unpinned = [{ time: run0 - 5 * MIN }, { time: run1 + 5 * MIN }];
    const plan = planForecastRefresh(unpinned, run1, 0, 15, nowMs);
    expect(plan.forecast).toEqual([run1 + 5 * MIN]);
    expect(plan.observed).toEqual([]);
  });

  it('refetches frames loaded before the run was known, as observed or pinned', () => {
    // Loaded unpinned at init with the run list down: the frame at run0+5
    // got whatever DWD served then — a forecast, if run0 was the newest run.
    const loaded = markUnverified<RunFrame>(
      [{ time: run0 - 30 * MIN }, { time: run0 + 5 * MIN }, { time: run1 + 5 * MIN }],
      (run0 - 15 * MIN) * 1000,
    );
    expect(loaded.map((f) => f.unverified)).toEqual([undefined, true, true]);
    const plan = planForecastRefresh(loaded, run1, 0, 15, nowMs);
    expect(plan.observed).toEqual([run0 + 5 * MIN]);
    expect(plan.forecast).toEqual([run1 + 5 * MIN]);
  });

  it('never touches frames that were observed all along', () => {
    const observedOnly = [{ time: run0 - 10 * MIN }, { time: run0 - 5 * MIN }];
    expect(planForecastRefresh(observedOnly, run1, 0, 5, nowMs)).toEqual({ forecast: [], observed: [] });
  });
});

describe('swappableFrames', () => {
  // Slots map to frame indices 0..5.
  const loaded = [0, 1, 2, 3, 4, 5];

  it('swaps everything when nothing is mid-fade', () => {
    expect(swappableFrames([1, 3, 5], loaded, 3, false)).toEqual([1, 3, 5]);
  });

  it('holds back the frame on screen and the two before it while the loop runs', () => {
    expect(swappableFrames([0, 1, 2, 3, 4, 5], loaded, 3, true)).toEqual([0, 4, 5]);
  });

  it('wraps around the start of the loop', () => {
    expect(swappableFrames([0, 1, 2, 3, 4, 5], loaded, 0, true)).toEqual([1, 2, 3]);
  });

  it('maps slots to frame indices when some frames failed to load', () => {
    // Slots 0..3 hold frames 0, 2, 4, 5.
    expect(swappableFrames([1, 2, 4, 5], [0, 2, 4, 5], 2, true)).toEqual([1, 5]);
  });
});

describe('fetchLatestRun', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });

  it("asks the layer's own GetCapabilities, without the workspace prefix", async () => {
    const fetchMock = vi.fn(async () => new Response(CAPS, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(fetchLatestRun('dwd:Radar_wn-product_1x1km_ger')).resolves.toBe(t('2026-10-05T03:25:00Z'));
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe(
      'https://maps.dwd.de/geoserver/dwd/Radar_wn-product_1x1km_ger/ows?service=WMS&version=1.3.0&request=GetCapabilities',
    );
  });

  it('gives up after 10 s, so a stalled request cannot hold DWD init or the update chain', async () => {
    vi.useFakeTimers();
    try {
      global.fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
      let result: number | null | undefined;
      void fetchLatestRun('Niederschlagsradar').then((r) => { result = r; });
      await vi.advanceTimersByTimeAsync(9_900);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      expect(result).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null on an HTTP error or a network failure', async () => {
    global.fetch = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    await expect(fetchLatestRun('Niederschlagsradar')).resolves.toBeNull();
    global.fetch = vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch;
    await expect(fetchLatestRun('Niederschlagsradar')).resolves.toBeNull();
  });
});

describe('remembered run (#279 forecast cache)', () => {
  afterEach(() => localStorage.clear());

  it('remembers the last run per DWD layer', () => {
    rememberRun('Radar_wn-product_1x1km_ger', 1_800_000_000);
    expect(recalledRun('Radar_wn-product_1x1km_ger')).toBe(1_800_000_000);
    expect(recalledRun('Niederschlagsradar')).toBeNull();
  });

  it('ignores a missing or corrupt value', () => {
    localStorage.setItem('weather-radar-card:dwd-forecast-run:x', 'garbage');
    expect(recalledRun('x')).toBeNull();
  });
});

describe('chooseStartRun', () => {
  const latest = t('2026-10-08T16:40:00Z');
  const now = (latest + 6 * MIN) * 1000;
  const max = 30 * 60_000;

  it('starts from the remembered run while it is at most 30 min old', () => {
    expect(chooseStartRun(latest, latest - 10 * MIN, now, max)).toBe(latest - 10 * MIN);
    expect(chooseStartRun(latest, latest - 24 * MIN, now, max)).toBe(latest - 24 * MIN);
  });

  it('starts from the newest run otherwise', () => {
    expect(chooseStartRun(latest, null, now, max)).toBe(latest);
    expect(chooseStartRun(latest, latest - 25 * MIN, now, max)).toBe(latest); // 31 min old
    expect(chooseStartRun(latest, latest, now, max)).toBe(latest);
    expect(chooseStartRun(latest, latest + 5 * MIN, now, max)).toBe(latest);
  });
});
