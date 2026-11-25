# Network access

The card runs in your browser. This page lists each server outside Home Assistant that the browser contacts for the card, why, and when. The card contacts a server only when a setting uses it. It sends no analytics or telemetry.

## Servers the card contacts

| Domain | Purpose | When |
| --- | --- | --- |
| `api.rainviewer.com` | RainViewer radar: the list of frames | `data_source: RainViewer` (the default) |
| `tilecache.rainviewer.com` | RainViewer radar tiles. The frame list gives this host. | `data_source: RainViewer` (the default) |
| `opengeo.ncep.noaa.gov` | NOAA radar: frame times and tiles | `data_source: NOAA` |
| `mapservices.weather.noaa.gov` | NOAA radar tiles from an older service | `data_source: NOAA`, only when the card can't read the frame times from `opengeo.ncep.noaa.gov` |
| `mapservices.weather.noaa.gov` | NDFD wind data | A wind overlay (`dwd_wind` or `dwd_wind_flow`) with `wind_source: ndfd_wind`, when the map centre is in NDFD coverage (US) |
| `maps.dwd.de` | DWD radar and forecast: the newest model run, frame times and tiles | `data_source: DWD` |
| `maps.dwd.de` | DWD ICON and AICON wind data | A wind overlay with `wind_source: dwd_aicon` (the default) or `dwd_icon`. With `wind_source: ndfd_wind`, when the map centre is outside NDFD coverage |
| `api.weather.gov` | Active NWS alerts, and the outlines of their zones | `show_alerts: true` |
| `services3.arcgis.com` | US wildfire perimeters (NIFC WFIGS) | `show_wildfires: true` |
| `inciweb.wildfire.gov` | Finds the fire's InciWeb page for the link in its popup | `show_wildfires: true`, when you open a fire popup |
| `earthquake.usgs.gov` | USGS earthquake feed | `show_earthquakes: true` |
| `a`–`d.basemaps.cartocdn.com` | CARTO map tiles and labels | `map_style: Light`, `Dark` or `Voyager`. `Satellite` labels with a `carto_api_key`, only where Home Assistant's map tiles can't draw them |
| `server.arcgisonline.com` | Esri map tiles | `map_style: Satellite`, `Grey` or `GreyDark` |
| `a`–`c.tile.openstreetmap.org` | OpenStreetMap tiles | `map_style: OSM`. `MapTiles` and `MapTilesVector` when Home Assistant has no `map_tiles` integration (before 2026.10). `Custom` without a usable `custom_tile_url` |
| The host in `custom_tile_url` | Your own map tiles | `map_style: Custom` |

`map_style: Auto` (also when `map_style` is not set) uses one of these maps or Home Assistant's own. [Map Style](configuration.md#map-style) tells which one it uses.

## Requests to Home Assistant

These requests go to your Home Assistant, not to an outside server:

- The card's files, from `/local/community/weather-radar-card/`.
- `MapTiles`, `MapTilesVector` and the `Satellite` place names on Home Assistant 2026.10 and later: tiles, styles, fonts and icons, from Home Assistant's `map_tiles` integration. Home Assistant's server, not your browser, gets these from `tile.openstreetmap.org` and `vector.openstreetmap.org`.
- Lightning: the card reads the strikes of the Blitzortung integration from Home Assistant. The integration, not the card, connects to Blitzortung.
- `viewer_layer_control`: each user's overlay choices, which Home Assistant keeps.

## What the requests send

- Your browser's IP address, as with each request on the web.
- Tile and wind requests ask for the part of the map that you see.
- Tile requests send only the address of your Home Assistant (for example `https://ha.example.com`) as `Referer`, not the dashboard path. Other requests send no `Referer`, because Home Assistant's pages set `Referrer-Policy: no-referrer`.
- CARTO tile requests include your `carto_api_key`.

## Links

Links in the map credits, the popups and the editor open these sites only when you select them: `rainviewer.com`, `weather.gov` (credits and alert pages), `dwd.de`, `openstreetmap.org`, `carto.com`, `esri.com`, `arcgis.com`, `leafletjs.com`, `inciweb.wildfire.gov`, `earthquake.usgs.gov` (earthquake pages), `tsunami.gov`, `map.blitzortung.org` and `github.com`.
