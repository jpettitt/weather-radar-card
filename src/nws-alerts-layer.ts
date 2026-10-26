import * as L from 'leaflet';
import { HomeAssistant, formatDateTime as haFormatDateTime, type FrontendLocaleData } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { localize } from './localize/localize';
import { colorForEvent, NWS_ALERT_DEFAULT_COLOR } from './nws-alert-colors';
import {
  ALL_ALERT_CATEGORIES, categoryForEvent, getActiveAlertCategories,
} from './nws-alert-categories';
import { centroidLngLat, haversineKm, geometryLngLatBounds } from './geo-utils';
import { sharedCanvasRenderer } from './shared-canvas-renderer';
import { onMapQuiet } from './map-quiet';
import {
  readZoneEntry, writeZone, sweepZones, defaultZoneKV, simplifyGeometry, normalizeZoneGeometry,
  simplifyToleranceForZoom, SIMPLIFY_TOLERANCE_DEG, type ZoneKV,
} from './zone-store';

// Cache entry for a zone with no drawable shape: contributes nothing to
// _geometryFromZones and has no bounds, but counts as resolved.
const NO_SHAPE: GeoJSON.MultiPolygon = { type: 'MultiPolygon', coordinates: [] };

// Resolves in idle time where the browser offers it (Safari may not).
function idle(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(() => resolve(), { timeout: 2000 });
    else setTimeout(resolve, 250);
  });
}
import { escapeHtml, truncate } from './string-utils';
import { mapsEqual } from './map-utils';
import { refreshOverrideMs } from './refresh-override';
import { DATA_TIMEOUT_MS, withTimeout } from './fetch-timeout';

const decisionsEqual = mapsEqual<string, string>;

// NWS public API — see docs/nws-alerts-feature-design.md.
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual';
// We deliberately do NOT set a User-Agent header from JavaScript even though
// NWS recommends it. User-Agent is on the Fetch spec's "forbidden header"
// list — browsers reject the entire request (TypeError: Failed to fetch)
// rather than silently stripping the header. The browser's own UA gets
// sent automatically, which satisfies NWS's identification requirement.

const DEFAULT_REFRESH_VISIBLE_MS = 60 * 1000;
const DEFAULT_REFRESH_EMPTY_MS = 5 * 60 * 1000;
// Floor for alerts_refresh_seconds (see refresh-override.ts).
const MIN_REFRESH_MS = 30 * 1000;

// Zone shapes go through a pool, ZONE_POOL_SIZE at a time, in-view alerts
// first. NWS's limiter is a burst limiter per address: unpublished, and it
// "clears typically within 5 seconds"; a block is a 403 without CORS
// headers, so the browser sees a status-less TypeError. With the marine
// categories on, a cold cache needed 2,100 zones; fired at once that was
// blocked on the owner's address (2026-10-16), and the 60 s refresh
// re-fired the same burst, so the alerts never got shapes. After a block
// the batch stops, waits ZONE_BACKOFF_MIN_MS doubling to
// ZONE_BACKOFF_MAX_MS, and resumes at half the pool; shapes arriving again
// restore both.
const ZONE_POOL_SIZE = 24;
const ZONE_POOL_MIN = 4;
// Stored zones of an older ZONE_FORMAT are rewritten this many at a time,
// in idle time after a zone batch, never while the map moves.
const WRITE_BACK_BATCH = 8;
const ZONE_BACKOFF_MIN_MS = 5_000;
const ZONE_BACKOFF_MAX_MS = 5 * 60_000;
const DEFAULT_FILL_OPACITY = 0.25;
const DEFAULT_MIN_SEVERITY: Severity = 'Minor';

// Persistent zone-shape cache lives in IndexedDB — see src/zone-store.ts
// for the format, compression, bounds, and the rationale for IndexedDB
// over localStorage (the full ~11,600-zone set is far past localStorage's
// shared ~5 MB cap).

// Anchor link to the NWS Watches & Warnings section of docs/overlays.md
// on GitHub. Surfaced after the popup's life-safety disclaimer so users
// can read the full caveat with one click. The hash matches GitHub's
// auto-generated anchor for the "## NWS Watches & Warnings" heading.
const DOCS_ALERTS_URL = 'https://github.com/jpettitt/weather-radar-card/blob/main/docs/overlays.md#nws-watches--warnings';

type Severity = 'Extreme' | 'Severe' | 'Moderate' | 'Minor' | 'Unknown';
const SEVERITY_RANK: Record<Severity, number> = {
  Unknown: 0, Minor: 1, Moderate: 2, Severe: 3, Extreme: 4,
};

interface AlertProps {
  id?: string;
  event?: string;
  severity?: Severity;
  certainty?: string;
  urgency?: string;
  sent?: string;
  effective?: string;
  onset?: string;
  expires?: string;
  ends?: string;
  headline?: string;
  description?: string;
  areaDesc?: string;
  uri?: string | null;
  affectedZones?: string[];
  senderName?: string;
}

type LngLatBounds = NonNullable<ReturnType<typeof geometryLngLatBounds>>;

/** What the host shows in its banner: the alerts list could not be fetched, or some zone shapes did not load. */
export interface AlertsStatus {
  kind: 'fetch' | 'zones';
  failures: number;
  total?: number;
}

// Leaflet's bounds run past ±180 on a map centred near the antimeridian, and
// geometryLngLatBounds answers in a 0..360 window for a shape that crosses
// it (the far Aleutians), so the box is tried in all three longitude
// windows. A false "visible" only costs a polygon; a false "hidden" would
// drop a warning from the map.
function boundsIntersect(
  b: LngLatBounds,
  view: { getWest(): number; getEast(): number; getSouth(): number; getNorth(): number },
): boolean {
  if (b.maxLat < view.getSouth() || b.minLat > view.getNorth()) return false;
  for (const shift of [0, -360, 360]) {
    if (b.maxLng + shift >= view.getWest() && b.minLng + shift <= view.getEast()) return true;
  }
  return false;
}

