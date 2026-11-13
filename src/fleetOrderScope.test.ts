import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildFleetOrdersScope,
  normalizeFleetOrdersLocality,
  resolveFleetOrdersLocality,
  restaurantBelongsToFleetOrdersLocality,
} from "./fleetOrderScope.js";

const tenantA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const tenantB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const fleetA = "cccccccccccccccccccccccc";
const restaurantA = "dddddddddddddddddddddddd";
const restaurantB = "eeeeeeeeeeeeeeeeeeeeeeee";
const riderA = "ffffffffffffffffffffffff";
const riderB = "111111111111111111111111";

test("a Fleet user's locality comes from its persisted Fleet record, not the request query", () => {
  assert.equal(resolveFleetOrdersLocality("fleet", "Valencia", { localityName: "Xàtiva" }), "Xàtiva");
  assert.equal(resolveFleetOrdersLocality("fleet", "Xàtiva", { localityName: "", city: "Novetlè" }), "Novetlè");
  assert.equal(resolveFleetOrdersLocality("fleet", "Xàtiva", {}), null);
  assert.equal(resolveFleetOrdersLocality("admin", "Valencia", { localityName: "Xàtiva" }), "Valencia");
  assert.equal(normalizeFleetOrdersLocality("  XÀTIVA  "), "xativa");
});

test("restaurant locality matching accepts either city or locality but is exact after normalization", () => {
  assert.equal(restaurantBelongsToFleetOrdersLocality({ city: "Valencia", locality: "Xàtiva" }, "Xativa"), true);
  assert.equal(restaurantBelongsToFleetOrdersLocality({ city: "Xàtiva Centro", locality: "Xàtiva" }, "Xàtiva"), true);
  assert.equal(restaurantBelongsToFleetOrdersLocality({ city: "Xàtiva Centro", locality: "Valencia" }, "Xàtiva"), false);
  assert.equal(restaurantBelongsToFleetOrdersLocality({ city: "", locality: "" }, "Xàtiva"), false);
});

test("Fleet order queries include only its tenant/locality and either unassigned orders or its own Riders", () => {
  assert.deepEqual(buildFleetOrdersScope({
    role: "fleet",
    tenantId: tenantA,
    fleetId: fleetA,
    restaurantIds: [restaurantA, "not-an-id", restaurantA],
    riderIds: [riderA, riderB],
  }), {
    tenantId: tenantA,
    restaurantId: { $in: [restaurantA] },
    $or: [
      { riderId: null },
      { riderId: { $in: [riderA, riderB] } },
    ],
  });
});

test("Fleet scope fails closed for missing tenant, fleet, or locality relation, including rider-only matches", () => {
  assert.deepEqual(buildFleetOrdersScope({ role: "fleet", tenantId: undefined, fleetId: fleetA, restaurantIds: [restaurantA], riderIds: [riderA] }), { _id: null });
  assert.deepEqual(buildFleetOrdersScope({ role: "fleet", tenantId: tenantA, fleetId: undefined, restaurantIds: [restaurantA], riderIds: [riderA] }), { _id: null });
  assert.deepEqual(buildFleetOrdersScope({ role: "fleet", tenantId: tenantA, fleetId: fleetA, restaurantIds: [], riderIds: [riderA] }), { _id: null });
  assert.deepEqual(buildFleetOrdersScope({ role: "fleet", tenantId: tenantA, fleetId: fleetA, restaurantIds: ["invalid"], riderIds: ["invalid"] }), { _id: null });
});

test("tenant Admin order query is tenant-bound, and global access requires explicit platform-superadmin context", () => {
  assert.deepEqual(buildFleetOrdersScope({
    role: "admin",
    tenantId: tenantA,
    restaurantIds: [restaurantA, restaurantB],
  }), {
    tenantId: tenantA,
    restaurantId: { $in: [restaurantA, restaurantB] },
  });
  assert.deepEqual(buildFleetOrdersScope({ role: "admin", tenantId: undefined, restaurantIds: [restaurantA] }), { _id: null });
  assert.deepEqual(buildFleetOrdersScope({ role: "admin", tenantId: undefined, isPlatformSuperadmin: true, restaurantIds: [restaurantA] }), { restaurantId: { $in: [restaurantA] } });
  assert.deepEqual(buildFleetOrdersScope({ role: "admin", tenantId: tenantA, restaurantIds: [] }), { _id: null });
  assert.deepEqual(buildFleetOrdersScope({ role: "support", tenantId: tenantA, restaurantIds: [restaurantA] }), { _id: null });
});

test("Fleet orders HTTP handler derives locality and relations from the authenticated Fleet and never queries globally", () => {
  const serverSource = readFileSync(fileURLToPath(new URL("./server.ts", import.meta.url)), "utf8");
  const start = serverSource.indexOf('app.get("/api/v1/fleet/orders"');
  const end = serverSource.indexOf('app.get("/api/v1/fleet/operations/live"', start);
  assert.ok(start >= 0 && end > start, "Fleet orders route must remain present and independently testable");
  const route = serverSource.slice(start, end);
  assert.match(route, /employeeScope\(req\)/);
  assert.match(route, /Fleet\.findOne\(/);
  assert.match(route, /buildTenantScope\(req\.auth\.tenantId\)/);
  assert.match(route, /resolveFleetOrdersLocality\("fleet", requestedLocality, fleet\)/);
  assert.match(route, /fleetRiderFilter\(req\)/);
  assert.match(route, /Restaurant\.find\(tenant\)/);
  assert.match(route, /restaurantBelongsToFleetOrdersLocality\(restaurant, locality\)/);
  assert.match(route, /Order\.find\(buildFleetOrdersScope\(/);
  assert.match(route, /isPlatformSuperadmin: hasExplicitPlatformSuperadminScope\(req\)/);
  assert.doesNotMatch(route, /Order\.find\(\{\}\)/);
});
