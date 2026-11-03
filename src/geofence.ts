/**
 * Geometría de las geocercas de reparto.
 *
 * Los polígonos se guardan en GeoJSON (anillo de pares [lng, lat]) y las
 * comprobaciones se hacen sobre coordenadas reales del dispositivo, nunca sobre
 * una posición inventada por la app.
 */

export type Ring = number[][];
export type GeoPolygon = { type: "Polygon"; coordinates: Ring[] };
export type GeoMultiPolygon = { type: "MultiPolygon"; coordinates: Ring[][] };
export type GeoGeometry = GeoPolygon | GeoMultiPolygon;

const EARTH_RADIUS_M = 6_371_000;

function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

/** Distancia en metros entre dos puntos (haversine). */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRadians(bLat - aLat);
  const dLng = toRadians(bLng - aLng);
  const lat1 = toRadians(aLat);
  const lat2 = toRadians(bLat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Punto dentro de un anillo por el algoritmo de lanzamiento de rayo. */
export function pointInRing(lat: number, lng: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const yi = ring[i][1];
    const xi = ring[i][0];
    const yj = ring[j][1];
    const xj = ring[j][0];
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonsOf(geometry: GeoGeometry): Ring[][] {
  return geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
}

/** Dentro de la geocerca, teniendo en cuenta agujeros interiores. */
export function pointInGeometry(lat: number, lng: number, geometry: GeoGeometry | null | undefined): boolean {
  if (!geometry) return false;
  for (const polygon of polygonsOf(geometry)) {
    if (!polygon.length) continue;
    if (!pointInRing(lat, lng, polygon[0])) continue;
    const inHole = polygon.slice(1).some((hole) => pointInRing(lat, lng, hole));
    if (!inHole) return true;
  }
  return false;
}

/** Distancia mínima desde el punto al borde de la geocerca. */
export function distanceToGeometryMeters(lat: number, lng: number, geometry: GeoGeometry | null | undefined): number {
  if (!geometry) return Number.POSITIVE_INFINITY;
  let best = Number.POSITIVE_INFINITY;
  for (const polygon of polygonsOf(geometry)) {
    for (const ring of polygon) {
      for (let index = 1; index < ring.length; index += 1) {
        const [lng1, lat1] = ring[index - 1];
        const [lng2, lat2] = ring[index];
        const candidate = distanceToSegmentMeters(lat, lng, lat1, lng1, lat2, lng2);
        if (candidate < best) best = candidate;
      }
    }
  }
  return best;
}

function distanceToSegmentMeters(lat: number, lng: number, lat1: number, lng1: number, lat2: number, lng2: number): number {
  const scale = Math.cos(toRadians(lat));
  const px = lng * scale;
  const py = lat;
  const ax = lng1 * scale;
  const ay = lat1;
  const bx = lng2 * scale;
  const by = lat2;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const closestLat = ay + t * dy;
  const closestLng = (ax + t * dx) / (scale || 1);
  return distanceMeters(lat, lng, closestLat, closestLng);
}

/** Une varios polígonos en una sola geometría para pintarla en el mapa. */
export function mergeGeometries(geometries: Array<GeoGeometry | null | undefined>): GeoGeometry | null {
  const polygons: Ring[][] = [];
  for (const geometry of geometries) {
    if (!geometry) continue;
    polygons.push(...polygonsOf(geometry));
  }
  if (!polygons.length) return null;
  if (polygons.length === 1) return { type: "Polygon", coordinates: polygons[0] };
  return { type: "MultiPolygon", coordinates: polygons };
}
