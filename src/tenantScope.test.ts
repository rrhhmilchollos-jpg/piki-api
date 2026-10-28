import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFleetEntityScope,
  buildTenantEntityScope,
  buildTenantEntitySetScope,
  buildTenantScope,
  isObjectIdLike,
} from "./tenantScope.js";

const tenantA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const tenantB = "bbbbbbbbbbbbbbbbbbbbbbbb";
const riderA = "cccccccccccccccccccccccc";
const riderB = "dddddddddddddddddddddddd";
const fleetA = "eeeeeeeeeeeeeeeeeeeeeeee";

test("tenant scope is deny-by-default for absent or malformed tenant contexts", () => {
  assert.deepEqual(buildTenantScope(undefined), { _id: null });
  assert.deepEqual(buildTenantScope("tenant-a"), { _id: null });
  assert.deepEqual(buildTenantScope(tenantA), { tenantId: tenantA });
  assert.equal(isObjectIdLike(tenantA), true);
  assert.equal(isObjectIdLike("not-an-object-id"), false);
});

test("exact tenant entity scope binds both tenant and entity and never accepts a malformed id", () => {
  assert.deepEqual(buildTenantEntityScope(tenantA, riderA), { tenantId: tenantA, _id: riderA });
  assert.deepEqual(buildTenantEntityScope(tenantA, riderA, "riderId"), { tenantId: tenantA, riderId: riderA });
  assert.deepEqual(buildTenantEntityScope(tenantA, "rider-a"), { _id: null });
  assert.deepEqual(buildTenantEntityScope(undefined, riderA), { _id: null });
  assert.deepEqual(buildTenantEntityScope(tenantA, riderA, "tenantId"), { _id: null });
});

test("tenant entity-set scope fails closed for an empty or invalid authorised relation set", () => {
  assert.deepEqual(buildTenantEntitySetScope(tenantA, [riderA, riderB], "riderId"), {
    tenantId: tenantA,
    riderId: { $in: [riderA, riderB] },
  });
  assert.deepEqual(buildTenantEntitySetScope(tenantA, [], "riderId"), { _id: null });
  assert.deepEqual(buildTenantEntitySetScope(tenantA, ["not-an-id"], "riderId"), { _id: null });
});

test("Fleet direct-ownership scope cannot fall back to tenant-wide or global data", () => {
  assert.deepEqual(buildFleetEntityScope({ tenantId: tenantA, role: "fleet", fleetId: fleetA }), {
    tenantId: tenantA,
    fleetId: fleetA,
  });
  assert.deepEqual(buildFleetEntityScope({ tenantId: tenantA, role: "fleet" }), { _id: null });
  assert.deepEqual(buildFleetEntityScope({ tenantId: tenantA, role: "admin", fleetId: fleetA }), { tenantId: tenantA });
  assert.deepEqual(buildFleetEntityScope({ tenantId: tenantB, role: "fleet", fleetId: fleetA, fleetField: "ownerFleetId" }), {
    tenantId: tenantB,
    ownerFleetId: fleetA,
  });
  assert.deepEqual(buildFleetEntityScope({ tenantId: tenantA, role: "fleet", fleetId: fleetA, fleetField: "tenantId" }), { _id: null });
});


test("Fleet Rider picker includes its assigned fleet and unassigned Riders only within the tenant", async () => {
  const { buildFleetRiderPickerScope } = await import("./tenantScope.js");
  assert.deepEqual(buildFleetRiderPickerScope({ tenantId: tenantA, role: "fleet", fleetId: fleetA }), {
    tenantId: tenantA,
    $or: [{ fleetId: fleetA }, { fleetId: null }],
  });
  assert.deepEqual(buildFleetRiderPickerScope({ tenantId: tenantA, role: "fleet" }), { _id: null });
  assert.deepEqual(buildFleetRiderPickerScope({ tenantId: "invalid", role: "fleet", fleetId: fleetA }), { _id: null });
  assert.deepEqual(buildFleetRiderPickerScope({ tenantId: tenantA, role: "admin", fleetId: fleetA }), { tenantId: tenantA });
});
