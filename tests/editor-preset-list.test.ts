// The editor's Presets page: one preset open at a time, the open one sent
// to the preview, map moves written back to it, reordering, and dropdowns
// that show their default. Renders the real editor element.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import '../src/editor';
import { editorPresetFocus, PRESET_MAP_EVENT } from '../src/view-presets';

/* eslint-disable @typescript-eslint/no-explicit-any */

const BAY = { name: 'Bay Area', latitude: 37.6, longitude: -122.2, zoom: 9 };
const VAN = { entity: 'device_tracker.van', zoom: 12 };

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
  // Lovelace answers config-changed with setConfig; do the same.
  ed.addEventListener('config-changed', (e: CustomEvent) => ed.setConfig(e.detail.config));
  return ed;
}

async function openPresets(ed: any): Promise<void> {
  ed._setView('presets');
  await ed.updateComplete;
}

const rows = (ed: any) => [...ed.shadowRoot.querySelectorAll('.preset-row')] as HTMLElement[];
const isOpen = (row: HTMLElement) => row.querySelector('ha-input') !== null;

describe('editor Presets page', () => {
  let ed: any;

  beforeEach(async () => {
    document.body.innerHTML = '';
    ed = await renderEditor({ presets: [BAY, VAN, { latitude: 40, longitude: -100 }] });
  });

  it('opens the first preset and folds the rest', async () => {
    await openPresets(ed);
    expect(rows(ed).map(isOpen)).toEqual([true, false, false]);
    expect(rows(ed)[2].querySelector('.preset-summary')!.textContent).toBe('40, -100');
  });

  it('opening another preset folds the open one; tapping the open one folds it', async () => {
    await openPresets(ed);
    rows(ed)[2].querySelector<HTMLButtonElement>('.preset-toggle')!.click();
    await ed.updateComplete;
    expect(rows(ed).map(isOpen)).toEqual([false, false, true]);
    rows(ed)[2].querySelector<HTMLButtonElement>('.preset-toggle')!.click();
    await ed.updateComplete;
    expect(rows(ed).map(isOpen)).toEqual([false, false, false]);
  });

  it('tells the preview which preset is open, and none once you leave the page', async () => {
    await openPresets(ed);
    expect(editorPresetFocus()).toBe(0);
    ed._presetOpen = 1;
    await ed.updateComplete;
    expect(editorPresetFocus()).toBe(1);
    ed._setView('main');
    await ed.updateComplete;
    expect(editorPresetFocus()).toBeNull();
  });

  it('a map move sets the open preset, or only the zoom of one following an entity', async () => {
    await openPresets(ed);
    window.dispatchEvent(new CustomEvent(PRESET_MAP_EVENT, { detail: { index: 0, latitude: 38, longitude: -121, zoom: 10 } }));
    expect(ed._config.presets[0]).toEqual({ ...BAY, latitude: 38, longitude: -121, zoom: 10 });
    ed._presetOpen = 1;
    await ed.updateComplete;
    window.dispatchEvent(new CustomEvent(PRESET_MAP_EVENT, { detail: { index: 1, latitude: 38, longitude: -121, zoom: 14 } }));
    expect(ed._config.presets[1]).toEqual({ ...VAN, zoom: 14 });
  });

  it('ignores a map move for a preset that is no longer open', async () => {
    await openPresets(ed);
    const before = ed._config;
    window.dispatchEvent(new CustomEvent(PRESET_MAP_EVENT, { detail: { index: 2, latitude: 1, longitude: 2, zoom: 5 } }));
    expect(ed._config).toBe(before);
  });

  it('reordering keeps the open preset open', async () => {
    await openPresets(ed);
    ed._movePreset(0, 3);
    await ed.updateComplete;
    expect(ed._config.presets.map((p: any) => p.name ?? p.entity ?? p.latitude)).toEqual(['device_tracker.van', 40, 'Bay Area']);
    expect(ed._presetOpen).toBe(2);
    expect(rows(ed).map(isOpen)).toEqual([false, false, true]);
  });

  it('arrow keys on the handle move a preset one place', async () => {
    await openPresets(ed);
    const handle = rows(ed)[1].querySelector<HTMLElement>('.drag-handle')!;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(ed._config.presets[0]).toEqual(VAN);
    rows(ed)[0].querySelector<HTMLElement>('.drag-handle')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(ed._config.presets[0]).toEqual(VAN);   // already first
  });

  it('removing the open preset closes it; removing an earlier one keeps it open', async () => {
    await openPresets(ed);
    ed._presetOpen = 2;
    ed._removePreset(0);
    expect(ed._presetOpen).toBe(1);
    ed._removePreset(1);
    expect(ed._presetOpen).toBeNull();
  });

  it('adding a preset opens it', async () => {
    await openPresets(ed);
    ed.shadowRoot.querySelector('.add-marker-btn').click();
    await ed.updateComplete;
    expect(ed._config.presets).toHaveLength(4);
    expect(rows(ed).map(isOpen)).toEqual([false, false, false, true]);
  });
});

describe('editor main page', () => {
  it('gives presets their own Preset Views section, above Markers and Overlays', async () => {
    document.body.innerHTML = '';
    const ed = await renderEditor({ presets: [BAY] });
    const headers = [...ed.shadowRoot.querySelectorAll('h3.section-header')].map((h: Element) => h.textContent!.trim());
    expect(headers.indexOf('Preset Views')).toBe(headers.indexOf('Markers and Overlays') - 1);
    const section = [...ed.shadowRoot.querySelectorAll('h3.section-header')].find((h: Element) => h.textContent!.trim() === 'Preset Views')!;
    const row = section.nextElementSibling as HTMLElement;
    expect(row.querySelector('.subpage-nav-label')!.textContent!.trim()).toBe('Presets');
    expect(row.nextElementSibling!.textContent!.trim()).toBe('Markers and Overlays');
  });
});

describe('dropdowns show their default', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it("the timeout and a preset's zoom, unset, select their default choice", async () => {
    const ed = await renderEditor({ presets: [{ latitude: 1, longitude: 2 }] });
    await openPresets(ed);
    const selectors = [...ed.shadowRoot.querySelectorAll('ha-selector')] as any[];
    const timeout = selectors.find((s) => s.configValue === 'preset_timeout');
    const zoom = selectors.find((s) => s.selector?.select && s.label === 'Zoom Level');
    expect(timeout.value).toBe('default');
    expect(timeout.selector.select.options.map((o: any) => o.value)).toContain('default');
    expect(zoom.value).toBe('default');
    expect(zoom.selector.select.options[0].value).toBe('default');
  });

  it("the card's zoom level, unset, selects Default", async () => {
    const ed = await renderEditor({});
    const zoom = [...ed.shadowRoot.querySelectorAll('ha-selector')].find((s: any) => s.configValue === 'zoom_level') as any;
    expect(zoom.value).toBe('default');
    expect(zoom.selector.select.options[0]).toEqual({ value: 'default', label: 'Default (7)' });
  });

  it('picking the default removes the key', async () => {
    const ed = await renderEditor({ zoom_level: 9 });
    const changed = vi.fn();
    ed.addEventListener('config-changed', changed);
    ed._handleSelectorNumberChanged({ target: { configValue: 'zoom_level' }, detail: { value: 'default' } });
    expect((changed.mock.calls.at(-1) as any[])[0].detail.config).not.toHaveProperty('zoom_level');
  });
});
