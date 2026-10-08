// Narrow cards (container query ≤ 397 px) swap the footer's credits line for
// a "© Sources" button that opens them in a small overlay. Driven by hand
// rather than through Lit state: the card's shouldUpdate() only passes
// _config / hass / editMode changes, so a state flag would never render.

export interface CreditsElements {
  toggle: HTMLElement | null;
  popup: HTMLElement | null;
}

export class CreditsPopup {
  constructor(private readonly _els: () => CreditsElements) {}

  get isOpen(): boolean {
    const { popup } = this._els();
    return !!popup && !popup.hidden;
  }

  toggle = (): void => {
    if (this.isOpen) this.close(); else this._open();
  };

  close = (): void => {
    const { toggle, popup } = this._els();
    if (popup) popup.hidden = true;
    toggle?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', this._onOutside, true);
    document.removeEventListener('keydown', this._onKey);
  };

  private _open(): void {
    const { toggle, popup } = this._els();
    if (!popup) return;
    popup.hidden = false;
    toggle?.setAttribute('aria-expanded', 'true');
    // Capture phase, added during the opening click: that click has already
    // passed the document, so it can't close the popup it just opened.
    document.addEventListener('click', this._onOutside, true);
    document.addEventListener('keydown', this._onKey);
  }

  // composedPath() sees into the card's shadow root, so clicks on the
  // popup's own links and on the toggle aren't "outside".
  private _onOutside = (e: Event): void => {
    const { toggle, popup } = this._els();
    const path = e.composedPath();
    if (popup && path.includes(popup)) return;
    if (toggle && path.includes(toggle)) return;
    this.close();
  };

  private _onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') this.close();
  };
}
