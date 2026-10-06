import assert from "node:assert/strict";
import test from "node:test";
import { rankDispatchCandidates } from "./dispatch.js";

test("dispatch chooses the closest eligible rider to the restaurant before tie-breakers", () => {
  const now = new Date("2026-10-06T00:00:00.000Z");
  const ranked = rankDispatchCandidates([
    { id: "far", status: "available", vehicle: "bike", location: { coordinates: [-0.40, 39.47] }, lastLocationAt: now },
    { id: "near", status: "available", vehicle: "bike", location: { coordinates: [-0.38, 39.47] }, lastLocationAt: now, reliabilityScore: 0.5 },
  ], { restaurantLocation: [-0.375, 39.47], customerLocation: [-0.36, 39.47], preparationMinutes: 10, now });
  assert.equal(ranked[0]?.riderId, "near");
  assert.ok((ranked[0]?.pickupDistanceKm ?? Infinity) < (ranked[1]?.pickupDistanceKm ?? -Infinity));
});
