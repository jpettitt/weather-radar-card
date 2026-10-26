// DWD + forecast_minutes with no dwd_time_override: the radar's newest frame
// is now + forecast and moves on with the clock. The wind anchor was computed
// once at map init, so hours later the overlays still asked for that slice.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import { cardHass, mountCard, tick } from './helpers/mount-card';
import * as L from 'leaflet';
import { windGridFetcher } from '../src/wind-grid-fetcher';

/* eslint-disable @typescript-eslint/no-explicit-any */

const grid = { rows: 1, cols: 1, latMin: 50, lonMin: 10, step: 1, cells: [[{ u: 1, v: 1 }]] };
const hourIso = (ms: number): string =>
  new Date(Math.round(ms / 3_600_000) * 3_600_000).toISOString().split('.')[0] + 'Z';

// happy-dom has no 2D canvas; the streamline overlay only needs calls to succeed.
const fakeCtx = (): unknown => new Proxy({}, {
  get: (t: any, k) => (k in t ? t[k] : () => undefined),
  set: (t: any, k, v) => { t[k] = v; return true; },
});
vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(fakeCtx as any);

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(windGridFetcher.fetch).mockRestore?.();
  document.body.innerHTML = '';
});

async function windTimesAfterSixHours(extra: Record<string, unknown>): Promise<{ first: string | null; last: string | null }> {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-26T10:10:00Z'));
  const spy = vi.spyOn(windGridFetcher, 'fetch').mockResolvedValue(grid as any);
  const el = await mountCard({
    data_source: 'DWD', center_latitude: 50.5, center_longitude: 10.5,
    dwd_wind: 'arrows', dwd_wind_flow: true, ...extra,
  }, cardHass());
  expect(el._windOverlay).toBeTruthy();
  expect(el._windFlow).toBeTruthy();
  el._map.getSize = () => L.point(600, 400);   // happy-dom lays out nothing
  el._map.fire('moveend');   // both overlays refetch on moveend
  await tick(400);
  const first = spy.mock.calls.at(-1)![0].timeIso ?? null;
  vi.setSystemTime(Date.parse('2026-10-26T16:10:00Z'));
  spy.mockClear();
  el._map.fire('moveend');   // both overlays refetch on moveend
  await tick(400);
  const times = spy.mock.calls.map((c) => c[0].timeIso ?? null);
  expect(times.length).toBeGreaterThanOrEqual(2);
  expect(new Set(times).size).toBe(1);   // arrows and streamlines agree
  return { first, last: times[0] };
}

describe('DWD wind anchor', () => {
  it('a forecast-only anchor follows the clock', async () => {
    const { first, last } = await windTimesAfterSixHours({ forecast_minutes: 60 });
    expect(first).toBe('2026-10-26T11:00:00Z');
    expect(last).toBe(hourIso(Date.parse('2026-10-26T17:10:00Z')));
  });

  it('a dwd_time_override anchor stays fixed', async () => {
    const { first, last } = await windTimesAfterSixHours({
      forecast_minutes: 60, dwd_time_override: '2026-10-25T08:00:00Z',
    });
    expect(first).toBe('2026-10-25T09:00:00Z');
    expect(last).toBe('2026-10-25T09:00:00Z');
  });
});
