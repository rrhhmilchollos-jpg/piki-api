import { distanceKm } from "./workflow.js";

export const DISPATCH_ALGORITHM_VERSION = "piki-jarvis-v2-proximity-rating";
// Bicycles, including electric bicycles, and stand-up electric scooters are
// restricted to verified urban routes strictly shorter than 1.5 km.
export const LIGHT_URBAN_VEHICLES = ["bike", "electric_bike", "electric_scooter"] as const;
export const LONG_ROUTE_VEHICLES = ["motorcycle", "scooter", "car"] as const;
export const LIGHT_URBAN_ROUTE_MAX_KM = 1.5;

export type DispatchVehicle = "bike" | "electric_bike" | "electric_scooter" | "motorcycle" | "scooter" | "car";

export type DispatchCandidate = {
  id: string;
  status: "offline" | "available" | "busy" | "paused";
  vehicle: DispatchVehicle;
  location?: { coordinates?: number[] } | null;
  lastLocationAt?: Date | null;
  activeOrderCount?: number;
  reliabilityScore?: number;
  ratingScore?: number;
  zoneFit?: number;
  servicePriority?: number;
};

export type DispatchVehicleEligibilityInput = {
  /** Restaurant → customer road distance. It is never inferred from rider → restaurant distance. */
  routeDistanceKm?: number | null;
  /** A degraded/unknown route is deliberately unsafe for normal bikes and e-scooters. */
  routingDegraded?: boolean | null;
  /** Persisted/geofenced proof that the delivery remains in the authorized municipality or locality. */
  withinMunicipality?: boolean | null;
  /** Additional, pre-existing operational restriction persisted with the order. */
  requiredVehicleClasses?: readonly unknown[] | null;
};

export type DispatchVehicleEligibilityReason =
  | "eligible_short_intra_city"
  | "eligible_long_route_capable_vehicle"
  | "route_unknown_light_vehicle"
  | "route_at_or_above_light_limit"
  | "light_vehicle_requires_verified_intra_city"
  | "vehicle_not_in_required_classes"
  | "unknown_vehicle";

export type DispatchVehicleEligibility = {
  eligible: boolean;
  reason: DispatchVehicleEligibilityReason;
  routeDistanceKm: number | null;
};

export type DispatchInput = {
  restaurantLocation: [number, number];
  customerLocation: [number, number];
  preparationMinutes: number;
  routeDistanceKm?: number | null;
  routeDurationMinutes?: number | null;
  routingDegraded?: boolean | null;
  withinMunicipality?: boolean | null;
  requiredVehicleClasses?: DispatchCandidate["vehicle"][];
  now?: Date;
  maxGpsAgeSeconds?: number;
  maxCustomerEtaMinutes?: number;
  maxConcurrentOrders?: 1 | 2;
  orderVolume?: "standard" | "bulky";
};

export type DispatchWeights = {
  riderDistance: number;
  riderEta: number;
  customerEta: number;
  preparationWait: number;
  load: number;
  zoneMismatch: number;
  reliability: number;
  rating: number;
  priority: number;
};

export type DispatchDecision = {
  riderId: string;
  algorithmVersion: string;
  score: number;
  pickupDistanceKm: number;
  routeDistanceKm: number | null;
  requiredVehicleClasses: DispatchCandidate["vehicle"][];
  pickupEtaMinutes: number;
  customerEtaMinutes: number;
  totalEtaMinutes: number;
  reasons: string[];
};

export const dispatchWeights: DispatchWeights = {
  riderDistance: 0.42,
  riderEta: 0.18,
  customerEta: 0.15,
  preparationWait: 0.05,
  load: 0.06,
  zoneMismatch: 0.03,
  reliability: 0.04,
  rating: 0.05,
  priority: 0.02,
};

const speedKmh: Record<DispatchCandidate["vehicle"], number> = {
  bike: 16,
  electric_bike: 19,
  electric_scooter: 23,
  motorcycle: 28,
  // "scooter" is the model's motorized-motorcycle value. It is intentionally
  // not an alias for the electric stand-up scooter (electric_scooter).
  scooter: 22,
  car: 28,
};

function isDispatchVehicle(value: unknown): value is DispatchVehicle {
  return typeof value === "string" && (["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"] as const).includes(value as DispatchVehicle);
}

