import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockHass } from './helpers/mock-hass';

// Mock Leaflet before importing marker-icon (vi.mock is hoisted)
vi.mock('leaflet', () => {
  const icon = vi.fn((opts: object) => ({ _type: 'icon', ...opts }));
  const divIcon = vi.fn((opts: object) => ({ _type: 'divIcon', ...opts }));
  return { icon, divIcon, default: { icon, divIcon } };
});

import {
  createMarkerIconForMarker,
  findPersonEntityForDeviceTracker,
  resolveEntityPicture,
  resolveToPersonEntity,
} from '../src/marker-icon';

beforeEach(() => { vi.clearAllMocks(); });

// ── createMarkerIconForMarker ────────────────────────────────────────────────

describe('createMarkerIconForMarker', () => {
  it('returns default icon (dark SVG) on a light map style', () => {
    const result = createMarkerIconForMarker({}, mockHass(), 'light') as any;
    expect(result._type).toBe('icon');
    expect(result.iconUrl).toContain('home-circle-dark.svg');
  });

  it('uses light SVG on dark map style', () => {
    const result = createMarkerIconForMarker({ icon: 'default' }, mockHass(), 'dark') as any;
    expect(result._type).toBe('icon');
    expect(result.iconUrl).toContain('home-circle-light.svg');
  });

  it('uses light SVG on satellite map style', () => {
    const result = createMarkerIconForMarker({ icon: 'default' }, mockHass(), 'satellite') as any;
    expect(result.iconUrl).toContain('home-circle-light.svg');
  });

  it('uses light SVG on greydark map style, dark SVG on grey', () => {
    const dark = createMarkerIconForMarker({ icon: 'default' }, mockHass(), 'greydark') as any;
    expect(dark.iconUrl).toContain('home-circle-light.svg');
    const grey = createMarkerIconForMarker({ icon: 'default' }, mockHass(), 'grey') as any;
    expect(grey.iconUrl).toContain('home-circle-dark.svg');
  });

  it('custom map style picks the SVG from custom_tile_theme', () => {
    const light = createMarkerIconForMarker({ icon: 'default' }, mockHass(), 'custom') as any;
    expect(light.iconUrl).toContain('home-circle-dark.svg');
    const inverted = createMarkerIconForMarker({ icon: 'default' }, mockHass(), 'custom', 'invert') as any;
    expect(inverted.iconUrl).toContain('home-circle-light.svg');
  });

  it('returns entity_picture icon when entity has a picture URL', () => {
    const hass = mockHass({
      states: {
        'person.john': { state: 'home', attributes: { entity_picture: '/api/image/john.jpg', latitude: -34, longitude: 151 } },
      },
    });
    const result = createMarkerIconForMarker({ icon: 'entity_picture', entity: 'person.john' }, hass, 'light') as any;
    expect(result._type).toBe('icon');
    expect(result.iconUrl).toBe('/api/image/john.jpg');
    expect(result.className).toBe('marker-entity-picture');
  });

  it('uses icon_entity in preference to entity for picture lookup', () => {
    const hass = mockHass({
      states: {
        'person.john': { state: 'home', attributes: { entity_picture: '/api/image/john.jpg' } },
        'person.other': { state: 'home', attributes: { entity_picture: '/api/image/other.jpg' } },
      },
    });
    const result = createMarkerIconForMarker(
      { icon: 'entity_picture', entity: 'person.other', icon_entity: 'person.john' },
      hass, 'light',
    ) as any;
    expect(result.iconUrl).toBe('/api/image/john.jpg');
  });

  it('falls back to default when entity has no entity_picture attribute', () => {
    const hass = mockHass({
      states: { 'person.john': { state: 'home', attributes: { latitude: -34, longitude: 151 } } },
    });
    const result = createMarkerIconForMarker({ icon: 'entity_picture', entity: 'person.john' }, hass, 'light') as any;
    expect(result._type).toBe('icon');
    expect(result.iconUrl).toContain('home-circle');
  });

  it('falls back to default when entity is missing from states', () => {
    const result = createMarkerIconForMarker({ icon: 'entity_picture', entity: 'person.missing' }, mockHass({ states: {} }), 'light') as any;
    expect(result.iconUrl).toContain('home-circle');
  });

  it('renders <ha-icon> divIcon with the configured icon name on a light map', () => {
    const result = createMarkerIconForMarker({ icon: 'mdi:car-pickup' }, mockHass(), 'light') as any;
    expect(result._type).toBe('divIcon');
    expect(result.html).toContain('<ha-icon');
    expect(result.html).toContain('icon="mdi:car-pickup"');
    expect(result.html).toContain('color: #333333');
  });

  it('uses light text colour on dark map style for MDI icon', () => {
    const result = createMarkerIconForMarker({ icon: 'mdi:home' }, mockHass(), 'dark') as any;
    expect(result.html).toContain('color: #EEEEEE');
  });

  it('uses light text colour on satellite map style for MDI icon', () => {
    const result = createMarkerIconForMarker({ icon: 'mdi:home' }, mockHass(), 'satellite') as any;
    expect(result.html).toContain('color: #EEEEEE');
  });

  it('passes any MDI icon name through to <ha-icon> (no hardcoded allow-list)', () => {
    const result = createMarkerIconForMarker({ icon: 'mdi:totally-unknown-xyz' }, mockHass(), 'light') as any;
    expect(result._type).toBe('divIcon');
    expect(result.html).toContain('icon="mdi:totally-unknown-xyz"');
  });

  it('falls back to default for an mdi: prefix with empty name', () => {
    const result = createMarkerIconForMarker({ icon: 'mdi:' }, mockHass(), 'light') as any;
    expect(result._type).toBe('icon');
  });

  // ── Custom colour ─────────────────────────────────────────────────────────

  it('uses custom color on MDI icon instead of map-style default', () => {
    const result = createMarkerIconForMarker({ icon: 'mdi:home', color: '#ff0000' }, mockHass(), 'light') as any;
    expect(result._type).toBe('divIcon');
    expect(result.html).toContain('color: #ff0000');
    expect(result.html).not.toContain('#333333');
  });

  it('custom color overrides dark map style default on MDI icon', () => {
    const result = createMarkerIconForMarker({ icon: 'mdi:home', color: '#00ff00' }, mockHass(), 'dark') as any;
    expect(result.html).toContain('color: #00ff00');
    expect(result.html).not.toContain('#EEEEEE');
  });

  it('renders default icon as inline divIcon when color is set', () => {
    const result = createMarkerIconForMarker({ color: '#ff0000' }, mockHass(), 'light') as any;
    expect(result._type).toBe('divIcon');
    expect(result.html).toContain('#ff0000');
  });

  it('renders default icon as external SVG file when no color set', () => {
    const result = createMarkerIconForMarker({}, mockHass(), 'light') as any;
    expect(result._type).toBe('icon');
    expect(result.iconUrl).toContain('.svg');
  });

  it('ignores color on entity_picture icons', () => {
    const hass = mockHass({
      states: { 'person.john': { state: 'home', attributes: { entity_picture: '/api/image/john.jpg' } } },
    });
    const result = createMarkerIconForMarker(
      { icon: 'entity_picture', entity: 'person.john', color: '#ff0000' },
      hass, 'light',
    ) as any;
    // entity_picture returns an L.Icon with the picture URL, not a coloured SVG
    expect(result.iconUrl).toBe('/api/image/john.jpg');
  });

  // ── XSS: color / icon are user config (e.g. pasted from an untrusted
  // dashboard share), not just a hex string or "mdi:name" — L.divIcon's
  // html option is assigned via innerHTML, so an unescaped value here can
  // break out of the SVG/ha-icon attribute it's interpolated into. ────────

  describe('escapes color and icon before interpolating into divIcon html', () => {
    it('MDI icon: escapes a color value that tries to break out of the style attribute', () => {
      const malicious = '"><script>alert(1)</script>';
      const result = createMarkerIconForMarker({ icon: 'mdi:home', color: malicious }, mockHass(), 'light') as any;
      expect(result.html).not.toContain('<script>');
      expect(result.html).toContain('&lt;script&gt;');
      expect(result.html).toContain('&quot;&gt;');
    });

    it('MDI icon: escapes an icon value that tries to break out of the icon attribute', () => {
      const malicious = 'mdi:home"><img src=x onerror=alert(1)>';
      const result = createMarkerIconForMarker({ icon: malicious }, mockHass(), 'light') as any;
      expect(result.html).not.toContain('<img');
      expect(result.html).toContain('&lt;img');
    });

    it('default icon (inline SVG): escapes a color value that tries to break out of the fill attribute', () => {
      const malicious = '"/><script>alert(1)</script>';
      const result = createMarkerIconForMarker({ color: malicious }, mockHass(), 'light') as any;
      expect(result.html).not.toContain('<script>');
      expect(result.html).toContain('&lt;script&gt;');
    });

    it('a well-behaved hex color still renders normally (no over-escaping)', () => {
      const result = createMarkerIconForMarker({ icon: 'mdi:home', color: '#ff0000' }, mockHass(), 'light') as any;
      expect(result.html).toContain('color: #ff0000');
    });
  });
});

