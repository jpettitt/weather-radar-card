// The width a card gets in an HA sections view, for sizing the editor's
// preview to match the dashboard.

/**
 * How many of a section grid's `count` columns a card spans: its
 * grid_options.columns ('full' is all of them), else the card's default.
 */
export function cardColumns(
  gridOptions: { columns?: number | 'full' } | undefined,
  count: number,
  defaultColumns: number,
): number {
  const v = gridOptions?.columns;
  const n = v === 'full' ? count : typeof v === 'number' && v > 0 ? v : defaultColumns;
  return Math.min(count, Math.max(1, Math.round(n)));
}

/**
 * A card's width across `columns` of a grid `gridWidth` wide with `count`
 * equal columns and `gap` between them. A section spanning two dashboard
 * columns has a 24-column grid, so a 12-column card fills half of it.
 */
export function sectionCardWidth(gridWidth: number, count: number, gap: number, columns: number): number {
  const column = (gridWidth - gap * (count - 1)) / count;
  return column * columns + gap * (columns - 1);
}
