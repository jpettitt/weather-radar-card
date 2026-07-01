/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { FIRE_PATH } from './marker-icon';
import { localize } from './localize/localize';
import { centroidLngLat, geometryLngLatBounds, haversineKm } from './geo-utils';
import { sharedCanvasRenderer } from './shared-canvas-renderer';
import { escapeHtml, slugify } from './string-utils';
import { mapsEqual } from './map-utils';

const decisionsEqual = mapsEqual<string, 'polygon' | 'icon'>;

// NIFC WFIGS Current Interagency Fire Perimeters — see docs/wildfire-feature-design.md.
// outFields trimmed to just what the popup renders. geometryPrecision=4 keeps
// coordinates to ~11m precision and shrinks the payload substantially without
// any visible difference at our zoom range.
// Anchor link to the Wildfires section of docs/overlays.md on GitHub.
// Rendered after the popup's safety disclaimer so users can reach the
// full caveat with one click. The hash matches GitHub's auto-generated
// anchor for the "## Wildfires" heading.
const DOCS_WILDFIRES_URL = 'https://github.com/jpettitt/weather-radar-card/blob/main/docs/overlays.md#wildfires';

const NIFC_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/'
  + 'WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query'
  + '?where=1%3D1'
  + '&outFields=poly_IncidentName,poly_GISAcres,attr_PercentContained,attr_FireDiscoveryDateTime,attr_POOJurisdictionalUnit'
  + '&geometryPrecision=4'
  + '&f=geojson';

// InciWeb's RSS index of currently-listed incidents. Used to gate the
// "More info → InciWeb" link in the popup so we don't link to 404s for
// fires that have no public InciWeb page (most small / contained fires).
const INCIWEB_RSS_URL = 'https://inciweb.wildfire.gov/incidents/rss.xml';

const DEFAULT_REFRESH_VISIBLE_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_EMPTY_MS = 30 * 60 * 1000;
const DEFAULT_MIN_ACRES = 10;
const DEFAULT_FILL_OPACITY = 0.2;
const DEFAULT_ACTIVE_COLOR = '#ff3300';
const DEFAULT_CONTAINED_COLOR = '#888888';

// Polygon's pixel-bbox below this size at the current zoom renders as the
// fire icon at the centroid instead of as a polygon outline.
const ICON_THRESHOLD_PX = 20;

// Acreage → icon size mapping. Wildfires <10 acres are usually filtered out
// by the default min_acres, but if the user lowers the floor we still want a
// reasonable visual scale.
function iconSizeForAcres(acres: number): number {
  if (acres < 10) return 16;
  if (acres < 100) return 24;
  return 32;
}

interface WildfireProps {
  poly_IncidentName?: string;
  poly_GISAcres?: number;
  attr_PercentContained?: number;
  attr_FireDiscoveryDateTime?: number;   // ms since epoch from ArcGIS
  attr_POOJurisdictionalUnit?: string;   // Point-of-origin jurisdictional unit (e.g. "FLFNF") — used to build the InciWeb URL
}

