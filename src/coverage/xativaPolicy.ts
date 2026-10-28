import { xativaMunicipalityGeometry } from "./xativaBoundary.js";
import { OPERATIONAL_AREAS } from "./operationalAreas.js";
import { distanceKm, insideGeometry, nearestCoveredArea, sameUrbanLocality, validCoordinate, type AreaGeometry, type Coordinate } from "./territoryGeometry.js";

export const XATIVA_PHASE_2_LOCALITIES = ["La Llosa de Ranes", "Novetlè", "El Genovés", "Alboi", "Bixquert", "La Granja de la Costera", "Llanera de Ranes", "Cerdà", "Torrella"] as const;
export const XATIVA_COVERAGE_POLICY = {
  slug: "xativa-casco-urbano-fase-1",
  city: "Xàtiva",
  version: 3,
  center: [-0.521111, 38.990276] as Coordinate,
  maxStraightLineDistanceKm: 3,
  deliveryBaseFeeCents: 299,
  outsideMunicipalitySurchargeCents: 0,
  serviceFeeCents: 79,
  routeVehicleThresholdKm: 1.5,
  routeVehicleClasses: ["electric_bike", "motorcycle", "scooter", "car"] as const,
  municipalityBoundarySource: "Verified OSM and CartoCiudad/IGN municipal boundaries; per-area source is attached to OPERATIONAL_AREAS",
  phase2Enabled: true,
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
  localityName: string | null;
  municipalityCode: string | null;
  coverageRule: "municipal_boundary" | "operational_radius" | "outside";
};
function extentKm(geometry: AreaGeometry, center: Coordinate) {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let maximum = 0;
  for (const polygon of polygons) for (const ring of polygon) for (const point of ring) maximum = Math.max(maximum, distanceKm(center, [point[0], point[1]]));
  return Math.ceil(maximum * 100) / 100;
}
const extents = new Map(OPERATIONAL_AREAS.map((area) => [area.slug, extentKm(area.geometry, area.center)]));
/** Membership is executable, not inferred from a province name or a marketing list. */
export function evaluateXativaCoverage(point: Coordinate): CoverageDecision {
  const valid = validCoordinate(point);
  const area = valid ? nearestCoveredArea(point, OPERATIONAL_AREAS) : null;
  const covered = Boolean(area);
  const withinMunicipality = covered || (valid && insideGeometry(point, xativaMunicipalityGeometry as unknown as AreaGeometry));
  const straightLineDistanceKm = valid ? distanceKm(area?.center || XATIVA_COVERAGE_POLICY.center, point) : 0;
  return {
    policySlug: area?.slug || XATIVA_COVERAGE_POLICY.slug,
    policyVersion: XATIVA_COVERAGE_POLICY.version,
    covered,
    // Keep the legacy public error code; locality/rule now explain the active scope.
    reason: covered ? "COVERED" : "OUTSIDE_XATIVA_RADIUS",
    straightLineDistanceKm: Math.round(straightLineDistanceKm * 1000) / 1000,
    maxStraightLineDistanceKm: area ? (area.operationalRadiusKm || extents.get(area.slug) || 3) : 3,
    withinMunicipality,
    deliveryBaseFeeCents: XATIVA_COVERAGE_POLICY.deliveryBaseFeeCents,
    outsideMunicipalitySurchargeCents: 0,
    deliveryFeeCents: covered ? XATIVA_COVERAGE_POLICY.deliveryBaseFeeCents : null,
    serviceFeeCents: covered ? XATIVA_COVERAGE_POLICY.serviceFeeCents : null,
    localityName: area?.name || null,
    municipalityCode: area?.municipalityCode || null,
    coverageRule: area ? (area.coverage === "full" ? "municipal_boundary" : "operational_radius") : "outside",
  };
}
export function withinSameOperationalCity(origin: unknown, destination: unknown) {
  return sameUrbanLocality(origin, destination, OPERATIONAL_AREAS);
}
export function requiredVehiclesForRoute(routeDistanceKm: number | null): VehicleClass[] {
  if (routeDistanceKm === null || !Number.isFinite(routeDistanceKm) || routeDistanceKm < 0 || routeDistanceKm >= XATIVA_COVERAGE_POLICY.routeVehicleThresholdKm) return [...XATIVA_COVERAGE_POLICY.routeVehicleClasses];
  return [];
}
export function isVehicleCompatibleWithRoute(vehicle: VehicleClass, requiredVehicleClasses: readonly VehicleClass[]) {
  return requiredVehicleClasses.length === 0 || requiredVehicleClasses.includes(vehicle);
}
