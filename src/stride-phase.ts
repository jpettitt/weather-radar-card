// Where a loop's frame grid sits: its frames fall on phase + k × stride
// (epoch seconds). Re-anchoring the grid on the newest frame at every refresh
// let a stride longer than the refresh period drift down to it — a 10-minute
// NOAA loop refreshed every 5 took each newest scan as a new frame. So the
// phase is fixed when a loop starts: from the newest frame, or from the phase
// cards on this source and stride last used if that was under half the
// window ago, so reloads and cards sharing a dashboard keep the same frame
// times. localStorage: per browser, like the tile cache whose entries those
// frame times match.
const KEY_PREFIX = 'weather-radar-card:stride-phase:';

const key = (source: string, strideSec: number): string => `${KEY_PREFIX}${source}:${strideSec}`;

export function gridPhase(timeSec: number, strideSec: number): number {
  return ((timeSec % strideSec) + strideSec) % strideSec;
}

export function recallStridePhase(source: string, strideSec: number, nowMs: number, maxAgeMs: number): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(key(source, strideSec)) ?? 'null') as { phase?: unknown; usedAt?: unknown } | null;
    if (typeof v?.phase !== 'number' || typeof v.usedAt !== 'number') return null;
    if (!(v.phase >= 0 && v.phase < strideSec) || nowMs - v.usedAt >= maxAgeMs) return null;
    return v.phase;
  } catch {
    return null; // storage blocked, or not ours
  }
}

export function rememberStridePhase(source: string, strideSec: number, phaseSec: number, nowMs: number): void {
  try {
    localStorage.setItem(key(source, strideSec), JSON.stringify({ phase: phaseSec, usedAt: nowMs }));
  } catch { /* storage blocked */ }
}
