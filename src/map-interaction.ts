import type { WeatherRadarCardConfig } from './types';

// Shared by the L.map options and the wheel listener that flags user moves:
// a wheel event that can't zoom must not raise that flag, since no moveend
// follows to clear it and marker tracking would stall.
export function isWheelZoomEnabled(
  cfg: Partial<Pick<WeatherRadarCardConfig, 'static_map' | 'disable_wheel_zoom'>>,
): boolean {
  return cfg.static_map !== true && cfg.disable_wheel_zoom !== true;
}
