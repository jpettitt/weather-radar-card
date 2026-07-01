// Per-user, per-card state framework.
//
// Wraps Home Assistant's frontend storage WebSocket API so layers and other
// in-card features can persist user choices (overlay visibility, playback
// speed, etc.) across reloads, browsers, and devices — without bouncing
// through the editor / YAML and without using `localStorage` (which is
// shared across users on the same browser and doesn't sync).
//
// Design — see [`docs/layer-control-design.md`](../docs/layer-control-design.md)
// for the long form and [`docs/viewer-state-api.md`](../docs/viewer-state-api.md)
// for the consumer API.
//
// Two responsibilities:
//
// 1. **Card identity** — mint and validate a per-card storage nonce. Stored
//    in YAML as `_layer_state_id: { dash, nonce }`. The card auto-mints it
//    on first `setConfig` (when the admin opt-in `viewer_layer_control` is
//    on) and dispatches `config-changed` so Lovelace writes it back to YAML.
//    Re-mints when the card moves to a different dashboard URL, and when a
//    within-dashboard copy-paste collides on nonce.
//
// 2. **Storage primitive** — debounced reads/writes through `hass.callWS`
//    against `frontend/{get,set}_user_data`. In-memory cache for sync
//    reads; debounced (500 ms) writes coalesce rapid-fire updates.
//
// Dormant when off. If `viewer_layer_control` is unset or false, no
// identity is minted, no WS calls fire, and all `get`/`set`/`delete` calls
// are no-ops that return `undefined`. Default user-facing behaviour is
// unchanged — the framework only activates when a consumer opts the card
// in via the admin toggle.

import type { HomeAssistant } from 'custom-card-helpers';
import type { WeatherRadarCardConfig } from './types';

// ── Public types ──────────────────────────────────────────────────────────

/** Two-field identity stored in YAML under `_layer_state_id`. */
export interface LayerStateId {
  /** `window.location.pathname` at mint time. Used for copy-detection. */
  dash: string;
  /** Short random ID. THE storage key fragment. */
  nonce: string;
}

/** Emitted on every cache mutation so multiple consumers can react. */
export interface ViewerStateChange {
  key: string | null;       // null on reset / hydrate (whole-cache event)
  value: unknown;
  source: 'set' | 'delete' | 'reset' | 'hydrate';
}

export type Unsubscribe = () => void;

export interface ViewerStateOptions {
  hass: HomeAssistant;
  getConfig: () => WeatherRadarCardConfig | undefined;
  /**
   * Called when ensureIdentity() mints or re-mints `_layer_state_id`.
   * The card should dispatch `config-changed` with the new id so Lovelace
   * persists it to YAML. Will fire synchronously from inside
   * ensureIdentity(); the next setConfig() carries the new id.
   */
  onIdentityMinted: (id: LayerStateId) => void;
}

// ── Module-scoped state ───────────────────────────────────────────────────

/**
 * Live cards keyed by nonce, used to detect within-dashboard copy-paste
 * (where the dash check can't help because both cards live at the same
 * URL). Entry written by ensureIdentity, removed by dispose.
 */
const liveCardsByNonce = new Map<string, ViewerState>();

const DEBOUNCE_WRITE_MS = 500;

/** Namespace prefix for the WS storage key. */
const STORAGE_KEY_PREFIX = 'weather-radar-card.viewer-state.';

// ── Implementation ────────────────────────────────────────────────────────

export class ViewerState {
  private readonly _hass: HomeAssistant;
  private readonly _getConfig: () => WeatherRadarCardConfig | undefined;
  private readonly _onIdentityMinted: (id: LayerStateId) => void;
  private readonly _listeners = new Set<(e: ViewerStateChange) => void>();

  /** In-memory cache. Written by hydrate/set/delete/reset. */
  private _cache: Record<string, unknown> = {};

  /** Currently registered nonce (so dispose() can deregister it). */
  private _registeredNonce: string | null = null;

  private _writeTimer: ReturnType<typeof setTimeout> | null = null;
  private _hydrated = false;
  // In-flight hydrate promise, so concurrent hydrate() calls (and
  // _flush()'s wait-for-hydrate) share one WS round-trip instead of
  // racing two GETs whose second response would clobber the first.
  private _hydratePromise: Promise<void> | null = null;
  private _errorLogged = false;

  constructor(opts: ViewerStateOptions) {
    this._hass = opts.hass;
    this._getConfig = opts.getConfig;
    this._onIdentityMinted = opts.onIdentityMinted;
  }

  // ── Status ──────────────────────────────────────────────────────────────

  /**
   * True when the admin opt-in is on AND we have a stable storage key.
   * Consumers should check this before assuming `get`/`set` will round-trip.
   */
  get isActive(): boolean {
    return this._registeredNonce !== null;
  }

