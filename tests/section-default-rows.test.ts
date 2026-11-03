// HA merges the card's getGridOptions() (rows: 7) under the config's
// grid_options and fixes a sections cell for any numeric rows. A card that
// was never resized has no grid_options, yet its cell is fixed, so height
// and square_map must not apply there.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import { isSectionHeightPinned, resolveCardLayout } from '../src/card-layout';
import type { WeatherRadarCardConfig } from '../src/types';
import { cardHass, mountCard } from './helpers/mount-card';
import '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

const cfg = (over: Record<string, unknown> = {}): WeatherRadarCardConfig =>
  ({ type: 'custom:weather-radar-card', ...over } as WeatherRadarCardConfig);

afterEach(() => { document.body.innerHTML = ''; });

describe('isSectionHeightPinned in a grid layout', () => {
  it('pins a card with no rows in its config, as HA does', () => {
    expect(isSectionHeightPinned(cfg(), 'grid')).toBe(true);
    expect(isSectionHeightPinned(cfg({ grid_options: { columns: 6 } }), 'grid')).toBe(true);
    expect(isSectionHeightPinned(cfg({ grid_options: { rows: 5 } }), 'grid')).toBe(true);
  });

  it('frees a card whose rows are auto, also in legacy layout_options', () => {
    expect(isSectionHeightPinned(cfg({ grid_options: { rows: 'auto' } }), 'grid')).toBe(false);
    expect(isSectionHeightPinned(cfg({ layout_options: { grid_rows: 'auto' } }), 'grid')).toBe(false);
  });

  it('keeps the config-only rule outside a grid', () => {
    for (const layout of [undefined, 'panel', 'masonry']) {
      expect(isSectionHeightPinned(cfg(), layout)).toBe(false);
      expect(isSectionHeightPinned(cfg({ grid_options: { rows: 5 } }), layout)).toBe(true);
    }
  });

  it('square_map gives way to the default fixed cell', () => {
    expect(resolveCardLayout(cfg({ square_map: true }), 'grid')).toEqual({ mode: 'flex', minHeight: null });
    expect(resolveCardLayout(cfg({ square_map: true }))).toEqual({ mode: 'aspect', minHeight: null });
  });
});

describe('the card in a sections cell it was never resized in', () => {
  it('does not apply its configured height', async () => {
    const el = await mountCard({ height: '600px' }, cardHass());
    const haCard = el.shadowRoot.querySelector('ha-card') as HTMLElement;
    expect(haCard.getAttribute('style')).toContain('min-height:600px');
    el.layout = 'grid';   // what hui-card sets in a sections view
    await el.updateComplete;
    expect(haCard.getAttribute('style') ?? '').not.toContain('min-height');
  });
});

describe('the editor for a card in a grid section', () => {
  async function renderEditorIn(sectionConfig: object | undefined): Promise<ShadowRoot> {
    (window as any).loadCardHelpers = async () => ({});
    const host: any = document.createElement('hui-card-element-editor');
    host.sectionConfig = sectionConfig;
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    const ed = document.createElement('weather-radar-card-editor') as any;
    ed.hass = { states: {}, config: { components: [] }, language: 'en' };
    ed.setConfig({ type: 'custom:weather-radar-card' });
    root.appendChild(ed);
    await new Promise((r) => setTimeout(r, 0));
    ed.requestUpdate();
    await ed.updateComplete;
    return ed.shadowRoot as ShadowRoot;
  }
  const squareMap = (r: ShadowRoot): any =>
    [...r.querySelectorAll('ha-switch')].find((s: any) => s.configValue === 'square_map');
  const height = (r: ShadowRoot): any =>
    [...r.querySelectorAll('ha-input')].find((i: any) => i.configValue === 'height');

  it('disables height and square_map like the card ignores them', async () => {
    const r = await renderEditorIn({ type: 'grid' });
    expect(squareMap(r).disabled).toBe(true);
    expect(height(r).disabled).toBe(true);
  });

  it('leaves them on outside a section', async () => {
    const r = await renderEditorIn(undefined);
    expect(squareMap(r).disabled).toBe(false);
    expect(height(r).disabled).toBe(false);
  });
});
