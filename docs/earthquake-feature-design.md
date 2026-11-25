# Earthquake overlay — design

Recent earthquakes worldwide from the USGS, drawn in the style of the USGS map.

**Implementation:** [src/earthquake-layer.ts](../src/earthquake-layer.ts). Tests in [tests/earthquake-layer.test.ts](../tests/earthquake-layer.test.ts) run the real layer on a real Leaflet map against [tests/fixtures/usgs-feed-sample.json](../tests/fixtures/usgs-feed-sample.json), ten features as the USGS feeds sent them.

## Data source

The USGS real-time GeoJSON summary feeds:

```text
https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/{level}_{period}.geojson
  level:  significant | 4.5 | 2.5 | 1.0 | all
  period: hour | day | week | month
```

### Why the feeds, not the FDSN query

The FDSN event service (`/fdsnws/event/1/query`) can filter by area, magnitude and time, but:

- USGS asks for the feeds: "automated applications should use Real-time GeoJSON Feeds for displaying earthquake information whenever possible, as they will have the best performance and availability".
- All cards request the same feed URLs, which stay in the USGS CDN cache (CloudFront, `max-age=60`). A query with each card's map area and a start time that moves each minute is a new URL each time, so each one goes to the USGS origin servers.

The feeds are small enough to filter in the browser (probed 2026-11-24, IPv4 and IPv6 the same):

| Feed | gzip | events |
| --- | --- | --- |
| `2.5_day` | 5 KB | 48 |
| `2.5_week` | 34 KB | 345 |
| `all_week` | 171 KB | 1,890 |
| `all_month` | 842 KB | ~10,000 |

All feeds send `access-control-allow-origin: *` and `last-modified`, and a conditional request gets a 304. The `significant` feeds are not used: significance is a separate USGS score, not a magnitude.

### Feed choice

`earthquake_min_magnitude` picks the highest level at or below it (4.5, 2.5, 1.0, else `all`), and the card drops the events below the minimum. USGS puts an event in a level's feed when its magnitude rounded to one decimal is at least the level (2.46 is in `2.5_week`, 0.95 in `1.0_week`), so the card's filter rounds the same way. Small events are mostly in the US: outside it, the catalogue holds few events below M2.5.

### Home Assistant's USGS integration

Core's `usgs_earthquakes_feed` is a legacy, YAML-only `geo_location` platform with a 50 km default radius. Its entities have no depth, tsunami flag, felt reports or event link. The card does not use it.

## Visual model

The values come from the code of the USGS Latest Earthquakes map (its main bundle, read 2026-11-24: `getMarkerStyles`, `getMarkerSizes`, `getWidth`). Do not measure them from a screenshot of the map's legend: a screenshot at 2x pixel density doubles the sizes, and colour management changes the colours.

| Age (at most) | Fill |
| --- | --- |
| 1 hour | `#f00` |
| 1 day | `#f90` |
| 7 days | `#ff0` |
| 30 days | `#fff` |
| Older | `#ccc` |

Diameters in px for magnitude classes 0, 1, … 7+:

| Map zoom | Diameters |
| --- | --- |
| below 5 | 5, 7, 9, 11, 13, 17, 21, 25 |
| 5 to below 8 | 8, 10, 12, 14, 17, 22, 27, 32 |
| 8 and more | 12, 13, 15, 17, 19, 24, 30, 36 |

- **Size:** the class is the whole magnitude, 7 and more in one class. USGS puts a magnitude of exactly 0, and negative ones, in class 1; the card puts every magnitude below 1 in class 0.
- **Shape:** a circle for `type: earthquake`, a diamond for every other type (quarry blast, explosion, ice quake and others), as on the USGS map.
- **Outline:** black, 0.5 px, as on the USGS map. On dark maps black disappears, so the card uses a light outline there.
- **Order:** larger events under smaller ones, so a small event inside a large one's circle stays visible; then older under newer.

A marker changes colour when its event passes an age boundary. The layer sets a timer for the next boundary (1 ms after an age limit, at most one hour ahead, because `setTimeout` fires at once for delays over 2^31 − 1 ms) and repaints without a fetch.

## Rendering

One canvas in the `wrc-earthquakes` pane (z-index 405: above the alert and fire outlines in `overlayPane`, under lightning). The canvas handling is the same as the lightning layer's (see [lightning-feature-design.md](lightning-feature-design.md)):

- **No DOM markers.** The month feed with all magnitudes holds about 10,000 events.
- **No Leaflet canvas renderer.** A second renderer stacked over the shared one would take the clicks meant for alert and fire outlines (see `shared-canvas-renderer.ts`). The pane has `pointer-events: none`, and a map-level click hit-tests the drawn events. Of the events under the click, the largest magnitude wins (the newer on a tie). Owner decision 2026-11-23: with small markers drawn over large ones, "topmost wins" opened an M1.0 for a click on the centre of an M5.
- **Canvas size limits** for iPhone and iPad come from `lightningCanvasPad` and `lightningCanvasDpr`. The canvas leaves the page during a zoom and repaints when the map has been still for a second.

Each event is drawn, hit-tested and given its popup at the copy of its longitude nearest the map centre (`lngNear` in `geo-utils.ts`). After a pan across the antimeridian, Leaflet keeps unwrapped longitudes: a view of Asia reached by panning west from the US ran from -320 to -202, and the events drawn at the feed's -180..180 longitudes were a world away (an M5.3 in India was missing).

The popup is a free `L.popup` opened with `openOn`, not bound to a drawn shape, so a refresh or repaint never closes it. Its text is built when it opens.

## Popup

Magnitude, and the type for events that are not earthquakes; place; time in HA's locale with how long ago; depth in km or miles from HA's unit system; review status. When USGS has the data, the popup also shows felt reports, the PAGER alert level, and the tsunami note. USGS's archived definition says the tsunami flag is set "for large events in oceanic regions" and "does not indicate if a tsunami actually did or will exist". The live feed also sets it inland: on 2026-11-24, 5 of 345 M2.5+ events of the week had it, among them Pinnacles CA (M5.0), Commerce CA (M3.9) and Carhuamayo, Peru (M6.7). So the popup says only that USGS links the event to tsunami information, and links to tsunami.gov. Feed text is escaped, feed values pick localized strings only through own-property lookups, and the event link must be `https://`.

## Lifecycle

The same rules as the wildfire and NWS alerts layers:

- Each fetch has a generation number and an `AbortController`; `withTimeout` limits it to `DATA_TIMEOUT_MS`.
- A failed fetch keeps what is drawn and retries after 1×, 2×, 4×… the refresh interval, up to one hour.
- Refresh every 5 minutes (`earthquake_refresh_minutes`, at least 1). The feeds change each minute.
- `pause()` keeps only the due time, and `resume()` fetches at once when the refresh came due while the card was hidden. Restarting the full interval at each resume would stop the refresh for a card hidden and shown more often than the interval. `preload_while_hidden` keeps fetching.
- The card pauses a layer that starts while the card is hidden (`_startOverlay`).

## Not in this version

- Showing each event in step with the radar loop's time.
- The `significant` feeds.
