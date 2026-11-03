// viewer_layer_control needs an _layer_state_id for its dashboard. HA saves
// config-changed only from the editor element, so the editor mints the id:
// the card's own mint reached no listener and the setting never turned on
// (pre-4.0 review, 2026-10-26).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/editor';
import '../src/weather-radar-card';
import { _resetLiveCardsForTests } from '../src/viewer-state';

/* eslint-disable @typescript-eslint/no-explicit-any */

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// The editor with a listener in place before setConfig, so the open-time mint is seen.
async function openEditor(config: Record<string, unknown>): Promise<{ ed: any; sent: any[] }> {
  (window as any).loadCardHelpers = async () => ({});
  const ed = document.createElement('weather-radar-card-editor') as any;
  const sent: any[] = [];
  ed.addEventListener('config-changed', (e: any) => sent.push(e.detail.config));
  ed.hass = { states: {}, config: { components: [] }, language: 'en' };
  ed.setConfig({ type: 'custom:weather-radar-card', ...config });
  document.body.appendChild(ed);
  await tick();
  await ed.updateComplete;
  return { ed, sent };
}

const layerSwitch = (ed: any): any =>
  [...ed.shadowRoot.querySelectorAll('ha-switch')].find((s: any) => s.configValue === 'viewer_layer_control');

describe('editor mints _layer_state_id', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/lovelace/weather'); _resetLiveCardsForTests(); });
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('turning viewer_layer_control on saves an id for this dashboard', async () => {
    const { ed, sent } = await openEditor({});
    expect(sent).toEqual([]);   // nothing to do while it is off
    const sw = layerSwitch(ed);
    sw.checked = true;
    sw.dispatchEvent(new Event('change'));
    const last = sent[sent.length - 1];
    expect(last.viewer_layer_control).toBe(true);
    expect(last._layer_state_id.dash).toBe('/lovelace/weather');
    expect(last._layer_state_id.nonce).toMatch(/^[a-z0-9]+$/);
  });

  it('turning it off and on again keeps a valid id', async () => {
    const id = { dash: '/lovelace/weather', nonce: 'keep001' };
    const { ed, sent } = await openEditor({ viewer_layer_control: true, _layer_state_id: id });
    const sw = layerSwitch(ed);
    sw.checked = false; sw.dispatchEvent(new Event('change'));
    sw.checked = true; sw.dispatchEvent(new Event('change'));
    expect(sent[sent.length - 1]._layer_state_id).toEqual(id);
  });

  it('opening a card that has the setting on but no id adds one', async () => {
    const { sent } = await openEditor({ viewer_layer_control: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]._layer_state_id.dash).toBe('/lovelace/weather');
  });

  it('opening a card whose id belongs to another dashboard replaces it', async () => {
    const { sent } = await openEditor({ viewer_layer_control: true, _layer_state_id: { dash: '/old/0', nonce: 'old0001' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]._layer_state_id.dash).toBe('/lovelace/weather');
    expect(sent[0]._layer_state_id.nonce).not.toBe('old0001');
  });

  it('opening a card with a valid id sends nothing (the dialog stays unchanged)', async () => {
    const { sent } = await openEditor({ viewer_layer_control: true, _layer_state_id: { dash: '/lovelace/weather', nonce: 'ok00001' } });
    expect(sent).toEqual([]);
  });

  it('the card no longer sends config-changed itself; it waits for the editor id', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    const card: any = document.createElement('weather-radar-card');
    const fromCard: any[] = [];
    card.addEventListener('config-changed', (e: any) => fromCard.push(e.detail.config));
    card.setConfig({ type: 'custom:weather-radar-card', viewer_layer_control: true });
    card.hass = { states: {}, config: { latitude: 0, longitude: 0, unit_system: { length: 'km' }, time_zone: 'UTC' }, themes: { darkMode: false }, language: 'en', locale: { language: 'en' }, user: { id: 'u' }, callWS: async () => ({}) };
    document.body.appendChild(card);
    await card.updateComplete; await tick();
    expect(fromCard).toEqual([]);
    expect(card._viewerState?.isActive ?? false).toBe(false);
  });
});

// In YAML mode HA keeps the editor off the page and still calls setConfig on
// each edit, but drops the editor's config-changed (testbed, 2026-10-27).
describe('viewer_layer_control added in the YAML editor', () => {
  beforeEach(() => { window.history.replaceState({}, '', '/lovelace/weather'); _resetLiveCardsForTests(); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('a later setConfig that turns it on mints an id', async () => {
    const { ed, sent } = await openEditor({});
    ed.setConfig({ type: 'custom:weather-radar-card', viewer_layer_control: true });
    await tick();
    expect(sent).toHaveLength(1);
    expect(sent[0]._layer_state_id.dash).toBe('/lovelace/weather');
  });

  it('an id minted off the page is sent again when the editor comes back', async () => {
    const { ed, sent } = await openEditor({});
    ed.remove();   // HA switches to YAML mode
    ed.setConfig({ type: 'custom:weather-radar-card', viewer_layer_control: true });
    await tick();
    expect(sent).toHaveLength(1);   // HA drops this one
    document.body.appendChild(ed);   // back to the visual editor
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]._layer_state_id).toEqual(sent[0]._layer_state_id);
  });

  it('one mint per change, not one per setConfig', async () => {
    const { ed, sent } = await openEditor({});
    ed.setConfig({ type: 'custom:weather-radar-card', viewer_layer_control: true });
    ed.setConfig({ type: 'custom:weather-radar-card', viewer_layer_control: true });
    await tick();
    expect(sent).toHaveLength(1);
  });
});
