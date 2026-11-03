// Finding the card's place in HA's nested shadow trees.

import { describe, it, expect } from 'vitest';
import { closestAncestor, deepQueryAll, hasAncestor } from '../src/dom-ancestry';

describe('hasAncestor', () => {
  it('looks through shadow roots to their hosts', () => {
    const dialog = document.createElement('hui-dialog-edit-card');
    const inner = document.createElement('ha-dialog');
    dialog.attachShadow({ mode: 'open' }).appendChild(inner);
    const card = document.createElement('weather-radar-card');
    inner.attachShadow({ mode: 'open' }).appendChild(card);
    document.body.appendChild(dialog);
    expect(hasAncestor(card, 'hui-dialog-edit-card')).toBe(true);
    expect(hasAncestor(card, 'hui-card-picker')).toBe(false);
  });

  it("doesn't count the node itself", () => {
    const el = document.createElement('hui-dialog-edit-card');
    document.body.appendChild(el);
    expect(hasAncestor(el, 'hui-dialog-edit-card')).toBe(false);
  });
});

describe('closestAncestor', () => {
  it('returns the nearest match across shadow roots', () => {
    const outer = document.createElement('hui-card');
    const inner = document.createElement('hui-card');
    outer.attachShadow({ mode: 'open' }).appendChild(inner);
    const card = document.createElement('weather-radar-card');
    inner.appendChild(card);
    document.body.appendChild(outer);
    expect(closestAncestor(card, 'hui-card')).toBe(inner);
    expect(closestAncestor(card, 'hui-section')).toBeNull();
  });
});

describe('deepQueryAll', () => {
  it('finds elements inside nested shadow trees, in document order', () => {
    document.body.innerHTML = '';
    const view = document.createElement('hui-view');
    const a = document.createElement('hui-section');
    const b = document.createElement('hui-section');
    const host = document.createElement('div');
    view.attachShadow({ mode: 'open' }).append(a, host);
    host.attachShadow({ mode: 'open' }).appendChild(b);
    document.body.appendChild(view);
    expect(deepQueryAll(document, 'hui-section')).toEqual([a, b]);
  });
});
