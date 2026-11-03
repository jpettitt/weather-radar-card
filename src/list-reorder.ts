// Drag-to-reorder for the editor's lists. An insert position is an index
// into the list before the move: 0 puts the item first, length last.

/** Where a drag at y would drop, given each row's vertical midpoint. */
export function dropIndex(midpoints: number[], y: number): number {
  return midpoints.filter((m) => m < y).length;
}

/** The list with the item at `from` moved to insert position `to`. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to > from ? to - 1 : to, 0, item);
  return out;
}

/** Where the item at `index` ends up after moveItem(list, from, to). */
export function indexAfterMove(index: number, from: number, to: number): number {
  const target = to > from ? to - 1 : to;
  if (index === from) return target;
  if (from < index && index <= target) return index - 1;
  if (target <= index && index < from) return index + 1;
  return index;
}

/** An index after the item at `removed` is deleted; null if it was that item. */
export function indexAfterRemove(index: number | null, removed: number): number | null {
  if (index === null || index === removed) return null;
  return index > removed ? index - 1 : index;
}
