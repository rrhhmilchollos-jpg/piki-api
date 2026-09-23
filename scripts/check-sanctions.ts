import assert from "node:assert/strict";
import { calculateSanctionDecision, canRiderReceiveOffers, resolveIncident } from "../src/sanctions.js";

const now = new Date("2026-09-23T10:00:00.000Z");
const incidents = [
  { id: "i1", riderId: "r1", reason: "no_show" as const, occurredAt: new Date("2026-09-22T10:00:00.000Z") },
  { id: "i2", riderId: "r1", reason: "late_delivery" as const, occurredAt: new Date("2026-09-21T10:00:00.000Z") },
  { id: "i3", riderId: "r1", reason: "late_acceptance" as const, occurredAt: new Date("2026-09-20T10:00:00.000Z") },
  { id: "i4", riderId: "r1", reason: "late_acceptance" as const, occurredAt: new Date("2026-09-19T10:00:00.000Z") },
];

const warning = calculateSanctionDecision([incidents[1], incidents[2]], now);
assert.equal(warning.severity, "warning");
assert.equal(warning.score, 2);
assert.equal(canRiderReceiveOffers(warning, now), true);

const restricted = calculateSanctionDecision(incidents, now);
assert.equal(restricted.severity, "temporary_restriction");
assert.equal(restricted.requiresHumanReview, true);
assert.equal(canRiderReceiveOffers(restricted, now), false);

const review = calculateSanctionDecision([
  ...incidents,
  { id: "i5", riderId: "r1", reason: "unsafe_driving" as const, occurredAt: now },
], now);
assert.equal(review.severity, "review");
assert.equal(review.restrictionUntil, null);
assert.equal(canRiderReceiveOffers(review, now), false);

const resolved = resolveIncident(incidents[0]);
assert.equal(resolved.resolved, true);
assert.equal(calculateSanctionDecision([resolved], now).score, 0);

console.log("sanctions checks passed");