function routeDistanceFrom(input: DispatchVehicleEligibilityInput): number | null {
  const distance = input.routeDistanceKm;
  if (input.routingDegraded === true || typeof distance !== "number" || !Number.isFinite(distance) || distance < 0) return null;
  return distance;
}

/**
 * Hard vehicle eligibility, shared by auto-dispatch, manual dispatch and offer
 * acceptance. A road route at exactly 1.5 km is not "less than" 1.5 km.
 */
export function evaluateDispatchVehicleEligibility(vehicle: unknown, input: DispatchVehicleEligibilityInput): DispatchVehicleEligibility {
  const routeDistanceKm = routeDistanceFrom(input);
  if (!isDispatchVehicle(vehicle)) return { eligible: false, reason: "unknown_vehicle", routeDistanceKm };

  const requiredVehicleClasses = Array.isArray(input.requiredVehicleClasses) ? input.requiredVehicleClasses : [];
  if (requiredVehicleClasses.length > 0 && !requiredVehicleClasses.includes(vehicle)) {
    return { eligible: false, reason: "vehicle_not_in_required_classes", routeDistanceKm };
  }

  const lightUrbanVehicle = (LIGHT_URBAN_VEHICLES as readonly string[]).includes(vehicle);
  if (routeDistanceKm === null) {
    return lightUrbanVehicle
      ? { eligible: false, reason: "route_unknown_light_vehicle", routeDistanceKm: null }
      : { eligible: true, reason: "eligible_long_route_capable_vehicle", routeDistanceKm: null };
  }

  if (routeDistanceKm >= LIGHT_URBAN_ROUTE_MAX_KM) {
    return lightUrbanVehicle
      ? { eligible: false, reason: "route_at_or_above_light_limit", routeDistanceKm }
      : { eligible: true, reason: "eligible_long_route_capable_vehicle", routeDistanceKm };
  }

  if (lightUrbanVehicle && input.withinMunicipality !== true) {
    return { eligible: false, reason: "light_vehicle_requires_verified_intra_city", routeDistanceKm };
  }

  return { eligible: true, reason: "eligible_short_intra_city", routeDistanceKm };
}

function bounded(value: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function travelMinutes(distance: number, vehicle: DispatchCandidate["vehicle"]) {
  return Math.max(1, Math.ceil((distance / speedKmh[vehicle]) * 60));
}

function freshnessSeconds(candidate: DispatchCandidate, now: Date) {
  if (!candidate.lastLocationAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - candidate.lastLocationAt.getTime()) / 1000);
}

