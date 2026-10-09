// InciWeb links come from checking the fire's page itself: InciWeb's RSS
// lists only 50 incidents, and InciWeb answers any slug with a 200 page, so
// only an incident page's "Date of Origin" shows the page is real.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control {
    constructor(_opts?: unknown) { void _opts; }
  }
  return { Layer, TileLayer, Control, default: { Layer, TileLayer, Control } };
});

import {
  inciwebCandidates, findInciwebPage, knownInciwebPage, _resetInciwebForTests,
} from '../src/inciweb';
import { WildfireLayer } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const INCIDENT = '<html><title>Waowf Little Giant Fire Information | InciWeb</title><dt>Date of Origin</dt></html>';
const NOT_AN_INCIDENT = '<html><title>Waowf Little Giant Information | InciWeb</title></html>';

describe('inciwebCandidates', () => {
  it('tries the jurisdictional unit, then the protecting unit, each bare and with -fire', () => {
    expect(inciwebCandidates(['WARLP', 'WANCP'], ['Border 2', undefined])).toEqual([
      'warlp-border-2', 'warlp-border-2-fire', 'wancp-border-2', 'wancp-border-2-fire',
    ]);
  });

  it("tries the complex's name after the fire's, and skips a missing unit", () => {
    expect(inciwebCandidates([undefined, 'ORPRD'], ['Crosswhite', 'ROWE CREEK COMPLEX'])).toEqual([
      'orprd-crosswhite', 'orprd-crosswhite-fire', 'orprd-rowe-creek-complex', 'orprd-rowe-creek-complex-fire',
    ]);
  });

  it('lists each slug once when both units are the same', () => {
    expect(inciwebCandidates(['WAOWF', 'WAOWF'], ['Little Giant'])).toEqual(['waowf-little-giant', 'waowf-little-giant-fire']);
  });

  it('has nothing to try without a unit or a name', () => {
    expect(inciwebCandidates([undefined, ''], ['Little Giant'])).toEqual([]);
    expect(inciwebCandidates(['WAOWF'], [undefined, '***'])).toEqual([]);
  });
});

describe('findInciwebPage', () => {
  const realFetch = global.fetch;
  let pages: Record<string, string | Error>;
  let fetched: string[];

  beforeEach(() => {
    _resetInciwebForTests();
    fetched = [];
    pages = {};
    global.fetch = vi.fn(async (url: string) => {
      fetched.push(String(url));
      const page = pages[String(url).split('/').pop()!] ?? NOT_AN_INCIDENT;
      if (page instanceof Error) throw page;
      return new Response(page, { status: 200 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('takes the first candidate that is an incident page, not a page InciWeb made up', async () => {
    pages['waowf-little-giant-fire'] = INCIDENT;
    pages['wancp-little-giant'] = INCIDENT;
    const candidates = ['waowf-little-giant', 'waowf-little-giant-fire', 'wancp-little-giant'];
    expect(await findInciwebPage(candidates)).toBe('waowf-little-giant-fire');
    expect(fetched[0]).toBe('https://inciweb.wildfire.gov/incident-information/waowf-little-giant');
  });

  it('looks each fire up once per page load, and says what it found', async () => {
    pages['waowf-little-giant-fire'] = INCIDENT;
    const candidates = ['waowf-little-giant', 'waowf-little-giant-fire'];
    expect(knownInciwebPage(candidates)).toBeNull();
    await findInciwebPage(candidates);
    await findInciwebPage(candidates);
    expect(fetched).toHaveLength(2);
    expect(knownInciwebPage(candidates)).toBe('waowf-little-giant-fire');
  });

  it('remembers that a fire has no page', async () => {
    expect(await findInciwebPage(['mnsuf-thumb', 'mnsuf-thumb-fire'])).toBeNull();
    await findInciwebPage(['mnsuf-thumb', 'mnsuf-thumb-fire']);
    expect(fetched).toHaveLength(2);
  });

  it('tries again next time after a network error that left the answer open', async () => {
    pages['mnsuf-thumb'] = new TypeError('Failed to fetch');
    await expect(findInciwebPage(['mnsuf-thumb', 'mnsuf-thumb-fire'])).rejects.toThrow();
    delete pages['mnsuf-thumb'];
    expect(await findInciwebPage(['mnsuf-thumb', 'mnsuf-thumb-fire'])).toBeNull();
    expect(fetched).toHaveLength(4);
  });

  it('trusts a page it found even if another candidate failed', async () => {
    pages['waowf-little-giant'] = INCIDENT;
    pages['waowf-little-giant-fire'] = new TypeError('Failed to fetch');
    expect(await findInciwebPage(['waowf-little-giant', 'waowf-little-giant-fire'])).toBe('waowf-little-giant');
  });

  it('fetches nothing for a fire with no candidates', async () => {
    expect(await findInciwebPage([])).toBeNull();
    expect(fetched).toEqual([]);
  });

  describe('in the popup', () => {
    function bind(props: any): { content: () => string; open: () => Promise<void>; update: ReturnType<typeof vi.fn>; setOpen: (o: boolean) => void } {
      const layer = Object.create(WildfireLayer.prototype) as any;
      layer._map = { getSize: () => ({ x: 600, y: 400 }) };
      let content: () => string = () => '';
      let onOpen: () => void = () => {};
      let isOpen = true;
      const update = vi.fn();
      layer._bindPopup({
        bindPopup: (fn: () => string) => { content = fn; },
        on: (_ev: string, fn: () => void) => { onOpen = fn; },
        isPopupOpen: () => isOpen,
        getPopup: () => ({ update }),
      }, props);
      return {
        content: () => content(),
        open: async () => { onOpen(); await new Promise((r) => setTimeout(r, 0)); },
        update,
        setOpen: (o) => { isOpen = o; },
      };
    }
    const littleGiant = { poly_IncidentName: 'Little Giant', attr_POOJurisdictionalUnit: 'WAOWF', attr_POOProtectingUnit: 'WAOWF' };

    it('opens without the link and redraws with it once the page is confirmed', async () => {
      pages['waowf-little-giant-fire'] = INCIDENT;
      const popup = bind(littleGiant);
      expect(popup.content()).not.toContain('inciweb.wildfire.gov');
      await popup.open();
      expect(popup.update).toHaveBeenCalledOnce();
      expect(popup.content()).toContain('incident-information/waowf-little-giant-fire');
    });

    it("doesn't redraw a popup closed before the answer came", async () => {
      pages['waowf-little-giant-fire'] = INCIDENT;
      const popup = bind(littleGiant);
      popup.setOpen(false);
      await popup.open();
      expect(popup.update).not.toHaveBeenCalled();
    });

    it("doesn't redraw when the fire has no page", async () => {
      const popup = bind(littleGiant);
      await popup.open();
      expect(popup.update).not.toHaveBeenCalled();
      expect(popup.content()).not.toContain('inciweb.wildfire.gov');
    });
  });
});
