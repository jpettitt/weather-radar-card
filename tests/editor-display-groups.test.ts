// The editor's Display section: toggles in headed groups, each switch once,
// and Static map under Interaction. Renders the real editor element.

import { describe, it, expect, beforeAll } from 'vitest';
import '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function renderEditor(config: Record<string, unknown>): Promise<ShadowRoot> {
  (window as any).loadCardHelpers = async () => ({});
  const ed = document.createElement('weather-radar-card-editor') as any;
  ed.hass = { states: {}, config: { components: [] }, language: 'en' };
  ed.setConfig({ type: 'custom:weather-radar-card', ...config });
  document.body.appendChild(ed);
  // setConfig's loadCardHelpers() resolves on the next tick; render after it.
  await new Promise((r) => setTimeout(r, 0));
  ed.requestUpdate();
  await ed.updateComplete;
  return ed.shadowRoot as ShadowRoot;
}

// Each group: its heading, then the switches in its grid.
function groups(root: ShadowRoot): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const heading of root.querySelectorAll('.toggle-group-label')) {
    const grid = heading.nextElementSibling;
    const switches = grid?.classList.contains('toggle-grid')
      ? [...grid.querySelectorAll('ha-switch')]
      : [grid?.querySelector('ha-switch')].filter(Boolean);
    out[heading.textContent!.trim()] = switches.map((s: any) => s.configValue);
  }
  return out;
}

describe('editor Display groups', () => {
  let root: ShadowRoot;

  beforeAll(async () => {
    root = await renderEditor({ past_minutes: 60 });
  });

  it('groups the toggles under headings', () => {
    expect(groups(root)).toEqual({
      'Map buttons': ['show_zoom', 'show_playback', 'show_recenter', 'show_layer_toggles'],
      'On the map': ['show_scale', 'show_range', 'cluster_markers', 'show_snow'],
      'Around the map': ['show_color_bar', 'show_progress_bar', 'show_loading_spinner', 'square_map'],
      'Off-screen': ['preload_while_hidden'],
    });
  });

  it('labels the switches without "Show"', () => {
    const labels = [...root.querySelectorAll('.toggle-grid label span')].map((s) => s.textContent!.trim());
    expect(labels).toContain('Zoom');
    expect(labels).toContain('Colour Bar');
    expect(labels.some((l) => l.startsWith('Show '))).toBe(false);
  });

  it('puts Static map under Interaction, once', () => {
    const switches = [...root.querySelectorAll('ha-switch')].filter((s: any) => s.configValue === 'static_map');
    expect(switches).toHaveLength(1);
    const header = [...root.querySelectorAll('h3.section-header')]
      .filter((h) => h.compareDocumentPosition(switches[0]) & Node.DOCUMENT_POSITION_FOLLOWING)
      .pop();
    expect(header?.textContent?.trim()).toBe('Interaction');
  });
});
