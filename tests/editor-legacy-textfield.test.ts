// Before HA 2026.4 the editor's text fields use ha-textfield: ha-input does
// not exist there, and an unknown tag renders as nothing. Both tags must get
// the same fields, and typing in either must save the same config.

import { describe, it, expect } from 'vitest';
import '../src/editor';
import { haAtLeast } from '../src/ha-version';

/* eslint-disable @typescript-eslint/no-explicit-any */

const NEW = '2026.4.0';
const OLD = '2025.3.4';

async function renderEditor(version: string | undefined, config: Record<string, unknown>, view = 'main'): Promise<any> {
  (window as any).loadCardHelpers = async () => ({});
  const ed = document.createElement('weather-radar-card-editor') as any;
  ed.hass = { states: {}, config: { components: ['blitzortung'], version }, language: 'en' };
  ed.setConfig({ type: 'custom:weather-radar-card', ...config });
  document.body.appendChild(ed);
  await new Promise((r) => setTimeout(r, 0));
  ed._view = view;
  if (view === 'presets') ed._presetOpen = 0;
  ed.requestUpdate();
  await ed.updateComplete;
  return ed;
}

const fields = (ed: any, tag: string): any[] => [...ed.shadowRoot.querySelectorAll(tag)];

// What the user sees and what the change handlers read, per field.
const describeField = (el: any, hintAttr: string) => ({
  label: el.getAttribute('label'),
  hint: el.getAttribute(hintAttr),
  type: el.getAttribute('type'),
  cls: el.getAttribute('class'),
  value: el.value,
  disabled: el.disabled,
  configValue: el.configValue,
  markerIndex: el.markerIndex,
  markerField: el.markerField,
});

const CASES: [string, Record<string, unknown>][] = [
  ['main', { map_style: 'Custom', carto_api_key: 'k', center_latitude: 37.5, frame_delay: 400, height: '300px' }],
  ['main', { height: '300px' }],
  ['overlays', { show_wildfires: true, show_alerts: true, show_lightning: true, alerts_radius_km: 50 }],
  ['presets', { presets: [{ name: 'Bay', latitude: 37.7, longitude: -122.4 }] }],
  ['markers', { markers: [{ latitude: 51.5, longitude: 9 }, { entity: 'person.a', icon: 'entity_picture' }] }],
];

describe('haAtLeast', () => {
  it.each([
    ['2025.3.4', false], ['2026.3.9', false], ['2026.4.0', true], ['2026.4.0b1', true],
    ['2026.5.0.dev20260401', true], ['2026.10.0', true], ['2027.1.0', true],
    [undefined, true], ['', true], ['dev', true],
  ])('%s', (version, expected) => {
    expect(haAtLeast({ config: { version } } as any, 2026, 4)).toBe(expected);
  });
});

describe('editor text fields by HA version', () => {
  it.each(CASES)('%s view: ha-textfield on 2025.3 matches ha-input on 2026.4', async (view, config) => {
    const edNew = await renderEditor(NEW, config, view);
    const edOld = await renderEditor(OLD, config, view);
    const newer = fields(edNew, 'ha-input');
    expect(newer.length).toBeGreaterThan(0);
    expect(fields(edNew, 'ha-textfield')).toHaveLength(0);
    expect(fields(edOld, 'ha-input')).toHaveLength(0);
    expect(fields(edOld, 'ha-textfield').map((el) => describeField(el, 'helper')))
      .toEqual(newer.map((el) => describeField(el, 'hint')));
  });

  it('an unknown core version gets ha-input', async () => {
    const ed = await renderEditor(undefined, {});
    expect(fields(ed, 'ha-input').length).toBeGreaterThan(0);
    expect(fields(ed, 'ha-textfield')).toHaveLength(0);
  });

  it('a field with a hint keeps it visible on ha-textfield', async () => {
    const ed = await renderEditor(OLD, {});
    const els = fields(ed, 'ha-textfield');
    for (const el of els) expect(el.helperPersistent, el.getAttribute('label')).toBe(el.hasAttribute('helper'));
    expect(els.some((el) => el.helperPersistent)).toBe(true);
  });

  it('typing in ha-textfield saves the same config as ha-input', async () => {
    const saved: Record<string, any> = {};
    for (const version of [NEW, OLD]) {
      const tag = version === NEW ? 'ha-input' : 'ha-textfield';
      const main = await renderEditor(version, {});
      const delay = fields(main, tag).find((el) => el.configValue === 'frame_delay');
      delay.value = '250';
      delay.dispatchEvent(new Event('input'));
      const markers = await renderEditor(version, { markers: [{ latitude: 1, longitude: 2 }] }, 'markers');
      const lat = fields(markers, tag).find((el) => el.markerField === 'latitude');
      lat.value = '-33.9';
      lat.dispatchEvent(new Event('input'));
      const presets = await renderEditor(version, { presets: [{ latitude: 1, longitude: 2 }] }, 'presets');
      const name = fields(presets, tag)[0];
      name.value = 'Cape Town';
      name.dispatchEvent(new Event('input'));
      saved[version] = { main: main._config, markers: markers._config, presets: presets._config };
    }
    expect(saved[OLD].main.frame_delay).toBe(250);
    expect(saved[OLD].markers.markers[0].latitude).toBe(-33.9);
    expect(saved[OLD].presets.presets[0].name).toBe('Cape Town');
    expect(saved[OLD]).toEqual(saved[NEW]);
  });
});
