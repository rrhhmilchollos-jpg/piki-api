import assert from "node:assert/strict";
import test from "node:test";
import { requiredVehiclesForRoute } from "./coverage/xativaPolicy.js";
import { evaluateDispatchVehicleEligibility, rankDispatchCandidates } from "./dispatch.js";

const longRouteCapableVehicles = ["motorcycle", "scooter", "car"] as const;
const lightUrbanVehicles = ["bike", "electric_bike", "electric_scooter"] as const;

function routeInput(routeDistanceKm: number | null, withinMunicipality = true) {
  return { routeDistanceKm, withinMunicipality };
}

test("dispatch chooses the closest eligible rider to the restaurant before tie-breakers", () => {
  const now = new Date("2026-10-06T00:00:00.000Z");
  const ranked = rankDispatchCandidates([
    { id: "far", status: "available", vehicle: "bike", location: { coordinates: [-0.40, 39.47] }, lastLocationAt: now },
    { id: "near", status: "available", vehicle: "bike", location: { coordinates: [-0.38, 39.47] }, lastLocationAt: now, reliabilityScore: 0.5 },
  ], { restaurantLocation: [-0.375, 39.47], customerLocation: [-0.36, 39.47], preparationMinutes: 15, routeDistanceKm: 1, withinMunicipality: true, now });
  assert.equal(ranked[0]?.riderId, "near");
  assert.ok((ranked[0]?.pickupDistanceKm ?? Infinity) < (ranked[1]?.pickupDistanceKm ?? -Infinity));
});

test("dispatch allows a busy rider to receive a second order only when capacity is two", () => {
  const now = new Date("2026-10-06T00:00:00.000Z");
  const rider = { id: "rider-1", status: "busy" as const, vehicle: "bike" as const, location: { coordinates: [-0.38, 39.47] }, lastLocationAt: now, activeOrderCount: 1 };
  const normal = rankDispatchCandidates([rider], { restaurantLocation: [-0.375, 39.47], customerLocation: [-0.36, 39.47], preparationMinutes: 15, routeDistanceKm: 1, withinMunicipality: true, now, maxConcurrentOrders: 1 });
  const saturated = rankDispatchCandidates([rider], { restaurantLocation: [-0.375, 39.47], customerLocation: [-0.36, 39.47], preparationMinutes: 15, routeDistanceKm: 1, withinMunicipality: true, now, maxConcurrentOrders: 2 });
  assert.equal(normal.length, 0);
  assert.equal(saturated[0]?.riderId, "rider-1");
});

test("bici normal, bici eléctrica y patinete eléctrico se permiten exclusivamente bajo 1,5 km e intraciudad", () => {
  for (const vehicle of lightUrbanVehicles) {
    assert.equal(evaluateDispatchVehicleEligibility(vehicle, routeInput(1.499, true)).eligible, true, `${vehicle} debe permitirse a 1.499 km intraciudad`);
    assert.equal(evaluateDispatchVehicleEligibility(vehicle, routeInput(1.499, false)).eligible, false, `${vehicle} debe requerir intraciudad verificable`);
    assert.equal(evaluateDispatchVehicleEligibility(vehicle, routeInput(1.5, true)).eligible, false, `${vehicle} no debe permitirse a 1.5 km exactos`);
    assert.equal(evaluateDispatchVehicleEligibility(vehicle, routeInput(1.501, true)).eligible, false, `${vehicle} no debe permitirse por encima de 1.5 km`);
  }
});

test("moto, scooter de motor y coche se permiten desde el límite inclusive", () => {
  for (const vehicle of longRouteCapableVehicles) {
    assert.equal(evaluateDispatchVehicleEligibility(vehicle, routeInput(1.5, false)).eligible, true, `${vehicle} debe permitirse a 1.5 km exactos`);
    assert.equal(evaluateDispatchVehicleEligibility(vehicle, routeInput(1.501, false)).eligible, true, `${vehicle} debe permitirse por encima de 1.5 km`);
  }
  // The persisted enum treats scooter as a motorized scooter/motorcycle. Only
  // electric_scooter is the stand-up electric scooter subject to the short rule.
  assert.equal(evaluateDispatchVehicleEligibility("scooter", routeInput(1.5, false)).eligible, true);
  assert.equal(evaluateDispatchVehicleEligibility("electric_bike", routeInput(1.5, true)).eligible, false);
  assert.equal(evaluateDispatchVehicleEligibility("electric_scooter", routeInput(1.5, true)).eligible, false);
});

test("la cotización persiste las mismas clases desde 1,5 km inclusive", () => {
  assert.deepEqual(requiredVehiclesForRoute(1.499), []);
  assert.deepEqual(requiredVehiclesForRoute(1.5), [...longRouteCapableVehicles]);
  assert.deepEqual(requiredVehiclesForRoute(1.501), [...longRouteCapableVehicles]);
  assert.deepEqual(requiredVehiclesForRoute(null), [...longRouteCapableVehicles]);
});

test("ruta nula excluye vehículos ligeros y no usa distancia rider-restaurante como sustituto", () => {
  for (const vehicle of lightUrbanVehicles) {
    const decision = evaluateDispatchVehicleEligibility(vehicle, routeInput(null, true));
    assert.equal(decision.eligible, false);
    assert.equal(decision.reason, "route_unknown_light_vehicle");
  }
  for (const vehicle of longRouteCapableVehicles) {
    assert.equal(evaluateDispatchVehicleEligibility(vehicle, routeInput(null, false)).eligible, true);
  }
});

test("la regla dura no puede ser anulada por clases heredadas ni por el ranking de oferta", () => {
  // This function is called both while candidates are offered and immediately
  // before an offered Rider is accepted in the API routes.
  assert.equal(evaluateDispatchVehicleEligibility("bike", {
    ...routeInput(1.501, true),
    requiredVehicleClasses: ["bike"],
  }).eligible, false);

  const now = new Date("2026-10-06T00:00:00.000Z");
  const ranked = rankDispatchCandidates([
    { id: "bike", status: "available", vehicle: "bike", location: { coordinates: [-0.38, 39.47] }, lastLocationAt: now },
    { id: "ebike", status: "available", vehicle: "electric_bike", location: { coordinates: [-0.3805, 39.47] }, lastLocationAt: now },
    { id: "patinete", status: "available", vehicle: "electric_scooter", location: { coordinates: [-0.381, 39.47] }, lastLocationAt: now },
    { id: "scooter-moto", status: "available", vehicle: "scooter", location: { coordinates: [-0.382, 39.47] }, lastLocationAt: now },
  ], {
    restaurantLocation: [-0.375, 39.47],
    customerLocation: [-0.36, 39.47],
    preparationMinutes: 15,
    routeDistanceKm: 1.501,
    withinMunicipality: true,
    now,
  });
  assert.deepEqual(ranked.map((decision) => decision.riderId), ["scooter-moto"]);
});
