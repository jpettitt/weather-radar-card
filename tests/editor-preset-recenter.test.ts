// In the edit preview, a hand pan writes the view into the preset open in
// the editor. Re-centre there returns to the open preset instead of
// rotating, so a pan never lands at another stop.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import { cardHass, mountCard } from './helpers/mount-card';
import { setEditorPresetFocus, PRESET_MAP_EVENT } from '../src/view-presets';

/* eslint-disable @typescript-eslint/no-explicit-any */

const presets = [
  { name: 'A', latitude: 34, longitude: -118, zoom: 8 },
  { name: 'B', latitude: 47, longitude: -122, zoom: 8 },
];

afterEach(() => { document.body.innerHTML = ''; setEditorPresetFocus(null); });

async function previewWithPresetOpen(): Promise<{ el: any; pushed: any[]; stop: () => void }> {
  const dialog = document.createElement('hui-dialog-edit-card');
  document.body.append(dialog);
  setEditorPresetFocus(0);
  const el = await mountCard({ show_recenter: true, center_latitude: 40, center_longitude: -100, presets },
    cardHass(), dialog);
  const pushed: any[] = [];
  const onMove = (e: Event): void => { pushed.push((e as CustomEvent).detail); };
  window.addEventListener(PRESET_MAP_EVENT, onMove);
  return { el, pushed, stop: () => window.removeEventListener(PRESET_MAP_EVENT, onMove) };
}

const handPan = (el: any): void => {
  el._map.getContainer().dispatchEvent(new Event('pointerdown', { bubbles: true }));
  el._map.panBy([5, 5], { animate: false });
};

describe('re-centre in the preview with a preset open', () => {
  it('re-centre returns to the open preset, and a pan there writes into it', async () => {
    const { el, pushed, stop } = await previewWithPresetOpen();
    expect(el._map.getCenter().lat).toBeCloseTo(34, 1);
    el._onRecenter();
    expect(el._map.getCenter().lat).toBeCloseTo(34, 1);
    el._map.setView([40, -100], 6, { animate: false });
    el._onRecenter();
    expect(el._map.getCenter().lat).toBeCloseTo(34, 1);
    handPan(el);
    stop();
    expect(pushed.length).toBe(1);
    expect(pushed[0].index).toBe(0);
  });

  it('a pan on the open preset still writes into it', async () => {
    const { el, pushed, stop } = await previewWithPresetOpen();
    handPan(el);
    stop();
    expect(pushed.length).toBe(1);
    expect(pushed[0].index).toBe(0);
    expect(pushed[0].latitude).toBeCloseTo(34, 0);
  });
});