export function scoreDispatchCandidate(candidate: DispatchCandidate, input: DispatchInput): DispatchDecision | null {
  const now = input.now || new Date();
  if (candidate.status !== "available" && candidate.status !== "busy") return null;
  if (!candidate.location?.coordinates || candidate.location.coordinates.length < 2) return null;
  if (freshnessSeconds(candidate, now) > (input.maxGpsAgeSeconds ?? 90)) return null;

  const vehicleEligibility = evaluateDispatchVehicleEligibility(candidate.vehicle, input);
  if (!vehicleEligibility.eligible) return null;
  const requiredVehicleClasses = input.requiredVehicleClasses || [];

  const riderLocation: [number, number] = [candidate.location.coordinates[0], candidate.location.coordinates[1]];
  const pickupDistanceKm = distanceKm(riderLocation, input.restaurantLocation);
  // Route distance is persisted from restaurant → customer and controls hard
  // vehicle eligibility. Haversine is only an ETA/scoring fallback for a
  // motorized/long-route-capable vehicle when routing is unavailable.
  const customerDistanceKm = vehicleEligibility.routeDistanceKm ?? distanceKm(input.restaurantLocation, input.customerLocation);
  const pickupEtaMinutes = travelMinutes(pickupDistanceKm, candidate.vehicle);
  const customerEtaMinutes = input.routeDurationMinutes != null && Number.isFinite(input.routeDurationMinutes)
    ? Math.max(1, Math.ceil(input.routeDurationMinutes))
    : travelMinutes(customerDistanceKm, candidate.vehicle);
  // Preparation and the rider's trip to the restaurant run concurrently.
  const totalEtaMinutes = Math.max(input.preparationMinutes, pickupEtaMinutes) + customerEtaMinutes;
  if (input.maxCustomerEtaMinutes && totalEtaMinutes > input.maxCustomerEtaMinutes) return null;

  const activeOrderCount = Math.max(0, candidate.activeOrderCount || 0);
  const maxConcurrentOrders = input.maxConcurrentOrders ?? 1;
  if (candidate.status === "busy" && maxConcurrentOrders < 2) return null;
  if (activeOrderCount >= maxConcurrentOrders) return null;
  const load = Math.min(1, activeOrderCount / maxConcurrentOrders);
  const reliability = bounded(candidate.reliabilityScore ?? 0.75, 0.75);
  // Existing riders may not have customer ratings yet. In that case the
  // operational reliability score is the conservative fallback.
  const rating = bounded(candidate.ratingScore ?? reliability, reliability);
  const zoneFit = bounded(candidate.zoneFit ?? 1, 1);
  const priority = bounded(candidate.servicePriority ?? 0.5, 0.5);
  const preparationWait = Math.max(0, pickupEtaMinutes - input.preparationMinutes);
  const lateRisk = Math.max(0, totalEtaMinutes - 60);
  const urbanVehiclePenalty = customerDistanceKm <= 3
    ? ({ electric_scooter: 0, electric_bike: 0.5, bike: 1, scooter: 0.25, motorcycle: 4, car: 8 } as const)[candidate.vehicle]
    : 0;

  // Lower is better. Every term is normalized or intentionally bounded and logged.
  const score =
    dispatchWeights.riderDistance * pickupDistanceKm * 5 +
    dispatchWeights.riderEta * pickupEtaMinutes +
    dispatchWeights.customerEta * (customerEtaMinutes + lateRisk) +
    dispatchWeights.preparationWait * preparationWait +
    dispatchWeights.load * load * 20 +
    dispatchWeights.zoneMismatch * (1 - zoneFit) * 20 +
    dispatchWeights.reliability * (1 - reliability) * 20 +
    dispatchWeights.rating * (1 - rating) * 20 +
    dispatchWeights.priority * (1 - priority) * 20 + urbanVehiclePenalty;

  return {
    riderId: candidate.id,
    algorithmVersion: DISPATCH_ALGORITHM_VERSION,
    score: Math.round(score * 100) / 100,
    pickupDistanceKm: Math.round(pickupDistanceKm * 100) / 100,
    routeDistanceKm: vehicleEligibility.routeDistanceKm,
    requiredVehicleClasses,
    pickupEtaMinutes,
    customerEtaMinutes,
    totalEtaMinutes,
    reasons: [
      `recogida en ${pickupEtaMinutes} min`,
      `entrega estimada en ${totalEtaMinutes} min`,
      `distancia de recogida ${pickupDistanceKm.toFixed(2)} km`,
      vehicleEligibility.routeDistanceKm == null ? "ruta sin proveedor: vehículos ligeros excluidos" : `ruta al cliente ${vehicleEligibility.routeDistanceKm.toFixed(2)} km`,
      `elegibilidad de vehículo: ${vehicleEligibility.reason}`,
      ...(input.routeDurationMinutes != null ? [`duración Google Maps/OSRM ${Math.ceil(input.routeDurationMinutes)} min`] : []),
      ...(requiredVehicleClasses.length ? [`vehículo requerido: ${requiredVehicleClasses.join(" o ")}`] : []),
      ...(customerDistanceKm <= 3 ? [`prioridad urbana de vehículo: ${candidate.vehicle === "electric_scooter" ? "patinete eléctrico" : candidate.vehicle}`] : []),
      `espera de preparación ${preparationWait} min`,
      `carga activa ${activeOrderCount}/${maxConcurrentOrders}`,
      `valoración Rider ${(rating * 5).toFixed(2)}/5`,
      `fiabilidad ${(reliability * 100).toFixed(0)}%`,
      `versión ${DISPATCH_ALGORITHM_VERSION}`,
    ],
  };
}

export function rankDispatchCandidates(candidates: DispatchCandidate[], input: DispatchInput) {
  return candidates
    .map((candidate) => scoreDispatchCandidate(candidate, input))
    .filter((decision): decision is DispatchDecision => Boolean(decision))
    .sort((a, b) => a.score - b.score || a.pickupDistanceKm - b.pickupDistanceKm);
}
