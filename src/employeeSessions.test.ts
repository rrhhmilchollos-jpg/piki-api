import assert from "node:assert/strict";
import test from "node:test";
import {
  OWNER_EMAIL,
  canIssueEmployeeSession,
  frozenTenantId,
  isRootOwnerAccount,
  sessionRole,
  sessionTenantMatchesEmployee,
} from "./employeeSessions.js";

const tenantA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const tenantB = "bbbbbbbbbbbbbbbbbbbbbbbb";

test("session tenant is compared against the frozen issue-time value", () => {
  assert.equal(frozenTenantId(tenantA), tenantA);
  assert.equal(frozenTenantId(undefined), null);
  assert.equal(sessionTenantMatchesEmployee(tenantA, tenantA), true);
  assert.equal(sessionTenantMatchesEmployee(tenantA, tenantB), false);
  assert.equal(sessionTenantMatchesEmployee(tenantA, null), false);
  assert.equal(sessionTenantMatchesEmployee(null, tenantA), false);
});

test("ordinary employee sessions fail closed without a tenant while the protected root owner remains available for bootstrap", () => {
  const ordinary = { email: "admin@example.test", tenantId: null, ownerProtected: false, accessLevel: "subadmin" };
  const root = { email: OWNER_EMAIL, tenantId: null, ownerProtected: true, accessLevel: "superadmin" };

  assert.equal(isRootOwnerAccount(ordinary), false);
  assert.equal(canIssueEmployeeSession(ordinary), false);
  assert.equal(isRootOwnerAccount(root), true);
  assert.equal(canIssueEmployeeSession(root), true);
  assert.equal(canIssueEmployeeSession({ ...ordinary, tenantId: tenantA }), true);
});

test("root owner retains its established administrative surface without broadening ordinary roles", () => {
  const owner = {
    email: OWNER_EMAIL,
    apiRole: "admin",
    roles: ["admin"],
    ownerProtected: true,
    authorizationStatus: "approved",
  };
  const employee = {
    email: "partner@example.test",
    apiRole: "partner",
    roles: ["partner"],
    authorizationStatus: "approved",
  };

  assert.equal(sessionRole(owner, "admin", "admin"), "admin");
  assert.equal(sessionRole(owner, "fleet", "fleet"), "fleet");
  assert.equal(sessionRole(employee, "fleet", "fleet"), null);
});
