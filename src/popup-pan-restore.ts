/**
 * Decides when to put the map's view back after a popup's autoPan moved it.
 *
 * Leaflet's popups have no "reposition instead of panning the map" mode, so
 * an off-edge hazard-layer popup (lightning/wildfire/NWS-alerts) still pans
 * the view to stay fully visible. This tracks the center from *before* that
 * happened so the caller can restore it once the user is done with the
 * popup — browsing hazard popups near the map edge shouldn't leave the view
 * shifted afterward.
 *
 * Pure decision logic only — no Leaflet, no timers. The caller (see
 * weather-radar-card.ts's _setupPopupPanRestore) owns the actual
 * map.on('popupopen'/'popupclose') wiring and the setTimeout that defers
 * the restore by a tick, needed because switching directly between two
 * popups fires popupclose then popupopen synchronously in the same tick
 * (Leaflet's one-popup-at-a-time autoClose behaviour) — onCloseSettled lets
 * that same-tick reopen cancel the pending restore instead of snapping back
 * only to immediately pan away again, so a chain of popup switches only
 * restores once, to the center from before the first one opened.
 */
export class PopupPanRestore<Center> {
  private savedCenter: Center | null = null;
  private token = 0;

  /** Call when a popup opens. Captures the pre-chain center on the first open of a chain. */
  onOpen(getCenter: () => Center): void {
    this.token++;
    if (this.savedCenter === null) {
      this.savedCenter = getCenter();
    }
  }

  /** Call when a popup closes. Returns a token to pass to onCloseSettled after a deferred tick. */
  onClose(): number {
    return ++this.token;
  }

  /**
   * Call after deferring a tick past onClose(). Returns the center to
   * restore to, or null if a popup reopened in the meantime (token no
   * longer matches) or there was nothing pending.
   */
  onCloseSettled(tokenAtClose: number): Center | null {
    if (tokenAtClose !== this.token) return null;
    const saved = this.savedCenter;
    this.savedCenter = null;
    return saved;
  }
}
