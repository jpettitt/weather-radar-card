import type { HomeAssistant } from 'custom-card-helpers';

/**
 * True when the connected core is `year.month` or later. An unknown or
 * unparsable version counts as new: dev and custom builds track current HA.
 */
export function haAtLeast(hass: HomeAssistant | undefined, year: number, month: number): boolean {
  const m = /^(\d+)\.(\d+)/.exec(hass?.config?.version ?? '');
  if (!m) return true;
  const y = Number(m[1]);
  return y > year || (y === year && Number(m[2]) >= month);
}
