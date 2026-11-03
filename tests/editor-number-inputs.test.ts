// Editor text fields that hold numbers: no keystroke may save NaN, and a
// re-render must not rewrite what the user is typing ('37.' to '37', '-0'
// to '0'). Also the person marker's "Use entity picture" switch.
// Renders the real editor element (pre-4.0 review, 2026-10-26).

import { describe, it, expect } from 'vitest';
import '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function renderEditor(
  config: Record<string, unknown>,
  view = 'main',
  states: Record<string, unknown> = {},
): Promise<any> {
  (window as any).loadCardHelpers = async () => ({});
  const ed = document.createElement('weather-radar-card-editor') as any;
  ed.hass = { states, config: { components: [] }, language: 'en' };
  ed.setConfig({ type: 'custom:weather-radar-card', ...config });
  document.body.appendChild(ed);
  await new Promise((r) => setTimeout(r, 0));
  ed._view = view;
  if (view === 'presets') ed._presetOpen = 0;
  ed.requestUpdate();
  await ed.updateComplete;
  return ed;
}

const inputs = (ed: any): any[] => [...ed.shadowRoot.querySelectorAll('ha-input')];
const byConfig = (ed: any, key: string) => inputs(ed).find((i) => i.configValue === key);
const byMarker = (ed: any, field: string) => inputs(ed).find((i) => i.markerField === field);
const byLabel = (ed: any, label: string) => inputs(ed).find((i) => i.getAttribute('label') === label);

// Each config the editor sent, as HA would store it (NaN becomes null in JSON).
function record(ed: any): any[] {
  const sent: any[] = [];
  ed.addEventListener('config-changed', (e: any) => sent.push(JSON.parse(JSON.stringify(e.detail.config))));
  return sent;
}

async function setText(ed: any, el: any, text: string): Promise<void> {
  el.value = text;
  el.dispatchEvent(new Event('input'));
  await ed.updateComplete;
}

// Types one character at a time onto whatever the field shows, so a
// re-render that rewrites the field corrupts the result as it would for a user.
async function typeChars(ed: any, el: any, text: string): Promise<void> {
  for (const ch of text) await setText(ed, el, `${el.value}${ch}`);
}

const hasNull = (v: unknown): boolean => JSON.stringify(v).includes('null');

describe('marker latitude and longitude', () => {
  it('typing "-" over a value saves no NaN and leaves "-" in the field', async () => {
    const ed = await renderEditor({ markers: [{ latitude: 37.5, longitude: 122.4 }] }, 'markers');
    const sent = record(ed);
    const lat = byMarker(ed, 'latitude');
    await setText(ed, lat, '-');
    expect(sent.some(hasNull)).toBe(false);
    expect(ed._config.markers[0].latitude).toBe(37.5);
    expect(lat.value).toBe('-');
    await typeChars(ed, lat, '37.5');
    expect(ed._config.markers[0].latitude).toBe(-37.5);
  });

  it('a longitude typed from empty keeps its sign and decimals', async () => {
    for (const text of ['-0.1', '-122.4194', '7.05', '-0']) {
      const ed = await renderEditor({ markers: [{ latitude: 51.5, longitude: 9 }] }, 'markers');
      const sent = record(ed);
      const lon = byMarker(ed, 'longitude');
      await setText(ed, lon, '');
      await typeChars(ed, lon, text);
      expect(lon.value, text).toBe(text);
      expect(ed._config.markers[0].longitude, text).toBe(Number(text));
      expect(sent.some(hasNull), text).toBe(false);
    }
  });
});

describe('centre latitude', () => {
  it('keeps the decimal point when the last decimal digit is deleted', async () => {
    const ed = await renderEditor({ center_latitude: 37.5, center_longitude: -122.4 });
    const lat = byConfig(ed, 'center_latitude');
    await setText(ed, lat, '37.');
    expect(lat.value).toBe('37.');
    await typeChars(ed, lat, '6');
    expect(ed._config.center_latitude).toBe(37.6);
  });

  it('a longitude typed from empty keeps "-0." so -0.1 is saved', async () => {
    const ed = await renderEditor({ center_latitude: 51.5, center_longitude: 9 });
    const lon = byConfig(ed, 'center_longitude');
    await setText(ed, lon, '');
    await typeChars(ed, lon, '-0.1');
    expect(lon.value).toBe('-0.1');
    expect(ed._config.center_longitude).toBe(-0.1);
  });
});

describe('preset latitude and longitude', () => {
  it('a longitude typed from empty keeps its sign and decimals', async () => {
    const ed = await renderEditor({ presets: [{ name: 'London', latitude: 51.5, longitude: 9 }] }, 'presets');
    const lon = byLabel(ed, 'Longitude');
    await setText(ed, lon, '');
    await typeChars(ed, lon, '-0.1');
    expect(lon.value).toBe('-0.1');
    expect(ed._config.presets[0].longitude).toBe(-0.1);
  });
});

describe('number fields (_valueChangedNumber)', () => {
  const keys = [
    'frame_delay', 'restart_delay', 'transition_time', 'wildfire_min_acres',
    'wildfire_radius_km', 'alerts_radius_km', 'lightning_max_age_minutes',
  ];

  it('text that is not a number keeps the saved value instead of saving NaN', async () => {
    for (const key of keys) {
      for (const text of ['-', 'abc', '1,5', '12abc']) {
        const ed = await renderEditor({ [key]: 7 });
        const sent = record(ed);
        ed._valueChangedNumber({ target: { configValue: key, value: text } });
        expect(sent.some(hasNull), `${key} '${text}'`).toBe(false);
        expect(ed._config[key], `${key} '${text}'`).toBe(7);
      }
    }
  });

  it('keeps the decimal point when the last decimal digit is deleted', async () => {
    const ed = await renderEditor({ show_alerts: true, alerts_radius_km: 12.5 }, 'overlays');
    const radius = byConfig(ed, 'alerts_radius_km');
    await setText(ed, radius, '12.');
    expect(radius.value).toBe('12.');
    await typeChars(ed, radius, '6');
    expect(ed._config.alerts_radius_km).toBe(12.6);
  });

  it('clearing a field whose value is 0 removes the key', async () => {
    const ed = await renderEditor({ transition_time: 0 });
    const tt = byConfig(ed, 'transition_time');
    expect(String(tt.value)).toBe('0');
    await setText(ed, tt, '');
    expect(ed._config).not.toHaveProperty('transition_time');
  });
});

describe('person marker: "Use entity picture" switch', () => {
  const states = {
    'person.me': { entity_id: 'person.me', state: 'home', attributes: { entity_picture: '/api/image/x', latitude: 1, longitude: 2 } },
  };

  it('turning it off for a person with a photo shows the icon picker', async () => {
    const ed = await renderEditor({ markers: [{ entity: 'person.me', icon: 'entity_picture' }] }, 'markers', states);
    const sw = [...ed.shadowRoot.querySelectorAll('ha-switch')].find((s: any) => s.markerIndex === 0 && s.markerField === undefined) as any;
    expect(sw.checked).toBe(true);
    sw.checked = false;
    sw.dispatchEvent(new Event('change'));
    await ed.updateComplete;
    expect(ed._config.markers[0].icon).toBe('mdi:account');
    expect(ed.shadowRoot.querySelector('ha-icon-picker')).not.toBeNull();
  });
});
