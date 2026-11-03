import { describe, it, expect, vi } from 'vitest';

vi.mock('leaflet', () => {
  class Layer {}
  class TileLayer {}
  class WMS {}
  (TileLayer as unknown as { WMS: typeof WMS }).WMS = WMS;
  class Control { constructor(_o?: unknown) { void _o; } }
  const DomUtil = { create: vi.fn(() => ({ style: {}, classList: { add: vi.fn() } })) };
  const DomEvent = { disableClickPropagation: vi.fn(), on: vi.fn() };
  return { Layer, TileLayer, Control, DomUtil, DomEvent, default: { Layer, TileLayer, Control, DomUtil, DomEvent } };
});

import { buildPopupHtml } from '../src/wildfire-layer';

/* eslint-disable @typescript-eslint/no-explicit-any */
const props = (over: Record<string, unknown>): any => ({
  poly_IncidentName: 'Sand Drain', poly_GISAcres: 10, attr_PercentContained: 5, ...over,
});

// attr_FireCause comes from the NIFC feed. A value that names an
// Object.prototype member found an inherited function in CAUSE_KEYS, and
// localize() threw, so that fire's popup did not open.
describe('wildfire popup: attr_FireCause', () => {
  // Any value other than the known causes is shown as sent (CAUSE_KEYS comment).
  for (const cause of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    it(`cause "${cause}" renders as sent, popup does not throw`, () => {
      let html = '';
      let err: unknown = null;
      try { html = buildPopupHtml(props({ attr_FireCause: cause }), null, undefined); } catch (e) { err = e; }
      expect(err).toBeNull();
      expect(html).toContain(cause);
    });
  }
});
