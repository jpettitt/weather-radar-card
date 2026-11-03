// Drag-to-reorder arithmetic for the editor's preset list.

import { describe, it, expect } from 'vitest';
import { dropIndex, indexAfterMove, indexAfterRemove, moveItem } from '../src/list-reorder';

describe('dropIndex', () => {
  const mids = [100, 200, 300];

  it('counts the rows whose middle is above the pointer', () => {
    expect(dropIndex(mids, 50)).toBe(0);
    expect(dropIndex(mids, 150)).toBe(1);
    expect(dropIndex(mids, 250)).toBe(2);
    expect(dropIndex(mids, 350)).toBe(3);
  });

  it('a pointer exactly on a middle drops before that row', () => {
    expect(dropIndex(mids, 200)).toBe(1);
  });
});

describe('moveItem', () => {
  const list = ['a', 'b', 'c', 'd'];

  it('moves down, to the end, and up', () => {
    expect(moveItem(list, 0, 2)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveItem(list, 1, 4)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('leaves the list alone for a drop beside the item, and never edits it in place', () => {
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, 1, 2)).toEqual(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('indexAfterMove', () => {
  it('follows every item through every move', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    for (let from = 0; from < list.length; from++) {
      for (let to = 0; to <= list.length; to++) {
        const moved = moveItem(list, from, to);
        for (let i = 0; i < list.length; i++) {
          expect(moved[indexAfterMove(i, from, to)]).toBe(list[i]);
        }
      }
    }
  });
});

describe('indexAfterRemove', () => {
  it('shifts later indexes down, keeps earlier ones, and drops the removed one', () => {
    expect(indexAfterRemove(3, 1)).toBe(2);
    expect(indexAfterRemove(0, 1)).toBe(0);
    expect(indexAfterRemove(1, 1)).toBeNull();
    expect(indexAfterRemove(null, 0)).toBeNull();
  });
});
