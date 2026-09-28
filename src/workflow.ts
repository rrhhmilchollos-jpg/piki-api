import { z } from "zod";

export const orderStatuses = ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way", "delivered", "cancelled"] as const;
export type OrderStatus = (typeof orderStatuses)[number];

export const transitionSchema = z.object({
  status: z.enum(orderStatuses),
  actorRole: z.enum(["customer", "partner", "rider", "admin", "fleet", "system"]),
  reason: z.string().trim().min(2).max(280).optional(),
});

const allowedTransitions: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ["accepted", "cancelled"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready_for_pickup", "cancelled"],
  ready_for_pickup: ["picked_up", "cancelled"],
  picked_up: ["on_the_way", "cancelled"],
  on_the_way: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

const rolePermissions: Record<OrderStatus, readonly string[]> = {
  pending: ["partner", "admin", "system"],
  accepted: ["partner", "admin", "system"],
  preparing: ["partner", "admin", "system"],
  ready_for_pickup: ["partner", "admin", "system"],
  picked_up: ["rider", "admin", "system"],
  on_the_way: ["rider", "admin", "system"],
  delivered: ["rider", "admin", "system"],
  cancelled: ["customer", "partner", "rider", "admin", "fleet", "system"],
};

export function canTransition(from: OrderStatus, to: OrderStatus, actorRole: string) {
  if (actorRole === "rider" && to === "picked_up" && ["accepted", "preparing", "ready_for_pickup"].includes(from)) return true;
  return allowedTransitions[from].includes(to) && rolePermissions[to].includes(actorRole);
}

export function assertTransition(from: OrderStatus, to: OrderStatus, actorRole: string) {
  if (!canTransition(from, to, actorRole)) {
    throw new Error(`INVALID_ORDER_TRANSITION:${from}:${to}:${actorRole}`);
  }
}

export function distanceKm(a: [number, number], b: [number, number]) {
  const [lonA, latA] = a;
  const [lonB, latB] = b;
  const earthRadius = 6371;
  const latDelta = (latB - latA) * Math.PI / 180;
  const lonDelta = (lonB - lonA) * Math.PI / 180;
  const sinLat = Math.sin(latDelta / 2);
  const sinLon = Math.sin(lonDelta / 2);
  const h = sinLat * sinLat + Math.cos(latA * Math.PI / 180) * Math.cos(latB * Math.PI / 180) * sinLon * sinLon;
  return earthRadius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function validateCoordinates(latitude: number, longitude: number) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180;
}

export function calculateEtaRange(preparationMinutes: [number, number], routeMinutes: [number, number], safetyMinutes = 5): [number, number] {
  return [Math.max(1, Math.round(preparationMinutes[0] + routeMinutes[0])), Math.max(1, Math.round(preparationMinutes[1] + routeMinutes[1] + safetyMinutes))];
}