  /** Full WS storage key, or null when inactive. */
  get storageKey(): string | null {
    return this._registeredNonce ? STORAGE_KEY_PREFIX + this._registeredNonce : null;
  }

  // ── Identity ────────────────────────────────────────────────────────────

  /**
   * Idempotent. Call from `setConfig` on every config update.
   *
   * Outcomes:
   *
   * - Admin toggle off → ensures we're deregistered, no-op otherwise.
   * - Admin on, no id yet → mints + fires `onIdentityMinted`. Returns;
   *   the next setConfig (after Lovelace writes back the new id) will
   *   register the nonce and the cache becomes useable.
   * - Admin on, dashboard path changed → re-mints + fires onIdentityMinted.
   * - Admin on, nonce already claimed by another live instance (copy-paste
   *   within the same dashboard) → re-mints on this instance, leaves the
   *   original alone.
   * - Admin on, id stable and not colliding → registers and returns.
   */
  ensureIdentity(): void {
    const config = this._getConfig();
    if (!config?.viewer_layer_control) {
      this._deregister();
      return;
    }

    const currentPath = typeof window !== 'undefined' ? window.location.pathname : '';
    const id = config._layer_state_id;

    if (!id || typeof id.nonce !== 'string' || typeof id.dash !== 'string') {
      this._mint(currentPath);
      return;
    }
    if (id.dash !== currentPath) {
      this._mint(currentPath);
      return;
    }
    const claimant = liveCardsByNonce.get(id.nonce);
    if (claimant && claimant !== this) {
      // Two live cards with the same nonce → within-dashboard copy-paste.
      // Re-mint on this instance; original keeps its identity untouched.
      this._mint(currentPath);
      return;
    }

    // Identity is stable and uncontested. Register and we're active.
    if (this._registeredNonce !== id.nonce) {
      this._deregister();
      this._registeredNonce = id.nonce;
      liveCardsByNonce.set(id.nonce, this);
    }
  }

  private _mint(dash: string): void {
    const fresh: LayerStateId = { dash, nonce: makeNonce() };
    // We don't register the new nonce yet — wait for the next setConfig
    // (post config-changed round-trip) to see it back from the config
    // and call ensureIdentity again. This keeps the in-memory state
    // strictly consistent with what's persisted in YAML.
    this._deregister();
    this._onIdentityMinted(fresh);
  }

  private _deregister(): void {
    if (this._registeredNonce !== null) {
      const claimant = liveCardsByNonce.get(this._registeredNonce);
      if (claimant === this) liveCardsByNonce.delete(this._registeredNonce);
      this._registeredNonce = null;
    }
  }

  // ── Hydration ───────────────────────────────────────────────────────────

  /**
   * One-time read of the persisted state into the in-memory cache. Call
   * from `connectedCallback` or after the first `ensureIdentity` succeeds.
   * Safe to call multiple times; subsequent calls are no-ops, and
   * concurrent calls share one in-flight WS round-trip.
   */
  async hydrate(): Promise<void> {
    if (this._hydrated || !this.isActive) return;
    if (this._hydratePromise) return this._hydratePromise;
    this._hydratePromise = this._doHydrate();
    try {
      await this._hydratePromise;
    } finally {
      this._hydratePromise = null;
    }
  }

  private async _doHydrate(): Promise<void> {
    try {
      const result = await this._hass.callWS<{ value?: Record<string, unknown> } | null>({
        type: 'frontend/get_user_data',
        key: this.storageKey!,
      });
      if (result?.value && typeof result.value === 'object') {
        // Merge UNDER the in-memory cache, not wholesale replace. set()
        // is legal while the WS round-trip is in flight (isActive is
        // true as soon as the nonce registers, before hydrate resolves)
        // — a replace would silently discard those optimistic writes,
        // and the already-scheduled debounced flush would then persist
        // the replaced cache, losing the user's change on disk too.
        // Optimistic in-memory keys win over persisted values: they are
        // strictly newer.
        this._cache = { ...result.value, ...this._cache };
      }
      this._hydrated = true;
      this._emit({ key: null, value: this._cache, source: 'hydrate' });
    } catch (err) {
      this._logErrorOnce('hydrate', err);
      this._hydrated = true;  // give up; subsequent gets return undefined
    }
  }

  // ── Consumer API ────────────────────────────────────────────────────────

  /** Sync read from the in-memory cache. Returns undefined when inactive or absent. */
  get<T>(key: string): T | undefined {
    if (!this.isActive) return undefined;
    return this._cache[key] as T | undefined;
  }

  /**
   * Optimistic update. The in-memory cache reflects the new value
   * immediately; the WS write is debounced ~500ms so rapid-fire updates
   * coalesce. No-op when inactive.
   */
  set<T>(key: string, value: T): void {
    if (!this.isActive) return;
    if (this._cache[key] === value) return;
    this._cache[key] = value;
    this._emit({ key, value, source: 'set' });
    this._scheduleWrite();
  }

