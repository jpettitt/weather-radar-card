import { describe, it, expect } from 'vitest';
import { escapeHtml, truncate, slugify } from '../src/string-utils';

describe('escapeHtml', () => {
  it('passes through strings with no HTML-significant chars', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
    expect(escapeHtml('')).toBe('');
    expect(escapeHtml('Tornado Warning — issued 2025-01-01')).toBe('Tornado Warning — issued 2025-01-01');
  });

  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes a tag-injection attempt', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('escapes attribute-breakout characters together', () => {
    // Simulates injecting into href="..." — the quote and ampersand both
    // need to be neutralised, otherwise an attacker can break out.
    expect(escapeHtml('"><img src=x onerror=alert(1)>')).toBe(
      '&quot;&gt;&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('handles all five chars together', () => {
    expect(escapeHtml('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&#39;f');
  });
});

describe('truncate', () => {
  it('returns the input unchanged when within limit', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('exact', 5)).toBe('exact');   // boundary: equal length
  });

  it('cuts to n-1 chars and appends an ellipsis when over', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
    expect(truncate('abcdefghij', 4)).toBe('abc…');
  });

  it('keeps the result at most n characters', () => {
    const r = truncate('a'.repeat(100), 10);
    expect(r.length).toBe(10);
    expect(r.endsWith('…')).toBe(true);
  });

  it('handles empty input', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('slugify', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(slugify('Sand Drain')).toBe('sand-drain');
    expect(slugify('Gun Range')).toBe('gun-range');
  });

  it('collapses runs of non-alphanumeric chars into single hyphens', () => {
    expect(slugify('East   Side  Fire')).toBe('east-side-fire');
    expect(slugify('Foo!@#$Bar')).toBe('foo-bar');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugify('  Hello World  ')).toBe('hello-world');
    expect(slugify('---wrapped---')).toBe('wrapped');
  });

  it('preserves digits', () => {
    expect(slugify('Fire 23')).toBe('fire-23');
    expect(slugify('FF 139')).toBe('ff-139');
  });

  it('handles purely numeric input', () => {
    expect(slugify('139')).toBe('139');
  });
});
