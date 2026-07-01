import type { WeatherRadarCardConfig } from './types';

/**
 * True when every changed top-level key between two configs is in
 * `allowedKeys`, and at least one of them actually changed. Used by
 * `setConfig` to detect narrow, expected config deltas (e.g. only the
 * layer-state id, only playback_speed, only the backprop'd view keys)
 * so those updates can skip a full map re-init.
 */
export function isOnlyKeysChanged(
  a: WeatherRadarCardConfig,
  b: WeatherRadarCardConfig,
  allowedKeys: ReadonlySet<string>,
): boolean {
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  let changed = false;
  for (const k of keys) {
    const av = JSON.stringify((a as Record<string, unknown>)[k]);
    const bv = JSON.stringify((b as Record<string, unknown>)[k]);
    if (av === bv) continue;
    if (!allowedKeys.has(k)) return false;
    changed = true;
  }
  return changed;
}
