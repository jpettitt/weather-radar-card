import * as L from 'leaflet';
import { formatDate, type FrontendLocaleData } from 'custom-card-helpers';
import { sharedCanvasRenderer } from './shared-canvas-renderer';
import { escapeHtml } from './string-utils';

export interface GeoJsonOverlaySource {
  id: string;
  name: string;
  url: string;
  /** External GeoJSON sources are opt-in so an added config never fetches unexpectedly. */
  enabled?: boolean;
  color?: string;
  color_property?: string;
  color_map?: Record<string, string>;
  fallback_color?: string;
  popup_fields?: string[];
  date_properties?: string[];
  attribution?: string;
}

const DEFAULT_COLOR = '#3388ff';
const LINE_WEIGHT = 3;

/** Sources that the dashboard author deliberately enabled. */
export function enabledGeoJsonSources(sources: GeoJsonOverlaySource[] | undefined): GeoJsonOverlaySource[] {
  return (sources ?? []).filter((source) => source.enabled === true);
}

export function colorForFeature(
  properties: GeoJSON.GeoJsonProperties | undefined,
  source: GeoJsonOverlaySource,
): string {
  const value = source.color_property ? properties?.[source.color_property] : undefined;
  const mapped = typeof value === 'string' ? source.color_map?.[value] : undefined;
  return mapped ?? source.fallback_color ?? source.color ?? DEFAULT_COLOR;
}

export function buildPopupHtml(
  properties: GeoJSON.GeoJsonProperties | undefined,
  source: GeoJsonOverlaySource,
  locale?: FrontendLocaleData,
): string {
  const rows = (source.popup_fields ?? []).flatMap((field) => {
    const value = properties?.[field];
    if (value == null || value === '') return [];
    return `<div><b>${escapeHtml(fieldLabel(field))}:</b> ${escapeHtml(formatPopupValue(value, field, source, locale))}</div>`;
  });
  const attribution = source.attribution
    ? `<div style="margin-top:6px;font-size:10px;color:#666">Source: ${escapeHtml(source.attribution)}</div>`
    : '';
  return `<div style="font:12px/1.4 'Helvetica Neue',Arial,sans-serif;min-width:180px">${rows.join('')}${attribution}</div>`;
}

function fieldLabel(field: string): string {
  return field.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function formatPopupValue(
  value: unknown,
  field: string,
  source: GeoJsonOverlaySource,
  locale: FrontendLocaleData | undefined,
): string {
  if (source.date_properties?.includes(field) && typeof value === 'number') {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return locale ? formatDate(date, locale) : date.toLocaleDateString();
  }
  return String(value);
}

/**
 * Fetches and displays the linework from one external GeoJSON FeatureCollection.
 * The card owns its lifecycle; this class is intentionally unaware of card config
 * so subsequent phases can add configuration and toggle wiring independently.
 */
export class GeoJsonOverlayLayer {
  private _layer: L.GeoJSON | null = null;

  private _abortCtrl: AbortController | null = null;

  private _generation = 0;

  constructor(
    private readonly _map: L.Map,
    private readonly _source: () => GeoJsonOverlaySource,
    private readonly _getLocale?: () => FrontendLocaleData | undefined,
  ) {}

  async start(): Promise<void> {
    const generation = ++this._generation;
    this._abortCtrl?.abort();
    const ctrl = new AbortController();
    this._abortCtrl = ctrl;
    const source = this._source();

    try {
      const response = await fetch(source.url, { cache: 'no-cache', signal: ctrl.signal });
      if (!response.ok) throw new Error(`GeoJSON overlay fetch ${response.status}`);
      const data = await response.json() as GeoJSON.FeatureCollection;
      if (ctrl.signal.aborted || generation !== this._generation) return;
      const features = (data?.features ?? []).filter(isLineFeature);
      this._render(features, source);
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') console.warn(`GeoJSON overlay "${source.id}" fetch failed`, err);
    } finally {
      if (this._abortCtrl === ctrl) this._abortCtrl = null;
    }
  }

  clear(): void {
    this._generation++;
    this._abortCtrl?.abort();
    this._abortCtrl = null;
    if (this._layer) this._map.removeLayer(this._layer);
    this._layer = null;
  }

  private _render(features: GeoJSON.Feature[], source: GeoJsonOverlaySource): void {
    if (this._layer) this._map.removeLayer(this._layer);
    this._layer = L.geoJSON(features, {
      renderer: sharedCanvasRenderer(this._map),
      style: (feature) => ({ color: colorForFeature(feature?.properties, source), weight: LINE_WEIGHT }),
      onEachFeature: (feature, layer) => {
        if ((source.popup_fields?.length ?? 0) === 0) return;
        layer.bindPopup(() => buildPopupHtml(feature.properties, source, this._getLocale?.()), {
          autoPan: true,
          autoPanPadding: [12, 12],
        });
      },
    } as L.GeoJSONOptions);
    this._layer.addTo(this._map);
  }
}

function isLineFeature(feature: GeoJSON.Feature): boolean {
  return feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString';
}
