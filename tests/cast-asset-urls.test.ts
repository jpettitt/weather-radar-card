// On Cast the page is cast.home-assistant.io, not the HA instance, so the
// card's own files (toolbar icons, colour bar) must load from the instance.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mountCard, cardHass } from './helpers/mount-card';
import { cardAssetUrl } from '../src/vector-basemap';

/* eslint-disable @typescript-eslint/no-explicit-any */

const HA = 'http://ha.local:8123';
const BASE = `${HA}/local/community/weather-radar-card/`;

describe('card files on Cast', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('cardAssetUrl uses the instance origin, and the page origin without one', () => {
    expect(cardAssetUrl({ auth: { data: { hassUrl: `${HA}/` } } } as any, 'play.png')).toBe(`${BASE}play.png`);
    expect(cardAssetUrl(undefined, 'play.png')).toBe(`${location.origin}/local/community/weather-radar-card/play.png`);
  });

  it('loads the colour bar and the toolbar icons from the HA instance', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const el = await mountCard(
      { show_playback: true, show_recenter: true, show_color_bar: true },
      cardHass({ auth: { data: { hassUrl: HA } } }),
    );
    const srcs = [...el.shadowRoot.querySelectorAll('img')].map((i: HTMLImageElement) => i.getAttribute('src') ?? '');
    const ours = srcs.filter((s) => s.includes('/local/community/weather-radar-card/'));
    expect(ours.some((s) => s.includes('radar-colour-bar'))).toBe(true);
    expect(ours.some((s) => s.endsWith('play.png') || s.endsWith('pause.png'))).toBe(true);
    for (const s of ours) expect(s.startsWith(BASE)).toBe(true);
  });
});
