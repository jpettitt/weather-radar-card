import * as L from 'leaflet';
import { sharedCanvasRenderer } from './shared-canvas-renderer';

export interface GeoJsonOverlaySource {
  id: string;
  name: string;
  url: string;
  /** External GeoJSON sources are opt-in so an added config never fetches unexpectedly. */
  enabled?: boolean;
  color?: string;
}

const DEFAULT_COLOR = '#3388ff';
const LINE_WEIGHT = 3;

/** Sources that the dashboard author deliberately enabled. */
export function enabledGeoJsonSources(sources: GeoJsonOverlaySource[] | undefined): GeoJsonOverlaySource[] {
  return (sources ?? []).filter((source) => source.enabled === true);
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
      this._render(features, source.color ?? DEFAULT_COLOR);
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

  private _render(features: GeoJSON.Feature[], color: string): void {
    if (this._layer) this._map.removeLayer(this._layer);
    this._layer = L.geoJSON(features, {
      renderer: sharedCanvasRenderer(this._map),
      style: { color, weight: LINE_WEIGHT },
    } as L.GeoJSONOptions);
    this._layer.addTo(this._map);
  }
}

function isLineFeature(feature: GeoJSON.Feature): boolean {
  return feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString';
}
