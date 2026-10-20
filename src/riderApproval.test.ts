import assert from "node:assert/strict";
import test from "node:test";
import {
  buildApprovedRiderOperationalProfile,
  buildRiderEmployeeProvisioningFields,
  riderEmployeeProvisioningConflict,
} from "./riderApproval.js";

const tenantA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const tenantB = "bbbbbbbbbbbbbbbbbbbbbbbb";

test("el perfil operativo aprobado no copia documentación sensible", () => {
  assert.deepEqual(
    buildApprovedRiderOperationalProfile({
      name: "  Rider Uno  ",
      email: " Rider@Example.test ",
      phone: " 600 123 123 ",
      city: " Xàtiva ",
      availability: " tardes ",
      vehicle: "bike",
    }),
    {
      name: "Rider Uno",
      email: "rider@example.test",
      phone: "600 123 123",
      city: "Xàtiva",
      availability: "tardes",
      vehicle: "bike",
    },
  );
});

test("el aprovisionamiento fija exclusivamente el acceso rider y exige cambio de contraseña", () => {
  const authorizedAt = new Date("2026-10-20T10:00:00.000Z");
  assert.deepEqual(
    buildRiderEmployeeProvisioningFields({
      name: " Rider Uno ",
      email: " Rider@Example.test ",
      tenantId: tenantA,
      fleetId: "cccccccccccccccccccccccc",
      authorizedBy: "dddddddddddddddddddddddd",
      authorizedAt,
    }),
    {
      tenantId: tenantA,
      name: "Rider Uno",
      email: "rider@example.test",
      jobRole: "rider",
      apiRole: "rider",
      primaryRole: "rider",
      roles: ["rider"],
      accessLevel: "subadmin",
      authorizationStatus: "approved",
      authorizedAt,
      authorizedBy: "dddddddddddddddddddddddd",
      authorizationReason: "Alta de RiderApplication validada documentalmente.",
      fleetId: "cccccccccccccccccccccccc",
      active: true,
      mustChangePassword: true,
    },
  );
});

test("un empleado existente solo se reutiliza si es un rider del mismo tenant", () => {
  const rider = { tenantId: tenantA, jobRole: "rider", apiRole: "rider", primaryRole: null, roles: ["rider"] };
  assert.equal(riderEmployeeProvisioningConflict(rider, tenantA), null);
  assert.equal(riderEmployeeProvisioningConflict(rider, tenantB), "EMPLOYEE_EMAIL_OWNED_BY_ANOTHER_TENANT");
  assert.equal(
    riderEmployeeProvisioningConflict({ ...rider, roles: ["rider", "fleet"] }, tenantA),
    "EMPLOYEE_EMAIL_ROLE_INCOMPATIBLE",
  );
  assert.equal(
    riderEmployeeProvisioningConflict({ ...rider, jobRole: "admin", apiRole: "admin", roles: ["admin"] }, tenantA),
    "EMPLOYEE_EMAIL_ROLE_INCOMPATIBLE",
  );
  assert.equal(
    riderEmployeeProvisioningConflict({ ...rider, ownerProtected: true }, tenantA),
    "EMPLOYEE_EMAIL_ROLE_INCOMPATIBLE",
  );
});
