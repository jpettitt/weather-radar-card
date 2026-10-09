// Tests for wildfire-layer.ts's buildPopupHtml — specifically the area
// unit conversion (acres -> hectares for metric users, issue follow-up
// to #239) and the discovery-date locale handling. Leaflet is mocked
// purely to satisfy the module's import graph; buildPopupHtml itself is
// a pure string builder that never touches L.* APIs.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control {
    constructor(_opts?: unknown) { void _opts; }
  }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return {
    Layer, TileLayer, Control, DomUtil, DomEvent,
    default: { Layer, TileLayer, Control, DomUtil, DomEvent },
  };
});

import { buildPopupHtml } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */

const baseProps = (over: Record<string, unknown> = {}): any => ({
  poly_IncidentName: 'Sand Drain',
  poly_GISAcres: 1000,
  attr_PercentContained: 50,
  attr_FireDiscoveryDateTime: new Date('2026-08-15T12:00:00Z').getTime(),
  attr_POOJurisdictionalUnit: null,
  ...over,
});

describe('buildPopupHtml — area (acres/hectares)', () => {
  it('without hass, defaults to metric (hectares) — same fallback convention as formatDistance', () => {
    // 1000 acres x 0.404686 = 404.686 -> 405
    const html = buildPopupHtml(baseProps(), new Set(), true, undefined);
    expect(html).toContain('405 ha');
    expect(html).toContain('Area');
  });

  it('with an imperial (mi) unit system, shows acres', () => {
    const hass = { config: { unit_system: { length: 'mi' } } } as any;
    const html = buildPopupHtml(baseProps(), new Set(), true, hass);
    expect(html).toContain('1,000 ac');
  });

  it('with a metric (km) unit system, converts to hectares', () => {
    // 1000 acres x 0.404686 = 404.686 -> 405
    const hass = { config: { unit_system: { length: 'km' } } } as any;
    const html = buildPopupHtml(baseProps(), new Set(), true, hass);
    expect(html).toContain('405 ha');
    expect(html).not.toContain('1,000 ac');
  });

  it('shows the em-dash placeholder when acreage is missing', () => {
    const html = buildPopupHtml(baseProps({ poly_GISAcres: undefined }), new Set(), true, undefined);
    expect(html).toMatch(/Area:<\/b>\s*—/);
  });
});

describe('buildPopupHtml — discovery date locale handling', () => {
  it('without hass, formats via Date#toLocaleDateString (browser-locale fallback)', () => {
    const html = buildPopupHtml(baseProps(), new Set(), true, undefined);
    expect(html).toMatch(/2026/);
  });

  it('with hass.locale, formats via HA\'s own formatDate (still contains the year)', () => {
    const hass = { locale: { language: 'en', number_format: 'language', time_format: '24' } } as any;
    const html = buildPopupHtml(baseProps(), new Set(), true, hass);
    expect(html).toMatch(/2026/);
  });

  it('shows the em-dash placeholder when discovery date is missing', () => {
    const html = buildPopupHtml(baseProps({ attr_FireDiscoveryDateTime: undefined }), new Set(), true, undefined);
    expect(html).toMatch(/Discovered:<\/b>\s*—/);
  });
});

// Fire details added in 3.12 (location, personnel, cause, perimeter and
// update ages), from WFIGS fields filled for 65–100% of current fires; a
// field a fire doesn't have leaves its row out.
describe('buildPopupHtml — fire details', () => {
  const NOW = Date.UTC(2026, 9, 8, 22, 0);
  const en = { locale: { language: 'en', number_format: 'language', time_format: '24' } } as any;
  const popup = (over: Record<string, unknown>, hass: any = en): string =>
    buildPopupHtml(baseProps(over), new Set(), true, hass, NOW);

  afterEach(() => localStorage.removeItem('selectedLanguage'));

  it("shows WFIGS's short description of where the fire is", () => {
    expect(popup({ attr_IncidentShortDescription: '30 Miles NW from Leavenworth, WA' }))
      .toContain('30 Miles NW from Leavenworth, WA');
  });

  it("falls back to county and state when WFIGS's description is an empty template", () => {
    // Garda Falls, 2026-10-08.
    const html = popup({ attr_IncidentShortDescription: 'null Miles null from null, ', attr_POOCounty: 'Pierce', attr_POOState: 'US-WA' });
    expect(html).toContain('Pierce, WA');
    expect(html).not.toContain('null');
    expect(popup({ attr_IncidentShortDescription: 'null Miles null from Leavenworth, WA', attr_POOCounty: 'Chelan', attr_POOState: 'US-WA' }))
      .toContain('Chelan, WA');
  });

  it('falls back to county and state, and leaves the line out with neither', () => {
    expect(popup({ attr_POOCounty: 'Chelan', attr_POOState: 'US-WA' })).toContain('Chelan, WA');
    expect(popup({ attr_POOState: 'US-WA' })).toContain('>WA<');
    expect(popup({})).not.toContain('color:#555');
  });

  it('shows personnel in the locale\'s number format', () => {
    expect(popup({ attr_TotalIncidentPersonnel: 1292 })).toMatch(/Personnel:<\/b>\s*1,292/);
    expect(popup({ attr_TotalIncidentPersonnel: 1292 }, { locale: { ...en.locale, language: 'de' } })).toContain('1.292');
    expect(popup({})).not.toContain('Personnel');
  });

  it("translates WFIGS's causes and shows any other value as sent, escaped", () => {
    localStorage.setItem('selectedLanguage', 'de');
    expect(popup({ attr_FireCause: 'Natural' })).toMatch(/Ursache:<\/b>\s*Natürlich/);
    localStorage.removeItem('selectedLanguage');
    expect(popup({ attr_FireCause: '<i>Lightning</i>' })).toContain('&lt;i&gt;Lightning&lt;/i&gt;');
    expect(popup({})).not.toContain('Cause');
  });

  it('says how long ago the perimeter was mapped and the record updated', () => {
    const html = popup({ poly_PolygonDateTime: NOW - 30 * 86_400_000, attr_ModifiedOnDateTime_dt: NOW - 5 * 3_600_000 });
    expect(html).toMatch(/Perimeter:<\/b>\s*mapped 30 days ago/);
    expect(html).toMatch(/Updated:<\/b>\s*5 hours ago/);
    expect(popup({ attr_ModifiedOnDateTime_dt: NOW - 40 * 60_000 })).toMatch(/Updated:<\/b>\s*40 minutes ago/);
  });

  it('words the ages in HA\'s language', () => {
    localStorage.setItem('selectedLanguage', 'de');
    const de = { locale: { ...en.locale, language: 'de' } };
    expect(popup({ poly_PolygonDateTime: NOW - 2 * 86_400_000 }, de)).toMatch(/Umriss:<\/b>\s*kartiert vor 2 Tagen/);
  });

  it('leaves out ages WFIGS has no time for', () => {
    const html = popup({});
    expect(html).not.toContain('Perimeter');
    expect(html).not.toContain('Updated');
  });

  it('labels the link InciWeb, where it goes', () => {
    const html = buildPopupHtml(baseProps({ attr_POOJurisdictionalUnit: 'WAOWF' }), new Set(), false, en, NOW);
    expect(html).toContain('inciweb.wildfire.gov/incident-information/waowf-sand-drain');
    expect(html).toContain('More info → InciWeb');
  });
});
