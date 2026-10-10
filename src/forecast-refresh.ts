// DWD forecast refresh (#279). DWD's radar layers have two time axes: TIME
// (the frame) and REFERENCE_TIME (the nowcast run, one every 5 min, each
// covering +2 h). A request without a run gets the newest one, so a forecast
// frame fetched once shows whatever run was newest at that moment — forever.
// With refresh on, forecast frames are pinned to a run via DIM_REFERENCE_TIME
// (the plain REFERENCE_TIME name is ignored by DWD's GeoServer) and refetched
// only when GetCapabilities lists a newer run.

const DWD_GEOSERVER = 'https://maps.dwd.de/geoserver/dwd';

export const FORECAST_REFRESH_CHOICES = [5, 10, 15, 30, 60];

// DWD init and every update wait for the run list, so a stalled request
// would hold the radar blank and stop the update chain; give up and fall
// back as if it had failed.
const RUN_LIST_TIMEOUT_MS = 10_000;

/** Epoch seconds as the ISO form DWD accepts for TIME / DIM_REFERENCE_TIME. */
export function dwdIsoTime(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().split('.')[0] + 'Z';
}

/**
 * Epoch ms of a `dwd_time_override`, or null when it is unset or not a date.
 * Shared by the radar player and the wind anchor: parsed separately, a bad
 * value reached the wind overlays as NaN and threw inside map init.
 */
export function parseDwdTimeOverride(override: string | undefined | null): number | null {
  if (!override) return null;
  const ms = new Date(override).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/** Newest REFERENCE_TIME (epoch seconds) in a GetCapabilities document, or null. */
export function parseLatestRun(xml: string): number | null {
  const m = xml.match(/<Dimension[^>]*name="REFERENCE_TIME"[^>]*>([^<]*)</);
  if (!m) return null;
  let latest = -Infinity;
  for (const item of m[1].split(',')) {
    // Lists today, but WMS also allows start/end/period ranges.
    const value = item.includes('/') ? item.split('/')[1] : item;
    const t = Date.parse(value.trim());
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return latest === -Infinity ? null : latest / 1000;
}

/** Newest run listed for `layerName`, or null on any failure (refresh just skips a tick). */
export async function fetchLatestRun(layerName: string, signal?: AbortSignal): Promise<number | null> {
  const layer = encodeURIComponent(layerName.replace(/^dwd:/, ''));
  // setTimeout rather than AbortSignal.timeout(): older tablet WebViews lack it.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RUN_LIST_TIMEOUT_MS);
  const onAbort = (): void => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(`${DWD_GEOSERVER}/${layer}/ows?service=WMS&version=1.3.0&request=GetCapabilities`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return parseLatestRun(await res.text());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export interface RunFrame {
  time: number;
  /** Run (epoch seconds) a forecast frame is pinned to; undefined for observed frames. */
  run?: number;
  /**
   * Loaded unpinned while the run was unknown (run list failed), so it may
   * hold the forecast DWD served then. The next refresh with a known run
   * refetches it, as observed or pinned.
   */
  unverified?: boolean;
}

/** Flag frames newer than `finalUpToMs` as unverified (see RunFrame). */
export function markUnverified<T extends RunFrame>(frames: T[], finalUpToMs: number): T[] {
  return frames.map((f) => (f.time * 1000 > finalUpToMs ? { ...f, unverified: true } : f));
}

/** Pin every frame the run still forecasts (time after the run) to that run. */
export function pinToRun<T extends RunFrame>(frames: T[], run: number): T[] {
  return frames.map((f) => (f.time > run ? { ...f, run } : f));
}

export interface ForecastRefreshPlan {
  /** Frame times to refetch pinned to the newest run. */
  forecast: number[];
  /** Forecast frames the newest run now covers as observed radar. */
  observed: number[];
}

/**
 * Which frames to refetch this tick. Forecast frames only when a run newer
 * than every pinned frame's exists *and* `intervalMin` has passed since the
 * last forecast refresh — so a short interval never reloads the same run.
 * Frames that crossed into observed, or were loaded unverified, are
 * refetched on every tick that finds them, whatever the interval.
 */
export function planForecastRefresh(
  frames: RunFrame[],
  latestRun: number,
  lastRefreshAtMs: number,
  intervalMin: number,
  nowMs: number,
): ForecastRefreshPlan {
  const observed = frames
    .filter((f) => (f.run !== undefined || f.unverified) && f.time <= latestRun)
    .map((f) => f.time);
  const newRun = frames.some((f) => f.time > latestRun && (f.run === undefined || f.run < latestRun));
  const due = nowMs - lastRefreshAtMs >= intervalMin * 60_000;
  const forecast = newRun && due
    ? frames.filter((f) => f.time > latestRun && (f.run === undefined || f.run < latestRun)).map((f) => f.time)
    : [];
  return { forecast, observed };
}

/**
 * Frame indices whose loaded replacement can be swapped in now. While the
 * loop runs, the frame on screen and the two before it (a cushion still
 * fading out, or an older overlapping fade in smooth mode) wait for a later
 * tick; swapping one mid-fade would cut its transition short. Paused, every
 * frame is settled, so all can swap.
 */
export function swappableFrames(
  stagedFis: number[],
  loadedSlots: number[],
  currentSlot: number,
  running: boolean,
): number[] {
  if (!running || loadedSlots.length === 0) return stagedFis;
  const n = loadedSlots.length;
  const busy = new Set<number>();
  for (let back = 0; back < 3 && back < n; back++) {
    const fi = loadedSlots[(currentSlot - back + n) % n];
    if (fi !== undefined) busy.add(fi);
  }
  return stagedFis.filter((fi) => !busy.has(fi));
}

// The run a card last pinned its forecast to, per DWD layer. Its tiles are in
// the tile cache, so a reload can show that forecast at once and then catch
// up to the newest run. localStorage: per browser, like the IndexedDB cache
// it points into, and cleared along with it.
const RUN_KEY_PREFIX = 'weather-radar-card:dwd-forecast-run:';

export function rememberRun(layerName: string, runSec: number): void {
  try { localStorage.setItem(RUN_KEY_PREFIX + layerName, String(runSec)); } catch { /* storage blocked */ }
}

export function recalledRun(layerName: string): number | null {
  try {
    const v = Number(localStorage.getItem(RUN_KEY_PREFIX + layerName));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/**
 * Run to load the forecast from at init: the one used last when it's older
 * than the newest but no more than `maxAgeMs` old (its tiles are cached, so
 * the forecast shows at once and a catch-up refresh moves it on), else the
 * newest.
 */
export function chooseStartRun(latestSec: number, recalledSec: number | null, nowMs: number, maxAgeMs: number): number {
  if (recalledSec !== null && recalledSec < latestSec && nowMs - recalledSec * 1000 <= maxAgeMs) return recalledSec;
  return latestSec;
}