  /**
   * Removes the key from storage. Consumers use this to express
   * "value returned to default" in sparse-storage style.
   */
  delete(key: string): void {
    if (!this.isActive) return;
    if (!(key in this._cache)) return;
    delete this._cache[key];
    this._emit({ key, value: undefined, source: 'delete' });
    this._scheduleWrite();
  }

  /**
   * Clears all stored state for this card. The persisted record is set
   * to an empty object (not deleted entirely; that would re-mint on
   * next read in some HA versions).
   */
  async reset(): Promise<void> {
    if (!this.isActive) return;
    this._cache = {};
    this._emit({ key: null, value: {}, source: 'reset' });
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
    }
    try {
      await this._hass.callWS({
        type: 'frontend/set_user_data',
        key: this.storageKey!,
        value: {},
      });
    } catch (err) {
      this._logErrorOnce('reset', err);
    }
  }

  // ── Change notifications ────────────────────────────────────────────────

  /** Subscribe to cache mutations. Returns an unsubscribe function. */
  subscribe(listener: (e: ViewerStateChange) => void): Unsubscribe {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private _emit(event: ViewerStateChange): void {
    for (const l of this._listeners) {
      try {
        l(event);
      } catch (err) {
        // Listener errors are isolated — one bad consumer shouldn't
        // poison the others.
        console.error('[weather-radar-card] viewer-state listener threw', err);
      }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Flush any pending debounced write, then deregister from the
   * live-instance map.
   *
   * The flush MUST happen (and start synchronously) before _deregister:
   * _flush captures the storage key at entry, and deregistering first
   * would null the key and silently drop the user's last ≤500 ms of
   * changes — which in HA happens constantly (dashboard navigation,
   * edit mode, view switches all tear the card down). Fire-and-forget
   * is fine; callWS dispatches on the still-open socket in the common
   * SPA-navigation case. When hydration never completed, _flush's
   * key-recheck after the hydrate await sees the deregistered state
   * and drops the write rather than risk wiping persisted keys.
   */
  dispose(): void {
    if (this._writeTimer) {
      clearTimeout(this._writeTimer);
      this._writeTimer = null;
      void this._flush();
    }
    this._listeners.clear();
    this._deregister();
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private _scheduleWrite(): void {
    if (this._writeTimer) clearTimeout(this._writeTimer);
    this._writeTimer = setTimeout(() => {
      this._writeTimer = null;
      void this._flush();
    }, DEBOUNCE_WRITE_MS);
  }

  /**
   * Internal: flush the cache to WS. Exposed via the test seam so tests
   * can deterministically wait on a write without sleeping for the
   * debounce window.
   *
   * Waits for hydration first when it hasn't happened yet: the persisted
   * record is the union of every key ever set, while a pre-hydrate cache
   * holds ONLY the keys set this session. Writing that thin cache would
   * destroy every other persisted key for this card. After hydrate's
   * merge-under, the write is safe. The storage key is captured up front
   * so a dispose()/re-mint that lands during the await can't misroute
   * the write to a different identity — we just drop it instead.
   * @internal
   */
  async _flush(): Promise<void> {
    const key = this.storageKey;
    if (!key) return;
    if (!this._hydrated) {
      await this.hydrate();
      // Disposed or re-minted while hydrating — the cache no longer
      // belongs to `key`; writing it would corrupt another identity's
      // record (or write under a dead key). Drop the flush.
      if (this.storageKey !== key) return;
    }
    try {
      await this._hass.callWS({
        type: 'frontend/set_user_data',
        key,
        value: { ...this._cache },
      });
    } catch (err) {
      this._logErrorOnce('write', err);
    }
  }

  private _logErrorOnce(op: string, err: unknown): void {
    if (this._errorLogged) return;
    this._errorLogged = true;
    console.warn(`[weather-radar-card] viewer-state ${op} failed; in-memory only:`, err);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Short random nonce — 7 lowercase-base36 chars (~36 bits of entropy,
 * collision probability ~1 in 70 billion for a single dashboard's worth
 * of cards). crypto.randomUUID() would be nicer but isn't available in
 * every HA-shipped browser baseline; Math.random fits the threat model
 * (collisions are caught by liveCardsByNonce and re-minted).
 */
function makeNonce(): string {
  return Math.random().toString(36).slice(2, 9);
}

// ── Test seams ────────────────────────────────────────────────────────────

/**
 * Reset the module-scoped live-cards map. Tests only.
 * @internal
 */
export function _resetLiveCardsForTests(): void {
  liveCardsByNonce.clear();
}

/**
 * Inspect the live-cards map. Tests only.
 * @internal
 */
export function _liveCardsForTests(): ReadonlyMap<string, ViewerState> {
  return liveCardsByNonce;
}
