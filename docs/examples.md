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

## Smooth animation with sequential overlap (no brightness dip)

Lighter basemaps benefit from `smooth_overlap: 0` so the previous frame holds at full opacity until the new one is fully in.

```yaml
type: 'custom:weather-radar-card'
map_style: Light
past_minutes: 90
smooth_animation: true
smooth_overlap: 0
```
