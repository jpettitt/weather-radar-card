// Mounts the real card under happy-dom. Callers stub fetch (vi.stubGlobal)
// so no request leaves the test.
import '../../src/weather-radar-card';

/* eslint-disable @typescript-eslint/no-explicit-any */

export function cardHass(over: Record<string, unknown> = {}): any {
  return {
    states: {},
    config: { latitude: 40, longitude: -100, unit_system: { length: 'km' }, time_zone: 'UTC' },
    themes: { darkMode: false },
    language: 'en',
    locale: { language: 'en' },
    user: { id: 'u1', name: 'Viewer' },
    callWS: async () => ({ value: {} }),
    ...over,
  };
}

export function trackerState(lat: number, lon: number, id = 'device_tracker.car'): Record<string, unknown> {
  return { [id]: { entity_id: id, state: 'not_home', attributes: { latitude: lat, longitude: lon } } };
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function mountCard(config: Record<string, unknown>, hass: any, parent: Element = document.body): Promise<any> {
  const el: any = document.createElement('weather-radar-card');
  el.setConfig({ type: 'custom:weather-radar-card', ...config });
  el.hass = hass;
  parent.appendChild(el);
  await el.updateComplete;
  await tick();
  return el;
}
