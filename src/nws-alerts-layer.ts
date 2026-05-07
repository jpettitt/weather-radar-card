/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { localize } from './localize/localize';
import { colorForEvent, NWS_ALERT_DEFAULT_COLOR } from './nws-alert-colors';
import {
  ALL_ALERT_CATEGORIES, categoryForEvent, getActiveAlertCategories,
} from './nws-alert-categories';
import { centroidLngLat, haversineKm } from './geo-utils';
import { escapeHtml, truncate } from './string-utils';

// NWS public API — see docs/nws-alerts-feature-design.md.
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?status=actual';
// We deliberately do NOT set a User-Agent header from JavaScript even though
// NWS recommends it. User-Agent is on the Fetch spec's "forbidden header"
// list — browsers reject the entire request (TypeError: Failed to fetch)
// rather than silently stripping the header. The browser's own UA gets
// sent automatically, which satisfies NWS's identification requirement.

const DEFAULT_REFRESH_VISIBLE_MS = 60 * 1000;
const DEFAULT_REFRESH_EMPTY_MS = 5 * 60 * 1000;
const DEFAULT_FILL_OPACITY = 0.25;
const DEFAULT_MIN_SEVERITY: Severity = 'Minor';

// Persistent zone-shape cache. NWS forecast zones change at most quarterly
// (and usually less often), so a 30-day TTL is comfortably conservative.
// The v1 suffix lets future format changes invalidate old entries by
// switching to v2 instead of needing a migration path.
const ZONE_LS_KEY_PREFIX = 'wrc-zone-v1:';
const ZONE_LS_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Anchor link to the NWS Watches & Warnings section of docs/overlays.md
// on GitHub. Surfaced after the popup's life-safety disclaimer so users
// can read the full caveat with one click. The hash matches GitHub's
// auto-generated anchor for the "## NWS Watches & Warnings" heading.
const DOCS_ALERTS_URL = 'https://github.com/Makin-Things/weather-radar-card/blob/master/docs/overlays.md#nws-watches--warnings';

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
  effective?: string;
  expires?: string;
  ends?: string;
  headline?: string;
  description?: string;
  areaDesc?: string;
  uri?: string | null;
  affectedZones?: string[];
  senderName?: string;
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

  constructor(
    map: L.Map,
    getConfig: () => WeatherRadarCardConfig,
    hass?: HomeAssistant,
  ) {
    this._map = map;
    this._getConfig = getConfig;
    this._hass = hass;
  }

  start(): void {
    void this._fetch();
  }

  clear(): void {
    this._gen++;   // invalidates any in-flight WFIGS / zone fetches
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._polygonLayer) { this._map.removeLayer(this._polygonLayer); this._polygonLayer = null; }
    this._features = [];
    this._renderDecisions.clear();
    this._zoneCache.clear();
    this._zoneFetches.clear();
  }

  // Stop scheduled fetches while the host card is hidden (off-screen or
  // tab in background). Currently-rendered alerts stay on the map; no
  // new network activity until resume().
  pause(): void {
    if (this._pausedAt != null) return;
    this._pausedAt = Date.now();
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
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
    if (this._features.length === 0) return;
    this._render({ skipIfDecisionsUnchanged: true });
  }

  private async _fetch(): Promise<void> {
    const myGen = ++this._gen;
    let features: GeoJSON.Feature[] = [];
    try {
      const res = await fetch(NWS_ALERTS_URL, { headers: { Accept: 'application/geo+json' } });
      if (!res.ok) throw new Error(`NWS fetch ${res.status}`);
      const data = await res.json() as GeoJSON.FeatureCollection;
      features = data?.features ?? [];
    } catch (err) {
      // Transient: NWS occasionally returns 5xx during outages. Retry on
      // the next scheduled interval; don't blow away currently-displayed
      // alerts (this._features is left intact below if features stays []).
      console.warn('NWS alerts: fetch failed', err);
      this._scheduleNext();
      return;
    }
    if (myGen !== this._gen) return;   // stale

    // Filter, then sort lexicographically by (severity, urgency,
    // certainty) so the most actionable alerts paint last and end up
    // on top of the visual stack. Sort once here, not per render —
    // the order is stable until the next _fetch().
    this._features = this._filter(features).sort(paintOrderAscending);
    // Render polygon-bearing alerts immediately for snappy first paint;
    // zone-only alerts will fill in progressively as their geometry arrives.
    this._render();
    this._scheduleNext();
    // Kick off zone resolution in the background — re-renders the layer
    // once each batch of zone fetches completes, picking up newly-cached
    // geometry. Doesn't await; lets the next refresh cycle run on time.
    void this._resolveZones();
  }

  // Fetch any zone shape we don't already have cached for an alert in
  // _features. Uses Promise.all over the missing-set; the browser will
  // throttle to ~6 concurrent requests per origin, which fits comfortably
  // inside NWS's published rate limits. Re-renders when the batch settles.
  private async _resolveZones(): Promise<void> {
    const myGen = this._gen;
    const needed = new Set<string>();
    for (const f of this._features) {
      if (f.geometry) continue;   // already has its own geometry; no zones needed
      const zones = (f.properties as AlertProps | null)?.affectedZones ?? [];
      for (const url of zones) {
        if (!this._zoneCache.has(url) && !this._zoneFetches.has(url)) {
          needed.add(url);
        }
      }
    }
    if (needed.size === 0) return;

    // _fetchZone self-registers in _zoneFetches as its first action so the
    // entry exists before any sync return path (e.g. localStorage hit) can
    // hit the matching `finally { delete }`. We just collect the promises
    // here for the Promise.all join.
    const promises = Array.from(needed, (url) => this._fetchZone(url));
    await Promise.all(promises);
    if (myGen !== this._gen) return;   // stale (cleared / reconfigured during the fetch)

    // Skip-if-unchanged still applies — only the features whose zones
    // actually arrived will see their decision strings flip, so this is
    // a no-op for any feature whose render state is stable.
    this._render({ skipIfDecisionsUnchanged: true });
  }

  private async _fetchZone(url: string): Promise<void> {
    // Self-register so concurrent callers dedupe. Registration must happen
    // BEFORE the localStorage early-return path so the matching `finally
    // { delete }` always pairs with a real entry, never a stale one. If
    // we're already in flight for this URL, await the existing promise
    // instead of starting a new request.
    const existing = this._zoneFetches.get(url);
    if (existing) return existing;
    let resolveOuter!: () => void;
    const outer = new Promise<void>((r) => { resolveOuter = r; });
    this._zoneFetches.set(url, outer);
    try {
      // localStorage hit short-circuits the network request — saves a
      // round-trip per zone for users who've previously viewed alerts in
      // the same area. First session pays the network cost; subsequent
      // sessions read from disk.
      const cached = readZoneFromLocalStorage(url);
      if (cached) {
        this._zoneCache.set(url, cached);
        return;
      }
      const myGen = this._gen;
      const res = await fetch(url, {
        headers: { Accept: 'application/geo+json' },
      });
      if (!res.ok) throw new Error(`zone fetch ${res.status}`);
      const data = await res.json();
      if (myGen !== this._gen) return;
      const geom: GeoJSON.Geometry | undefined = data?.geometry;
      // Some forecast zones return geometry === null (rare, usually
      // administrative entries with no shape). Cache only real geometries.
      if (geom && (geom.type === 'Polygon' || geom.type === 'MultiPolygon')) {
        this._zoneCache.set(url, geom);
        writeZoneToLocalStorage(url, geom);
      }
    } catch (err) {
      // Per-zone failures are common (404s on retired zones, transient
      // network blips). Log once and move on; the alert's other zones
      // may still resolve and render.
      console.warn('NWS alerts: zone fetch failed', url, err);
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

    return all.filter((f) => {
      // Keep both polygon-bearing and zone-only alerts. Zone-only ones are
      // resolved into geometry asynchronously by _resolveZones() and
      // become renderable on a subsequent _render() pass.
      const props = f.properties as AlertProps | null;
      const hasZones = (props?.affectedZones?.length ?? 0) > 0;
      if (!f.geometry && !hasZones) return false;

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
      // filter set; it'll be re-evaluated on the next render once any zone
      // resolves. Letting it through is safer than dropping it (a far-away
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

  // Build a synthetic MultiPolygon from whatever zone shapes are currently
  // in the cache. Zones still being fetched are silently omitted — the
  // _renderInner pass picks them up on a subsequent re-render once they
  // arrive. Returns null if no zones are cached yet.
  private _geometryFromZones(zoneUrls: string[]): GeoJSON.MultiPolygon | null {
    const polys: GeoJSON.Position[][][] = [];
    for (const url of zoneUrls) {
      const g = this._zoneCache.get(url);
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
    const renderable: GeoJSON.Feature[] = [];
    const newDecisions = new Map<string, string>();
    for (const f of this._features) {
      const key = featureKey(f);
      const props = f.properties as AlertProps | null;

      let geom: GeoJSON.Geometry | null = f.geometry ?? null;
      let zonesLoaded = 0;
      let zonesTotal = 0;
      if (!geom) {
        const zones = props?.affectedZones ?? [];
        zonesTotal = zones.length;
        const synth = this._geometryFromZones(zones);
        if (synth) {
          geom = synth;
          // Count how many zones contributed — for the decision string.
          zonesLoaded = zones.filter((u) => this._zoneCache.has(u)).length;
        }
      }

      // Decision captures everything that affects this feature's render:
      // event (colour), severity (z-order), and either "polygon" for
      // inline geometry or "zones:N/M" for zone-derived. When more zones
      // arrive the count rises, the decision flips, and we re-render.
      const geomTag = f.geometry ? 'polygon' : `zones:${zonesLoaded}/${zonesTotal}`;
      newDecisions.set(key, `${props?.event ?? ''}|${props?.severity ?? ''}|${geomTag}`);

      if (!geom) continue;   // zone-only with nothing in cache yet — skip this render

      // Push a feature carrying the derived geometry; preserve id/properties
      // so the popup picks up the original alert metadata.
      renderable.push({
        type: 'Feature',
        id: f.id,
        properties: f.properties,
        geometry: geom,
      });
    }

    if (opts?.skipIfDecisionsUnchanged && decisionsEqual(this._renderDecisions, newDecisions)) {
      return;
    }
    this._renderDecisions = newDecisions;

    if (this._polygonLayer) {
      this._map.removeLayer(this._polygonLayer);
      this._polygonLayer = null;
    }

    if (renderable.length === 0) return;

    this._polygonLayer = L.geoJSON(renderable, {
      style: (feature) => {
        const event = (feature?.properties as AlertProps | null)?.event;
        const colour = colorForEvent(event);
        return { color: colour, weight: 1.5, fillColor: colour, fillOpacity };
      },
      onEachFeature: (feature, layer) => {
        // autoPan defaults to true — when an off-edge popup opens, Leaflet
        // pans the map so it's fully visible inside the card. autoPanPadding
        // adds a small inset so the popup never butts right against the card
        // edge (looks awkward). maxHeight caps the popup at 90% of the map
        // height so a long alert description never spills outside the card;
        // Leaflet adds an internal scrollbar past the cap.
        layer.bindPopup(
          buildPopupHtml(feature.properties as AlertProps | null),
          { autoPan: true, autoPanPadding: [12, 12], maxHeight: this._popupMaxHeight() },
        );
      },
    });
    this._polygonLayer.addTo(this._map);
  }

  /** 80% of the current map height, floored at 200 px so a tiny / not-yet-sized map still produces a usable popup. */
  private _popupMaxHeight(): number {
    return Math.max(200, Math.floor(this._map.getSize().y * 0.8));
  }

  private _scheduleNext(): void {
    if (this._timer) clearTimeout(this._timer);
    const cfg = this._getConfig();
    const overrideSec = cfg.alerts_refresh_seconds;
    const intervalMs = overrideSec
      ? overrideSec * 1000
      : (this._features.length > 0 ? DEFAULT_REFRESH_VISIBLE_MS : DEFAULT_REFRESH_EMPTY_MS);
    this._timer = setTimeout(() => void this._fetch(), intervalMs);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

// localStorage helpers for the persistent zone cache. Both functions are
// best-effort — any storage error (quota, disabled, corrupt entry) is
// swallowed silently so the layer still works with just the in-memory
// cache. Keying is by zone URL with a versioned prefix; a future cache
// format change can use ZONE_LS_KEY_PREFIX = 'wrc-zone-v2:' and old
// entries become invisible without needing a migration.
function readZoneFromLocalStorage(url: string): GeoJSON.Geometry | null {
  try {
    const raw = localStorage.getItem(ZONE_LS_KEY_PREFIX + url);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { geometry: GeoJSON.Geometry; ts: number };
    if (Date.now() - parsed.ts > ZONE_LS_TTL_MS) {
      // TTL expired — drop and treat as a miss so we re-fetch fresh data.
      localStorage.removeItem(ZONE_LS_KEY_PREFIX + url);
      return null;
    }
    return parsed.geometry;
  } catch {
    return null;
  }
}

function writeZoneToLocalStorage(url: string, geometry: GeoJSON.Geometry): void {
  try {
    localStorage.setItem(
      ZONE_LS_KEY_PREFIX + url,
      JSON.stringify({ geometry, ts: Date.now() }),
    );
  } catch {
    // Quota exceeded or storage disabled. Swallow — the in-memory cache
    // still works for this session, the persistent cache is a bonus.
  }
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

function decisionsEqual(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function buildPopupHtml(props: AlertProps | null): string {
  const event = props?.event ?? localize('ui.alerts.unknown_event');
  const severity = props?.severity ?? '—';
  const certainty = props?.certainty ?? '—';
  const urgency = props?.urgency ?? '—';
  const effective = formatDateTime(props?.effective);
  const expires = formatDateTime(props?.expires ?? props?.ends);
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

  return `
    <div style="font:12px/1.4 'Helvetica Neue',Arial,sans-serif;min-width:220px;max-width:320px">
      <div style="font-weight:bold;font-size:13px;margin-bottom:4px;color:${accent}">${escapeHtml(event)}</div>
      ${headline ? `<div style="margin-bottom:6px">${escapeHtml(truncate(headline, 200))}</div>` : ''}
      <div><b>${escapeHtml(localize('ui.alerts.severity'))}:</b> ${escapeHtml(severity)} · <b>${escapeHtml(localize('ui.alerts.certainty'))}:</b> ${escapeHtml(certainty)} · <b>${escapeHtml(localize('ui.alerts.urgency'))}:</b> ${escapeHtml(urgency)}</div>
      <div><b>${escapeHtml(localize('ui.alerts.effective'))}:</b> ${escapeHtml(effective)}</div>
      <div><b>${escapeHtml(localize('ui.alerts.expires'))}:</b> ${escapeHtml(expires)}</div>
      ${description ? `<div style="margin-top:6px;white-space:pre-line;max-height:240px;overflow:auto">${escapeHtml(truncate(description, 1500))}</div>` : ''}
      <div style="margin-top:6px;font-size:10px;color:#a00;font-weight:bold">${escapeHtml(localize('ui.alerts.disclaimer'))} <a href="${DOCS_ALERTS_URL}" target="_blank" rel="noopener noreferrer" style="color:#a00;text-decoration:underline">${escapeHtml(localize('ui.alerts.see_readme'))}</a>.</div>
      <div style="margin-top:4px"><a href="${escapeHtml(linkUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize('ui.alerts.more_info'))}</a></div>
    </div>
  `;
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

function formatDateTime(s: string | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString();
}

// Re-export for the editor to enumerate available categories without
// importing the categories module directly.
export { ALL_ALERT_CATEGORIES, NWS_ALERT_DEFAULT_COLOR };

// Test-only exports — these are internal implementation details that
// would be `private` in an OOP language. Exposed here so the unit
// tests can exercise them; do not consume from production code paths
// outside this module.
export {
  featureKey,
  decisionsEqual,
  paintOrderAscending,
  relativeLuminance,
  formatDateTime,
  buildPopupHtml,
  readZoneFromLocalStorage,
  writeZoneToLocalStorage,
  ZONE_LS_KEY_PREFIX,
  ZONE_LS_TTL_MS,
};
