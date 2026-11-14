# External GeoJSON Overlay Design

## Purpose

`geojson_overlays` adds a general-purpose, opt-in path for rendering externally hosted line data on the Weather Radar Card map. It is deliberately not a Ridge to Rivers integration: a source supplies its own name, URL, style mapping, popup fields, attribution and relevance constraints.

The first version accepts only GeoJSON `LineString` and `MultiLineString` features. That matches trail and route data while avoiding an unreviewed interaction between arbitrary polygons/points and the card's established alert, wildfire and marker panes.

## Architecture

`src/geojson-overlay-layer.ts` owns one `GeoJsonOverlayLayer` per configured, enabled source. It:

- fetches the source directly in the browser with an `AbortController`;
- ignores unsupported geometry before rendering;
- draws accepted features through `sharedCanvasRenderer`, preserving the card's pointer-event and canvas-layer conventions;
- styles each feature from a configured property mapping and neutral fallback;
- builds only configured popups, escaping all source text before HTML interpolation;
- formats configured epoch-millisecond date properties through Home Assistant's locale helper;
- cancels timers, map listeners and in-flight work on removal.

The card creates the layers only while the corresponding `geojson:<id>` visibility key is on. `layer-toggles.ts` derives those dynamic keys from enabled config sources and sends their display names to the Leaflet control. Dynamic keys use the same viewer-state persistence path as the built-in layers.

## Fetch, cache and relevance lifecycle

A process-wide in-memory cache is keyed by source URL and stores only successfully fetched, supported line features. It is shared by card instances so a toggle-off/toggle-on cycle can render immediately without another request. It is intentionally not persisted across a browser reload, avoiding stale provider data in Home Assistant storage.

`refresh_minutes` schedules the next refresh only after a cache render or a completed fetch. A request cannot overlap another. If a refresh fails, the current line layer remains present and no failure enters the cache.

When `bounds` or `min_zoom` makes a source irrelevant, `moveend` / `zoomend` suspends the layer: its rendering, refresh timer and request stop, while the successful in-memory cache remains available for return to the area. Bounds are a WGS84 `[west, south, east, north]` tuple.

## External-data and compatibility considerations

No source fetch occurs without `enabled: true`. The provider must allow direct browser CORS access. Data-source terms, accuracy, availability and required attribution remain the dashboard author's responsibility; the card does not claim a configured condition colour is provider-official.

The implementation does not paginate provider-specific services or transform source coordinate systems. A configured URL must already return a complete GeoJSON FeatureCollection in the coordinate system Leaflet expects. This keeps the generic overlay engine independent of ArcGIS and avoids hard-coded regional behavior.

## Validation

Unit tests cover source enablement, accepted geometry, style mapping and fallback, escaped popup content, locale date handling, cache reuse, refresh timing, failure preservation, relevance filtering, dynamic controls and cleanup. Browser-only CORS enforcement, canvas hit testing, touch interaction and performance during radar/wind animation require the disposable Home Assistant testbed.
