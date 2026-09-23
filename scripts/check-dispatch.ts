import assert from "node:assert/strict";
import { rankDispatchCandidates } from "../src/dispatch.js";

const now = new Date("2026-09-23T04:00:00.000Z");
const ranked = rankDispatchCandidates([
  { id: "near", status: "available", vehicle: "scooter", location: { coordinates: [-0.52, 38.99] }, lastLocationAt: now, activeOrderCount: 0, reliabilityScore: 0.9, zoneFit: 1 },
  { id: "stale", status: "available", vehicle: "car", location: { coordinates: [-0.55, 39.01] }, lastLocationAt: new Date("2026-09-23T03:55:00.000Z"), activeOrderCount: 0, reliabilityScore: 1, zoneFit: 1 },
  { id: "busy", status: "busy", vehicle: "bike", location: { coordinates: [-0.52, 38.99] }, lastLocationAt: now },
], {
  restaurantLocation: [-0.521, 38.991],
  customerLocation: [-0.518, 38.995],
  preparationMinutes: 15,
  now,
});

assert.equal(ranked.length, 1);
assert.equal(ranked[0]?.riderId, "near");
assert.ok(ranked[0]?.pickupEtaMinutes >= 1);
console.log(JSON.stringify({ ok: true, selected: ranked[0] }, null, 2));
