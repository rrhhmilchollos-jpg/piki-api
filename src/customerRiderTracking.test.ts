import test from "node:test";
import assert from "node:assert/strict";
import { EmployeeAccount, Rider } from "./models.js";
import { CUSTOMER_RIDER_PROJECTION, customerAssignedRider } from "./customerRiderTracking.js";
import { PNG_PHOTO, WEBP_PHOTO, fixtureQuery, ids } from "./testFixtures/profileIdentities.js";
const order = { riderId: ids.rider, tenantId: ids.tenant, assignmentState: "assigned", status: "preparing" };
const rider = { _id: ids.rider, tenantId: ids.tenant, name: "José María López García", firstName: "José María", lastName: "López García", email: "rider@example.test", vehicle: "bike", photoUrl: null };
const employee = { _id: ids.employee, tenantId: ids.tenant, email: rider.email, active: true, authorizationStatus: "approved", photoUrl: PNG_PHOTO };

test("avatar falls back only to exact unique employee email and same tenant, active and approved", async (t) => {
  t.mock.method(Rider as any, "findOne", (filter: any) => { assert.deepEqual(filter, { _id: ids.rider, tenantId: ids.tenant }); return fixtureQuery(rider, (fields) => assert.equal(fields, CUSTOMER_RIDER_PROJECTION)); });
  t.mock.method(EmployeeAccount as any, "find", (filter: any) => { assert.deepEqual(filter, { email: rider.email, tenantId: ids.tenant }); return fixtureQuery([employee], (fields) => assert.equal(fields, "_id tenantId email active authorizationStatus photoUrl"), (limit) => assert.equal(limit, 2)); });
  const result = await customerAssignedRider(order);
  assert.deepEqual(result.identity, { riderId: ids.rider, riderName: "José María L.", riderPhotoUrl: PNG_PHOTO, vehicle: "bike" });
  assert(!JSON.stringify(result.identity).match(/email|phone|documents|password|@|García|López/));
});

test("explicit valid Rider avatar has precedence without reading employee or KYC", async (t) => {
  const row = { ...rider, photoUrl: WEBP_PHOTO };
  Object.defineProperty(row, "documents", { get() { throw new Error("KYC_MUST_NOT_BE_READ"); } });
  t.mock.method(Rider as any, "findOne", () => fixtureQuery(row));
  t.mock.method(EmployeeAccount as any, "find", () => { throw new Error("EMPLOYEE_FALLBACK_MUST_NOT_BE_READ"); });
  assert.equal((await customerAssignedRider(order)).identity.riderPhotoUrl, WEBP_PHOTO);
});

for (const [reason, employees] of [
  ["no exact linked account", []], ["duplicate link", [employee, employee]], ["cross tenant", [{ ...employee, tenantId: ids.otherTenant }]],
  ["inactive", [{ ...employee, active: false }]], ["suspended", [{ ...employee, authorizationStatus: "suspended" }]],
  ["pending", [{ ...employee, authorizationStatus: "pending" }]], ["revoked", [{ ...employee, authorizationStatus: "revoked" }]],
  ["email case mismatch", [{ ...employee, email: "Rider@example.test" }]], ["email partial mismatch", [{ ...employee, email: "other-rider@example.test" }]],
  ["private URL avatar", [{ ...employee, photoUrl: "/api/v1/document-requests/private" }]],
  ["KYC-only employee", [{ ...employee, photoUrl: null, documents: [{ type: "identity", contentBase64: PNG_PHOTO }] }]],
] as const) test(`never uses employee photo for ${reason}`, async (t) => {
  t.mock.method(Rider as any, "findOne", () => fixtureQuery(rider)); t.mock.method(EmployeeAccount as any, "find", () => fixtureQuery(employees));
  assert.equal((await customerAssignedRider(order)).identity.riderPhotoUrl, null);
});

test("Rider documents and private photo paths never become avatars; no name fallback to email/phone", async (t) => {
  t.mock.method(Rider as any, "findOne", () => fixtureQuery({ ...rider, photoUrl: "/private/identity.png", firstName: null, lastName: null, name: "", documents: [{ photoUrl: PNG_PHOTO }], phone: "+34612345678" }));
  t.mock.method(EmployeeAccount as any, "find", () => fixtureQuery([]));
  const { identity } = await customerAssignedRider(order); assert.equal(identity.riderPhotoUrl, null); assert.equal(identity.riderName, null);
});
for (const [reason, value] of [["missing rider", null], ["different Rider", { ...rider, _id: ids.employee }], ["other tenant", { ...rider, tenantId: ids.otherTenant }], ["unbound Rider", { ...rider, tenantId: null }]] as const) test(`fails closed for ${reason}`, async (t) => {
  t.mock.method(Rider as any, "findOne", () => fixtureQuery(value)); t.mock.method(EmployeeAccount as any, "find", () => { throw new Error("UNEXPECTED_EMPLOYEE_READ"); });
  assert.deepEqual((await customerAssignedRider(order)).identity, { riderId: null, riderName: null, riderPhotoUrl: null, vehicle: null });
});
test("no identity lookup for ended, offered, released, missing rider or unbound tenant", async (t) => {
  t.mock.method(Rider as any, "findOne", () => { throw new Error("NO_TERMINAL_IDENTITY_READ"); });
  for (const override of [{ status: "delivered" }, { status: "cancelled" }, { assignmentState: "offered" }, { assignmentState: "unassigned" }, { riderId: null }, { tenantId: null }]) {
    assert.deepEqual((await customerAssignedRider({ ...order, ...override })).identity, { riderId: null, riderName: null, riderPhotoUrl: null, vehicle: null });
  }
});
test("email must already be exact canonical identity; never normalize into a different link", async (t) => {
  t.mock.method(EmployeeAccount as any, "find", () => { throw new Error("NO_FUZZY_EMAIL_LOOKUP"); });
  for (const email of [" Rider@example.test ", "Rider@example.test", ""]) {
    t.mock.method(Rider as any, "findOne", () => fixtureQuery({ ...rider, email }));
    assert.equal((await customerAssignedRider(order)).identity.riderPhotoUrl, null);
  }
});
