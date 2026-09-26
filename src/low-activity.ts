import { distanceKm } from "./workflow.js";

export const LOW_ACTIVITY_ALGORITHM_VERSION = "piki-mobility-v1";

export type ZoneDemand = {
  slug: string;
  name: string;
  anchor: [number, number];
  ordersLastWindow: number;
};

export type MobilityAdvice = {
  algorithmVersion: string;
  shouldMove: boolean;
  currentZone: { slug: string; name: string } | null;
  currentDemand: number;
  targetZone: { slug: string; name: string; distanceKm: number; demand: number } | null;
  reason: "balanced" | "low_activity" | "higher_demand_nearby";
  cooldownMinutes: number;
};

export function computeMobilityAdvice(input: {
  currentZone: ZoneDemand | null;
  zones: ZoneDemand[];
  lowActivityMinutes: number;
  maxMoveDistanceKm?: number;
}): MobilityAdvice {
  const currentDemand = input.currentZone?.ordersLastWindow ?? 0;
  const maxMoveDistanceKm = input.maxMoveDistanceKm ?? 18;
  const candidates = input.currentZone
    ? input.zones
        .filter((zone) => zone.slug !== input.currentZone?.slug)
        .map((zone) => ({ ...zone, distanceKm: Math.round(distanceKm(input.currentZone!.anchor, zone.anchor) * 10) / 10 }))
        .filter((zone) => zone.distanceKm <= maxMoveDistanceKm && zone.ordersLastWindow > currentDemand)
        .sort((a, b) => b.ordersLastWindow - a.ordersLastWindow || a.distanceKm - b.distanceKm)
    : [];
  const target = candidates[0];
  const shouldMove = Boolean(target && input.lowActivityMinutes >= 15 && target.ordersLastWindow >= Math.max(2, currentDemand + 1));
  return {
    algorithmVersion: LOW_ACTIVITY_ALGORITHM_VERSION,
    shouldMove,
    currentZone: input.currentZone ? { slug: input.currentZone.slug, name: input.currentZone.name } : null,
    currentDemand,
    targetZone: shouldMove && target ? { slug: target.slug, name: target.name, distanceKm: target.distanceKm, demand: target.ordersLastWindow } : null,
    reason: shouldMove ? (currentDemand === 0 ? "low_activity" : "higher_demand_nearby") : "balanced",
    cooldownMinutes: 15,
  };
}
