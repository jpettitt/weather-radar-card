// The Sources popup on narrow cards: opens from the © Sources button and
// closes with ×, a click anywhere else, or Escape.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CreditsPopup } from '../src/credits-popup';

describe('CreditsPopup', () => {
  let toggle: HTMLButtonElement;
  let popup: HTMLDivElement;
  let link: HTMLAnchorElement;
  let elsewhere: HTMLDivElement;
  let credits: CreditsPopup;

  beforeEach(() => {
    toggle = document.createElement('button');
    popup = document.createElement('div');
    popup.hidden = true;
    link = document.createElement('a');
    popup.appendChild(link);
    elsewhere = document.createElement('div');
    document.body.append(toggle, popup, elsewhere);
    credits = new CreditsPopup(() => ({ toggle, popup }));
    toggle.addEventListener('click', credits.toggle);
  });

  afterEach(() => {
    credits.close();
    document.body.innerHTML = '';
  });

  it('opens from the toggle and stays open through that same click', () => {
    toggle.click();
    expect(credits.isOpen).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on a second click of the toggle', () => {
    toggle.click();
    toggle.click();
    expect(credits.isOpen).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('stays open for clicks inside, such as a credit link', () => {
    toggle.click();
    link.click();
    expect(credits.isOpen).toBe(true);
  });

  it('closes on a click anywhere else', () => {
    toggle.click();
    elsewhere.click();
    expect(credits.isOpen).toBe(false);
  });

  it('closes on Escape, and ignores other keys', () => {
    toggle.click();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(credits.isOpen).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(credits.isOpen).toBe(false);
  });

  it('stops listening once closed', () => {
    toggle.click();
    credits.close();
    popup.hidden = false; // shown by something else: a stray click must not touch it
    elsewhere.click();
    expect(popup.hidden).toBe(false);
  });
});
