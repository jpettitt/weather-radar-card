/* eslint-disable @typescript-eslint/no-explicit-any */
import * as L from 'leaflet';
import { HomeAssistant } from 'custom-card-helpers';
import { WeatherRadarCardConfig } from './types';
import { LIGHTNING_BOLT_PATH } from './marker-icon';
import { localize } from './localize/localize';
import { haversineKm } from './geo-utils';
import { escapeHtml } from './string-utils';
import {
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
// 30 s recompute of the age-derived fill — the design doc's chosen
// cadence. Smoothing the age across 30 s on a multi-thousand-second
// gradient is visually indistinguishable from continuous fade and
// avoids per-marker timers.
const AGE_REFRESH_MS = 30 * 1000;

interface Strike {
  ts: number;        // epoch ms when the strike was first observed
  lat: number;
  lon: number;
}

export class LightningLayer {
  private _map: L.Map;
  private _getConfig: () => WeatherRadarCardConfig;
  private _hass: HomeAssistant | undefined;

  // Two parallel maps keyed by entity_id (geo_location.lightning_strike_*).
  // Splitting strike data from the Leaflet marker keeps _refreshAges()
  // small — it iterates _strikes and recolours the matching marker, no
  // need to dig coords or timestamps back out of the marker DOM.
  private _strikes: Map<string, Strike> = new Map();
  private _markers: Map<string, L.Marker> = new Map();

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
    this._refreshFromHass();
    this._ageTimer = setInterval(() => this._refreshAges(), AGE_REFRESH_MS);
  }

  clear(): void {
    if (this._ageTimer) { clearInterval(this._ageTimer); this._ageTimer = null; }
    for (const marker of this._markers.values()) {
      this._map.removeLayer(marker);
    }
    this._markers.clear();
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
  // attribute is the disambiguator.
  private _collectStrikes(): Map<string, Strike> {
    const out = new Map<string, Strike>();
    if (!this._hass?.states) return out;
    for (const [id, st] of Object.entries(this._hass.states)) {
      if (!id.startsWith('geo_location.')) continue;
      const attrs = (st as any)?.attributes;
      if (!attrs || attrs.source !== 'blitzortung') continue;
      const lat = attrs.latitude;
      const lon = attrs.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number') continue;
      out.set(id, { ts: parseStrikeTimestamp(st), lat, lon });
    }
    return out;
  }

  private _addMarker(id: string, strike: Strike): void {
    const cfg = this._getConfig();
    const size = cfg.lightning_icon_size ?? DEFAULT_ICON_SIZE_PX;
    const pulseEnabled = cfg.lightning_pulse !== false;

    const fill = colorForAge(this._ageSec(strike), this._maxAgeSec());
    // Inline SVG so the per-strike fill colour can be set directly. Stroke
    // uses HA's primary text colour so the bolt outline reads on light
    // and dark basemaps without a per-style branch. Both fill and stroke
    // get refreshed by _refreshAges() on the 30 s timer.
    const html = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;overflow:visible">`
      + `<path fill="${fill}" stroke="var(--primary-text-color, #000)" stroke-width="0.6" stroke-linejoin="round" d="${LIGHTNING_BOLT_PATH}"/>`
      + `</svg>`;

    const className = pulseEnabled
      ? 'wrc-lightning-icon wrc-lightning-pulse'
      : 'wrc-lightning-icon';
    const icon = L.divIcon({
      html,
      iconSize: [size, size],
      className,
    });
    const marker = L.marker([strike.lat, strike.lon], { icon });
    // Bind the popup as a factory so distance / bearing / relative time
    // are recomputed at popup-open — the map may have panned and a few
    // seconds may have passed since the strike was added. A stale fixed
    // popup would show the wrong "X s ago".
    marker.bindPopup(() => this._popupHtml(strike), {
      autoPan: true,
      autoPanPadding: [12, 12],
      maxHeight: this._popupMaxHeight(),
    });
    marker.addTo(this._map);
    this._markers.set(id, marker);

    // The pulse class triggers a one-shot CSS keyframe animation on the
    // outer divIcon container. Remove the class once the animation
    // finishes so a future re-render of this marker doesn't re-fire.
    // Skip when reduced-motion is preferred — the CSS already disables
    // the animation; this just keeps the className tidy.
    if (pulseEnabled) {
      const el = marker.getElement();
      if (el) {
        const handler = (): void => {
          el.classList.remove('wrc-lightning-pulse');
          el.removeEventListener('animationend', handler);
        };
        el.addEventListener('animationend', handler);
      }
    }
  }

  private _removeMarker(id: string): void {
    const marker = this._markers.get(id);
    if (!marker) return;
    this._map.removeLayer(marker);
    this._markers.delete(id);
  }

  // Re-paint each visible marker's fill. Cheap — tens of markers in
  // typical use, single SVG attribute write per marker.
  private _refreshAges(): void {
    const max = this._maxAgeSec();
    for (const [id, strike] of this._strikes) {
      const marker = this._markers.get(id);
      if (!marker) continue;
      const el = marker.getElement();
      if (!el) continue;
      const path = el.querySelector('svg path') as SVGPathElement | null;
      if (!path) continue;
      path.setAttribute('fill', colorForAge(this._ageSec(strike), max));
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

    const distLabel = `${Math.round(distKm)} km ${localize(`ui.lightning.bearing.${bearing}`)}`;
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
        <div style="margin-top:4px"><a href="${url}" target="_blank" rel="noopener noreferrer">${escapeHtml(localize('ui.lightning.more_info'))}</a></div>
      </div>
    `;
  }

  private _popupMaxHeight(): number {
    return Math.max(160, Math.floor(this._map.getSize().y * 0.8));
  }

  private _ageSec(strike: Strike): number {
    return Math.max(0, (Date.now() - strike.ts) / 1000);
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
