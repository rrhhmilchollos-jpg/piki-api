import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
import { handleCustomerTrpc } from "./customerCompat.js";
import { CustomerAccount, EmployeeAccount, Rider, Order, Restaurant } from "./models.js";
import { apiRoles, isTemporaryPasswordAllowedPath } from "./auth.js";
import { customerAssignedRider } from "./customerRiderTracking.js";
import { customerDeliveryIsActive, employeeProfileUpdateSchema, riderAdminProfileUpdateSchema } from "./profileIdentityPolicy.js";
import { PNG_PHOTO, WEBP_PHOTO, fixtureQuery as q, fixtureResponse as response, ids } from "./testFixtures/profileIdentities.js";
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compile(code: string, context: Record<string, any>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${js}; return subject;`)(...Object.values(context));
}
function registration(method: string, path: string) {
  const statement = source.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === `app.${method}` && ts.isStringLiteral(node.expression.arguments[0]) && node.expression.arguments[0].text === path) as ts.ExpressionStatement;
  assert(statement, `Actual ${method} ${path} route must exist`); return statement.expression as ts.CallExpression;
}
function route(method: string, path: string, context: Record<string, any>) {
  return compile(`const subject = ${registration(method, path).arguments.at(-1)!.getText(source)};`, context);
}
function realGuard(name: string, context: Record<string, any>) {
  const node = authSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name); assert(node);
  return compile(`${node.getText(authSource).replace("export function", "function")}; const subject = ${name};`, context);
}
const employee = { _id: ids.employee, tenantId: ids.tenant, name: "Nombre Real Empleado Dos Apellidos", jobRole: "zone_manager", apiRole: "fleet", photoUrl: PNG_PHOTO };
const ownProfilePath = "/api/v1/auth/employee/profile";

test("new avatar PATCH mounts precisely all existing roles; Owner-only structured names do not relax permissions", () => {
  const guard = registration("patch", ownProfilePath).arguments[1] as ts.CallExpression;
  assert.equal(guard.expression.getText(source), "requireRole");
  assert.deepEqual(guard.arguments.map((arg) => (arg as ts.StringLiteral).text), [...apiRoles]);
  assert.equal(registration("patch", "/api/v1/admin/riders/:id/basic-profile").arguments[1].getText(source), "requireOwner()");
  assert(source.getText().includes('app.use(express.json({ limit: "20mb" }))'));
});
for (const role of apiRoles) test(`avatar PATCH ${role} updates only authenticated employee photo, never target/roles/name`, async () => {
  let write: any;
  const handler = route("patch", ownProfilePath, { employeeProfileUpdateSchema, tenantScope: () => ({ tenantId: ids.tenant }),
    EmployeeAccount: { findOneAndUpdate(filter: any, update: any, options: any) { write = { filter, update, options }; return q({ ...employee, photoUrl: update.$set.photoUrl }); } } });
  const res = response(); await handler({ auth: { role, employeeId: ids.employee }, body: { photoUrl: WEBP_PHOTO }, query: { employeeId: ids.customer }, params: { id: ids.customer } }, res);
  assert.equal(res.code, 200); assert.deepEqual(write.filter, { _id: ids.employee, tenantId: ids.tenant, active: true, authorizationStatus: "approved" });
  assert.deepEqual(write.update, { $set: { photoUrl: WEBP_PHOTO } }); assert.deepEqual(write.options, { new: true, runValidators: true });
  assert.deepEqual(res.body, { updated: true, employee: { id: ids.employee, name: employee.name, fullName: employee.name, jobRole: "zone_manager", role, photoUrl: WEBP_PHOTO } });
});
test("employee PATCH rejects bad photo/extra fields before writes, requires human employee, handles absent account and removes with null", async () => {
  let writes = 0; let found = true;
  const handler = route("patch", ownProfilePath, { employeeProfileUpdateSchema, tenantScope: () => ({ tenantId: ids.tenant }),
    EmployeeAccount: { findOneAndUpdate(_filter: any, update: any) { writes++; return q(found ? { ...employee, photoUrl: update.$set.photoUrl } : null); } } });
  for (const body of [{}, { photoUrl: "https://external.example.test/photo.png" }, { photoUrl: PNG_PHOTO, name: "Other Name" }, { photoUrl: null, role: "admin" }, { photoUrl: null, tenantId: ids.otherTenant }, { photoUrl: null, employeeId: ids.customer }]) {
    const res = response(); await handler({ auth: { role: "rider", employeeId: ids.employee }, body }, res); assert.equal(res.code, 400);
  }
  const emergency = response(); await handler({ auth: { role: "admin" }, body: { photoUrl: null } }, emergency); assert.equal(emergency.code, 403); assert.equal(writes, 0);
  const removal = response(); await handler({ auth: { role: "rider", employeeId: ids.employee }, body: { photoUrl: null } }, removal); assert.equal(removal.body.employee.photoUrl, null);
  found = false; const missing = response(); await handler({ auth: { role: "rider", employeeId: ids.employee }, body: { photoUrl: null } }, missing); assert.equal(missing.code, 404);
});
test("actual requireRole retains auth, tenant and temporary-password gates for own profile PATCH", async () => {
  for (const [auth, code] of [[null, 401], [{ role: "customer" }, 403], [{ role: "fleet", employeeId: ids.employee }, 403], [{ role: "fleet", employeeId: ids.employee, tenantId: ids.tenant, mustChangePassword: true }, 428]]) {
    const guard = realGuard("requireRole", { resolveRole: async () => auth, isTemporaryPasswordAllowedPath })(...apiRoles);
    const res = response(); let next = false; await guard({ path: ownProfilePath }, res, () => { next = true; }); assert.equal(res.code, code); assert(!next);
  }
});
test("employee/me preserves existing role/permissions/location fields and adds REAL full name and own photo", async () => {
  const handler = route("get", "/api/v1/auth/employee/me", { EmployeeAccount: { findOne: (filter: any) => { assert.deepEqual(filter, { _id: ids.employee, tenantId: ids.tenant }); return q(employee, (fields) => assert(fields.includes("photoUrl"))); } },
    tenantScope: () => ({ tenantId: ids.tenant }), partnerRolesForEmployee: () => ["fleet"], permissionsForPartnerRoles: () => ["existing:permission"], partnerLocationsFor: async () => [{ id: "existing-location" }], employeeCodeFor: () => "PIKI-E-FIXTURE" });
  const res = response(); await handler({ auth: { role: "fleet", employeeId: ids.employee } }, res);
  assert.equal(res.body.employee.name, employee.name); assert.equal(res.body.employee.fullName, employee.name); assert.equal(res.body.employee.photoUrl, PNG_PHOTO);
  assert.equal(res.body.employee.role, "fleet"); assert.equal(res.body.employee.jobRole, "zone_manager"); assert.deepEqual(res.body.employee.roles, ["fleet"]);
  assert.deepEqual(res.body.employee.permissions, ["existing:permission"]); assert.deepEqual(res.body.employee.locations, [{ id: "existing-location" }]); assert.equal(res.body.employee.fleetId, null);
});
test("Rider session preserves rider/slot while adding real employee identity and session role", async () => {
  const rider = { _id: ids.rider, riderCode: "R-FIXTURE", name: "Nombre Operativo Diferente", email: "rider@example.test", status: "available", lifecycleStatus: "active", fleetId: null };
  const now = { date: "2026-11-13", time: "12:00" }; const slot = { status: "active" };
  const handler = route("get", "/api/v1/riders/session", { tenantScope: () => ({ tenantId: ids.tenant }), EmployeeAccount: { findOne: () => q(employee) }, Rider: { findOne: () => q(rider), updateOne: () => { throw new Error("STATUS_NOT_CHANGED"); } }, Order: { exists: async () => false }, findCurrentRiderSlot: async () => ({ now, slot }) });
  const res = response(); await handler({ auth: { role: "rider", employeeId: ids.employee } }, res);
  assert.deepEqual(res.body.employee, { id: ids.employee, name: employee.name, fullName: employee.name, jobRole: "zone_manager", role: "rider", photoUrl: PNG_PHOTO });
  assert.deepEqual(res.body.rider, { id: ids.rider, riderCode: "R-FIXTURE", name: rider.name, email: rider.email, status: "available", fleetId: null }); assert.deepEqual(res.body.now, now); assert.deepEqual(res.body.slot, slot);
});
test("Owner structured-name route validates fields and exact tenant scope; audit contains only field names", async () => {
  let write: any; let audit: any; let writes = 0;
  const handler = route("patch", "/api/v1/admin/riders/:id/basic-profile", { riderAdminProfileUpdateSchema, objectId: (id: string) => /^[a-f\d]{24}$/.test(id) ? id : null, tenantScope: () => ({ tenantId: ids.tenant }),
    Rider: { findOneAndUpdate(filter: any, update: any, options: any) { writes++; write = { filter, update, options }; return q({ _id: ids.rider, name: "Legacy Full Name", ...update.$set }); } }, recordGovernanceEvent: async (value: any) => { audit = value; } });
  const req = { auth: { employeeId: ids.employee, tenantId: ids.tenant }, params: { id: ids.rider } };
  for (const body of [{}, { firstName: "" }, { firstName: "Ana", role: "admin" }, { photoUrl: PNG_PHOTO }, { lastName: "mail@example.test" }]) {
    const res = response(); await handler({ ...req, body }, res); assert.equal(res.code, 400);
  }
  assert.equal(writes, 0); const valid = response(); await handler({ ...req, body: { firstName: "Ana María", lastName: "López García" } }, valid);
  assert.equal(valid.code, 200); assert.deepEqual(write, { filter: { _id: ids.rider, tenantId: ids.tenant }, update: { $set: { firstName: "Ana María", lastName: "López García" } }, options: { new: true, runValidators: true } });
  assert.deepEqual(audit.after, { fields: ["firstName", "lastName"] }); assert(!JSON.stringify(audit).includes("López"));
});
test("Admin existing operational fields and nullable public names remain accepted together, GET retains name parts", async () => {
  const changes = { name: "Ana María López García", firstName: "Ana María", lastName: "López García", phone: "600000000", city: "Xàtiva", availability: "Mañana", vehicle: "bike", zoneSlug: null };
  assert.deepEqual(riderAdminProfileUpdateSchema.parse(changes), changes);
  assert.deepEqual(riderAdminProfileUpdateSchema.parse({ firstName: null, lastName: null }), { firstName: null, lastName: null });
  assert(!riderAdminProfileUpdateSchema.safeParse({ ...changes, role: "admin" }).success);
  assert(!riderAdminProfileUpdateSchema.safeParse({ firstName: "a".repeat(81) }).success);
  assert(!riderAdminProfileUpdateSchema.safeParse({ lastName: "a".repeat(121) }).success);
  assert(registration("get", "/api/v1/riders/:id/profile").getText(source).includes("name firstName lastName"));
  assert(registration("patch", "/api/v1/admin/riders/:id/profile").getText(source).includes("riderAdminProfileUpdateSchema.safeParse"));
});
test("actual requireOwner still blocks non-owner roles and emergency env identity for structured names", async () => {
  for (const [auth, status] of [[null, 401], [{ role: "rider", employeeId: ids.employee }, 403], [{ role: "admin" }, 403], [{ role: "admin", employeeId: ids.employee }, 403]]) {
    const guard = realGuard("requireOwner", { resolveRole: async () => auth, PIKI_OWNER_EMAIL: "owner@example.test", EmployeeAccount: { findOne: () => q(null) } })();
    const res = response(); await guard({}, res, () => { throw new Error("OWNER_BYPASS"); }); assert.equal(res.code, status);
  }
});

const customer = { _id: ids.customer, name: "Fixture Customer", email: "customer@example.test", referralCode: "PIKI-FIXTURE", photoUrl: PNG_PHOTO, phone: "", locality: "Xàtiva", deliveryAddress: "Fixture address" };
const ownedOrder = { _id: ids.order, publicCode: "PIKI-FIXTURE", tenantId: ids.tenant, restaurantId: ids.restaurant, customerId: ids.customer, riderId: ids.rider, assignmentState: "assigned", status: "preparing", routeDurationMinutes: 10, paymentState: "paid" };
const trackedRider = { _id: ids.rider, tenantId: ids.tenant, name: "José María López García", firstName: "José María", lastName: "López García", email: "rider@example.test", vehicle: "bike", photoUrl: PNG_PHOTO, location: { coordinates: [-0.5, 39] }, lastLocationAt: new Date() };
async function trpc(procedure: string, input: any = {}, method = "POST", authenticated = true) {
  const req: any = { method, originalUrl: `/api/trpc/${procedure}`, path: `/api/trpc/${procedure}`, url: `/api/trpc/${procedure}`, params: { procedure }, query: method === "GET" ? { input: JSON.stringify({ json: input }) } : {}, body: method === "POST" ? { json: input } : {}, header: (name: string) => name === "x-piki-session" && authenticated ? "OFFLINE_CUSTOMER_SESSION" : undefined };
  const res = response(); await handleCustomerTrpc(req, res); return { code: res.code, body: res.body, value: res.body?.result?.data?.json, headers: res.headers };
}
function mockCustomer(t: any) {
  t.mock.method(CustomerAccount as any, "findOne", (filter: any) => { assert.deepEqual(filter, { sessionHash: createHash("sha256").update("OFFLINE_CUSTOMER_SESSION").digest("hex") }); return q(customer); });
}
test("real Customer auth.me/profile.get return only customer's own photo; login transport GET/POST preserved", async (t) => {
  mockCustomer(t);
  for (const procedure of ["auth.me", "customer.profile.get"]) for (const method of ["GET", "POST"]) {
    const result = await trpc(procedure, {}, method); assert.equal(result.code, 200); assert.equal(result.value.id, ids.customer); assert.equal(result.value.photoUrl, PNG_PHOTO); assert.equal(result.value.name, customer.name);
    if (procedure === "auth.me") assert.equal(result.value.role, "user");
  }
});
test("Customer photo update/removal uses common validation and whitelist; role/foreign IDs cannot affect update", async (t) => {
  mockCustomer(t); const writes: any[] = [];
  t.mock.method(CustomerAccount as any, "findOneAndUpdate", (filter: any, update: any, options: any) => { writes.push({ filter, update, options }); return q({ ...customer, ...update.$set }); });
  for (const photoUrl of [WEBP_PHOTO, null]) {
    const result = await trpc("customer.profile.update", { photoUrl, role: "admin", apiRole: "admin", permissions: ["*"], employeeId: ids.employee, customerId: ids.employee });
    assert.equal(result.code, 200); assert.equal(result.value.saved, true); assert.equal(result.value.profile.photoUrl, photoUrl);
    const write = writes.at(-1); assert.deepEqual(write.filter, { _id: ids.customer }); assert.deepEqual(write.update, { $set: { name: customer.name, phone: "", locality: "Xàtiva", photoUrl } }); assert.equal(write.options.runValidators, true);
  }
  const before = writes.length;
  for (const photoUrl of ["/private/kyc", "https://external.test/photo.png", "data:image/svg+xml;base64,PHN2Zy8+", "a".repeat(220_001), 123]) assert.equal((await trpc("customer.profile.update", { photoUrl })).code, 400);
  assert.equal(writes.length, before);
  const oldClient = await trpc("customer.profile.update", { name: "Changed Customer", phone: "123", locality: "Xàtiva", address: "Changed address" }); assert.equal(oldClient.code, 200);
  assert(!Object.hasOwn(writes.at(-1).update.$set, "photoUrl")); assert.equal(writes.at(-1).update.$set.deliveryAddress, "Changed address");
});
test("Customer profile/tracking require real Customer session; anonymous auth.me remains null", async () => {
  assert.equal((await trpc("auth.me", {}, "GET", false)).value, null);
  for (const procedure of ["customer.profile.get", "customer.profile.update", "order.get", "order.customerTracking"]) assert.equal((await trpc(procedure, {}, "POST", false)).code, 401);
});
function trackingMocks(t: any, order: any, rider: any = trackedRider) {
  mockCustomer(t);
  t.mock.method(Order as any, "findOne", (filter: any) => { assert.deepEqual(filter, { publicCode: ownedOrder.publicCode, customerId: ids.customer }); return q(order, (fields) => assert(fields.includes("tenantId"))); });
  t.mock.method(Restaurant as any, "findById", () => q({ name: "Fixture Restaurant" }));
  t.mock.method(Rider as any, "findOne", (filter: any) => { assert.deepEqual(filter, { _id: ids.rider, tenantId: ids.tenant }); return q(rider); });
}
for (const status of ["preparing", "ready_for_pickup", "picked_up", "on_the_way"]) test(`actual Customer tRPC assigned ${status} returns public identity without widening GPS`, async (t) => {
  trackingMocks(t, { ...ownedOrder, status }, { ...trackedRider, lastLocationAt: new Date() });
  for (const procedure of ["order.customerTracking", "order.get"]) {
    const result = await trpc(procedure, { id: ownedOrder.publicCode, customerId: ids.employee }); assert.equal(result.code, 200);
    assert.equal(result.value.riderId, ids.rider); assert.equal(result.value.assignmentState, "assigned"); assert.equal(result.value.riderName, "José María L."); assert.equal(result.value.riderPhotoUrl, PNG_PHOTO);
    assert(!JSON.stringify(result.value).match(/López|García|rider@example|email|phone|document/));
    if (procedure === "order.customerTracking") { const active = ["picked_up", "on_the_way"].includes(status); assert.equal(result.value.available, active); assert.equal(result.value.chatAvailable, active); assert.equal(Object.hasOwn(result.value, "latitude"), active); }
    else assert(!Object.hasOwn(result.value, "latitude"));
  }
});
for (const override of [{ status: "delivered" }, { status: "cancelled" }, { assignmentState: "offered" }, { assignmentState: "unassigned" }, { riderId: null }]) test(`actual Customer tRPC clears identity for ${JSON.stringify(override)}`, async (t) => {
  trackingMocks(t, { ...ownedOrder, ...override }); t.mock.method(Rider as any, "findOne", () => { throw new Error("NO_RELEASED_IDENTITY_LOOKUP"); });
  for (const procedure of ["order.customerTracking", "order.get"]) {
    const result = await trpc(procedure, { id: ownedOrder.publicCode }); assert.equal(result.code, 200); assert.equal(result.value.riderId, null); assert.equal(result.value.riderName, null); assert.equal(result.value.riderPhotoUrl, null); assert.equal(result.value.vehicle, null); assert(!Object.hasOwn(result.value, "latitude"));
  }
});
test("actual Customer tRPC rejects another customer's order before any Rider lookup", async (t) => {
  trackingMocks(t, null); t.mock.method(Rider as any, "findOne", () => { throw new Error("NO_FOREIGN_ORDER_LOOKUP"); });
  for (const procedure of ["order.customerTracking", "order.get"]) assert.equal((await trpc(procedure, { id: ownedOrder.publicCode, customerId: ids.employee })).code, 404);
});
test("actual Customer tRPC missing/cross-tenant Rider fails closed; legacy name never exposes surnames", async (t) => {
  for (const rider of [null, { ...trackedRider, tenantId: ids.otherTenant }, { ...trackedRider, firstName: null, lastName: null }]) {
    trackingMocks(t, { ...ownedOrder, status: "on_the_way" }, rider);
    const result = await trpc("order.customerTracking", { id: ownedOrder.publicCode }); assert.equal(result.code, 200);
    assert.equal(result.value.riderName, rider?.tenantId === ids.tenant ? "José" : null);
  }
});
test("tracking preserves freshness windows (tRPC 90s, internal 120s), own scope, public identity and internal cash fields", async (t) => {
  trackingMocks(t, { ...ownedOrder, status: "on_the_way" }, { ...trackedRider, lastLocationAt: new Date(Date.now() - 100_000) });
  const trpcResult = await trpc("order.customerTracking", { id: ownedOrder.publicCode }); assert.equal(trpcResult.value.available, false); assert.equal(trpcResult.value.riderName, "José María L."); assert(!Object.hasOwn(trpcResult.value, "latitude"));
  const handler = route("get", "/api/v1/internal/customer-orders/:publicCode/tracking", { requireCustomerSyncSecret: () => true, Order: { findOne(filter: any) { assert.deepEqual(filter, { publicCode: ownedOrder.publicCode, customerId: ids.customer }); return q({ ...ownedOrder, status: "on_the_way", paymentMethod: "cash", paymentState: "pending", tipCents: 200 }); } }, customerAssignedRider, customerDeliveryIsActive });
  const res = response(); await handler({ params: { publicCode: ownedOrder.publicCode }, query: { customerId: ids.customer } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.riderName, "José María L."); assert.equal(res.body.riderId, ids.rider); assert.equal(res.body.locationAvailable, true); assert.equal(res.body.latitude, 39); assert.equal(res.body.chatAvailable, true); assert.equal(res.body.cashDueAtDelivery, true); assert.equal(res.body.tipCents, 200);
});
test("internal tracking demands sync gate and customerId before read, plus customer-owned order query", async () => {
  let reads = 0; let gate = true;
  const handler = route("get", "/api/v1/internal/customer-orders/:publicCode/tracking", { requireCustomerSyncSecret: (_req: any, res: any) => { if (!gate) res.status(401).json({ error: "INVALID_SYNC_AUTH" }); return gate; }, Order: { findOne(filter: any) { reads++; assert.deepEqual(filter, { publicCode: ownedOrder.publicCode, customerId: ids.employee }); return q(null); } }, customerAssignedRider, customerDeliveryIsActive });
  for (const customerId of [undefined, "", [ids.customer], "x".repeat(161)]) { const res = response(); await handler({ params: { publicCode: ownedOrder.publicCode }, query: { customerId } }, res); assert.equal(res.code, 400); }
  assert.equal(reads, 0); gate = false; const denied = response(); await handler({ query: {}, params: {} }, denied); assert.equal(denied.code, 401); assert.equal(reads, 0);
  gate = true; const foreign = response(); await handler({ params: { publicCode: ownedOrder.publicCode }, query: { customerId: ids.employee } }, foreign); assert.equal(foreign.code, 404); assert.equal(reads, 1);
});
test("internal tracking separates assigned identity from GPS/chat and clears final identity", async (t) => {
  t.mock.method(Rider as any, "findOne", () => q(trackedRider));
  for (const status of ["preparing", "ready_for_pickup", "delivered", "cancelled"]) {
    const handler = route("get", "/api/v1/internal/customer-orders/:publicCode/tracking", { requireCustomerSyncSecret: () => true, Order: { findOne: () => q({ ...ownedOrder, status }) }, customerAssignedRider, customerDeliveryIsActive });
    const res = response(); await handler({ params: { publicCode: ownedOrder.publicCode }, query: { customerId: ids.customer } }, res);
    assert.equal(res.code, 200); assert.equal(res.body.locationAvailable, false); assert.equal(res.body.chatAvailable, false); assert.equal(res.body.latitude, null); assert.equal(res.body.updatedAt, null);
    assert.equal(res.body.riderName, ["delivered", "cancelled"].includes(status) ? null : "José María L."); assert.equal(res.body.riderPhotoUrl, ["delivered", "cancelled"].includes(status) ? null : PNG_PHOTO);
  }
});
