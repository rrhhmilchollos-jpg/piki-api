import { withinSameOperationalCity } from "./coverage/xativaPolicy.js";

export function dispatchVehicleInputForOrder(order: any) {
  return {
    routeDistanceKm: typeof order?.routeDistanceKm === "number" ? order.routeDistanceKm : null,
    routeDurationMinutes: typeof order?.routeDurationMinutes === "number" ? order.routeDurationMinutes : null,
    routingDegraded: order?.routingDegraded === true,
    // Real restaurant pickup snapshot and customer must share an urban core.
    // Legacy orders lacking a pickup snapshot fail closed for light vehicles.
    withinMunicipality: withinSameOperationalCity(order?.pickupLocation?.coordinates, order?.deliveryLocation?.coordinates),
    requiredVehicleClasses: Array.isArray(order?.requiredVehicleClasses) ? order.requiredVehicleClasses : [],
  };
}