// ── findPersonEntityForDeviceTracker ─────────────────────────────────────────

describe('findPersonEntityForDeviceTracker', () => {
  it('returns the person entity when tracker is in their device_trackers array', () => {
    const hass = mockHass({
      states: {
        'person.john': { state: 'home', attributes: { device_trackers: ['device_tracker.phone'] } },
      },
    });
    expect(findPersonEntityForDeviceTracker('device_tracker.phone', hass)).toBe('person.john');
  });

  it('returns undefined when no person has that device tracker', () => {
    const hass = mockHass({ states: {} });
    expect(findPersonEntityForDeviceTracker('device_tracker.phone', hass)).toBeUndefined();
  });

  it('returns undefined when person exists but tracker is not in their list', () => {
    const hass = mockHass({
      states: {
        'person.john': { state: 'home', attributes: { device_trackers: ['device_tracker.tablet'] } },
      },
    });
    expect(findPersonEntityForDeviceTracker('device_tracker.phone', hass)).toBeUndefined();
  });
});

// ── resolveEntityPicture ─────────────────────────────────────────────────────

describe('resolveEntityPicture', () => {
  it('returns the picture URL when entity has entity_picture attribute', () => {
    const hass = mockHass({
      states: { 'person.john': { state: 'home', attributes: { entity_picture: '/api/img.jpg' } } },
    });
    expect(resolveEntityPicture('person.john', hass)).toBe('/api/img.jpg');
  });

  it('returns null for undefined entityId', () => {
    expect(resolveEntityPicture(undefined, mockHass())).toBeNull();
  });

  it('returns null when entity is missing from states', () => {
    expect(resolveEntityPicture('person.missing', mockHass({ states: {} }))).toBeNull();
  });

  it('returns null when entity has no entity_picture attribute', () => {
    const hass = mockHass({ states: { 'person.john': { state: 'home', attributes: {} } } });
    expect(resolveEntityPicture('person.john', hass)).toBeNull();
  });
});

// ── resolveToPersonEntity ────────────────────────────────────────────────────

describe('resolveToPersonEntity', () => {
  it('maps a device_tracker to its person entity', () => {
    const hass = mockHass({
      states: {
        'person.john': { state: 'home', attributes: { device_trackers: ['device_tracker.phone'] } },
      },
    });
    expect(resolveToPersonEntity('device_tracker.phone', hass)).toBe('person.john');
  });

  it('returns entity unchanged when it is already a person entity', () => {
    expect(resolveToPersonEntity('person.john', mockHass())).toBe('person.john');
  });

  it('returns device_tracker unchanged when no matching person found', () => {
    const hass = mockHass({ states: {} });
    expect(resolveToPersonEntity('device_tracker.phone', hass)).toBe('device_tracker.phone');
  });

  it('returns non-tracker entity unchanged', () => {
    expect(resolveToPersonEntity('zone.home', mockHass())).toBe('zone.home');
  });
});
