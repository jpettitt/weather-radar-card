// Pure geometry helpers shared by overlay layers (wildfire perimeters,
// NWS alert polygons, future GeoJSON overlays). Kept side-effect-free
// so they're trivially unit-testable.

// Compute the lng/lat bounding box of a Polygon or MultiPolygon. Returns
// null for unsupported geometry types (Point, LineString, etc.) or empty
// coordinate arrays. Skips coordinate pairs whose values aren't numbers.
//
// NOTE: bounding-box logic does not handle the antimeridian (180°E/W).
// A polygon spanning the dateline would report a bbox covering most of
// the planet. Acceptable for our current US-mainland use cases; revisit
// if Alaska/Aleutian zones become important.
export function geometryLngLatBounds(
  geom: GeoJSON.Geometry,
): { minLng: number; minLat: number; maxLng: number; maxLat: number } | null {
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  let any = false;
  const visit = (ring: GeoJSON.Position[]): void => {
    for (const p of ring) {
      const [lng, lat] = p;
      if (typeof lng !== 'number' || typeof lat !== 'number') continue;
      if (lng < minLng) minLng = lng;
      if (lat < minLat) minLat = lat;
      if (lng > maxLng) maxLng = lng;
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
  return any ? { minLng, minLat, maxLng, maxLat } : null;
}

// Bbox-centre, NOT a true polygon centroid — good enough for icon
// placement and rough distance filtering, and avoids pulling in
// @turf/centroid for a few KB. Returns [lng, lat] or null for empty
// / unsupported geometries.
export function centroidLngLat(geom: GeoJSON.Geometry): [number, number] | null {
  const b = geometryLngLatBounds(geom);
  if (!b) return null;
  return [(b.minLng + b.maxLng) / 2, (b.minLat + b.maxLat) / 2];
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
