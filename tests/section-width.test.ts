// A card's width in an HA sections view, checked against widths measured
// on the testbed: a section spanning two columns (an 823 px grid of 24
// columns, 8 px gaps) holding a full-width card (407 px) and a 6-column one
// (200 px).

import { describe, it, expect } from 'vitest';
import { cardColumns, sectionCardWidth } from '../src/section-width';

describe('sectionCardWidth', () => {
  it('matches the dashboard', () => {
    expect(sectionCardWidth(823, 24, 8, 12)).toBeCloseTo(407.5);
    expect(sectionCardWidth(823, 24, 8, 6)).toBeCloseTo(199.75);
  });

  it('is the whole grid for every column, and one column for one', () => {
    expect(sectionCardWidth(823, 24, 8, 24)).toBeCloseTo(823);
    expect(sectionCardWidth(400, 12, 8, 1)).toBeCloseTo((400 - 88) / 12);
  });
});

describe('cardColumns', () => {
  it("uses the card's grid_options, 'full' meaning every column", () => {
    expect(cardColumns({ columns: 6 }, 24, 12)).toBe(6);
    expect(cardColumns({ columns: 'full' }, 24, 12)).toBe(24);
  });

  it("falls back to the card's default, and stays within the grid", () => {
    expect(cardColumns(undefined, 24, 12)).toBe(12);
    expect(cardColumns({ columns: 0 }, 24, 12)).toBe(12);
    expect(cardColumns({}, 12, 12)).toBe(12);
    expect(cardColumns({ columns: 30 }, 24, 12)).toBe(24);
  });
});
