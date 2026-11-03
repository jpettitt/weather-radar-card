// The editor's "Smooth Radar Edges" switch (#326): shown only for DWD; on
// writes dwd_interpolation: bilinear, off leaves the key out of the YAML.
// Renders the real editor element.

import { describe, it, expect } from 'vitest';
import '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function renderEditor(config: Record<string, unknown>): Promise<any> {
  (window as any).loadCardHelpers = async () => ({});
  const ed = document.createElement('weather-radar-card-editor') as any;
  ed.hass = { states: {}, config: { components: [] }, language: 'en' };
  ed.setConfig({ type: 'custom:weather-radar-card', ...config });
  document.body.appendChild(ed);
  // setConfig's loadCardHelpers() resolves on the next tick; render after it.
  await new Promise((r) => setTimeout(r, 0));
  ed.requestUpdate();
  await ed.updateComplete;
  return ed;
}

function smoothSwitch(ed: any): any {
  const label = [...ed.shadowRoot.querySelectorAll('label')]
    .find((l: Element) => l.querySelector('span')?.textContent?.trim() === 'Smooth Radar Edges');
  return label?.querySelector('ha-switch');
}

// Flip the switch the way a user does and return the config the editor fires.
function flip(ed: any, checked: boolean): Record<string, unknown> {
  const fired: Record<string, unknown>[] = [];
  ed.addEventListener('config-changed', (e: CustomEvent) => fired.push(e.detail.config));
  const sw = smoothSwitch(ed);
  sw.checked = checked;
  sw.dispatchEvent(new Event('change'));
  expect(fired).toHaveLength(1);
  return fired[0];
}

describe('Smooth Radar Edges switch', () => {
  it('is shown for DWD only', async () => {
    expect(smoothSwitch(await renderEditor({ data_source: 'DWD' }))).toBeTruthy();
    expect(smoothSwitch(await renderEditor({ data_source: 'NOAA' }))).toBeUndefined();
    expect(smoothSwitch(await renderEditor({}))).toBeUndefined();
  });

  it('reflects the config', async () => {
    expect(smoothSwitch(await renderEditor({ data_source: 'DWD' })).checked).toBe(false);
    expect(smoothSwitch(await renderEditor({ data_source: 'DWD', dwd_interpolation: 'bilinear' })).checked).toBe(true);
  });

  // Compared with the editor's own config, which setConfig fills with defaults.
  it('writes dwd_interpolation: bilinear when switched on', async () => {
    const ed = await renderEditor({ data_source: 'DWD' });
    const before = { ...ed._config };
    expect(flip(ed, true)).toEqual({ ...before, dwd_interpolation: 'bilinear' });
  });

  it('removes the key when switched off', async () => {
    const ed = await renderEditor({ data_source: 'DWD', dwd_interpolation: 'bilinear' });
    const { dwd_interpolation, ...rest } = ed._config;
    expect(dwd_interpolation).toBe('bilinear');
    expect(flip(ed, false)).toEqual(rest);
  });
});
