// Pure geometry helpers shared by overlay layers (wildfire perimeters,
// NWS alert polygons, future GeoJSON overlays). Kept side-effect-free
// so they're trivially unit-testable.

// Compute the lng/lat bounding box of a Polygon or MultiPolygon. Returns
// null for unsupported geometry types (Point, LineString, etc.) or empty
// coordinate arrays. Skips coordinate pairs whose values aren't numbers.
//
// Antimeridian handling: a geometry genuinely crossing 180°E/W (Aleutian
// fires; NWS Alaska marine zones carry coordinates on both sides) would
// produce a naive min/max bbox spanning ~360° of longitude, putting the
// bbox-centre near lon 0 (mid-Atlantic) — which made the radius filters
// drop/keep those features wrongly and forced screen-wide polygon
// rendering. When the naive span exceeds 180° we renormalise negative
// longitudes into a continuous 0..360 window and recompute, so the
// returned bbox may legitimately have maxLng > 180 (continuous-window
// convention; Leaflet accepts unwrapped longitudes). centroidLngLat
// wraps its result back into [-180, 180].
export function geometryLngLatBounds(
  geom: GeoJSON.Geometry,
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  const lngs: number[] = [];
  let minLat = Infinity, maxLat = -Infinity;
  let any = false;
  const visit = (ring: GeoJSON.Position[]): void => {
    for (const p of ring) {
      const [lng, lat] = p;
      if (typeof lng !== 'number' || typeof lat !== 'number') continue;
      lngs.push(lng);
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      any = true;
    }
  };
  if (geom.type === 'Polygon') {
    for (const r of geom.coordinates) visit(r);
  } else if (geom.type === 'MultiPolygon') {
    for (const poly of geom.coordinates) for (const r of poly) visit(r);
  } else {
    return null;
  }
  if (!any) return null;

  let minLng = Math.min(...lngs);
  let maxLng = Math.max(...lngs);
  if (maxLng - minLng > 180) {
    // Suspected dateline crossing — recompute in a 0..360 window.
    // (A real single geometry spanning >180° of longitude without
    // crossing the dateline doesn't exist in our data sources.)
    const shifted = lngs.map((l) => (l < 0 ? l + 360 : l));
    const sMin = Math.min(...shifted);
    const sMax = Math.max(...shifted);
    // Only adopt the shifted window if it's actually tighter —
    // degenerate geometries keep the naive answer.
    if (sMax - sMin < maxLng - minLng) {
      minLng = sMin;
      maxLng = sMax;
    }
  }
  return { minLng, minLat, maxLng, maxLat };
}

// Bbox-centre, NOT a true polygon centroid — good enough for icon
// placement and rough distance filtering, and avoids pulling in
// @turf/centroid for a few KB. Returns [lng, lat] or null for empty
// / unsupported geometries. Longitude is wrapped to [-180, 180] (the
// bbox may use a continuous >180 window across the dateline).
export function centroidLngLat(geom: GeoJSON.Geometry): [number, number] | null {
  const b = geometryLngLatBounds(geom);
  if (!b) return null;
  let lng = (b.minLng + b.maxLng) / 2;
  if (lng > 180) lng -= 360;
  return [lng, (b.minLat + b.maxLat) / 2];
}

// Great-circle distance between two lat/lon points in kilometres.
// Standard haversine; mean Earth radius 6371 km. Accurate to ~0.5%
// over typical map distances — plenty for "is this fire within N km".
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Format a kilometre distance for display in HA's preferred length unit.
// `lengthUnit` is `hass.config.unit_system.length` ('km' or 'mi'). Anything
// other than 'mi' defaults to metric — matches the fallback convention used
// elsewhere in the card (Leaflet scale control, range rings).
const KM_TO_MILES = 0.621371;
export function formatDistance(distKm: number, lengthUnit: string | undefined): string {
  if (lengthUnit === 'mi') {
    return `${Math.round(distKm * KM_TO_MILES)} mi`;
  }
  return `${Math.round(distKm)} km`;
}
