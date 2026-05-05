import { describe, it, expect } from 'vitest';
import {
  NWS_ALERT_COLORS,
  NWS_ALERT_DEFAULT_COLOR,
  colorForEvent,
} from '../src/nws-alert-colors';

describe('NWS_ALERT_COLORS table', () => {
  it('is non-empty', () => {
    expect(Object.keys(NWS_ALERT_COLORS).length).toBeGreaterThan(50);
  });

  it('uses #RRGGBB hex strings throughout', () => {
    for (const [event, hex] of Object.entries(NWS_ALERT_COLORS)) {
      expect(hex, `colour for ${event}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('renders the expected NWS-standard colours for the major warnings', () => {
    expect(NWS_ALERT_COLORS['Tornado Warning']).toBe('#FF0000');
    expect(NWS_ALERT_COLORS['Severe Thunderstorm Warning']).toBe('#FFA500');
    expect(NWS_ALERT_COLORS['Flash Flood Warning']).toBe('#8B0000');
    expect(NWS_ALERT_COLORS['Hurricane Warning']).toBe('#DC143C');
  });
});

describe('colorForEvent', () => {
  it('returns the table colour for known events', () => {
    expect(colorForEvent('Tornado Warning')).toBe('#FF0000');
    expect(colorForEvent('Winter Storm Warning')).toBe('#FF69B4');
  });

  it('falls back to NWS_ALERT_DEFAULT_COLOR for unknown events', () => {
    expect(colorForEvent('Unknown Future Event')).toBe(NWS_ALERT_DEFAULT_COLOR);
    expect(colorForEvent('completely made up')).toBe(NWS_ALERT_DEFAULT_COLOR);
  });

  it('falls back to default for undefined event', () => {
    expect(colorForEvent(undefined)).toBe(NWS_ALERT_DEFAULT_COLOR);
  });

  it('falls back to default for empty string', () => {
    expect(colorForEvent('')).toBe(NWS_ALERT_DEFAULT_COLOR);
  });

  it('default colour is a valid hex string', () => {
    // The fallback colour happens to match one rare NWS entry (Winter
    // Weather Advisory uses #7B68EE too) — accepted, since unknown-event
    // overlap with a single advisory is benign. Just verify the format.
    expect(NWS_ALERT_DEFAULT_COLOR).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });
});
