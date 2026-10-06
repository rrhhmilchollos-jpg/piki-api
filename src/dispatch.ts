import { distanceKm } from "./workflow.js";

export const DISPATCH_ALGORITHM_VERSION = "piki-jarvis-v1";

export type DispatchCandidate = {
  id: string;
  status: "offline" | "available" | "busy" | "paused";
  vehicle: "bike" | "electric_bike" | "electric_scooter" | "motorcycle" | "scooter" | "car";
  location?: { coordinates?: number[] } | null;
  lastLocationAt?: Date | null;
  activeOrderCount?: number;
  reliabilityScore?: number;
  zoneFit?: number;
  servicePriority?: number;
};

export type DispatchInput = {
  restaurantLocation: [number, number];
  customerLocation: [number, number];
  preparationMinutes: number;
  routeDistanceKm?: number | null;
  routeDurationMinutes?: number | null;
  requiredVehicleClasses?: DispatchCandidate["vehicle"][];
  now?: Date;
  maxGpsAgeSeconds?: number;
  maxCustomerEtaMinutes?: number;
  maxConcurrentOrders?: 1 | 2;
};

export type DispatchWeights = {
  riderDistance: number;
  riderEta: number;
  customerEta: number;
  preparationWait: number;
  load: number;
  zoneMismatch: number;
  reliability: number;
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
  riderDistance: 0.22,
  riderEta: 0.24,
  customerEta: 0.26,
  preparationWait: 0.08,
  load: 0.08,
  zoneMismatch: 0.04,
  reliability: 0.05,
  priority: 0.03,
};

const speedKmh: Record<DispatchCandidate["vehicle"], number> = {
  bike: 16,
  electric_bike: 19,
  electric_scooter: 23,
  motorcycle: 28,
  scooter: 22,
  car: 28,
};

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
  const requiredVehicleClasses = input.requiredVehicleClasses || [];
  if (requiredVehicleClasses.length && !requiredVehicleClasses.includes(candidate.vehicle)) return null;

  const riderLocation: [number, number] = [candidate.location.coordinates[0], candidate.location.coordinates[1]];
  const pickupDistanceKm = distanceKm(riderLocation, input.restaurantLocation);
  // Route distance is persisted at order creation and controls vehicle eligibility.
  // Haversine remains only as an ETA fallback when the provider was unavailable.
  const customerDistanceKm = input.routeDistanceKm ?? distanceKm(input.restaurantLocation, input.customerLocation);
  const pickupEtaMinutes = travelMinutes(pickupDistanceKm, candidate.vehicle);
  const customerEtaMinutes = input.routeDurationMinutes != null && Number.isFinite(input.routeDurationMinutes) ? Math.max(1, Math.ceil(input.routeDurationMinutes)) : travelMinutes(customerDistanceKm, candidate.vehicle);
  const totalEtaMinutes = input.preparationMinutes + Math.max(input.preparationMinutes, pickupEtaMinutes) + customerEtaMinutes;
  if (input.maxCustomerEtaMinutes && totalEtaMinutes > input.maxCustomerEtaMinutes) return null;

  const activeOrderCount = Math.max(0, candidate.activeOrderCount || 0);
  const maxConcurrentOrders = input.maxConcurrentOrders ?? 1;
  if (candidate.status === "busy" && maxConcurrentOrders < 2) return null;
  if (activeOrderCount >= maxConcurrentOrders) return null;
  const load = Math.min(1, activeOrderCount / maxConcurrentOrders);
  const reliability = bounded(candidate.reliabilityScore ?? 0.75, 0.75);
  const zoneFit = bounded(candidate.zoneFit ?? 1, 1);
  const priority = bounded(candidate.servicePriority ?? 0.5, 0.5);
  const preparationWait = Math.max(0, pickupEtaMinutes - input.preparationMinutes);
  const lateRisk = Math.max(0, totalEtaMinutes - 60);

  // Lower is better. Every term is normalized or intentionally bounded and logged.
  const score =
    dispatchWeights.riderDistance * pickupDistanceKm * 5 +
    dispatchWeights.riderEta * pickupEtaMinutes +
    dispatchWeights.customerEta * (customerEtaMinutes + lateRisk) +
    dispatchWeights.preparationWait * preparationWait +
    dispatchWeights.load * load * 20 +
    dispatchWeights.zoneMismatch * (1 - zoneFit) * 20 +
    dispatchWeights.reliability * (1 - reliability) * 20 +
    dispatchWeights.priority * (1 - priority) * 20;

  return {
    riderId: candidate.id,
    algorithmVersion: DISPATCH_ALGORITHM_VERSION,
    score: Math.round(score * 100) / 100,
    pickupDistanceKm: Math.round(pickupDistanceKm * 100) / 100,
    routeDistanceKm: input.routeDistanceKm ?? null,
    requiredVehicleClasses,
    pickupEtaMinutes,
    customerEtaMinutes,
    totalEtaMinutes,
    reasons: [
      `recogida en ${pickupEtaMinutes} min`,
      `entrega estimada en ${totalEtaMinutes} min`,
      `distancia de recogida ${pickupDistanceKm.toFixed(2)} km`,
      input.routeDistanceKm == null ? "ruta sin proveedor: restricción conservadora aplicada" : `ruta al cliente ${input.routeDistanceKm.toFixed(2)} km`,
      ...(input.routeDurationMinutes != null ? [`duración Google Maps/OSRM ${Math.ceil(input.routeDurationMinutes)} min`] : []),
      ...(requiredVehicleClasses.length ? [`vehículo requerido: ${requiredVehicleClasses.join(" o ")}`] : []),
      `espera de preparación ${preparationWait} min`,
      `carga activa ${activeOrderCount}/${maxConcurrentOrders}`,
      `fiabilidad ${(reliability * 100).toFixed(0)}%`,
      `versión ${DISPATCH_ALGORITHM_VERSION}`,
    ],
  };
}

export function rankDispatchCandidates(candidates: DispatchCandidate[], input: DispatchInput) {
  return candidates
    .map((candidate) => scoreDispatchCandidate(candidate, input))
    .filter((decision): decision is DispatchDecision => Boolean(decision))
    .sort((a, b) => a.pickupDistanceKm - b.pickupDistanceKm || a.score - b.score);
}
