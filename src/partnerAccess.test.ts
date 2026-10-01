import test from "node:test";
import assert from "node:assert/strict";
import { partnerCan, partnerRolesForEmployee } from "./partnerAccess.js";
import { sessionRole } from "./employeeSessions.js";
import { isTemporaryPasswordAllowedPath } from "./auth.js";

test("legacy partner accounts receive partner administrator permissions", () => {
  const roles = partnerRolesForEmployee({ apiRole: "partner", jobRole: "partner" });
  assert.deepEqual(roles, ["partner_admin"]);
  assert.equal(partnerCan(roles, "orders:write"), true);
  assert.equal(partnerCan(roles, "menu:write"), true);
  assert.equal(partnerCan(roles, "metrics:read"), true);
});

test("kitchen access remains scoped to preparation actions", () => {
  const roles = partnerRolesForEmployee({ apiRole: "partner", partnerRoles: ["kitchen"] });
  assert.equal(partnerCan(roles, "orders:read"), true);
  assert.equal(partnerCan(roles, "orders:prepare"), true);
  assert.equal(partnerCan(roles, "orders:cancel"), false);
  assert.equal(partnerCan(roles, "menu:write"), false);
});

test("explicit admin role is preserved for the protected owner session", () => {
  const employee = {
    email: "rrhh.milchollos@gmail.com",
    apiRole: "partner",
    roles: ["admin"],
    ownerProtected: true,
    authorizationStatus: "approved",
  };
  assert.equal(sessionRole(employee, "admin", "admin"), "admin");
  assert.equal(sessionRole(employee, "admin"), "admin");
});

test("demo commercial can enter Partner Orders with its primary partner role", () => {
  const employee = {
    email: "mendezadolfo5@gmail.com",
    apiRole: "partner",
    roles: ["partner", "commercial", "gerente_comercial_zona"],
    primaryRole: "partner",
    authorizationStatus: "approved",
  };
  assert.equal(sessionRole(employee, "partner"), "partner");
  assert.equal(sessionRole(employee, "admin", "commercial"), "commercial");
});

test("temporary credentials only reach the password-change endpoint", () => {
  assert.equal(isTemporaryPasswordAllowedPath("/api/v1/auth/employee/change-password"), true);
  assert.equal(isTemporaryPasswordAllowedPath("/api/v1/auth/employee/me"), false);
  assert.equal(isTemporaryPasswordAllowedPath("/api/v1/partners/kitchen/orders"), false);
});
