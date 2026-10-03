import assert from "node:assert/strict";
import { decideLatePickup } from "../src/pickupPolicy.js";

const partner = { type: "Point", coordinates: [-0.5185, 38.9908] };
const closeRider = { type: "Point", coordinates: [-0.5181, 38.9910] };
const distantRider = { type: "Point", coordinates: [-0.5000, 39.0000] };
const now = new Date("2026-10-03T23:00:00.000Z");

const withinRadius = decideLatePickup({
  riderLocation: closeRider,
  partnerLocation: partner,
  riderLastLocationAt: new Date(now.getTime() - 10_000),
  arrivalRadiusMeters: 250,
  now,
});
assert.equal(withinRadius.action, "mark_arrived");
assert.ok(withinRadius.distanceMeters != null && withinRadius.distanceMeters < 250);

const overdue = decideLatePickup({
  riderLocation: distantRider,
  partnerLocation: partner,
  riderLastLocationAt: new Date(now.getTime() - 10_000),
  arrivalRadiusMeters: 250,
  now,
});
assert.equal(overdue.action, "reassign");
assert.ok(overdue.distanceMeters != null && overdue.distanceMeters > 250);

const confirmed = decideLatePickup({
  riderArrivedAt: new Date(),
  riderLocation: distantRider,
  partnerLocation: partner,
  riderLastLocationAt: new Date(now.getTime() - 10_000),
  arrivalRadiusMeters: 250,
  now,
});
assert.equal(confirmed.action, "keep");

const missingGps = decideLatePickup({
  riderLocation: null,
  partnerLocation: partner,
  arrivalRadiusMeters: 250,
  now,
});
assert.equal(missingGps.action, "reassign");

const staleGps = decideLatePickup({
  riderLocation: closeRider,
  partnerLocation: partner,
  riderLastLocationAt: new Date(now.getTime() - 91_000),
  arrivalRadiusMeters: 250,
  now,
});
assert.equal(staleGps.action, "reassign");

console.log(JSON.stringify({
  scenario: "pickup-reassignment-policy",
  passed: true,
  cases: ["gps_inside_radius_marks_arrival", "gps_outside_radius_reassigns", "confirmed_arrival_keeps_assignment", "missing_gps_reassigns", "stale_gps_reassigns"],
}));
