// YAML-only refresh overrides (alerts_refresh_seconds,
// wildfire_refresh_minutes) reach setTimeout. A negative or tiny value
// polled the upstream back-to-back (-60 s: ~1000 alerts requests a second),
// so a value that is not a positive number means "use the adaptive default"
// and a positive one is held to a floor.

/** The override in ms, or null for the adaptive default. */
export function refreshOverrideMs(value: unknown, unitMs: number, floorMs: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.max(floorMs, value * unitMs);
}
