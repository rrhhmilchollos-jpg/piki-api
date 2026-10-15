import assert from "node:assert/strict";
import test from "node:test";
import { decideLatePickup, pointDistanceMeters } from "./pickupPolicy.js";

const partner = { type: "Point", coordinates: [-0.376, 39.469] } as const;

test("la llegada dentro de 80 metros puede marcarse automáticamente", () => {
  const rider = { type: "Point", coordinates: [-0.37600005, 39.469] } as const;
  const distance = pointDistanceMeters(rider, partner);
  assert.ok(distance !== null && distance < 10);
  assert.deepEqual(decideLatePickup({
    riderLocation: rider,
    partnerLocation: partner,
    riderLastLocationAt: new Date("2026-10-12T10:00:00.000Z"),
    arrivalRadiusMeters: 80,
    now: new Date("2026-10-12T10:00:30.000Z"),
  }), { action: "mark_arrived", distanceMeters: distance, reason: "gps_within_partner_radius" });
});

test("la llegada a más de 80 metros fuerza la reasignación al vencer el plazo", () => {
  const rider = { type: "Point", coordinates: [-0.3762, 39.469] } as const;
  const distance = pointDistanceMeters(rider, partner);
  assert.ok(distance !== null && distance > 10);
  const decision = decideLatePickup({
    riderLocation: rider,
    partnerLocation: partner,
    riderLastLocationAt: new Date("2026-10-12T10:00:00.000Z"),
    arrivalRadiusMeters: 80,
    now: new Date("2026-10-12T10:16:00.000Z"),
  });
  assert.equal(decision.action, "reassign");
  assert.equal(decision.reason, "outside_partner_radius_or_missing_gps");
});
