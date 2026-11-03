// The edit dialog's preview writes its map view into the open editor over
// window events that name no card. With two radar cards in the dialog (a
// stack), a pan of one was written into the other's editor, so the card
// turns that off when it is not the dialog's only radar card
// (pre-4.0 review, 2026-10-26).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import '../src/editor';
import { mountCard, cardHass, tick } from './helpers/mount-card';

/* eslint-disable @typescript-eslint/no-explicit-any */

async function dialogWithEditor(): Promise<{ dialog: HTMLElement; changes: any[] }> {
  (window as any).loadCardHelpers = async () => ({});
  const dialog = document.createElement('hui-dialog-edit-card');
  document.body.append(dialog);
  const ed: any = document.createElement('weather-radar-card-editor');
  ed.hass = cardHass({ config: { latitude: 40, longitude: -100, unit_system: { length: 'km' }, time_zone: 'UTC', components: [] } });
  ed.setConfig({ type: 'custom:weather-radar-card', center_latitude: 40, center_longitude: -100, zoom_level: 7 });
  const changes: any[] = [];
  ed.addEventListener('config-changed', (e: any) => changes.push(e.detail.config));
  dialog.append(ed);
  await tick();
  return { dialog, changes };
}

async function previewCard(dialog: HTMLElement, lat: number, lon: number): Promise<any> {
  const el = await mountCard({ center_latitude: lat, center_longitude: lon, zoom_level: 7 }, cardHass(), dialog);
  el.editMode = true;
  await el.updateComplete;
  return el;
}

function pan(card: any): void {
  card._map.getContainer().dispatchEvent(new Event('pointerdown', { bubbles: true }));
  card._map.panBy([5, 5], { animate: false });
}

describe('map-to-editor updates in the edit dialog', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); });
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('a stack of two radar cards: panning one writes nothing into the editor', async () => {
    const { dialog, changes } = await dialogWithEditor();
    await previewCard(dialog, 40, -100);
    const b = await previewCard(dialog, 51, 0);
    pan(b);
    expect(changes).toEqual([]);
  });

  it('the only radar card in the dialog still writes its view into the editor', async () => {
    const { dialog, changes } = await dialogWithEditor();
    const a = await previewCard(dialog, 40, -100);
    pan(a);
    expect(changes.length).toBeGreaterThan(0);
    expect(changes[changes.length - 1].center_latitude).toBeCloseTo(40, 0);
  });
});
