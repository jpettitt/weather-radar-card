# Example Configurations

Sample YAML for common setups. The GUI editor covers most of these without needing YAML.

## Basic radar loop with a static home marker

```yaml
type: 'custom:weather-radar-card'
past_minutes: 90
center_latitude: -25.567607
center_longitude: 152.930597
show_range: true
show_zoom: true
show_recenter: true
show_playback: true
zoom_level: 8
markers:
  - latitude: -26.175328
    longitude: 152.653189
    icon: mdi:home
```

## Dense 24-hour DWD loop

RainViewer caps at ~2 h of past, so a full-day loop needs DWD. Combine `past_minutes` with `frame_stride_minutes` to keep the frame count manageable on long ranges.

```yaml
type: 'custom:weather-radar-card'
data_source: DWD
past_minutes: 1440          # 24 h
frame_stride_minutes: 10    # one frame every 10 min instead of the native 5 min
frame_delay: 100
markers:
  - latitude: 52.520008
    longitude: 13.404954
```

## DWD with 2-hour nowcast forecast

The forecast frames sit at the end of the timeline. The "now" marker on the progress bar shows where wall-clock time falls — useful when forecast frames push "now" away from the rightmost edge.

```yaml
type: 'custom:weather-radar-card'
data_source: DWD
past_minutes: 120        # 2 h history
forecast_minutes: 120    # 2 h nowcast
zoom_level: 7
show_playback: true
```

## Custom card dimensions

```yaml
type: 'custom:weather-radar-card'
height: '400px'
width: '600px'
show_playback: true
zoom_level: 7
```

## Tablet-friendly timeline scrubbing

Increase the touch target upward over the lower map area while keeping the visible progress track slim and the bottom bar at its original height.

```yaml
type: 'custom:weather-radar-card'
show_progress_bar: true
progress_bar_touch_height: 44
```

## US NOAA radar with slow crossfade

```yaml
type: 'custom:weather-radar-card'
data_source: NOAA
map_style: Light
zoom_level: 8
past_minutes: 30        # 6 frames at NOAA's 5-min interval
frame_delay: 600
transition_time: 300
show_playback: true
show_recenter: true
```

## Localized map labels using OpenStreetMap

```yaml
type: 'custom:weather-radar-card'
map_style: OSM
zoom_level: 7
markers:
  - latitude: -33.86
    longitude: 151.21
    icon: mdi:home
```

## Desktop shows home marker, mobile shows current device location

```yaml
type: 'custom:weather-radar-card'
center_latitude: -25.567607
center_longitude: 152.930597
show_range: true
zoom_level: 8
markers:
  - latitude: -25.567607
    longitude: 152.930597
    icon: mdi:home

  - entity: device_tracker.my_phone
    icon: entity_picture
    mobile_only: true
```

## Track a person — map follows them when they are the logged-in user

```yaml
type: 'custom:weather-radar-card'
show_range: true
show_recenter: true
zoom_level: 9
markers:
  - entity: person.john
    icon: entity_picture
    track: entity
```

## US wildfire perimeter overlay

```yaml
type: 'custom:weather-radar-card'
data_source: NOAA
center_latitude: 37.7749
center_longitude: -122.4194
zoom_level: 6
show_wildfires: true
wildfire_min_acres: 100   # only show larger incidents
```

## US NWS watches & warnings overlay, severe and above only

```yaml
type: 'custom:weather-radar-card'
data_source: NOAA
center_latitude: 35.4676
center_longitude: -97.5164
zoom_level: 7
show_alerts: true
alerts_min_severity: Severe
alerts_categories:
  - tornado
  - thunderstorm
  - flood
```

## FAA VFR Sectional chart with live radar overlay

A custom tile source doesn't have to be a conventional basemap — aeronautical charts work too. Lowering `radar_opacity` keeps the sectional's airspace rings, MOAs, VOR roses and elevations legible under the radar composite.

