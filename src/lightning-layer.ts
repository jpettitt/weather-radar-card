/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { LIGHTNING_BOLT_PATH, LIGHTNING_PLUS_PATH } from './marker-icon';
import { localize } from './localize/localize';
import { haversineKm, formatDistance } from './geo-utils';
import { escapeHtml } from './string-utils';
import {
  BOLT_DURATION_SEC,
  DEFAULT_BLITZORTUNG_MAX_AGE_SEC,
  bearingCardinal,
  colorForAge,
  formatBlitzortungUrl,
  relativeTime,
} from './lightning-helpers';

// Lightning overlay — renders Blitzortung integration's per-strike
// geo_location entities as small bolt-shaped markers, fill-coloured by
// age. See docs/lightning-feature-design.md for the full design.
//
// No external HTTP from this file. The Blitzortung integration owns the
// data plumbing (WebSocket polling, distance/age filter); we just diff
// hass.states for new/gone strikes and paint markers on the map.

const DEFAULT_ICON_SIZE_PX = 14;
// Bolts render at 1.3× the + size — the "happening now" indicator
// reads better when it's visibly larger than the steady-state markers
// it sits among. Applied at icon creation; if the user sets
// lightning_icon_size, the bolt stays proportionally larger.
const BOLT_SIZE_RATIO = 1.3;
// Default card-side max-age cap. The Blitzortung integration commonly
// keeps strikes for 120 min; rendering them all turns busy storms into
// noise. 30 min surfaces just the meaningful lifetime of an active
// cell. Configurable via cfg.lightning_max_age_minutes.
const DEFAULT_MAX_AGE_MIN = 30;
// 30 s recompute of the age-derived fill — the design doc's chosen
// cadence. Smoothing the age across 30 s on a multi-thousand-second
// gradient is visually indistinguishable from continuous fade and
// avoids per-marker timers.
const AGE_REFRESH_MS = 30 * 1000;

// Two custom Leaflet panes. Both sit between the default overlayPane
// (400, where radar tiles + wildfire / alert polygons live) and the
// default markerPane (600, where home / person / device-tracker
// markers live). This ordering matches the design doc: lightning is
// visible over a NWS alert polygon, and the home marker stays on top
// of any strike at the same point.
//
// The OUTLINE pane (z 499) carries the black-stroked path of each +
// sign on its own. The FILL pane (z 500) carries the coloured-fill
// path. Splitting them solves the "black blob" problem at low zoom
// when many strikes pile up at the same screen location: the outlines
// stack and merge harmlessly underneath, while the topmost coloured
// fill stays cleanly visible on top instead of being lost under
// stacked strokes.
//
// Bolt-phase markers go on the FILL pane only — they're a single
// glyph and don't suffer the same stacking issue (bolt phase is
// short, and the bolts are bigger than the +s).
const LIGHTNING_PANE = 'wrc-lightning';
const LIGHTNING_PANE_Z = 500;
const LIGHTNING_OUTLINE_PANE = 'wrc-lightning-outline';
const LIGHTNING_OUTLINE_PANE_Z = 499;

interface Strike {
  ts: number;        // epoch ms when the strike was first observed
  lat: number;
  lon: number;
  // Two-phase visual: bolt (with pulse) for the first BOLT_DURATION_SEC,
  // then plus-sign for the rest of the lifetime. Tracked here so a
  // strike that crosses the threshold between age refreshes only swaps
  // its icon DOM once (setIcon rebuilds the marker element).
  isBolt: boolean;
}

