import { describe, it, expect } from 'vitest';
import {
  AlertCategory,
  ALL_ALERT_CATEGORIES,
  DEFAULT_ALERT_CATEGORIES,
  categoryForEvent,
  getActiveAlertCategories,
} from '../src/nws-alert-categories';

describe('ALL_ALERT_CATEGORIES', () => {
  it('contains 10 categories including marine', () => {
    expect(ALL_ALERT_CATEGORIES).toHaveLength(10);
    expect(ALL_ALERT_CATEGORIES).toContain('tornado');
    expect(ALL_ALERT_CATEGORIES).toContain('marine');
    expect(ALL_ALERT_CATEGORIES).toContain('other');
  });
});

describe('DEFAULT_ALERT_CATEGORIES', () => {
  it('omits marine by design (most users are inland)', () => {
    expect(DEFAULT_ALERT_CATEGORIES).not.toContain('marine');
  });

  it('includes every other category', () => {
    expect(DEFAULT_ALERT_CATEGORIES).toHaveLength(ALL_ALERT_CATEGORIES.length - 1);
    for (const cat of ALL_ALERT_CATEGORIES) {
      if (cat === 'marine') continue;
      expect(DEFAULT_ALERT_CATEGORIES).toContain(cat);
    }
  });
});

describe('categoryForEvent', () => {
  it('maps known events to their category', () => {
    expect(categoryForEvent('Tornado Warning')).toBe('tornado');
    expect(categoryForEvent('Severe Thunderstorm Warning')).toBe('thunderstorm');
    expect(categoryForEvent('Flash Flood Warning')).toBe('flood');
    expect(categoryForEvent('Winter Storm Warning')).toBe('winter');
    expect(categoryForEvent('Hurricane Warning')).toBe('tropical');
    expect(categoryForEvent('Red Flag Warning')).toBe('fire_weather');
    expect(categoryForEvent('Heat Advisory')).toBe('heat');
    expect(categoryForEvent('High Wind Warning')).toBe('wind');
    expect(categoryForEvent('Special Marine Warning')).toBe('marine');
    expect(categoryForEvent('Civil Danger Warning')).toBe('other');
  });

  it('falls back to "other" for unknown events', () => {
    expect(categoryForEvent('Mystery Event')).toBe('other');
    expect(categoryForEvent('Brand New Future Warning Type')).toBe('other');
  });

  it('falls back to "other" for undefined', () => {
    expect(categoryForEvent(undefined)).toBe('other');
  });

  it('falls back to "other" for empty string', () => {
    expect(categoryForEvent('')).toBe('other');
  });
});

describe('getActiveAlertCategories', () => {
  // This is the helper that closed Bug 2 from the code review: an
  // explicit empty-array config (the user unchecked everything) used
  // to wrongly fall back to defaults. Distinguishing undefined from
  // [] is the whole point.

  it('returns the default set when undefined is passed', () => {
    const result = getActiveAlertCategories(undefined);
    expect(result.size).toBe(DEFAULT_ALERT_CATEGORIES.length);
    for (const cat of DEFAULT_ALERT_CATEGORIES) {
      expect(result.has(cat)).toBe(true);
    }
    expect(result.has('marine' as AlertCategory)).toBe(false);
  });

  it('returns an empty set when [] is passed (user opted out of everything)', () => {
    // ← regression guard for Bug 2: this MUST return empty, not fall
    // back to the default set.
    const result = getActiveAlertCategories([]);
    expect(result.size).toBe(0);
  });

  it('returns the explicit set the user configured', () => {
    const result = getActiveAlertCategories(['tornado', 'flood']);
    expect(result.size).toBe(2);
    expect(result.has('tornado' as AlertCategory)).toBe(true);
    expect(result.has('flood' as AlertCategory)).toBe(true);
    expect(result.has('winter' as AlertCategory)).toBe(false);
  });

  it('returns a fresh Set on each call (no shared mutable state)', () => {
    const a = getActiveAlertCategories(undefined);
    const b = getActiveAlertCategories(undefined);
    expect(a).not.toBe(b);
    a.add('marine' as AlertCategory);
    expect(b.has('marine' as AlertCategory)).toBe(false);
  });

  it('preserves marine when the user explicitly enables it', () => {
    const result = getActiveAlertCategories(['marine']);
    expect(result.has('marine' as AlertCategory)).toBe(true);
    expect(result.size).toBe(1);
  });
});
