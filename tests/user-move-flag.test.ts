// pointerdown marks a user move so tracking does not pull the map mid-gesture.
// Only a moveend cleared the mark, so a tap that moved nothing (a toolbar
// button, a static map) stopped tracking until the next pan.
import { describe, it, expect, vi, afterEach } from 'vitest';
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
import { cardHass, mountCard, tick, trackerState } from './helpers/mount-card';

/* eslint-disable @typescript-eslint/no-explicit-any */

const tracked = { markers: [{ entity: 'device_tracker.car', track: true }] };
const fire = (t: EventTarget, ...types: string[]): void => {
  for (const type of types) t.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
};

afterEach(() => { document.body.innerHTML = ''; });

describe('user-move flag after a gesture', () => {
  it('a play-button tap does not stop tracking', async () => {
    const hass = cardHass({ states: trackerState(40, -100) });
    const el = await mountCard({ show_playback: true, ...tracked }, hass);
    const play = [...el.shadowRoot.querySelectorAll('a')].find((a: any) => a.title === 'Play / Pause');
    expect(play).toBeTruthy();
    fire(play, 'pointerdown', 'pointerup', 'click');
    await tick(600);
    el.hass = { ...hass, states: trackerState(42, -95) };
    await el.updateComplete;
    expect(el._map.getCenter().lat).toBeCloseTo(42, 2);
  });

  it('a tap on a static map does not stop tracking', async () => {
    const hass = cardHass({ states: trackerState(40, -100) });
    const el = await mountCard({ static_map: true, ...tracked }, hass);
    fire(el._map.getContainer(), 'pointerdown', 'pointerup', 'click');
    await tick(600);
    el.hass = { ...hass, states: trackerState(45, -90) };
    await el.updateComplete;
    expect(el._map.getCenter().lat).toBeCloseTo(45, 2);
  });

  it('a tracker update skipped just after a tap is applied when the tap is over', async () => {
    const hass = cardHass({ states: trackerState(40, -100) });
    const el = await mountCard(tracked, hass);
    fire(el._map.getContainer(), 'pointerdown', 'pointerup');
    el.hass = { ...hass, states: trackerState(43, -97) };
    await el.updateComplete;
    expect(el._map.getCenter().lat).toBeCloseTo(40, 2);
    await tick(600);
    expect(el._map.getCenter().lat).toBeCloseTo(43, 2);
  });

  it('tracking still waits for the end of a drag that outlasts the pointer', async () => {
    const hass = cardHass({ states: trackerState(40, -100) });
    const el = await mountCard(tracked, hass);
    const map = el._map;
    fire(map.getContainer(), 'pointerdown');
    map.fire('movestart');
    fire(map.getContainer(), 'pointerup');
    await tick(600);
    el.hass = { ...hass, states: trackerState(44, -92) };
    await el.updateComplete;
    expect(map.getCenter().lat).toBeCloseTo(40, 2);
  });

  it('a click-driven zoom that starts after pointerup still reaches the editor', async () => {
    const el = await mountCard({ center_latitude: 40, center_longitude: -100, zoom_level: 7 }, cardHass());
    el.editMode = true;
    el._editorOpen = true;
    await el.updateComplete;
    const pushed: any[] = [];
    const onPush = (e: Event): void => { pushed.push((e as CustomEvent).detail); };
    window.addEventListener('weather-radar-center-update', onPush);
    fire(el._map.getContainer(), 'pointerdown', 'pointerup');
    await tick(50);   // an animated zoom starts a frame or more after the click
    el._map.setZoom(8, { animate: false });
    window.removeEventListener('weather-radar-center-update', onPush);
    expect(pushed.at(-1)?.zoom_level).toBe(8);
  });
});