export class NwsAlertsLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;

  private _polygonLayer: L.GeoJSON | null = null;
  // Filtered alerts — both polygon-bearing AND zone-only. Zone-only alerts
  // become renderable once their affectedZones URLs are resolved into the
  // _zoneCache below.
  private _features: GeoJSON.Feature[] = [];
  // Per-feature render decision keyed by feature.id (NWS-provided URL).
  // Compared on each _render() call; if unchanged, we skip the rebuild,
  // preserving any open popup. See "Lessons from the wildfire build" in the
  // alerts design doc — same trap that closed wildfire popups every hass tick.
  // For zone-resolved alerts the decision string includes the count of
  // zones currently loaded, so a fresh zone arrival re-renders just enough.
  private _renderDecisions: Map<string, string> = new Map();
  // Keys of the alerts the last render left out of view, for _zoneQueue.
  // Kept apart from the decision string: reading it from the string's
  // tail broke when `|z<lod>` was appended, and every alert counted as
  // in view.
  private _hidden = new Set<string>();
  // Zone-shape cache. Persists across refresh cycles for the lifetime of
  // the layer instance — zones change rarely (monthly at most), so a single
  // fetch per zone per session covers the typical user.
  private _zoneCache: Map<string, GeoJSON.Geometry> = new Map();
  // In-flight zone fetches, keyed by URL. Used to dedupe concurrent
  // requests for the same zone across multiple alerts.
  private _zoneFetches: Map<string, Promise<void>> = new Map();
  private _timer: ReturnType<typeof setTimeout> | null = null;
  // Set in pause(), cleared in resume(). When non-null we're paused —
  // timer is cancelled, zone-fetches in flight will still complete but
  // their re-render result becomes a no-op (skipIfDecisionsUnchanged).
  // Used by resume() to decide whether to refetch immediately.
  private _pausedAt: number | null = null;
  private _gen = 0;
  // Consecutive _fetch failures. Drives the retry backoff below; reset
  // to 0 on any successful fetch.
  private _failureCount = 0;
  // Cancellation for the alerts-list fetch (set per _fetch call) and the
  // per-zone fetches (single shared controller — they all become stale
  // together when the layer tears down or the alert list is replaced).
  // The gen check already discards stale responses; aborting just stops
  // the wire bandwidth too.
  private _abortCtrl: AbortController | null = null;
  private _zoneAbortCtrl: AbortController | null = null;
  // Zone pool state: current concurrency, the backoff in force after a
  // block (0 = none) and when it ends, its timer, and whether a batch is
  // draining (a _resolveZones call meanwhile asks for a re-plan after it).
  private _zonePool = ZONE_POOL_SIZE;
  private _zoneBackoffMs = 0;
  private _zoneBackoffUntil = 0;
  private _zoneRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private _zoneBatchRunning = false;
  private _zoneReplan = false;
  // Lng/lat bounds per cached zone and per inline-geometry feature, so the
  // view test in _renderInner never walks a vertex.
  private _zoneBounds: Map<string, LngLatBounds> = new Map();
  private _featureBounds: Map<string, LngLatBounds | null> = new Map();
  // Coarser copies of cached zones per integer zoom, built on first use
  // (simplifyToleranceForZoom); zoom 9 and up draw the cached outline.
  private _zoneLod: Map<string, Map<number, GeoJSON.Geometry>> = new Map();
  // A view change while a popup is open defers its re-render to popupclose:
  // the rebuild would close the popup the user is reading.
  private _renderAfterPopup = false;
  private _onStatus: ((status: AlertsStatus | null) => void) | undefined;
  private _lastStatusKey = '';
  private _disposeQuiet: (() => void) | null = null;
  // True from movestart/zoomstart until the map has been still for a second.
  private _mapBusy = false;
  private _quietWaiters: Array<() => void> = [];
  private _kv: ZoneKV = defaultZoneKV();
  private _timesCache = new WeakMap<GeoJSON.Feature, { over: number; inForce: number; sent: number }>();
  // Cached zones read from an older-format record, to write back with the
  // record's own time so the TTL is unchanged (see ZONE_FORMAT).
  private _writeBack: Array<{ url: string; ts: number }> = [];
  private _writeBackRunning = false;

  constructor(
    map: L.Map,
    getConfig: () => WeatherRadarCardConfig,
    hass?: HomeAssistant,
    onStatus?: (status: AlertsStatus | null) => void,
  ) {
    this._map = map;
    this._getConfig = getConfig;
    this._hass = hass;
    this._onStatus = onStatus;
  }

  start(): void {
    // Prune expired/over-cap IndexedDB zones and purge the legacy
    // localStorage caches once per layer start. Fire-and-forget — the
    // sweep never blocks rendering and its failures are swallowed.
    void sweepZones(this._kv, Date.now());
    // While the map moves the layer is idle: no render from any source (a
    // hass tick, a refresh, zones arriving) and no zone request starts.
    // Everything resumes once the map has been still for a second (see
    // map-quiet.ts). A pinch on an iPhone still crashed Safari with this
    // layer on and nothing in view, often before that second was up
    // (2026-10-16): what ran during the gesture was the zone pool's
    // decode, simplify and IndexedDB writes, and renders on hass ticks.
    this._map.on('movestart zoomstart', this._onMapBusy);
    this._disposeQuiet = onMapQuiet(this._map, this._onMapQuiet);
    this._map.on('resize', this._onViewChange);
    void this._fetch();
  }

  clear(): void {
    this._gen++;   // invalidates any in-flight WFIGS / zone fetches
    this._abortCtrl?.abort();
    this._abortCtrl = null;
    this._zoneAbortCtrl?.abort();
    this._zoneAbortCtrl = null;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._polygonLayer) { this._map.removeLayer(this._polygonLayer); this._polygonLayer = null; }
    // The shared canvas renderer is deliberately NOT removed — the
    // wildfire layer may still be drawing through it (map-lifetime,
    // see shared-canvas-renderer.ts).
    this._features = [];
    this._renderDecisions.clear();
    this._hidden.clear();
    this._zoneCache.clear();
    this._zoneFetches.clear();
    this._zoneBounds.clear();
    this._featureBounds.clear();
    this._zoneLod.clear();
    this._renderAfterPopup = false;
    if (this._zoneRetryTimer) { clearTimeout(this._zoneRetryTimer); this._zoneRetryTimer = null; }
    this._zoneBackoffMs = 0;
    this._zoneBackoffUntil = 0;
    this._zonePool = ZONE_POOL_SIZE;
    this._zoneReplan = false;
    this._disposeQuiet?.();
    this._disposeQuiet = null;
    this._map.off('movestart zoomstart', this._onMapBusy);
    this._map.off('resize', this._onViewChange);
    this._mapBusy = false;
    this._writeBack = [];
    this._releaseQuietWaiters();
    this._setStatus(null);
  }

  // Stop scheduled fetches while the host card is hidden (off-screen or
  // tab in background). Currently-rendered alerts stay on the map; no
  // new network activity until resume() — unless preload_while_hidden
  // opts out of that, in which case fetches keep running on their
  // normal cadence so the card resumes with fresh data instead of a
  // stale-then-refetch cycle.
  pause(): void {
    if (this._getConfig().preload_while_hidden) return;
    if (this._pausedAt != null) return;
    this._pausedAt = Date.now();
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    // The backoff itself stays; the next _resolveZones re-arms the timer.
    if (this._zoneRetryTimer) { clearTimeout(this._zoneRetryTimer); this._zoneRetryTimer = null; }
  }

  // Resume after a pause. Alerts have a much shorter staleness threshold
  // than wildfires (60 s vs 5 min) — a tornado warning issued while the
  // user was away should appear quickly. If paused longer than the
  // refresh interval, refetch immediately; otherwise just reschedule.
  resume(): void {
    if (this._pausedAt == null) return;
    const pausedMs = Date.now() - this._pausedAt;
    this._pausedAt = null;
    if (pausedMs >= DEFAULT_REFRESH_VISIBLE_MS) {
      void this._fetch();
    } else {
      this._scheduleNext();
    }
  }

  // hass changes don't affect the polygon-vs-polygon decisions (no zoom-
  // dependent rendering for alerts). Re-render with the skip-if-unchanged
  // guard so a no-op tick is truly a no-op and any open popup stays open.
  // The radius_km filter does depend on map centre, but the centre changes
  // via map move events, not hass — and map moves don't trigger this method.
  updateHass(hass: HomeAssistant): void {
    this._hass = hass;
    if (this._features.length === 0 && !this._polygonLayer) return;
    this._render({ skipIfDecisionsUnchanged: true });
  }

  private async _fetch(): Promise<void> {
    const myGen = ++this._gen;
    // Abort any previous alerts-list fetch and the in-flight zone fetches.
    // The new alerts list will trigger a fresh _resolveZones pass on the
    // affected-zones from the new payload; zones for alerts that dropped
    // off the list are no longer interesting.
    this._abortCtrl?.abort();
    this._zoneAbortCtrl?.abort();
    const ctrl = new AbortController();
    this._abortCtrl = ctrl;
    let features: GeoJSON.Feature[] = [];
    try {
      // A time limit rejects with TimeoutError, not AbortError, so a list
      // request that never answers takes the failure path and its backoff.
      const data = await withTimeout(DATA_TIMEOUT_MS, ctrl.signal, async (signal) => {
        const res = await fetch(NWS_ALERTS_URL, { headers: { Accept: 'application/geo+json' }, signal });
        if (!res.ok) throw new Error(`NWS fetch ${res.status}`);
        return await res.json() as GeoJSON.FeatureCollection;
      });
      features = data?.features ?? [];
    } catch (err) {
      // Deliberate cancellation (teardown / superseded). Drop silently;
      // the new fetch is already in flight or the layer is going away.
      if ((err as Error)?.name === 'AbortError') return;
      // Failure: NWS occasionally returns 5xx during outages, and its
      // rate limiter blocks WITHOUT CORS headers — the browser surfaces
      // that as a statusless "TypeError: Failed to fetch". Don't blow
      // away currently-displayed alerts, and DON'T retry on the normal
      // cadence: with alerts displayed that was a 60-second hammer
      // against the very host that's rate-limiting us, which kept the
      // block alive indefinitely (observed live: repeated fetch-failed
      // errors with no recovery). Exponential backoff instead — first
      // retry stays quick for blips, persistent blocks back off to a
      // 30-minute cap. Reset on success.
      console.warn('NWS alerts: fetch failed', err);
      this._failureCount++;
      this._setStatus({ kind: 'fetch', failures: this._failureCount });
      this._scheduleRetry();
      // The zone batch was aborted above, before the list was known; the
      // alerts kept on screen still need their shapes.
      void this._resolveZones();
      return;
    }
    if (myGen !== this._gen) return;   // stale
    if (this._abortCtrl === ctrl) this._abortCtrl = null;
    this._failureCount = 0;
    if (this._lastStatusKey.startsWith('fetch')) this._setStatus(null);
    this._featureBounds = new Map();

    // Filter, then sort lexicographically by (severity, urgency,
    // certainty) so the most actionable alerts paint last and end up
    // on top of the visual stack. Sort once here, not per render —
    // the order is stable until the next _fetch().
    try {
      this._features = this._filter(features).sort(paintOrderAscending);
    } catch (err) {
      // Keep the alerts on screen and the refresh chain alive, as _render
      // does for its own failures; nothing after the await catches for us.
      console.warn('NWS alerts: filter failed', err);
    }
    // Render polygon-bearing alerts immediately for snappy first paint;
    // zone-only alerts will fill in progressively as their geometry arrives.
    // Skip when nothing changed: a rebuild closes an open popup, and on the
    // 60 s cadence that cut reads short. An updated alert has a new id, so
    // it still redraws.
    this._render({ skipIfDecisionsUnchanged: true });
    this._scheduleNext();
    // Kick off zone resolution in the background — re-renders the layer
    // once each batch of zone fetches completes, picking up newly-cached
    // geometry. Doesn't await; lets the next refresh cycle run on time.
    void this._resolveZones();
  }

  // Fetch any zone shape we don't already have cached for an alert in
  // _features, all at once (api.weather.gov is HTTP/2, so the browser does
  // not cap this at ~6; a cold cache can mean hundreds). Re-renders when
  // the batch settles, and logs one error summarising any failures.
  private async _resolveZones(): Promise<void> {
    if (this._zoneBatchRunning) { this._zoneReplan = true; return; }
    if (Date.now() < this._zoneBackoffUntil) { this._armZoneRetry(); return; }
    const myGen = this._gen;
    const queue = this._zoneQueue();
    if (queue.length === 0) {
      // Nothing is missing any more, so drop a "zones did not load" status
      // whose alerts left the list. A re-planned batch also ends here: draw
      // the shapes it read from disk after the refresh's own render, and
      // write back the older records among them.
      if (this._lastStatusKey.startsWith('zones')) this._setStatus(null);
      this._zonesSettled();
      return;
    }

    // Shared controller for this batch — a fresh _fetch() that
    // supersedes the current alerts list aborts the entire in-flight
    // zone batch in one go (it's the new feature list that decides
    // which zones are still relevant).
    const ctrl = new AbortController();
    this._zoneAbortCtrl = ctrl;
    this._zoneBatchRunning = true;

    // _fetchZone self-registers in _zoneFetches as its first action so the
    // entry exists before any sync return path (e.g. a persistent-cache hit)
    // can hit the matching `finally { delete }`. Workers take the next URL
    // each time one settles; a status-less failure (NWS's block) stops them.
    const failures: unknown[] = [];
    let blocked = false;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length && !blocked && !ctrl.signal.aborted) {
        if (this._mapBusy) await this._untilQuiet();
        if (ctrl.signal.aborted) break;
        const url = queue[next++];
        await this._fetchZone(url, ctrl.signal, failures);
        // Any status-less failure so far, not just this worker's: concurrent
        // workers push into the same list.
        if (!blocked && failures.some((e) => e instanceof TypeError)) blocked = true;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this._zonePool, queue.length) }, worker));
    this._zoneBatchRunning = false;
    if (this._zoneReplan) {
      // Refreshed while the batch ran: plan again from the current list.
      this._zoneReplan = false;
      void this._resolveZones();
      return;
    }
    if (myGen !== this._gen) return;   // stale (cleared / reconfigured during the fetch)
    if (this._zoneAbortCtrl === ctrl) this._zoneAbortCtrl = null;

    const missing = failures.length + (queue.length - next);
    if (blocked) {
      this._zonePool = Math.max(ZONE_POOL_MIN, Math.floor(this._zonePool / 2));
      this._zoneBackoffMs = this._zoneBackoffMs ? Math.min(this._zoneBackoffMs * 2, ZONE_BACKOFF_MAX_MS) : ZONE_BACKOFF_MIN_MS;
      this._zoneBackoffUntil = Date.now() + this._zoneBackoffMs;
      this._armZoneRetry();
    } else if (missing < queue.length) {
      // Shapes arrived, so the address is not blocked: full speed again.
      this._zonePool = ZONE_POOL_SIZE;
      this._zoneBackoffMs = 0;
    }
    if (missing > 0) {
      // One line per batch, not per zone.
      console.error(
        `NWS alerts: ${missing} of ${queue.length} zone requests failed`
        + (blocked ? ` (status-less: NWS is rate-limiting this address; next try in ${Math.round(this._zoneBackoffMs / 1000)} s, ${this._zonePool} at a time)` : '')
        + '; those alerts stay without shapes until the next try.',
        failures[0],
      );
      this._setStatus({ kind: 'zones', failures: missing, total: queue.length });
    } else if (this._lastStatusKey.startsWith('zones')) {
      this._setStatus(null);
    }

    this._zonesSettled();
  }

  // After zone shapes arrived: re-apply alerts_radius_km, which _filter
  // could not judge for a zone alert without shapes, then redraw. Skip-if-
  // unchanged applies: only alerts whose zones arrived flip their decision.
  private _zonesSettled(): void {
    if (this._getConfig().alerts_radius_km) {
      try {
        this._features = this._filter(this._features);
      } catch (err) {
        console.warn('NWS alerts: filter failed', err);
      }
    }
    this._render({ skipIfDecisionsUnchanged: true });
    void this._drainWriteBack();
  }

  // Rewrite older-format stored zones with the cached (current) geometry, a
  // few per idle slice. Not during a zone batch: the next batch's end
  // starts it again. Not while the map moves.
  private async _drainWriteBack(): Promise<void> {
    if (this._writeBackRunning) return;
    this._writeBackRunning = true;
    try {
      while (this._writeBack.length > 0 && !this._zoneBatchRunning) {
        await idle();
        if (this._mapBusy) await this._untilQuiet();
        if (this._zoneBatchRunning) break;
        for (const { url, ts } of this._writeBack.splice(0, WRITE_BACK_BATCH)) {
          const geom = this._zoneCache.get(url);
          if (geom && geom !== NO_SHAPE) await writeZone(this._kv, url, geom, ts);
        }
      }
    } finally {
      this._writeBackRunning = false;
    }
  }

  // An alert's times, parsed once per feature object (renders run on hass
  // ticks): over (alertOverAt), in force (alertInForceAt) and sent.
  private _times(f: GeoJSON.Feature): { over: number; inForce: number; sent: number } {
    let t = this._timesCache.get(f);
    if (!t) {
      const p = f.properties as AlertProps | null;
      const sent = p?.sent ? Date.parse(p.sent) : NaN;
      t = { over: alertOverAt(p), inForce: alertInForceAt(p), sent: Number.isNaN(sent) ? -Infinity : sent };
      this._timesCache.set(f, t);
    }
    return t;
  }

  private _overAt(f: GeoJSON.Feature): number {
    return this._times(f).over;
  }

  // Zones still to fetch, most severe alert first and alerts in view before
  // the hidden ones (whose shapes are not drawn until they scroll in).
  private _zoneQueue(): string[] {
    const first: string[] = [];
    const later: string[] = [];
    const seen = new Set<string>();
    const now = Date.now();
    for (let i = this._features.length - 1; i >= 0; i--) {
      const f = this._features[i];
      if (f.geometry) continue;   // has its own geometry; no zones needed
      if (this._overAt(f) <= now) continue;
      const hidden = this._hidden.has(featureKey(f));
      for (const url of (f.properties as AlertProps | null)?.affectedZones ?? []) {
        if (seen.has(url) || this._zoneCache.has(url) || this._zoneFetches.has(url)) continue;
        seen.add(url);
        (hidden ? later : first).push(url);
      }
    }
    return first.concat(later);
  }

  private _armZoneRetry(): void {
    if (this._zoneRetryTimer) return;
    const wait = Math.max(0, this._zoneBackoffUntil - Date.now());
    this._zoneRetryTimer = setTimeout(() => {
      this._zoneRetryTimer = null;
      void this._resolveZones();
    }, wait);
  }

  private async _fetchZone(url: string, signal: AbortSignal, failures: unknown[] = []): Promise<void> {
    // Self-register so concurrent callers dedupe. Registration must happen
    // BEFORE the persistent-cache early-return path so the matching `finally
    // { delete }` always pairs with a real entry, never a stale one. If
    // we're already in flight for this URL, await the existing promise
    // instead of starting a new request.
    const existing = this._zoneFetches.get(url);
    if (existing) return existing;
    let resolveOuter!: () => void;
    const outer = new Promise<void>((r) => { resolveOuter = r; });
    this._zoneFetches.set(url, outer);
    try {
      // Persistent-cache (IndexedDB) hit short-circuits the network request — saves a
      // round-trip per zone for users who've previously viewed alerts in
      // the same area. First session pays the network cost; subsequent
      // sessions read from disk.
      const cached = await readZoneEntry(this._kv, url, Date.now());
      if (cached) {
        this._cacheZone(url, cached.geom);
        if (!cached.current) this._writeBack.push({ url, ts: cached.ts });
        return;
      }
      const myGen = this._gen;
      // A zone that never answers held its worker, and the batch, forever.
      const data = await withTimeout(DATA_TIMEOUT_MS, signal, async (sig) => {
        const res = await fetch(url, { headers: { Accept: 'application/geo+json' }, signal: sig });
        if (!res.ok) throw new Error(`zone fetch ${res.status}`);
        return res.json();
      });
      if (myGen !== this._gen) return;
      const geom = normalizeZoneGeometry(data?.geometry);
      if (geom) {
        const stored = this._cacheZone(url, geom);
        // Not awaited: the pool limits requests to NWS, and the gzip and
        // IndexedDB write are not one. Holding the slot for them tied the
        // next request to the disk (slow on a phone) and, in tests, to
        // thread-pool time that fake timers do not advance (CI, 2026-10-17).
        // writeZone never rejects.
        void writeZone(this._kv, url, stored, Date.now());
      } else {
        // No shape (administrative entries): remember that for the session
        // so the zone is not requested again every refresh, but don't
        // persist it, in case NWS adds one.
        this._zoneCache.set(url, NO_SHAPE);
      }
    } catch (err) {
      // Deliberate cancellation — alert list was replaced; new
      // _resolveZones pass will refetch any still-relevant zones.
      if ((err as Error)?.name === 'AbortError') return;
      // Per-zone failures happen (404s on retired zones, blips); the
      // alert's other zones may still resolve. _resolveZones logs them.
      failures.push(err);
    } finally {
      this._zoneFetches.delete(url);
      resolveOuter();
    }
  }

  private _filter(all: GeoJSON.Feature[]): GeoJSON.Feature[] {
    const cfg = this._getConfig();
    const minSev = (cfg.alerts_min_severity ?? DEFAULT_MIN_SEVERITY) as Severity;
    const minRank = SEVERITY_RANK[minSev] ?? SEVERITY_RANK.Minor;
    const radiusKm = cfg.alerts_radius_km;
    const centre = radiusKm ? this._map.getCenter() : null;

    // Resolve the active type allowlist. Explicit alerts_types (when
    // present and non-empty) overrides alerts_categories; otherwise we
    // resolve the category set via the shared helper (which correctly
    // distinguishes "undefined → defaults" from "empty array → none").
    const explicitTypes = cfg.alerts_types && cfg.alerts_types.length > 0
      ? new Set(cfg.alerts_types) : null;
    const activeCategories = getActiveAlertCategories(cfg.alerts_categories);
    const now = Date.now();

    return all.filter((f) => {
      // Keep both polygon-bearing and zone-only alerts. Zone-only ones are
      // resolved into geometry asynchronously by _resolveZones() and
      // become renderable on a subsequent _render() pass.
      const props = f.properties as AlertProps | null;
      const hasZones = (props?.affectedZones?.length ?? 0) > 0;
      if (!f.geometry && !hasZones) return false;

      // Past its expiry: alerts/active still lists it (see alertOverAt).
      if (alertOverAt(props) <= now) return false;

      // Severity floor
      const sev = (props?.severity ?? 'Unknown') as Severity;
      if ((SEVERITY_RANK[sev] ?? 0) < minRank) return false;

      // Type / category allowlist
      const event = props?.event;
      if (explicitTypes) {
        if (!event || !explicitTypes.has(event)) return false;
      } else {
        if (!activeCategories.has(categoryForEvent(event))) return false;
      }

      // Radius from map centre. For zone-only alerts whose zones haven't
      // resolved yet we can't compute a centroid — keep the alert in the
      // filter set; it is re-evaluated when its zones arrive
      // (_zonesSettled). Letting it through is safer than dropping it (a far-away
      // alert just won't find geometry in the cache and rendered as null).
      if (radiusKm && centre) {
        const geom = f.geometry ?? this._geometryFromZones(props?.affectedZones ?? []);
        if (geom) {
          const c = centroidLngLat(geom);
          if (c) {
            const distKm = haversineKm(centre.lat, centre.lng, c[1], c[0]);
            if (distKm > radiusKm) return false;
          }
        }
      }

      return true;
    });
  }

  // The cached zone outline at the drawing tolerance for `zoom`, or the
  // outline itself when that tolerance is no coarser than the stored one.
  private _zoneAtZoom(url: string, zoom: number | undefined): GeoJSON.Geometry | undefined {
    const base = this._zoneCache.get(url);
    if (!base || zoom === undefined) return base;
    const tol = simplifyToleranceForZoom(zoom);
    if (tol <= SIMPLIFY_TOLERANCE_DEG) return base;
    const key = Math.round(zoom);
    let perZoom = this._zoneLod.get(url);
    if (!perZoom) { perZoom = new Map(); this._zoneLod.set(url, perZoom); }
    let g = perZoom.get(key);
    if (!g) { g = simplifyGeometry(base, tol); perZoom.set(key, g); }
    return g;
  }

  // Build a synthetic MultiPolygon from whatever zone shapes are currently
  // in the cache. Zones still being fetched are silently omitted — the
  // _renderInner pass picks them up on a subsequent re-render once they
  // arrive. Returns null if no zones are cached yet. With `zoom`, the
  // shapes come at that zoom's drawing tolerance.
  private _geometryFromZones(zoneUrls: string[], zoom?: number): GeoJSON.MultiPolygon | null {
    const polys: GeoJSON.Position[][][] = [];
    for (const url of zoneUrls) {
      const g = this._zoneAtZoom(url, zoom);
      if (!g) continue;
      if (g.type === 'Polygon') {
        polys.push(g.coordinates);
      } else if (g.type === 'MultiPolygon') {
        for (const p of g.coordinates) polys.push(p);
      }
    }
    if (polys.length === 0) return null;
    return { type: 'MultiPolygon', coordinates: polys };
  }

  private _render(opts?: { skipIfDecisionsUnchanged?: boolean }): void {
    // Not while the map moves: the quiet callback renders, and the
    // decision diff finds whatever changed meanwhile.
    if (this._mapBusy) return;
    // Not while an alert popup is open, from any caller: a rebuild removes
    // the layer and its popup. Only view changes waited; after a tall
    // popup's auto-pan the next hass tick saw 21 alerts change visibility
    // and closed the popup about a second after it opened (2026-10-17).
    // popupclose runs the deferred render.
    if (this._popupOpen()) {
      this._renderAfterPopup = true;
      return;
    }
    try {
      this._renderInner(opts);
    } catch (err) {
      // Catch-all so a render exception can never escape into the host
      // card's Lit lifecycle. Same protection the wildfire layer carries.
      console.warn('NWS alerts: render failed', err);
    }
  }

  private _renderInner(opts?: { skipIfDecisionsUnchanged?: boolean }): void {
    if (!this._map) return;
    const cfg = this._getConfig();
    const fillOpacity = cfg.alerts_fill_opacity ?? DEFAULT_FILL_OPACITY;

    // _features is already sorted severity-ascending by _fetch (see there).
    // Materialise the renderable feature set: features get their inline
    // geometry where present, otherwise a synthetic MultiPolygon built
    // from cached zone shapes. Features whose zones haven't arrived yet
    // are excluded from this render but stay in _features so they pick
    // up geometry on the next render when zones land.
    // Only shapes that touch the padded view are built: at zoom 9 that was 7
    // of 572 polygons (2026-10-16), and Leaflet re-projects every vertex of
    // every built polygon on each zoom. The decision string carries the
    // visibility, so a view change that moves shapes in or out re-renders
    // and one that doesn't is a no-op.
    const view = this._viewBounds();
    // Drawing tolerance follows the zoom (simplifyToleranceForZoom); the
    // decision string carries the zoom so a zoom across levels redraws.
    const zoom = this._map.getZoom();
    const lod = Math.round(zoom);
    const tol = simplifyToleranceForZoom(zoom);
    const newDecisions = new Map<string, string>();
    const hidden = new Set<string>();
    // Visible alerts to build, by index in _features (paint order): inline
    // polygons one by one, zone alerts grouped by event (see below).
    const inline: number[] = [];
    const byEvent = new Map<string, number[]>();
    const now = Date.now();
    for (let fi = 0; fi < this._features.length; fi++) {
      const f = this._features[fi];
      const key = featureKey(f);
      const props = f.properties as AlertProps | null;
      // Expired since the last fetch, which can fail for minutes: gone at
      // the next render (no decision, so the layer rebuilds without it).
      if (this._overAt(f) <= now) continue;

      const geom: GeoJSON.Geometry | null = f.geometry ?? null;
      let bounds: LngLatBounds | null = null;
      let zonesLoaded = 0;
      let zonesTotal = 0;
      const zones = geom ? [] : props?.affectedZones ?? [];
      if (geom) {
        bounds = this._inlineBounds(key, geom);
      } else {
        zonesTotal = zones.length;
        // Count how many zones contributed — for the decision string.
        zonesLoaded = zones.filter((u) => this._zoneCache.has(u)).length;
        bounds = this._zonesBounds(zones);
      }
      const visible = !view || !bounds || boundsIntersect(bounds, view);

      // Decision captures everything that affects this feature's render:
      // event (colour), severity (z-order), either "polygon" for inline
      // geometry or "zones:N/M" for zone-derived, and whether it is in
      // view. When more zones arrive the count rises, the decision flips,
      // and we re-render.
      const geomTag = f.geometry ? 'polygon' : `zones:${zonesLoaded}/${zonesTotal}`;
      // `|p` while the alert is not in force yet: replacement on a zone
      // (below) depends on it, so the switch to in force must rebuild.
      const pending = this._times(f).inForce > now ? '|p' : '';
      newDecisions.set(key, `${props?.event ?? ''}|${props?.severity ?? ''}|${geomTag}|${visible ? 'v' : 'h'}|z${lod}${pending}`);

      if (!visible) { hidden.add(key); continue; }
      if (geom) inline.push(fi);
      else if (zonesLoaded > 0) {
        const event = props?.event ?? '';
        const list = byEvent.get(event);
        if (list) list.push(fi); else byEvent.set(event, [fi]);
      }
      // zone-only with nothing in cache yet: skipped until its zones land
    }

    if (opts?.skipIfDecisionsUnchanged && decisionsEqual(this._renderDecisions, newDecisions)) {
      return;
    }
    this._renderDecisions = newDecisions;
    this._hidden = hidden;

    // Features carry the original alert's id and properties so the popup
    // and style pick up its metadata; `alerts` is what the popup lists.
    const built: Array<{ order: number; feature: GeoJSON.Feature; alerts: Array<AlertProps | null> }> = [];
    for (const fi of inline) {
      const f = this._features[fi];
      built.push({
        order: fi,
        // inline storm polygons: small, simplified per render
        feature: { type: 'Feature', id: f.id, properties: f.properties, geometry: simplifyGeometry(f.geometry!, tol) },
        alerts: [f.properties as AlertProps | null],
      });
    }
    // Each zone is drawn once per event. Overlapping alerts of one event
    // (49 Small Craft Advisories from one office sharing zones, 2026-10-17)
    // drew a zone two to four times, and a click opened only the topmost
    // alert. Zones are grouped by the set of alerts that cover them: one
    // feature per group, whose popup lists every alert in it. An event with
    // one alert gives the same single feature as before.
    for (const list of byEvent.values()) {
      const cover = new Map<string, number[]>();   // zone url -> positions in list
      list.forEach((fi, i) => {
        for (const url of (this._features[fi].properties as AlertProps | null)?.affectedZones ?? []) {
          if (!this._zoneCache.has(url)) continue;
          const c = cover.get(url);
          if (!c) cover.set(url, [i]);
          else if (c[c.length - 1] !== i) c.push(i);   // a zone listed twice in one alert
        }
      });
      // On a zone, an alert of this event is replaced by a later-issued one
      // that is already in force: Juneau's Small Craft Advisory issued at
      // 3:43 AM, in force at 4:43, still showed under the one issued at
      // 9:36 PM the day before (2026-10-17). A later one not yet in force
      // is listed with the current one until it starts. NWS's event numbers
      // (VTEC) differed in all 18 such overlaps, so they cannot link them.
      for (const [url, members] of cover) {
        if (members.length < 2) continue;
        let latest = -Infinity;
        for (const i of members) {
          const tm = this._times(this._features[list[i]]);
          if (tm.inForce <= now && tm.sent > latest) latest = tm.sent;
        }
        if (latest === -Infinity) continue;
        const kept = members.filter((i) => this._times(this._features[list[i]]).sent >= latest);
        if (kept.length < members.length) cover.set(url, kept);
      }
      const groups = new Map<string, { members: number[]; zones: string[] }>();
      for (const [url, members] of cover) {
        const sig = members.join(',');
        const g = groups.get(sig);
        if (g) g.zones.push(url); else groups.set(sig, { members, zones: [url] });
      }
      for (const { members, zones } of groups.values()) {
        const geometry = this._geometryFromZones(zones, zoom);
        if (!geometry) continue;
        const top = this._features[list[members[members.length - 1]]];   // most severe: last in paint order
        built.push({
          order: list[members[members.length - 1]],
          feature: {
            type: 'Feature',
            id: members.length === 1 ? top.id : members.map((i) => featureKey(this._features[list[i]])).join('+'),
            properties: top.properties,
            geometry,
          },
          alerts: members.slice().reverse().map((i) => this._features[list[i]].properties as AlertProps | null),
        });
      }
    }
    built.sort((a, b) => a.order - b.order);   // stable: paint order, most severe on top
    const renderable = built.map((b) => b.feature);
    const alertsOf = new Map(built.map((b) => [b.feature, b.alerts]));

    if (this._polygonLayer) {
      this._map.removeLayer(this._polygonLayer);
      this._polygonLayer = null;
    }

    if (renderable.length === 0) return;

    // Canvas instead of one SVG node per polygon ring — alert outbreaks
    // routinely carry hundreds of multi-ring zone shapes, and the
    // per-node DOM cost is what makes pan/zoom heavy. MUST be the
    // map-shared renderer, never a private L.canvas() — see
    // shared-canvas-renderer.ts for why stacked canvas renderers
    // swallow each other's clicks. Popup wiring is unchanged: the
    // canvas renderer does its own hit-testing.
    // The cast: `renderer` is a real option here — GeoJSON forwards its
    // whole options bag to every child Path via geometryToLayer — but
    // @types/leaflet's GeoJSONOptions doesn't declare it.
    this._polygonLayer = L.geoJSON(renderable, {
      renderer: sharedCanvasRenderer(this._map),
      style: (feature) => {
        const event = (feature?.properties as AlertProps | null)?.event;
        const colour = colorForEvent(event);
        return { color: colour, weight: 1.5, fillColor: colour, fillOpacity };
      },
      onEachFeature: (feature, layer) => {
        // autoPan defaults to true — when an off-edge popup opens, Leaflet
        // pans the map so it's fully visible inside the card. autoPanPadding
        // adds a small inset so the popup never butts right against the card
        // edge (looks awkward). maxHeight caps the popup at 80% of the map
        // height so a long alert description never spills outside the card;
        // Leaflet adds an internal scrollbar past the cap.
        const alerts = alertsOf.get(feature) ?? [feature.properties as AlertProps | null];
        // Built when opened: building every popup made up ~73% of a
        // 450-alert rebuild. Leaflet calls this before it lays the popup
        // out, so the cap also follows the map's size at that moment.
        layer.bindPopup(() => {
          const popup = layer.getPopup();
          if (popup) popup.options.maxHeight = this._popupMaxHeight();
          return buildGroupPopupHtml(alerts, this._hass?.locale);
        }, { autoPan: true, autoPanPadding: [12, 12] });
      },
    } as L.GeoJSONOptions);
    this._polygonLayer.addTo(this._map);
    // Under the fire perimeters on the shared canvas, whichever layer
    // rebuilt last, so a fire inside an alert zone stays tappable. In
    // reverse, so the alerts keep their severity order.
    const paths = this._polygonLayer.getLayers() as L.Path[];
    for (let i = paths.length - 1; i >= 0; i--) paths[i].bringToBack();
    this._polygonLayer.on('popupclose', this._onPopupClose);
  }

  /** 80% of the current map height, floored at 200 px so a tiny / not-yet-sized map still produces a usable popup. */
  private _popupMaxHeight(): number {
    return Math.max(200, Math.floor(this._map.getSize().y * 0.8));
  }

  // The view the canvas renderer draws (padding 0.5 = half a viewport past
  // each edge), or null for a map without a size yet (hidden card, editor
  // preview before layout): then everything counts as visible.
  private _viewBounds(): L.LatLngBounds | null {
    const size = this._map.getSize();
    if (!size.x || !size.y) return null;
    return this._map.getBounds().pad(0.5);
  }

  private _inlineBounds(key: string, geom: GeoJSON.Geometry): LngLatBounds | null {
    let b = this._featureBounds.get(key);
    if (b === undefined) {
      b = geometryLngLatBounds(geom);
      this._featureBounds.set(key, b);
    }
    return b;
  }

  /** Union of the bounds of the zones already cached; null when none are. */
  private _zonesBounds(zoneUrls: string[]): LngLatBounds | null {
    let out: LngLatBounds | null = null;
    for (const url of zoneUrls) {
      const b = this._zoneBounds.get(url);
      if (!b) continue;
      out = out
        ? { minLng: Math.min(out.minLng, b.minLng), minLat: Math.min(out.minLat, b.minLat), maxLng: Math.max(out.maxLng, b.maxLng), maxLat: Math.max(out.maxLat, b.maxLat) }
        : { ...b };
    }
    return out;
  }

  // Every zone enters the cache simplified (see SIMPLIFY_TOLERANCE_DEG), from
  // the network and from disk alike, so an entry written before this
  // existed is cut down on read too. Returns what went in, for writeZone.
  private _cacheZone(url: string, geom: GeoJSON.Geometry): GeoJSON.Geometry {
    const simplified = simplifyGeometry(geom);
    this._zoneCache.set(url, simplified);
    this._zoneLod.delete(url);
    const b = geometryLngLatBounds(simplified);
    if (b) this._zoneBounds.set(url, b);
    return simplified;
  }

  private _onViewChange = (): void => {
    // With polygons still drawn, an empty list must render: an empty
    // refresh that landed during a gesture deferred their removal to here.
    if (this._features.length === 0 && !this._polygonLayer) return;
    this._render({ skipIfDecisionsUnchanged: true });   // waits for an open popup (see _render)
  };

  private _onMapBusy = (): void => {
    this._mapBusy = true;
  };

  // The map has been still for a second: render for the new view and let
  // the zone workers go on.
  private _onMapQuiet = (): void => {
    this._mapBusy = false;
    this._releaseQuietWaiters();
    this._onViewChange();
  };

  private _untilQuiet(): Promise<void> {
    return new Promise((resolve) => { this._quietWaiters.push(resolve); });
  }

  private _releaseQuietWaiters(): void {
    const waiters = this._quietWaiters;
    this._quietWaiters = [];
    for (const w of waiters) w();
  }

  private _onPopupClose = (): void => {
    if (!this._renderAfterPopup) return;
    // Leaflet fires popupclose from the popup's onRemove, while the popup
    // is still on the map, so _popupOpen() is still true here and _render
    // would defer again, forever. Render once the close has finished; if
    // the close was another alert popup opening, _render defers again.
    queueMicrotask(() => {
      if (!this._renderAfterPopup) return;
      this._renderAfterPopup = false;
      this._render({ skipIfDecisionsUnchanged: true });
    });
  };

  private _popupOpen(): boolean {
    return this._polygonLayer?.getLayers().some((l) => (l as L.Layer).isPopupOpen?.()) ?? false;
  }

  // One callback per change of state, so the host's banner toggles once.
  private _setStatus(status: AlertsStatus | null): void {
    const key = status ? `${status.kind}:${status.failures}` : '';
    if (key === this._lastStatusKey) return;
    this._lastStatusKey = key;
    this._onStatus?.(status);
  }

  /** Backoff delay for the Nth consecutive failure (1-based). */
  private _retryDelayMs(failures: number): number {
    const base = 60_000;                       // first retry: quick (blip)
    const capped = Math.min(failures - 1, 10); // avoid 2**huge
    return Math.min(base * 2 ** capped, 30 * 60_000);
  }

  // Failure-path counterpart of _scheduleNext: same paused guard, but
  // the delay ladder is driven by consecutive failures instead of the
  // normal refresh cadence.
  private _scheduleRetry(): void {
    if (this._pausedAt != null) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => void this._fetch(), this._retryDelayMs(this._failureCount));
  }

  private _scheduleNext(): void {
    // Paused → don't re-arm. pause() only cancels the ARMED timer; a
    // fetch that was already in flight when pause() ran (the 60 s
    // alerts cadence makes that window frequent) completes and its
    // tail calls _scheduleNext — without this guard that re-armed the
    // chain and the layer kept polling api.weather.gov at full cadence
    // for as long as the card stayed hidden. resume() decides between
    // an immediate refetch and a reschedule, so dropping the re-arm
    // here is safe.
    if (this._pausedAt != null) return;
    if (this._timer) clearTimeout(this._timer);
    const cfg = this._getConfig();
    const intervalMs = refreshOverrideMs(cfg.alerts_refresh_seconds, 1000, MIN_REFRESH_MS)
      ?? (this._features.length > 0 ? DEFAULT_REFRESH_VISIBLE_MS : DEFAULT_REFRESH_EMPTY_MS);
    this._timer = setTimeout(() => void this._fetch(), intervalMs);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

// When an alert stops applying: the earlier of `expires` (when its message
// expires; the next issue, if any, is a new alert) and `ends` (when the
// hazard ends). Infinity when NWS gives neither. alerts/active keeps an
// alert until `ends`: 108 of 492 alerts were past `expires` (2026-10-17),
// one Heavy Freezing Spray Warning by five days, and 92 of them were
// covered zone for zone by a newer alert of the same event.
function alertOverAt(props: AlertProps | null): number {
  let t = Infinity;
  for (const s of [props?.expires, props?.ends]) {
    const ms = s ? Date.parse(s) : NaN;
    if (ms < t) t = ms;
  }
  return t;
}

// The `expires` or `ends` text alertOverAt picked, for the popup: it
// showed `expires` while the map dropped the alert at an earlier `ends`.
function alertOverText(props: AlertProps | null): string | undefined {
  let best: string | undefined;
  let t = Infinity;
  for (const s of [props?.expires, props?.ends]) {
    const ms = s ? Date.parse(s) : NaN;
    if (ms < t) { t = ms; best = s; }
  }
  return best ?? props?.expires ?? props?.ends;
}

// When an alert is in force: the later of its message's `effective` time
// and its hazard's `onset`, else `sent`; -Infinity with none of them.
function alertInForceAt(props: AlertProps | null): number {
  let t = -Infinity;
  for (const s of [props?.effective, props?.onset]) {
    const ms = s ? Date.parse(s) : NaN;
    if (ms > t) t = ms;
  }
  if (t === -Infinity && props?.sent) {
    const ms = Date.parse(props.sent);
    if (!Number.isNaN(ms)) t = ms;
  }
  return t;
}

function featureKey(f: GeoJSON.Feature): string {
  // NWS gives every alert a unique URL as feature.id. Always present in
  // practice; fall back to properties.id (a urn:oid:...) just in case.
  if (f.id != null) return String(f.id);
  const p = f.properties as AlertProps | null;
  return p?.id ?? '';
}

// CAP-standard rank tables for the two attributes beyond severity.
// Higher rank = "more important to surface" — so ascending sort
// (lower-rank-first) puts the highest-priority alerts last in the array,
// which means Leaflet paints them on top.
//
// Past sits below Unknown for urgency: "this already happened" is the
// least actionable state, while "we don't know" at least carries some
// possibility. Mirrors NWS field documentation.
type Urgency = 'Past' | 'Unknown' | 'Future' | 'Expected' | 'Immediate';
type Certainty = 'Unknown' | 'Unlikely' | 'Possible' | 'Likely' | 'Observed';

const URGENCY_RANK: Record<Urgency, number> = {
  Past: 0, Unknown: 1, Future: 2, Expected: 3, Immediate: 4,
};
const CERTAINTY_RANK: Record<Certainty, number> = {
  Unknown: 0, Unlikely: 1, Possible: 2, Likely: 3, Observed: 4,
};

// Lexicographic paint-order sort over the three CAP fields NWS attaches
// to every alert. Ascending: lowest-priority paints first (ends up at
// the bottom of the visual stack), highest-priority paints last (ends
// up on top).
//
//   Primary:    severity   (Unknown < Minor < Moderate < Severe < Extreme)
//   Secondary:  urgency    (Past < Unknown < Future < Expected < Immediate)
//   Tertiary:   certainty  (Unknown < Unlikely < Possible < Likely < Observed)
//
// Severity dominates because it's also the user-facing filter axis
// (`alerts_min_severity`). Urgency breaks severity ties — at the same
// "how bad" level, sooner-action-needed wins. Certainty breaks urgency
// ties — same-severity-and-urgency, the more confident alert wins.
//
// Worked examples (within typical Warnings):
//   Tornado Warning Observed         (Extreme, Immediate, Observed)  ← top
//   Tornado Warning Radar-Indicated  (Extreme, Immediate, Likely)
//   Severe T-storm Warning Observed  (Severe,  Immediate, Observed)
//   Severe T-storm Warning Likely    (Severe,  Immediate, Likely)
//   Flash Flood Warning              (Severe,  Expected,  Likely)
//   Wind Advisory Observed           (Moderate, Expected, Observed)
//   Frost Advisory                   (Minor,   Future,    Likely)    ← bottom
//
// Ties on all three fields are extremely rare and would require two
// alerts of identical severity AND urgency AND certainty to overlap on
// screen — at which point the paint order between them is genuinely
// irrelevant.
function paintOrderAscending(a: GeoJSON.Feature, b: GeoJSON.Feature): number {
  const ap = a.properties as AlertProps | null;
  const bp = b.properties as AlertProps | null;

  const sa = SEVERITY_RANK[(ap?.severity ?? 'Unknown') as Severity] ?? 0;
  const sb = SEVERITY_RANK[(bp?.severity ?? 'Unknown') as Severity] ?? 0;
  if (sa !== sb) return sa - sb;

  const ua = URGENCY_RANK[(ap?.urgency ?? 'Unknown') as Urgency] ?? 0;
  const ub = URGENCY_RANK[(bp?.urgency ?? 'Unknown') as Urgency] ?? 0;
  if (ua !== ub) return ua - ub;

  const ca = CERTAINTY_RANK[(ap?.certainty ?? 'Unknown') as Certainty] ?? 0;
  const cb = CERTAINTY_RANK[(bp?.certainty ?? 'Unknown') as Certainty] ?? 0;
  return ca - cb;
}

function alertPopupParts(props: AlertProps | null, locale: FrontendLocaleData | undefined): { body: string; link: string } {
  const event = props?.event ?? localize('ui.alerts.unknown_event');
  const severity = props?.severity ?? '—';
  const certainty = props?.certainty ?? '—';
  const urgency = props?.urgency ?? '—';
  const effective = formatDateTime(props?.effective, locale);
  const expires = formatDateTime(alertOverText(props), locale);
  const headline = props?.headline ?? '';
  // NWS descriptions are free-text bodies of the alert (winds, hail size,
  // location, recommended actions). They preserve their own line breaks —
  // we render with white-space: pre-line so paragraphs read correctly.
  // Truncate generously since the popup is the only place the user sees
  // the full text. Affected-areas is omitted: the user can see the polygon.
  const description = props?.description ?? '';
  const colour = colorForEvent(props?.event);
  // Some NWS palette colours (Yellow, Moccasin, White, …) are too light to
  // read as bold text on the popup's white background. Use the colour only
  // when it has enough contrast; fall back to dark grey otherwise. Picks
  // up new "light" entries automatically if the palette grows.
  const accent = relativeLuminance(colour) < 0.7 ? colour : '#444';

  // properties.uri is sometimes null in practice; fall back to the alerts
  // index page so the link always works (even if it's not as deep). The
  // scheme check blocks javascript: URIs, but does NOT block HTML
  // attribute breakouts — if NWS ever returns a uri containing " or >,
  // we still need to escape it before interpolating into href="…". The
  // escapeHtml(linkUrl) at the call site below handles that.
  const linkUrl = props?.uri && /^https?:\/\//.test(props.uri)
    ? props.uri
    : 'https://www.weather.gov/alerts';

  const body = `
      <div style="font-weight:bold;font-size:13px;margin-bottom:4px;color:${accent}">${escapeHtml(event)}</div>
      ${headline ? `<div style="margin-bottom:6px">${escapeHtml(truncate(headline, 200))}</div>` : ''}
      <div><b>${escapeHtml(localize('ui.alerts.severity'))}:</b> ${escapeHtml(severity)} · <b>${escapeHtml(localize('ui.alerts.certainty'))}:</b> ${escapeHtml(certainty)} · <b>${escapeHtml(localize('ui.alerts.urgency'))}:</b> ${escapeHtml(urgency)}</div>
      <div><b>${escapeHtml(localize('ui.alerts.effective'))}:</b> ${escapeHtml(effective)}</div>
      <div><b>${escapeHtml(localize('ui.alerts.expires'))}:</b> ${escapeHtml(expires)}</div>
      ${description ? `<div style="margin-top:6px;white-space:pre-line;max-height:240px;overflow:auto">${escapeHtml(truncate(description, 1500))}</div>` : ''}`;
  const link = `
      <div style="margin-top:4px"><a href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize('ui.alerts.more_info'))}</a></div>`;
  return { body, link };
}

const POPUP_OPEN = `
    <div style="font:12px/1.4 'Helvetica Neue',Arial,sans-serif;min-width:220px;max-width:320px">`;
const POPUP_CLOSE = `
    </div>
  `;

function disclaimerHtml(): string {
  return `
      <div style="margin-top:6px;font-size:10px;color:#a00;font-weight:bold">${escapeHtml(localize('ui.alerts.disclaimer'))} <a href="${DOCS_ALERTS_URL}" target="_blank" rel="noopener noreferrer" style="color:#a00;text-decoration:underline">${escapeHtml(localize('ui.alerts.see_readme'))}</a>.</div>`;
}

function buildPopupHtml(props: AlertProps | null, locale: FrontendLocaleData | undefined): string {
  const { body, link } = alertPopupParts(props, locale);
  return POPUP_OPEN + body + disclaimerHtml() + link + POPUP_CLOSE;
}

/** Popup for a zone several alerts of one event cover: each alert in
 * turn, most severe first, and the disclaimer once at the end. */
function buildGroupPopupHtml(alerts: Array<AlertProps | null>, locale: FrontendLocaleData | undefined): string {
  if (alerts.length <= 1) return buildPopupHtml(alerts[0] ?? null, locale);
  const parts = alerts.map((p) => { const { body, link } = alertPopupParts(p, locale); return body + link; });
  return POPUP_OPEN + parts.join(`
      <hr style="border:0;border-top:1px solid #ccc;margin:8px 0">`) + disclaimerHtml() + POPUP_CLOSE;
}

// Relative luminance per WCAG (simplified — straight-RGB average rather
// than the full sRGB→linear conversion). Good enough for "is this colour
// too light to read on a white background?" decisions in popup chrome.
// Returns 0..1 where 1 is pure white.
function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0.5;   // unknown format — assume mid-grey
  const r = parseInt(m[1].slice(0, 2), 16) / 255;
  const g = parseInt(m[1].slice(2, 4), 16) / 255;
  const b = parseInt(m[1].slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Defers to HA's own time_format setting (Settings > General) via
// custom-card-helpers' formatDateTime when locale is available — the
// browser's ambient locale is an unreliable signal for 12h/24h
// specifically (see the equivalent note in radar-player.ts's
// _getTimeString). Falls back to the previous browser-locale behaviour
// otherwise.
function formatDateTime(s: string | undefined, locale: FrontendLocaleData | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return locale ? haFormatDateTime(d, locale) : d.toLocaleString();
}

// Re-export for the editor to enumerate available categories without
// importing the categories module directly.
export { ALL_ALERT_CATEGORIES, NWS_ALERT_DEFAULT_COLOR };

// Test-only exports — these are internal implementation details that
// would be `private` in an OOP language. Exposed here so the unit
// tests can exercise them; do not consume from production code paths
// outside this module.
export {
  alertOverAt,
  alertInForceAt,
  featureKey,
  decisionsEqual,
  paintOrderAscending,
  relativeLuminance,
  formatDateTime,
  buildPopupHtml,
  buildGroupPopupHtml,
  boundsIntersect,
};