export class LightningLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;

  // Three parallel maps keyed by entity_id (geo_location.lightning_strike_*).
  // Splitting strike data from the Leaflet markers keeps _refreshAges()
  // small — it iterates _strikes and recolours the matching marker, no
  // need to dig coords or timestamps back out of the marker DOM.
  //
  // _markers is the FILL marker — bolt during the first 30 s, then a
  // coloured + sign on the LIGHTNING_PANE. Popups bind here.
  // _outlines is the OUTLINE marker — only present in the + phase, on
  // the LIGHTNING_OUTLINE_PANE one z-step lower. Non-interactive.
  // Splitting + signs into two markers on different panes is what
  // prevents stacked outlines obscuring stacked colours at low zoom:
  // outlines pile up harmlessly underneath, fills stay clean on top.
  private _strikes: Map<string, Strike> = new Map();
  private _markers: Map<string, L.Marker> = new Map();
  private _outlines: Map<string, L.Marker> = new Map();

  private _ageTimer: ReturnType<typeof setInterval> | null = null;
  // Set in pause(), cleared in resume(). Differs from the wildfire/alerts
  // pattern: there's no fetch to reschedule, just the age-recompute timer.
  private _pausedAt: number | null = null;

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
    this._ensurePanes();
    this._refreshFromHass();
    this._ageTimer = setInterval(() => this._refreshAges(), AGE_REFRESH_MS);
  }

  // Idempotent — Leaflet panes are sticky for the map's lifetime. We just
  // need both panes to exist before the first L.marker(...{pane}) call.
  // pointer-events: none on each pane (Leaflet's default for marker
  // panes) lets clicks fall through dead space; .wrc-lightning-icon
  // flips it back on for the actual icon hit area on the FILL pane.
  // Outline-pane markers stay non-interactive (interactive: false on the
  // L.marker) — clicks hit the fill on top, which carries the popup.
  private _ensurePanes(): void {
    for (const [name, z] of [
      [LIGHTNING_PANE, LIGHTNING_PANE_Z],
      [LIGHTNING_OUTLINE_PANE, LIGHTNING_OUTLINE_PANE_Z],
    ] as const) {
      if (this._map.getPane(name)) continue;
      const pane = this._map.createPane(name);
      pane.style.zIndex = String(z);
      pane.style.pointerEvents = 'none';
    }
  }

  clear(): void {
    if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
    for (const marker of this._markers.values()) this._map.removeLayer(marker);
    for (const outline of this._outlines.values()) this._map.removeLayer(outline);
    this._markers.clear();
    this._outlines.clear();
    this._strikes.clear();
  }

  // Stop the age timer while the host card is hidden. Currently-displayed
  // markers stay on the map (they'll resume refreshing on the next visible
  // tick). The strike-set diff still runs on hass updates because the
  // card's IntersectionObserver doesn't gate updateHass calls — but a
  // hidden card receives few hass-update render passes anyway, so this is
  // not worth defensive guarding.
  pause(): void {
    if (this._pausedAt != null) return;
    this._pausedAt = Date.now();
    if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
  }

  // Resume after a pause. Always recompute ages immediately (the visible
  // strikes have aged during the hidden interval) and restart the timer.
  resume(): void {
    if (this._pausedAt == null) return;
    this._pausedAt = null;
    this._refreshAges();
    if (!this._ageTimer) {
      this._ageTimer = setInterval(() => this._refreshAges(), AGE_REFRESH_MS);
    }
  }

  // Diff incoming hass against the current strike set, mutating only what
  // changed. Hass updates fire on every state change in the system —
  // frequent — so a no-op tick must be cheap. The Blitzortung integration
  // adds entities one at a time as strikes arrive and removes them after
  // its max-age window expires; per tick we typically see 0–1 changes.
  updateHass(hass: HomeAssistant): void {
    this._hass = hass;
    this._refreshFromHass();
  }

  private _refreshFromHass(): void {
    const current = this._collectStrikes();

    // Additions: strikes in hass that we don't have a marker for yet.
    for (const [id, strike] of current) {
      if (!this._strikes.has(id)) {
        this._strikes.set(id, strike);
        this._addMarker(id, strike);
      }
    }

    // Removals: strikes we tracked that hass no longer has (integration
    // dropped them past its max-age cap).
    for (const id of Array.from(this._strikes.keys())) {
      if (!current.has(id)) {
        this._strikes.delete(id);
        this._removeMarker(id);
      }
    }
  }

  // Walk hass.states once. Only entity_ids matching geo_location.* with
  // attributes.source === 'blitzortung' are strikes — the same entity
  // domain is used for earthquakes, fire perimeters, etc. so the source
  // attribute is the disambiguator. Strikes already past the
  // display-cap are filtered out at this stage so a freshly-mounted
  // card doesn't paint markers it would immediately drop.
  private _collectStrikes(): Map<string, Strike> {
    const out = new Map<string, Strike>();
    if (!this._hass?.states) return out;
    const maxAgeSec = this._displayMaxAgeSec();
    const now = Date.now();
    // for-in with an early prefix test rather than Object.entries: this
    // runs on EVERY hass tick (any state change in the whole install),
    // and Object.entries allocates a [key, value] pair array for
    // potentially thousands of entities each time. for-in touches only
    // the keys until the prefix matches — scales with installation
    // size, which entity-heavy installs hit several times per second.
    const states = this._hass.states as Record<string, unknown>;
    for (const id in states) {
      if (!id.startsWith('geo_location.')) continue;
      const st = states[id];
      const attrs = (st as any)?.attributes;
      if (!attrs || attrs.source !== 'blitzortung') continue;
      const lat = attrs.latitude;
      const lon = attrs.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      const ts = parseStrikeTimestamp(st);
      const ageSec = (now - ts) / 1000;
      if (ageSec > maxAgeSec) continue;
      // Initial-form decision happens here so a strike we discover well
      // past its 30 s window (e.g. card just mounted with strikes
      // already present) renders as a plus rather than briefly flashing
      // as a bolt.
      const isBolt = ageSec < BOLT_DURATION_SEC;
      out.set(id, { ts, lat, lon, isBolt });
    }
    return out;
  }

  // Strike paint order: newest-on-top within each pane, matching
  // Blitzortung's own web map.
  //
  // Leaflet's L.Marker computes z-index from screen-Y position
  // (markers further south render on top) and adds `options.zIndexOffset`
  // on top. The default ordering is geographic, NOT DOM-insertion order
  // — without an offset, two strikes close together on screen would
  // stack with the southern one on top regardless of arrival time.
  //
  // We set zIndexOffset = floor(strike.ts / 1000) on every strike
  // marker (bolt, + fill, + outline). Newer strikes have larger
  // timestamps → higher offsets → render on top of older strikes in
  // the same pane, regardless of their relative latitude.
  //
  // Seconds-since-epoch is ~1.74e9 in 2026, comfortably under the 2^31
  // ceiling some browsers apply to CSS z-index. Drops below the ceiling
  // again if needed by dividing strike.ts by a larger denominator.
  //
  // The bolt → + swap uses setIcon (in-place mutation, no DOM
  // re-insertion), so the original marker's zIndexOffset persists
  // across the swap. The new OUTLINE marker added during the swap is
  // given the same strike.ts-derived offset explicitly.
  private _addMarker(id: string, strike: Strike): void {
    const cfg = this._getConfig();
    const plusSize = cfg.lightning_icon_size ?? DEFAULT_ICON_SIZE_PX;
    const boltSize = Math.round(plusSize * BOLT_SIZE_RATIO);
    // Pulse only fires for strikes still in their bolt phase. A strike
    // we discover already past 30 s (card-mount-with-existing-strikes
    // case) renders straight as a + with no flash.
    const pulseEnabled = cfg.lightning_pulse !== false && strike.isBolt;

    if (strike.isBolt) {
      // Bolt phase: single marker, no separate outline (the bolt's own
      // path stroke + halo do that work, and bolts don't suffer the
      // same stacking-blob problem +s do because they only last 30 s
      // and are bigger).
      const marker = L.marker([strike.lat, strike.lon], {
        icon: L.divIcon({
          html: this._boltSvg(boltSize, pulseEnabled),
          iconSize: [boltSize, boltSize],
          className: 'wrc-lightning-icon',
        }),
        pane: LIGHTNING_PANE,
        zIndexOffset: Math.floor(strike.ts / 1000),
      });
      marker.bindPopup(() => this._popupHtml(strike), {
        autoPan: true, autoPanPadding: [12, 12], maxHeight: this._popupMaxHeight(),
      });
      marker.addTo(this._map);
      this._markers.set(id, marker);
      if (pulseEnabled) this._wirePulseCleanup(marker);
      return;
    }

    // Plus phase: split into FILL + OUTLINE markers on different panes
    // so stacked outlines don't obscure stacked colour fills.
    const fillColor = colorForAge(this._ageSec(strike), this._displayMaxAgeSec());
    this._addPlusMarkers(id, strike, plusSize, fillColor);
  }

  // Build and attach the FILL + OUTLINE marker pair for a strike in the
  // + phase. Popup binds to the FILL marker (which sits on the higher
  // pane and intercepts clicks); the outline is non-interactive.
  private _addPlusMarkers(id: string, strike: Strike, size: number, fillColor: string): void {
    const z = Math.floor(strike.ts / 1000);
    const fillMarker = L.marker([strike.lat, strike.lon], {
      icon: L.divIcon({
        html: this._plusFillSvg(size, fillColor),
        iconSize: [size, size],
        className: 'wrc-lightning-icon',
      }),
      pane: LIGHTNING_PANE,
      zIndexOffset: z,
    });
    fillMarker.bindPopup(() => this._popupHtml(strike), {
      autoPan: true, autoPanPadding: [12, 12], maxHeight: this._popupMaxHeight(),
    });
    fillMarker.addTo(this._map);
    this._markers.set(id, fillMarker);

    const outlineMarker = L.marker([strike.lat, strike.lon], {
      icon: L.divIcon({
        html: this._plusOutlineSvg(size),
        iconSize: [size, size],
        className: 'wrc-lightning-icon',
      }),
      pane: LIGHTNING_OUTLINE_PANE,
      interactive: false,
      zIndexOffset: z,
    });
    outlineMarker.addTo(this._map);
    this._outlines.set(id, outlineMarker);
  }

  // SVG builders — one per phase. Both share the readability halo
  // (CSS drop-shadow) which gives every marker a 2 px black outline
  // against any basemap or radar overlay colour, regardless of stroke
  // colour. Cheaper and more reliable than nesting concentric SVG
  // shapes for a manual halo.
  //
  // The pulse animation class lives on the SVG, NOT the divIcon's
  // outer container — Leaflet owns the container's `transform` to
  // position the marker, and only one CSS transform value applies per
  // element (latest wins). If the pulse class went on the container,
  // our `transform: scale(2)` would clobber Leaflet's
  // `transform: translate3d(...)` for the duration of the keyframe,
  // visually snapping every flashing strike to the lightning pane's
  // origin (≈ map centre). Animating the inner SVG keeps Leaflet's
  // positioning intact.
  private static readonly HALO = 'filter:drop-shadow(0 0 1px #000) drop-shadow(0 0 1px #000);';

  // Bolt phase (0–30 s): white fill, thin red outline. The red echoes
  // the "danger / immediate" colour language without dominating the
  // shape; the halo gives it darker contrast against light basemaps.
  // We don't use the age gradient here (would be near-white anyway
  // across the 30 s window). Bolt renders at 1.3× the + size so the
  // "fresh!" indicator stands out against the older + markers
  // around it.
  private _boltSvg(size: number, pulse: boolean): string {
    const cls = pulse ? 'wrc-lightning-pulse' : '';
    return `<svg class="${cls}" viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;overflow:visible;${LightningLayer.HALO}">`
      + `<path fill="#fff" stroke="#ff0000" stroke-width="1" stroke-linejoin="round" d="${LIGHTNING_BOLT_PATH}"/>`
      + `</svg>`;
  }

  // Plus phase (30 s+) FILL marker: just the coloured + with no
  // stroke or halo — the outline marker on the lower pane provides
  // both. Stacked colours read clean (no per-marker stroke noise).
  private _plusFillSvg(size: number, fillColor: string): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;overflow:visible">`
      + `<path fill="${fillColor}" stroke="none" d="${LIGHTNING_PLUS_PATH}"/>`
      + `</svg>`;
  }

  // Plus phase (30 s+) OUTLINE marker: black-stroked + with no fill,
  // plus the drop-shadow halo for background contrast. Sits one z-step
  // below the fill marker, so when many strikes pile up at the same
  // location the outlines stack harmlessly underneath while the
  // topmost colour stays clean and visible. Stroke 1.5 in viewBox
  // units ≈ 1 px at the default 14 px icon size.
  private _plusOutlineSvg(size: number): string {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;overflow:visible;${LightningLayer.HALO}">`
      + `<path fill="none" stroke="#000" stroke-width="1.5" stroke-linejoin="miter" d="${LIGHTNING_PLUS_PATH}"/>`
      + `</svg>`;
  }

  // Remove the pulse class from the SVG once the animation finishes,
  // so a future re-render of this marker doesn't re-fire it. Listen on
  // the outer divIcon container — animationend bubbles up — but mutate
  // the SVG (which is the element actually carrying the class).
  private _wirePulseCleanup(marker: L.Marker): void {
    const el = marker.getElement();
    if (!el) return;
    const handler = (): void => {
      const svg = el.querySelector('svg');
      if (svg) svg.classList.remove('wrc-lightning-pulse');
      el.removeEventListener('animationend', handler);
    };
    el.addEventListener('animationend', handler);
  }

  private _removeMarker(id: string): void {
    const marker = this._markers.get(id);
    if (marker) {
      this._map.removeLayer(marker);
      this._markers.delete(id);
    }
    const outline = this._outlines.get(id);
    if (outline) {
      this._map.removeLayer(outline);
      this._outlines.delete(id);
    }
  }

  // Re-paint each + sign's fill, swap bolt → plus once a strike
  // crosses BOLT_DURATION_SEC, and remove strikes that have aged past
  // the display cap. The swap mutates the existing fill marker in
  // place (setIcon swaps the icon HTML but keeps the marker and its
  // popup binding) AND attaches the OUTLINE marker on the lower pane.
  // The colour-only refresh just mutates the fill marker's <path>
  // fill attribute. Bolt-phase markers are skipped — their colour
  // (white fill / red stroke) doesn't depend on age.
  private _refreshAges(): void {
    const max = this._displayMaxAgeSec();
    const cfg = this._getConfig();
    const plusSize = cfg.lightning_icon_size ?? DEFAULT_ICON_SIZE_PX;
    const toRemove: string[] = [];
    for (const [id, strike] of this._strikes) {
      const marker = this._markers.get(id);
      if (!marker) continue;
      const ageSec = this._ageSec(strike);

      // Past the display cap → drop the strike from the card. The
      // Blitzortung integration may still hold the underlying entity
      // (its own max-age is the upper bound); we just stop rendering.
      if (ageSec > max) {
        toRemove.push(id);
        continue;
      }

      // Form transition (one-way: bolt → plus). Swap the existing
      // marker's icon to the FILL SVG, then attach a new OUTLINE
      // marker on the lower pane. The popup binding survives setIcon
      // so users keep the click target. We don't re-fire the pulse —
      // it's a "just appeared!" cue, not recurring.
      if (strike.isBolt && ageSec >= BOLT_DURATION_SEC) {
        strike.isBolt = false;
        const fill = colorForAge(ageSec, max);
        marker.setIcon(L.divIcon({
          html: this._plusFillSvg(plusSize, fill),
          iconSize: [plusSize, plusSize],
          className: 'wrc-lightning-icon',
        }));
        const outlineMarker = L.marker([strike.lat, strike.lon], {
          icon: L.divIcon({
            html: this._plusOutlineSvg(plusSize),
            iconSize: [plusSize, plusSize],
            className: 'wrc-lightning-icon',
          }),
          pane: LIGHTNING_OUTLINE_PANE,
          interactive: false,
          zIndexOffset: Math.floor(strike.ts / 1000),
        });
        outlineMarker.addTo(this._map);
        this._outlines.set(id, outlineMarker);
        continue;
      }

      // Bolt phase has fixed colours — nothing to refresh.
      if (strike.isBolt) continue;

      // Plus phase: cheap fill-only refresh on the FILL marker. The
      // OUTLINE marker is age-independent (always black) — leave it.
      const el = marker.getElement();
      if (!el) continue;
      const pathEl = el.querySelector('svg path') as SVGPathElement | null;
      if (!pathEl) continue;
      pathEl.setAttribute('fill', colorForAge(ageSec, max));
    }
    // Drop expired strikes outside the iteration so we don't mutate
    // the Map we're walking. The strike stays in hass.states (the
    // integration's max-age governs that); we just stop tracking it.
    for (const id of toRemove) {
      this._strikes.delete(id);
      this._removeMarker(id);
    }
  }

  // Build the popup HTML. Inline-styled because Leaflet's popup container
  // lives outside the card's shadow root, so the card's CSS doesn't apply.
  // Re-rendered each open via the bindPopup factory so distance + relative
  // time are fresh.
  private _popupHtml(strike: Strike): string {
    const center = this._map.getCenter();
    const distKm = haversineKm(center.lat, center.lng, strike.lat, strike.lon);
    const bearing = bearingCardinal(center.lat, center.lng, strike.lat, strike.lon);
    const ageSec = this._ageSec(strike);
    const rel = relativeTime(ageSec);

    const distLabel = `${formatDistance(distKm, this._hass?.config?.unit_system?.length)} ${localize(`ui.lightning.bearing.${bearing}`)}`;
    const relLabel = rel.key === 'just_now'
      ? localize('ui.lightning.relative.just_now')
      : localize(`ui.lightning.relative.${rel.key}`).replace('{n}', String(rel.n));

    const url = formatBlitzortungUrl(this._map.getZoom(), strike.lat, strike.lon);

    return `
      <div style="font:12px/1.5 'Helvetica Neue',Arial,sans-serif;min-width:160px">
        <div style="font-weight:bold;font-size:13px;margin-bottom:4px">${escapeHtml(localize('ui.lightning.popup_title'))}</div>
        <div>${escapeHtml(distLabel)}</div>
        <div>${escapeHtml(relLabel)}</div>
        <div style="margin-top:6px;font-size:10px;color:#666">${escapeHtml(localize('ui.lightning.source_label'))}</div>
        <div style="margin-top:4px"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize('ui.lightning.more_info'))}</a></div>
      </div>
    `;
  }

  private _popupMaxHeight(): number {
    return Math.max(160, Math.floor(this._map.getSize().y * 0.8));
  }

  private _ageSec(strike: Strike): number {
    return Math.max(0, (Date.now() - strike.ts) / 1000);
  }

  // The effective max-age the card uses for both filtering (don't
  // render past this) and the colour gradient denominator. Returns
  // min(card cap, integration max). The card cap defaults to 30 min;
  // overridable via cfg.lightning_max_age_minutes. We never EXCEED
  // the integration's max-age — there's no point pretending strikes
  // exist that the integration has already dropped from hass.states.
  private _displayMaxAgeSec(): number {
    const cfg = this._getConfig();
    const cardCapMin = cfg.lightning_max_age_minutes ?? DEFAULT_MAX_AGE_MIN;
    // Floor at 1 min to keep the gradient meaningful and avoid silly
    // configs like 0 or negative values blanking the layer entirely.
    const cardCapSec = Math.max(60, cardCapMin * 60);
    return Math.min(cardCapSec, this._maxAgeSec());
  }

  // Try to pull the user's actual configured Blitzortung max-age out of
  // the integration's distance sensor's attributes. The integration
  // exposes a few config knobs there in some versions; if not present
  // we fall back to the integration's current default. See Open
  // Question 1 in docs/lightning-feature-design.md.
  private _maxAgeSec(): number {
    const dist = this._hass?.states?.['sensor.blitzortung_lightning_distance'];
    const attrs = (dist as any)?.attributes;
    // The integration historically exposed a 'window' attribute on this
    // sensor; newer versions may not. Be permissive and accept any of
    // the plausible names without committing to a specific schema.
    const candidates = [attrs?.window, attrs?.max_age, attrs?.max_age_seconds];
    for (const v of candidates) {
      if (typeof v === 'number' && v > 0) return v;
    }
    return DEFAULT_BLITZORTUNG_MAX_AGE_SEC;
  }
}

// Pull the strike's first-seen timestamp out of the entity state. The
// Blitzortung integration writes a publication_date attribute; if it's
// absent (older versions / future schema changes), fall back to the
// state's last_changed which is set when HA first saw the entity. The
// resolved value is epoch ms.
function parseStrikeTimestamp(state: any): number {
  const pub = state?.attributes?.publication_date;
  if (typeof pub === 'string') {
    const t = Date.parse(pub);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof pub === 'number') {
    // Heuristic: if the number is in seconds (10 digits), promote to ms.
    return pub < 1e12 ? pub * 1000 : pub;
  }
  const lc = state?.last_changed;
  if (typeof lc === 'string') {
    const t = Date.parse(lc);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}
