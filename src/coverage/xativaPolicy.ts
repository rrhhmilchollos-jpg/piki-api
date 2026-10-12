import { xativaMunicipalityGeometry } from "./xativaBoundary.js";

export const XATIVA_COVERAGE_POLICY = {
  slug: "xativa-v1",
  city: "Xàtiva",
  version: 2,
  center: [-0.521111, 38.990276] as [number, number],
  maxStraightLineDistanceKm: 10,
  deliveryBaseFeeCents: 299,
  outsideMunicipalitySurchargeCents: 100,
  serviceFeeCents: 299,
  routeVehicleThresholdKm: 3,
  routeVehicleClasses: ["motorcycle", "car"] as const,
  municipalityBoundarySource: "OpenStreetMap relation via Nominatim, retrieved 2026-09-26",
} as const;

export type VehicleClass = "bike" | "electric_bike" | "electric_scooter" | "motorcycle" | "scooter" | "car";
export type CoverageDecision = {
  policySlug: string;
  policyVersion: number;
  covered: boolean;
  reason: "COVERED" | "OUTSIDE_XATIVA_RADIUS";
  straightLineDistanceKm: number;
  maxStraightLineDistanceKm: number;
  withinMunicipality: boolean;
  deliveryBaseFeeCents: number;
  outsideMunicipalitySurchargeCents: number;
  deliveryFeeCents: number | null;
  serviceFeeCents: number | null;
};

function distanceKm(a: [number, number], b: [number, number]) {
  const [lonA, latA] = a;
  const [lonB, latB] = b;
  const latDelta = (latB - latA) * Math.PI / 180;
  const lonDelta = (lonB - lonA) * Math.PI / 180;
  const sinLat = Math.sin(latDelta / 2);
  const sinLon = Math.sin(lonDelta / 2);
  const h = sinLat * sinLat + Math.cos(latA * Math.PI / 180) * Math.cos(latB * Math.PI / 180) * sinLon * sinLon;
  return 6371 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function onSegment(point: [number, number], a: readonly number[], b: readonly number[]) {
  const [x, y] = point;
  const [ax, ay] = a;
  const [bx, by] = b;
  const cross = (x - ax) * (by - ay) - (y - ay) * (bx - ax);
  if (Math.abs(cross) > 1e-10) return false;
  return x >= Math.min(ax, bx) - 1e-10 && x <= Math.max(ax, bx) + 1e-10 && y >= Math.min(ay, by) - 1e-10 && y <= Math.max(ay, by) + 1e-10;
}

/** Ray-casting with explicit border inclusion so municipal boundaries have a stable price. */
function insideRing(point: [number, number], ring: readonly (readonly number[])[]) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index++) {
    const current = ring[index];
    const prior = ring[previous];
    if (onSegment(point, prior, current)) return true;
    const intersects = ((current[1] > point[1]) !== (prior[1] > point[1]))
      && point[0] < ((prior[0] - current[0]) * (point[1] - current[1])) / (prior[1] - current[1]) + current[0];
    if (intersects) inside = !inside;
  }
  return inside;
}

function insideMunicipality(point: [number, number]) {
  const geometry = xativaMunicipalityGeometry as unknown as { type: "MultiPolygon"; coordinates: readonly (readonly (readonly (readonly number[])[])[])[] };
  return geometry.coordinates.some((polygon) => {
    const [outer, ...holes] = polygon;
    return Boolean(outer) && insideRing(point, outer) && !holes.some((hole) => insideRing(point, hole));
  });
}

export function evaluateXativaCoverage(point: [number, number]): CoverageDecision {
  const straightLineDistanceKm = distanceKm(XATIVA_COVERAGE_POLICY.center, point);
  const covered = straightLineDistanceKm <= XATIVA_COVERAGE_POLICY.maxStraightLineDistanceKm;
  const withinMunicipality = insideMunicipality(point);
  const outsideMunicipalitySurchargeCents = covered && !withinMunicipality ? XATIVA_COVERAGE_POLICY.outsideMunicipalitySurchargeCents : 0;
  const deliveryFeeCents = covered ? XATIVA_COVERAGE_POLICY.deliveryBaseFeeCents + outsideMunicipalitySurchargeCents : null;
  return {
    policySlug: XATIVA_COVERAGE_POLICY.slug,
    policyVersion: XATIVA_COVERAGE_POLICY.version,
    covered,
    reason: covered ? "COVERED" : "OUTSIDE_XATIVA_RADIUS",
    straightLineDistanceKm: Math.round(straightLineDistanceKm * 1000) / 1000,
    maxStraightLineDistanceKm: XATIVA_COVERAGE_POLICY.maxStraightLineDistanceKm,
    withinMunicipality,
    deliveryBaseFeeCents: XATIVA_COVERAGE_POLICY.deliveryBaseFeeCents,
    outsideMunicipalitySurchargeCents,
    deliveryFeeCents,
    serviceFeeCents: covered ? XATIVA_COVERAGE_POLICY.serviceFeeCents : null,
  };
}

export function requiredVehiclesForRoute(routeDistanceKm: number | null): VehicleClass[] {
  // If the route provider is unavailable, restrict to the robust vehicle set.
  // This is intentionally conservative: a degraded quote never sends a long
  // journey to a bicycle or e-scooter rider.
  if (routeDistanceKm === null || routeDistanceKm > XATIVA_COVERAGE_POLICY.routeVehicleThresholdKm) {
    return [...XATIVA_COVERAGE_POLICY.routeVehicleClasses];
  }
  return [];
}

export function isVehicleCompatibleWithRoute(vehicle: VehicleClass, requiredVehicleClasses: readonly VehicleClass[]) {
  return requiredVehicleClasses.length === 0 || requiredVehicleClasses.includes(vehicle);
}