```yaml
type: 'custom:weather-radar-card'
map_style: Custom
custom_tile_url: https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/VFR_Sectional/MapServer/tile/{z}/{y}/{x}
custom_tile_attribution: FAA Aeronautical Information Services
custom_tile_theme: light
radar_opacity: 0.5
data_source: RainViewer
center_latitude: 39.3152
center_longitude: -102.2662
zoom_level: 9
```

## Smooth animation with sequential overlap (no brightness dip)

Lighter basemaps benefit from `smooth_overlap: 0` so the previous frame holds at full opacity until the new one is fully in.

```yaml
type: 'custom:weather-radar-card'
map_style: Light
past_minutes: 90
smooth_animation: true
smooth_overlap: 0
```

## 4.0: vector map in the classic style, with labels above the radar

Needs Home Assistant 2026.10 or later. The vector map draws place names above the radar, so they stay readable through rain. `classic` gives the colours of the standard OpenStreetMap map. `theme_mode: auto` follows your theme and uses the hand-tuned dark version in dark mode.

```yaml
type: 'custom:weather-radar-card'
map_style: MapTilesVector
vector_style: classic
theme_mode: auto
past_minutes: 90
show_zoom: true
show_recenter: true
show_playback: true
```

## 4.0: satellite imagery with labels above the radar

On Home Assistant 2026.10 or later, `Satellite` draws place and street names from HA's map tiles above the radar. No CARTO key is needed.

```yaml
type: 'custom:weather-radar-card'
map_style: Satellite
past_minutes: 60
show_recenter: true
show_playback: true
```

## 4.0: more place names on the vector map

`extra_labels` shows each label kind a zoom level earlier, smaller and packed tighter. On the vector map and for Satellite labels it works from the label data; on raster maps it draws the tiles a zoom level higher at half size.

```yaml
type: 'custom:weather-radar-card'
map_style: MapTilesVector
vector_style: classic
extra_labels: true
zoom_level: 11
```

## 4.0: view presets — tour the people and places you care about

The re-centre button rotates through the tracked person, Default (the configured centre), and each preset. A preset is a fixed spot or an entity the map follows, each with its own zoom. The preset's name shows beside the button. After `preset_timeout` idle minutes the map returns to the tracked person on its own.

```yaml
type: 'custom:weather-radar-card'
show_recenter: true
zoom_level: 8
markers:
  - entity: person.alex
    track: entity
presets:
  - name: Work
    latitude: 48.14
    longitude: 11.58
    zoom: 11
  - entity: device_tracker.car
    zoom: 12
  - name: Region
    latitude: 48.5
    longitude: 11.0
    zoom: 7
preset_timeout: 5
```

## 4.0: layer toggles, saved per user

`show_layer_toggles` adds a button for each overlay the card has turned on. A hidden overlay stops fetching. With `viewer_layer_control`, each user's choices are saved across devices; without it they last until the page reloads.

```yaml
type: 'custom:weather-radar-card'
data_source: NOAA
past_minutes: 60
show_alerts: true
show_wildfires: true
dwd_wind: arrows
show_layer_toggles: true
viewer_layer_control: true
```

## 4.0: wall tablet with the vector map, presets and toggles

Everything above on one card. `low_power_mode` is off here; turn it on for an old tablet, which then shows `MapTiles` instead of the vector map.

```yaml
type: 'custom:weather-radar-card'
map_style: MapTilesVector
vector_style: classic
theme_mode: dark
data_source: DWD
past_minutes: 120
forecast_minutes: 60
forecast_refresh_minutes: 15
show_zoom: true
show_recenter: true
show_playback: true
show_layer_toggles: true
viewer_layer_control: true
show_alerts: false
dwd_wind_flow: true
markers:
  - entity: person.alex
    track: entity
presets:
  - name: Home
    entity: zone.home
    zoom: 10
  - entity: device_tracker.car
    zoom: 12
preset_timeout: 10
```