export class WildfireLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;

  private _polygonLayer: L.GeoJSON | null = null;
  private _iconLayer: L.LayerGroup | null = null;
  private _features: GeoJSON.Feature[] = [];
  // Lower-cased slugs (path segment after /incident-information/) of fires
  // currently listed on InciWeb. Used to suppress the InciWeb link for
  // incidents with no public page. Empty + _inciwebReady=false means the
  // RSS hasn't returned yet (or failed) — fall back to showing the link.
  private _inciwebSlugs: Set<string> = new Set();
  private _inciwebReady = false;
  // Per-feature render decision from the last _render() pass — keyed by
  // featureKey(feature). Used to skip re-rendering (which would close any
  // open popup) when zoomend fires but no feature actually crossed the
  // polygon-vs-icon threshold.
  private _renderDecisions: Map<string, 'polygon' | 'icon'> = new Map();
  private _timer: ReturnType<typeof setTimeout> | null = null;
  // Set to Date.now() in pause(), cleared in resume(). When non-null we
  // know we're paused: timer is cancelled, no fetches in flight should
  // act on their result. Used by resume() to decide whether to refetch
  // immediately (data went stale during the pause) or just reschedule.
  private _pausedAt: number | null = null;
  // Generation guard — incremented on every fetch start. If the value at the
  // resolve point doesn't match, the fetch is stale (config changed mid-flight,
  // teardown happened, etc.) and we discard the result.
  private _gen = 0;
  // Consecutive WFIGS fetch failures — drives the retry backoff. NIFC's
  // ArcGIS endpoint rate-limits intermittently; retrying on the normal
  // cadence keeps the block alive. Reset on success.
  private _failureCount = 0;
  // Abort the in-flight fetches (NIFC + InciWeb) when a new fetch starts
  // or the layer tears down, so the browser doesn't keep downloading
  // payloads we've already decided to discard via the gen check.
  private _abortCtrl: AbortController | null = null;
  private _zoomHandler: (() => void) | null = null;

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
    // On zoomend, only re-render if at least one feature crossed the
    // polygon-vs-icon threshold. This preserves any open popup when the
    // user zooms (e.g. via double-tap) without crossing the threshold.
    this._zoomHandler = () => this._render({ skipIfDecisionsUnchanged: true });
    this._map.on('zoomend', this._zoomHandler);
    void this._fetch();
  }

  clear(): void {
    this._gen++;   // invalidate any in-flight fetches
    this._abortCtrl?.abort();   // cancel the HTTP requests too, not just the response handling
    this._abortCtrl = null;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._zoomHandler) {
      this._map.off('zoomend', this._zoomHandler);
      this._zoomHandler = null;
    }
    if (this._polygonLayer) { this._map.removeLayer(this._polygonLayer); this._polygonLayer = null; }
    // The shared canvas renderer is deliberately NOT removed — the
    // alerts layer may still be drawing through it (map-lifetime,
    // see shared-canvas-renderer.ts).
    if (this._iconLayer) { this._map.removeLayer(this._iconLayer); this._iconLayer = null; }
    this._features = [];
    this._renderDecisions.clear();
  }

  // Stop scheduled fetches while the host card is hidden (off-screen or
  // tab in background). The currently-rendered features stay on the map
  // but no new network activity happens.
  pause(): void {
    if (this._pausedAt != null) return;
    this._pausedAt = Date.now();
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
  }

  // Resume after a pause. If we were paused longer than the
  // refresh-when-visible interval, the displayed features are presumed
  // stale and we refetch immediately. Otherwise just reschedule the
  // next periodic refresh.
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

  // Re-filter and re-render in response to a hass change. Currently only
  // affects results when wildfire_radius_km is set and the map center has
  // shifted — cheap to call unconditionally since filter+render is fast for
  // the modest feature counts we deal with.
  updateHass(hass: HomeAssistant): void {
    this._hass = hass;
    if (this._features.length === 0) return;
    // HA pushes hass updates on every state change — frequent. Don't tear
    // down the layers (which would close any open popup) unless the
    // per-feature polygon-vs-icon decisions actually change. Pass the
    // skip-if-unchanged flag so a no-op hass tick is truly a no-op.
    this._render({ skipIfDecisionsUnchanged: true });
  }

  private async _fetch(): Promise<void> {
    const myGen = ++this._gen;
    // Abort any previous in-flight fetches so their bytes stop hitting
    // the wire — the gen check below would discard the response anyway,
    // but on mobile we'd rather not pay the bandwidth.
    this._abortCtrl?.abort();
    const ctrl = new AbortController();
    this._abortCtrl = ctrl;
    // Fetch WFIGS perimeters and the InciWeb incident index in parallel —
    // they're independent and we want the latest of both before re-rendering.
    const [features, inciwebSlugs] = await Promise.all([
      this._fetchWfigs(ctrl.signal),
      this._fetchInciwebSlugs(ctrl.signal),
    ]);
    if (myGen !== this._gen) return;   // stale — abandon
    if (this._abortCtrl === ctrl) this._abortCtrl = null;

    // null = the WFIGS fetch failed (transient 503 / rate-limit). Keep
    // the currently displayed perimeters rather than blanking every
    // fire polygon/icon for the 5-30 min until the next scheduled
    // retry. Same convention _fetchInciwebSlugs already uses. A
    // SUCCESSFUL fetch returning [] is real data ("no active fires in
    // the feed") and replaces as before.
    if (inciwebSlugs) {
      this._inciwebSlugs = inciwebSlugs;
      this._inciwebReady = true;
    }
    if (features !== null) {
      this._features = this._filter(features);
      this._failureCount = 0;
      this._render();
      this._scheduleNext();
    } else {
      // WFIGS failed (kept the displayed perimeters) — back off instead
      // of retrying on the normal cadence, mirroring the alerts layer.
      this._failureCount++;
      this._render();
      this._scheduleRetry();
    }
  }

  /** Backoff delay for the Nth consecutive failure (1-based): 5 min
   * doubling to a 60-minute cap. */
  private _retryDelayMs(failures: number): number {
    const capped = Math.min(failures - 1, 10);
    return Math.min(DEFAULT_REFRESH_VISIBLE_MS * 2 ** capped, 60 * 60_000);
  }

  private _scheduleRetry(): void {
    if (this._pausedAt != null) return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => void this._fetch(), this._retryDelayMs(this._failureCount));
  }

  // Returns null on failure so the caller can keep the existing feature
  // set in place (avoid blowing displayed perimeters away on a transient
  // error) — mirroring _fetchInciwebSlugs.
  private async _fetchWfigs(signal: AbortSignal): Promise<GeoJSON.Feature[] | null> {
    try {
      const res = await fetch(NIFC_URL, { signal });
      if (!res.ok) throw new Error(`NIFC fetch ${res.status}`);
      const data = await res.json() as GeoJSON.FeatureCollection;
      return (data?.features ?? []).filter((f): f is GeoJSON.Feature => !!f?.geometry);
    } catch (err) {
      // Deliberate cancellation (teardown / superseded by a fresh fetch).
      // Not a real failure — caller's gen check will discard the result anyway.
      if ((err as Error)?.name === 'AbortError') return null;
      // Transient — NIFC's ArcGIS endpoint occasionally rate-limits or
      // returns 503. Next scheduled fetch will retry.
      console.warn('Wildfire layer: WFIGS fetch failed', err);
      return null;
    }
  }

  // Fetch InciWeb's RSS and extract the slug (path segment) from every
  // incident link. Returns null on failure so the caller can leave the
  // existing slug set in place (avoid blowing it away on a transient error).
  private async _fetchInciwebSlugs(signal: AbortSignal): Promise<Set<string> | null> {
    try {
      const res = await fetch(INCIWEB_RSS_URL, { signal });
      if (!res.ok) throw new Error(`InciWeb RSS fetch ${res.status}`);
      const text = await res.text();
      const doc = new DOMParser().parseFromString(text, 'application/xml');
      const slugs = new Set<string>();
      doc.querySelectorAll('item > link').forEach((linkEl) => {
        const url = linkEl.textContent?.trim();
        if (!url) return;
        const m = url.match(/\/incident-information\/([^/?#]+)/i);
        if (m) slugs.add(m[1].toLowerCase());
      });
      return slugs;
    } catch (err) {
      // Deliberate cancellation (teardown / superseded by a fresh fetch).
      // Not a real failure — return null so the caller keeps the prior slug set.
      if ((err as Error)?.name === 'AbortError') return null;
      // CORS, network, or parse failure. Leave the previous set intact and
      // fall back to "show link" behaviour for new fires until next refresh.
      console.warn('Wildfire layer: InciWeb RSS fetch failed', err);
      return null;
    }
  }

  private _filter(features: GeoJSON.Feature[]): GeoJSON.Feature[] {
    const cfg = this._getConfig();
    const minAcres = cfg.wildfire_min_acres ?? DEFAULT_MIN_ACRES;
    const radiusKm = cfg.wildfire_radius_km;
    const center = radiusKm ? this._map.getCenter() : null;

    return features.filter((f) => {
      const props = f.properties as WildfireProps | null;
      const acres = props?.poly_GISAcres ?? 0;
      if (acres < minAcres) return false;

      if (radiusKm && center) {
        const c = centroidLngLat(f.geometry);
        if (!c) return false;
        const distKm = haversineKm(center.lat, center.lng, c[1], c[0]);
        if (distKm > radiusKm) return false;
      }
      return true;
    });
  }

  private _render(opts?: { skipIfDecisionsUnchanged?: boolean }): void {
    try {
      this._renderInner(opts);
    } catch (err) {
      // Never let a render exception escape — it would break the host card's
      // Lit lifecycle and (worse) the dashboard's pointer handling.
      console.warn('Wildfire layer: render failed', err);
    }
  }

  private _renderInner(opts?: { skipIfDecisionsUnchanged?: boolean }): void {
    if (!this._map) return;
    const cfg = this._getConfig();
    const fillOpacity = cfg.wildfire_fill_opacity ?? DEFAULT_FILL_OPACITY;
    const activeColor = cfg.wildfire_color ?? DEFAULT_ACTIVE_COLOR;
    const containedColor = cfg.wildfire_contained_color ?? DEFAULT_CONTAINED_COLOR;

    // Compute polygon-vs-icon for each feature first so we can skip the full
    // tear-down/rebuild when the zoom change didn't actually cross the
    // threshold for any feature. Preserves any popup the user has open.
    const polygons: GeoJSON.Feature[] = [];
    const icons: { latLng: L.LatLng; feature: GeoJSON.Feature }[] = [];
    const newDecisions = new Map<string, 'polygon' | 'icon'>();

    for (const f of this._features) {
      const bbox = featureBboxPx(f.geometry, this._map);
      if (!bbox) continue;
      const px = Math.max(bbox.width, bbox.height);
      const key = featureKey(f);
      if (px >= ICON_THRESHOLD_PX) {
        polygons.push(f);
        newDecisions.set(key, 'polygon');
      } else {
        const c = centroidLngLat(f.geometry);
        if (c) {
          icons.push({ latLng: L.latLng(c[1], c[0]), feature: f });
          newDecisions.set(key, 'icon');
        }
      }
    }

    if (opts?.skipIfDecisionsUnchanged && decisionsEqual(this._renderDecisions, newDecisions)) {
      return;
    }
    this._renderDecisions = newDecisions;

    // Tear down any existing layers before re-rendering — simplest correct
    // approach for the volume we deal with (typically 50–200 features post-filter).
    if (this._polygonLayer) { this._map.removeLayer(this._polygonLayer); this._polygonLayer = null; }
    if (this._iconLayer) { this._map.removeLayer(this._iconLayer); this._iconLayer = null; }

    if (this._features.length === 0) return;

    if (polygons.length > 0) {
      // Canvas instead of per-ring SVG nodes — WFIGS perimeter rings
      // carry thousands of vertices each. MUST be the map-shared
      // renderer, never a private L.canvas() — this layer creates its
      // polygon layer lazily (only when a fire crosses the icon→polygon
      // zoom threshold), and a second renderer created at that moment
      // stacks over the alerts canvas and swallows its clicks from then
      // on (see shared-canvas-renderer.ts). Fire icons stay DOM markers
      // (bounded count, need the divIcon SVG glyph).
      // The cast: `renderer` is a real option here — GeoJSON forwards its
      // whole options bag to every child Path via geometryToLayer — but
      // @types/leaflet's GeoJSONOptions doesn't declare it.
      this._polygonLayer = L.geoJSON(polygons, {
        renderer: sharedCanvasRenderer(this._map),
        style: (feature) => {
          const contained = isContained(feature?.properties as WildfireProps | null);
          const color = contained ? containedColor : activeColor;
          return { color, weight: 1.5, fillColor: color, fillOpacity };
        },
        onEachFeature: (feature, layer) => {
          // autoPan keeps the popup inside the visible map area when the
          // anchor is near an edge — Leaflet smoothly slides the map so the
          // popup is fully readable. autoPanPadding keeps a small inset so
          // it never butts against the card edge.
          layer.bindPopup(
            buildPopupHtml(
              feature.properties as WildfireProps | null,
              this._inciwebSlugs,
              this._inciwebReady,
            ),
            { autoPan: true, autoPanPadding: [12, 12], maxHeight: this._popupMaxHeight() },
          );
        },
      } as L.GeoJSONOptions);
      this._polygonLayer.addTo(this._map);
    }

    if (icons.length > 0) {
      this._iconLayer = L.layerGroup();
      for (const item of icons) {
        const props = item.feature.properties as WildfireProps | null;
        const acres = props?.poly_GISAcres ?? 0;
        const size = iconSizeForAcres(acres);
        const color = isContained(props) ? containedColor : activeColor;
        const icon = L.divIcon({
          html: `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block"><path fill="${color}" d="${FIRE_PATH}"/></svg>`,
          iconSize: [size, size],
          className: 'wildfire-icon',
        });
        const marker = L.marker(item.latLng, { icon });
        marker.bindPopup(
          buildPopupHtml(props, this._inciwebSlugs, this._inciwebReady),
          { autoPan: true, autoPanPadding: [12, 12], maxHeight: this._popupMaxHeight() },
        );
        marker.addTo(this._iconLayer!);
      }
      this._iconLayer.addTo(this._map);
    }
  }

  /** 80% of the current map height, floored at 200 px so a tiny / not-yet-sized map still produces a usable popup. */
  private _popupMaxHeight(): number {
    return Math.max(200, Math.floor(this._map.getSize().y * 0.8));
  }

  private _scheduleNext(): void {
    // Paused → don't re-arm. pause() only cancels the ARMED timer; a
    // fetch that was already in flight when pause() ran completes and
    // its tail calls _scheduleNext — without this guard that re-armed
    // the chain and the layer kept polling NIFC at full cadence for as
    // long as the card stayed hidden. resume() decides between an
    // immediate refetch and a reschedule, so dropping the re-arm here
    // is safe.
    if (this._pausedAt != null) return;
    if (this._timer) clearTimeout(this._timer);
    const cfg = this._getConfig();
    const overrideMin = cfg.wildfire_refresh_minutes;
    const intervalMs = overrideMin
      ? overrideMin * 60 * 1000
      : (this._features.length > 0 ? DEFAULT_REFRESH_VISIBLE_MS : DEFAULT_REFRESH_EMPTY_MS);
    this._timer = setTimeout(() => void this._fetch(), intervalMs);
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isContained(props: WildfireProps | null): boolean {
  return (props?.attr_PercentContained ?? 0) >= 100;
}

// Stable identifier for a NIFC feature. ArcGIS GeoJSON usually carries an
// OBJECTID as feature.id; fall back to name+discovery so we still get a
// reasonable key when id isn't set.
function featureKey(f: GeoJSON.Feature): string {
  if (f.id != null) return String(f.id);
  const p = f.properties as WildfireProps | null;
  return `${p?.poly_IncidentName ?? ''}|${p?.attr_FireDiscoveryDateTime ?? ''}`;
}

function buildPopupHtml(
  props: WildfireProps | null,
  inciwebSlugs: Set<string>,
  inciwebReady: boolean,
): string {
  const name = props?.poly_IncidentName ?? localize('ui.wildfire.unknown_name');
  const acres = props?.poly_GISAcres;
  const contained = props?.attr_PercentContained;
  const discovered = props?.attr_FireDiscoveryDateTime;

  const acresStr = typeof acres === 'number'
    ? acres.toLocaleString(undefined, { maximumFractionDigits: 0 })
    : '—';
  const containedStr = typeof contained === 'number'
    ? `${Math.round(contained)}%`
    : '—';
  const discoveredStr = typeof discovered === 'number'
    ? new Date(discovered).toLocaleDateString()
    : '—';

  // InciWeb URL format: /incident-information/{poo-jurisdictional-unit-lower}-{name-slug}
  // e.g. flfnf-sand-drain. We only render the link when the computed slug
  // appears in InciWeb's RSS index — that way we don't link users to 404s
  // for fires too small / contained to have a public InciWeb page.
  // InciWeb sometimes appends "-fire" to incident slugs (e.g. "East Side"
  // → mtgnf-east-side-fire), so we test both variants. If neither matches,
  // no link is rendered. While the RSS fetch hasn't returned yet
  // (inciwebReady=false), fall back to the bare slug so first paint
  // isn't degraded.
  const unit = props?.attr_POOJurisdictionalUnit;
  const baseSlug = unit ? `${unit.toLowerCase()}-${slugify(name)}` : null;
  let linkSlug: string | null = null;
  if (baseSlug) {
    if (!inciwebReady) {
      linkSlug = baseSlug;
    } else {
      const candidates = [baseSlug, `${baseSlug}-fire`];
      linkSlug = candidates.find((c) => inciwebSlugs.has(c)) ?? null;
    }
  }
  // linkSlug is currently safe-by-construction — always one of
  // [baseSlug, baseSlug + '-fire'] where baseSlug derives from
  // slugify() which strips everything outside [a-z0-9-]. The InciWeb
  // RSS-parsed slugs are only consulted via Set.has() (a key check),
  // never substituted into HTML. Defensive escapeHtml here protects
  // against a future refactor that breaks the safe-by-construction
  // guarantee.
  const linkHtml = linkSlug
    ? `<div style="margin-top:4px"><a href="https://inciweb.wildfire.gov/incident-information/${escapeHtml(linkSlug)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize('ui.wildfire.more_info'))}</a></div>`
    : '';

  // Inline-styled HTML — the popup renders inside Leaflet's own container,
  // outside the card's shadow root, so card CSS doesn't apply.
  return `
    <div style="font:12px/1.4 'Helvetica Neue',Arial,sans-serif;min-width:180px">
      <div style="font-weight:bold;font-size:13px;margin-bottom:4px">${escapeHtml(name)}</div>
      <div><b>${escapeHtml(localize('ui.wildfire.acres'))}:</b> ${escapeHtml(acresStr)}</div>
      <div><b>${escapeHtml(localize('ui.wildfire.contained'))}:</b> ${escapeHtml(containedStr)}</div>
      <div><b>${escapeHtml(localize('ui.wildfire.discovered'))}:</b> ${escapeHtml(discoveredStr)}</div>
      <div style="margin-top:6px;font-size:10px;color:#666">${escapeHtml(localize('ui.wildfire.disclaimer'))} <a href="${DOCS_WILDFIRES_URL}" target="_blank" rel="noopener noreferrer" style="color:#666;text-decoration:underline">${escapeHtml(localize('ui.wildfire.see_readme'))}</a>.</div>
      ${linkHtml}
    </div>
  `;
}

// Compute the on-screen pixel bounding box of a geometry at the current zoom.
// Returns null if the geometry is empty or unsupported.
function featureBboxPx(
  geom: GeoJSON.Geometry,
  map: L.Map,
): { width: number; height: number } | null {
  const ll = geometryLngLatBounds(geom);
  if (!ll) return null;
  const sw = map.latLngToLayerPoint(L.latLng(ll.minLat, ll.minLng));
  const ne = map.latLngToLayerPoint(L.latLng(ll.maxLat, ll.maxLng));
  return { width: Math.abs(ne.x - sw.x), height: Math.abs(ne.y - sw.y) };
}

// Test-only exports — internal helpers exposed for the unit tests.
export { featureKey, decisionsEqual, isContained, iconSizeForAcres };
