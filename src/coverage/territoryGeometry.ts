export type Coordinate = [number, number];
export type PolygonCoordinates = readonly (readonly (readonly number[])[])[];
export type AreaGeometry = { type: "Polygon"; coordinates: PolygonCoordinates } | { type: "MultiPolygon"; coordinates: readonly PolygonCoordinates[] };
export type OperationalArea = {
  slug: string;
  name: string;
  municipalityCode: string;
  municipalityName: string;
  center: Coordinate;
  geometry: AreaGeometry;
  coverage: "partial" | "full";
  urbanLocality: boolean;
  source: string;
  sourceKind: string;
  operationalRadiusKm?: number;
};
export function validCoordinate(value: unknown): value is Coordinate {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === "number" && typeof value[1] === "number" && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}
export function distanceKm(a: Coordinate, b: Coordinate): number {
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLon = (b[0] - a[0]) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * Math.PI / 180) * Math.cos(b[1] * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(Math.min(1, h)), Math.sqrt(Math.max(0, 1 - h)));
}
function onSegment(point: Coordinate, a: readonly number[], b: readonly number[]) {
  const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
  return Math.abs(cross) <= 1e-10 && point[0] >= Math.min(a[0], b[0]) - 1e-10 && point[0] <= Math.max(a[0], b[0]) + 1e-10 && point[1] >= Math.min(a[1], b[1]) - 1e-10 && point[1] <= Math.max(a[1], b[1]) + 1e-10;
}
function insideRing(point: Coordinate, ring: readonly (readonly number[])[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
export function insideGeometry(point: Coordinate, geometry: AreaGeometry): boolean {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.some(([outer, ...holes]) => Boolean(outer) && insideRing(point, outer) && !holes.some((hole) => insideRing(point, hole)));
}
export function nearestCoveredArea(point: Coordinate, areas: readonly OperationalArea[]): OperationalArea | null {
  if (!validCoordinate(point)) return null;
  return areas.filter((area) => insideGeometry(point, area.geometry)).sort((a, b) => distanceKm(point, a.center) - distanceKm(point, b.center))[0] || null;
}
/** Conservative urban eligibility, not a claim that a municipal polygon is urban.
 * Both points must be in the same named operational locality and within its
 * verified central 1.5 km core. Rural Bixquert is deliberately never a light-
 * vehicle core. Missing origin snapshots fail closed for legacy orders.
 */
export function sameUrbanLocality(origin: unknown, destination: unknown, areas: readonly OperationalArea[]): boolean {
  if (!validCoordinate(origin) || !validCoordinate(destination)) return false;
  const urbanAt = (point: Coordinate) => {
    const area = nearestCoveredArea(point, areas);
    return area?.urbanLocality && distanceKm(point, area.center) < 1.5 ? area : null;
  };
  const a = urbanAt(origin), b = urbanAt(destination);
  return Boolean(a && b && a.slug === b.slug && a.municipalityCode === b.municipalityCode);
}
