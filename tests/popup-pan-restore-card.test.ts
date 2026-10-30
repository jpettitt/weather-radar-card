// Closing a hazard popup puts back the view its autoPan moved. It must not
// undo a move made for another reason while the popup was open (a preset,
// a tracked marker, a drag).
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import * as L from 'leaflet';
import { cardHass, mountCard, tick } from './helpers/mount-card';

afterEach(() => { document.body.innerHTML = ''; });

async function openPopupOnCard(): Promise<{ map: L.Map; popup: L.Popup }> {
  const el = await mountCard({ center_latitude: 40, center_longitude: -100, zoom_level: 7 }, cardHass());
  const map = el._map as L.Map;
  const popup = L.popup({ autoPan: false }).setLatLng([40, -100]).setContent('alert');
  popup.openOn(map);
  return { map, popup };
}

describe('popup pan restore on the card', () => {
  it('keeps a programmatic move made while the popup was open', async () => {
    const { map } = await openPopupOnCard();
    map.setView([45, -90], 8, { animate: false });
    map.closePopup();
    await tick(10);
    expect(map.getCenter().lat).toBeCloseTo(45, 3);
    expect(map.getCenter().lng).toBeCloseTo(-90, 3);
  });

  it('still puts back the view the popup autoPan moved', async () => {
    const { map } = await openPopupOnCard();
    const panTo = vi.spyOn(map, 'panTo');
    map.fire('autopanstart').panBy([200, 0], { animate: false });   // what Popup._adjustPan does
    expect(map.getCenter().lng).not.toBeCloseTo(-100, 1);
    map.closePopup();
    await tick(10);
    expect(panTo).toHaveBeenCalledTimes(1);
    const back = panTo.mock.calls[0][0] as L.LatLng;
    expect(back.lat).toBeCloseTo(40, 3);
    expect(back.lng).toBeCloseTo(-100, 3);
  });
});
