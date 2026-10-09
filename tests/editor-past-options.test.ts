// The past-time dropdown: presets up to the editor's cap, plus an entry for
// a YAML value it doesn't offer. A preset above the cap (DWD 24 h, above
// the editor's 12 h) used to get no entry, leaving nothing selected.

import { describe, it, expect } from 'vitest';
import * as editorModule from '../src/editor';

/* eslint-disable @typescript-eslint/no-explicit-any */

const proto = (Object.values(editorModule).find((v: any) => typeof v === 'function' && v.prototype?._buildPastOptions) as any).prototype;
const labels = (raw: number | undefined, editorCap: number, maxPast: number): string[] =>
  proto._buildPastOptions.call({}, raw, editorCap, maxPast).map((o: { label: string }) => o.label);
const values = (raw: number | undefined, editorCap: number, maxPast: number): string[] =>
  proto._buildPastOptions.call({}, raw, editorCap, maxPast).map((o: { value: string }) => o.value);

describe('past-time dropdown', () => {
  it('lists a YAML preset above the editor cap, so the dropdown can show it', () => {
    expect(values(1440, 720, 1440)).toContain('1440');
    expect(labels(1440, 720, 1440).at(-1)).toMatch(/YAML/);
  });

  it("labels a YAML value above the source's limit with what the card plays", () => {
    // An older config with 84 h: the entry keeps its value, so picking it
    // changes nothing, but says 24 h.
    const opts = proto._buildPastOptions.call({}, 5040, 720, 1440);
    expect(opts.at(-1).value).toBe('5040');
    expect(opts.at(-1).label).toBe(labels(1440, 720, 1440).at(-1));
  });

  it('adds nothing for a value the presets already offer', () => {
    expect(values(120, 720, 1440).filter((v) => v === '120')).toHaveLength(1);
    expect(labels(120, 720, 1440).some((l) => /YAML/.test(l))).toBe(false);
  });
});
