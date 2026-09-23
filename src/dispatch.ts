import { distanceKm } from "./workflow.js";

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
  now?: Date;
  maxGpsAgeSeconds?: number;
};

export type DispatchDecision = {
  riderId: string;
  score: number;
  pickupDistanceKm: number;
  pickupEtaMinutes: number;
  customerEtaMinutes: number;
  reasons: string[];
};

const speedKmh: Record<DispatchCandidate["vehicle"], number> = { bike: 16, electric_bike: 19, electric_scooter: 23, motorcycle: 28, scooter: 22, car: 28 };

function travelMinutes(distance: number, vehicle: DispatchCandidate["vehicle"]) {
  return Math.max(1, Math.ceil((distance / speedKmh[vehicle]) * 60));
}

function freshnessSeconds(candidate: DispatchCandidate, now: Date) {
  if (!candidate.lastLocationAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - candidate.lastLocationAt.getTime()) / 1000);
}

export function scoreDispatchCandidate(candidate: DispatchCandidate, input: DispatchInput): DispatchDecision | null {
  const now = input.now || new Date();
  if (candidate.status !== "available") return null;
  if (!candidate.location?.coordinates || candidate.location.coordinates.length < 2) return null;
  if (freshnessSeconds(candidate, now) > (input.maxGpsAgeSeconds ?? 90)) return null;

  const riderLocation: [number, number] = [candidate.location.coordinates[0], candidate.location.coordinates[1]];
  const pickupDistanceKm = distanceKm(riderLocation, input.restaurantLocation);
  const customerDistanceKm = distanceKm(input.restaurantLocation, input.customerLocation);
  const pickupEtaMinutes = travelMinutes(pickupDistanceKm, candidate.vehicle);
  const customerEtaMinutes = travelMinutes(customerDistanceKm, candidate.vehicle);
  const currentLoad = Math.min(1, Math.max(0, (candidate.activeOrderCount || 0) / 2));
  const reliability = Math.min(1, Math.max(0, candidate.reliabilityScore ?? 0.75));
  const zoneFit = Math.min(1, Math.max(0, candidate.zoneFit ?? 1));
  const priority = Math.min(1, Math.max(0, candidate.servicePriority ?? 0.5));
  const waitPenalty = Math.max(0, pickupEtaMinutes - input.preparationMinutes);
  const lateRisk = Math.max(0, pickupEtaMinutes + customerEtaMinutes - 60);

  // Lower is better. The weights are deliberately explicit and auditable for Phase 1.
  const score =
    0.35 * pickupEtaMinutes +
    0.25 * lateRisk +
    0.15 * currentLoad * 20 +
    0.10 * (1 - zoneFit) * 20 +
    0.10 * (1 - reliability) * 20 +
    0.05 * (1 - priority) * 20 +
    0.05 * waitPenalty;

  return {
    riderId: candidate.id,
    score: Math.round(score * 100) / 100,
    pickupDistanceKm: Math.round(pickupDistanceKm * 100) / 100,
    pickupEtaMinutes,
    customerEtaMinutes,
    reasons: [
      `llega al comercio en ${pickupEtaMinutes} min`,
      `distancia de recogida ${pickupDistanceKm.toFixed(2)} km`,
      `carga activa ${candidate.activeOrderCount || 0}`,
      `fiabilidad ${(reliability * 100).toFixed(0)}%`,
    ],
  };
}

export function rankDispatchCandidates(candidates: DispatchCandidate[], input: DispatchInput) {
  return candidates.map((candidate) => scoreDispatchCandidate(candidate, input)).filter((decision): decision is DispatchDecision => Boolean(decision)).sort((a, b) => a.score - b.score);
}
