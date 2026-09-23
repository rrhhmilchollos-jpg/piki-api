import { rankDispatchCandidates } from "../src/dispatch.js";

const now = new Date("2026-09-23T12:00:00.000Z");
const ranked = rankDispatchCandidates([
  { id: "near-bike", status: "available", vehicle: "bike", location: { coordinates: [-0.52, 38.99] }, lastLocationAt: now, reliabilityScore: 0.95, zoneFit: 1, servicePriority: 0.5 },
  { id: "stale-moto", status: "available", vehicle: "motorcycle", location: { coordinates: [-0.52, 38.99] }, lastLocationAt: new Date(now.getTime() - 120_000), reliabilityScore: 1, zoneFit: 1, servicePriority: 1 },
  { id: "busy-car", status: "busy", vehicle: "car", location: { coordinates: [-0.52, 38.99] }, lastLocationAt: now, reliabilityScore: 1, zoneFit: 1, servicePriority: 1 },
], { restaurantLocation: [-0.52, 38.99], customerLocation: [-0.51, 39.0], preparationMinutes: 15, now });

if (ranked.length !== 1 || ranked[0].riderId !== "near-bike") throw new Error(`Unexpected dispatch result: ${JSON.stringify(ranked)}`);
if (ranked[0].algorithmVersion !== "piki-jarvis-v1") throw new Error("Missing algorithm version");
console.log(JSON.stringify({ ok: true, ranked }, null, 2));
