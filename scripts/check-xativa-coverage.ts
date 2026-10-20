import assert from "node:assert/strict";
import { evaluateXativaCoverage, requiredVehiclesForRoute, XATIVA_COVERAGE_POLICY } from "../src/coverage/xativaPolicy.js";

const [lon, lat] = XATIVA_COVERAGE_POLICY.center;
const center = evaluateXativaCoverage([lon, lat]);
assert.equal(center.covered, true);
assert.equal(center.withinMunicipality, true);
assert.equal(center.deliveryFeeCents, 299);

// ~3.3 km north: outside the strict Phase 1 casco urbano cap.
const outside = evaluateXativaCoverage([lon, lat + 0.03]);
assert.equal(outside.covered, false);
assert.equal(outside.reason, "OUTSIDE_XATIVA_RADIUS");
assert.equal(outside.deliveryFeeCents, null);

assert.deepEqual(requiredVehiclesForRoute(3), []);
assert.deepEqual(requiredVehiclesForRoute(3.001), ["motorcycle", "car"]);
assert.deepEqual(requiredVehiclesForRoute(null), ["motorcycle", "car"]);
console.log("xativa coverage policy checks passed", { center, outside });
