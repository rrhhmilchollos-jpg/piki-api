import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import mongoose from "mongoose";
import { z } from "zod";
import { OWNER_EMAIL, sessionRole } from "./employeeSessions.js";
import { partnerAccessForRequest, partnerRequestAccess, partnerReadinessReason, requirePartnerSurface, type PartnerOperationalDependencies } from "./partnerOperationalAccess.js";
import { buildTenantScope } from "./tenantScope.js";
import { partnerRolesForEmployee, permissionsForPartnerRoles } from "./partnerAccess.js";

// No real identities/credentials/orders, server import, DB or socket.
const id = (n: number) => `65f0000000000000${n.toString(16).padStart(8, "0")}`;
const ids = { owner: id(1), tenant: id(2), otherTenant: id(3), order: id(4) };
const clone = (v: any) => structuredClone(v);
function fixture() {
  const rows = Array.from({ length: 7 }, (_, n) => ({ _id: id(10 + n), tenantId: ids.tenant, name: `Offline local ${n}`, onboardingStatus: n < 5 ? "approved" : "pending_review", isActive: n < 5, availabilityStatus: n < 5 ? "available" : "coming_soon", listingType: n < 5 ? undefined : "official_partner", internalDemo: false, marketplaceCompliance: { pikiStatus: "verified" }, menu: n < 5 ? [{ available: true, allergens: [] }] : [{ available: false, allergens: null }] }));
  const employee: any = { _id: ids.owner, email: OWNER_EMAIL, tenantId: ids.tenant, active: true, authorizationStatus: "approved", ownerProtected: true, accessLevel: "superadmin", apiRole: "admin", jobRole: "admin", primaryRole: "admin", roles: ["admin"], restaurantIds: rows.slice(0, 5).map((r) => r._id), restaurantId: rows[0]._id };
  let memberships: any[] = [{ employeeId: ids.owner, tenantId: ids.tenant, role: "owner", status: "active", restaurantIds: [], scopes: ["*"] }];
  let tenant: any = { _id: ids.tenant, status: "active" };
  let enumerations = 0;
  const deps: PartnerOperationalDependencies = {
    resolveAuth: async (req) => req.auth || null,
    employeeById: async () => clone(employee),
    binding: { ownerEmail: OWNER_EMAIL, objectId: (v) => v, tenants: { findOne: async () => clone(tenant) }, memberships: { find: (filter) => ({ toArray: async () => clone(memberships.filter((row) => (!filter.tenantId || row.tenantId === filter.tenantId) && row.employeeId === filter.employeeId)) }) }, restaurants: { findOne: async (f) => clone(rows.find((r) => r._id === String(f._id) && r.tenantId === String(f.tenantId)) || null) } },
    ownerRestaurants: async (tenantId) => { assert.equal(tenantId, ids.tenant); enumerations++; return clone(rows); },
  };
  const request = (role = "partner", locationId?: string): any => ({ auth: { role, employeeId: ids.owner, tenantId: ids.tenant, isRootOwner: true }, body: {}, params: {}, query: {}, headers: { "x-piki-surface": "partner" }, header: (name: string) => name === "x-piki-restaurant-id" ? locationId || "" : "" });
  return { rows, employee, deps, request, setMemberships: (v: any[]) => { memberships = v; }, setTenant: (v: any) => { tenant = v; }, get enumerations() { return enumerations; } };
}
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compile(code: string, context: any) {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(context), `${js}; return subject;`)(...Object.values(context));
}
function helper(name: string, context: any) {
  const node = source.statements.find((v) => ts.isFunctionDeclaration(v) && v.name?.text === name); assert(node);
  return compile(`${node.getText(source)}; const subject = ${name};`, context);
}
function route(path: string, method: string, context: any) {
  for (const node of source.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue;
    const call = node.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== method) continue;
    if (ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === path) return compile(`const subject = ${call.arguments.at(-1)!.getText(source)};`, context);
  }
  throw new Error("Missing actual route");
}
function response(): any { return { code: 200, body: null, headers: {}, status(n: number) { this.code = n; return this; }, json(v: any) { this.body = v; return this; }, setHeader(k: string, v: string) { this.headers[k] = v; } }; }
const query = (v: any) => ({ select() { return this; }, lean() { return this; }, sort() { return this; }, exec: async () => clone(v) });
function context(f: ReturnType<typeof fixture>) {
  const ctx: any = { partnerRolesForEmployee, permissionsForPartnerRoles, partnerReadinessReason, onboardingCode: (_: string, v: string) => `OFFLINE-${v}`, employeeCodeFor: () => "OFFLINE-EMPLOYEE", objectId: (v: string) => new mongoose.Types.ObjectId(v), buildTenantScope,
    tenantScope: () => ({}), // Simulate genuine platform-admin cross-tenant scope.
    sharedPartnerAccessForRequest: (r: any) => partnerAccessForRequest(r, f.deps), sharedPartnerRequestAccess: (r: any, p: any) => partnerRequestAccess(r, p, f.deps), assignedRestaurantIds: (e: any) => e.restaurantIds,
    EmployeeAccount: { findOne: () => query(f.employee) },
    Fleet: { findById: () => { throw new Error("Unexpected Fleet read"); } },
    Restaurant: { find(filter: any) { assert.equal(String(filter.tenantId), ids.tenant); return query(f.rows.filter((r) => filter._id.$in.includes(r._id) && r.tenantId === String(filter.tenantId))); } },
  };
  for (const name of ["partnerAccessForRequest", "partnerRequestAccess", "partnerTenantScope", "employeeRestaurant", "partnerLocationsFor"]) ctx[name] = helper(name, ctx);
  return ctx;
}

for (const role of ["partner", "admin"]) test(`persisted Owner ${role} session receives seven-local frozen-tenant portfolio, never changes assignments`, async () => {
  const f = fixture(); const before = clone(f.employee); const access = await partnerAccessForRequest(f.request(role), f.deps);
  assert(access?.ownerPortfolio); assert.deepEqual(access.restaurantIds, f.rows.map((r) => r._id)); assert.equal(access.tenantId, ids.tenant); assert.deepEqual(access.roles, ["owner"]); assert.deepEqual(f.employee, before);
  f.employee.restaurantIds = []; f.employee.restaurantId = null; assert.equal((await partnerAccessForRequest(f.request(role), f.deps))?.restaurantIds.length, 7);
});
test("Owner login already narrows the persisted admin account to Partner; no role/binding rewrite is necessary", () => {
  const f = fixture(); assert.equal(sessionRole(f.employee, "partner"), "partner"); assert.equal(sessionRole(f.employee, "partner", "admin"), "partner");
});
for (const change of ["email", "protected", "access", "inactive", "status", "tenant", "membership", "foreignMembership", "membershipRole", "kitchen", "temporary"]) test(`Owner portfolio fails closed for persisted ${change}, even with caller superadmin claims`, async () => {
  const f = fixture(); const r = f.request("admin");
  if (change === "email") f.employee.email = "ordinary@example.test";
  if (change === "protected") f.employee.ownerProtected = false;
  if (change === "access") f.employee.accessLevel = "subadmin";
  if (change === "inactive") f.employee.active = false;
  if (change === "status") f.employee.authorizationStatus = "pending";
  if (change === "tenant") f.setTenant({ _id: ids.tenant, status: "frozen" });
  if (change === "membership") f.setMemberships([]);
  if (change === "foreignMembership") f.setMemberships([{ employeeId: ids.owner, tenantId: ids.otherTenant, role: "owner", status: "active" }]);
  if (change === "membershipRole") f.setMemberships([{ employeeId: ids.owner, tenantId: ids.tenant, role: "partner", status: "active" }]);
  if (change === "kitchen") f.employee.kitchenAccessSetupVersion = 1;
  if (change === "temporary") f.employee.mustChangePassword = true;
  r.body = { email: OWNER_EMAIL, ownerProtected: true, accessLevel: "superadmin", isRootOwner: true };
  assert.equal(await partnerAccessForRequest(r, f.deps), null); assert.equal(f.enumerations, 0);
});
test("shared environmental token, absent/foreign frozen tenant and stale req.auth never produce a portfolio", async () => {
  const f = fixture();
  for (const auth of [{ role: "admin", isRootOwner: true }, { role: "admin", employeeId: ids.owner }, { role: "admin", employeeId: ids.owner, tenantId: ids.otherTenant }]) assert.equal(await partnerAccessForRequest({ ...f.request(), auth } as any, f.deps), null);
  assert.equal(await partnerAccessForRequest(f.request(), { ...f.deps, resolveAuth: async () => ({ role: "admin", employeeId: ids.owner, tenantId: ids.tenant }) }), null);
  assert.equal(f.enumerations, 0);
});
test("ordinary Partner manager remains on exactly five assignments; ordinary admin gets no Partner data", async () => {
  const f = fixture(); Object.assign(f.employee, { email: "manager@example.test", ownerProtected: false, accessLevel: "subadmin", apiRole: "partner", jobRole: "partner", roles: ["partner"], partnerRoles: ["manager"] }); f.setMemberships([]);
  const result = await partnerAccessForRequest(f.request(), f.deps); assert.equal(result?.restaurantIds.length, 5); assert.equal(result?.ownerPortfolio, undefined); assert.equal(f.enumerations, 0);
  assert.equal(await partnerAccessForRequest(f.request("admin"), f.deps), null);
});
test("portfolio excludes foreign tenant, directory, assisted, demo, hidden-test and rejected records", async () => {
  const f = fixture(); for (const override of [{ tenantId: ids.otherTenant }, { listingType: "local_directory" }, { fulfillmentMode: "assisted_purchase" }, { internalDemo: true }, { slug: "partner-test" }, { onboardingStatus: "rejected" }]) f.rows.push({ ...clone(f.rows[0]), _id: id(30 + f.rows.length), ...override });
  assert.equal((await partnerAccessForRequest(f.request(), f.deps))?.restaurantIds.length, 7);
});
test("pending local allows owner configuration but keeps order operations gated", async () => {
  const f = fixture(); const pending = f.rows[5]; f.employee.restaurantIds.push(pending._id); pending.isActive = true;
  for (const permission of ["orders:read", "orders:write", "orders:prepare", "orders:cancel"] as const) {
    const result = await partnerRequestAccess(f.request("admin", pending._id), permission, f.deps); assert.equal(result.allowed, false); assert.equal(result.denial?.reason, "not_approved");
  }
  assert.equal((await partnerRequestAccess(f.request("admin", pending._id), "store:write", f.deps)).allowed, true);
  assert.equal((await partnerRequestAccess(f.request("admin", pending._id), "menu:write", f.deps)).allowed, true);
  assert.equal((await partnerRequestAccess(f.request("admin", pending._id), "menu:read", f.deps)).allowed, true);
});
for (const override of [{ isActive: false }, { availabilityStatus: "coming_soon" }, { menu: [] }, { menu: [{ available: false, allergens: [] }] }, { menu: [{ available: true, allergens: null }] }, { marketplaceCompliance: { pikiStatus: "pending" } }]) test(`Owner never bypasses food readiness ${JSON.stringify(override)}`, async () => {
  const f = fixture(); Object.assign(f.rows[0], override); assert.equal((await partnerRequestAccess(f.request("admin"), "orders:read", f.deps)).allowed, false);
});
test("actual employeeMe and GET locations return the same seven-local scope and pending status truth", async () => {
  const f = fixture(); const ctx = context(f); const me = response(); const locations = response();
  await route("/api/v1/auth/employee/me", "get", ctx)(f.request("admin"), me);
  await route("/api/v1/partners/locations", "get", ctx)(f.request("admin"), locations);
  assert.deepEqual(me.body.employee.locations, locations.body.locations); assert.deepEqual(me.body.employee.restaurantIds, f.rows.map((row) => row._id)); assert.equal(me.body.employee.tenantId, ids.tenant); assert.equal(locations.body.locations.length, 7); assert.equal(me.body.employee.fleetId, null);
  for (const pending of locations.body.locations.slice(5)) { assert.deepEqual(pending.permissions, ["*"]); assert.equal(pending.ordersEnabled, false); assert.equal(pending.isOpen, false); assert.equal(pending.readOnly, false); assert.equal(pending.reason, "not_approved"); assert.equal(pending.tenantId, ids.tenant); }
  assert.equal(me.headers["Cache-Control"], "no-store"); assert.equal(locations.headers["Cache-Control"], "no-store");
});
test("actual Partner middleware accepts only persisted identity, never mutates admin session role", async () => {
  const f = fixture(); const r = f.request("admin"); let next = false; await requirePartnerSurface(f.deps)(r, response(), () => { next = true; }); assert(next); assert.equal(r.auth.role, "admin");
  const res = response(); await requirePartnerSurface({ ...f.deps, resolveAuth: async () => ({ role: "admin", isRootOwner: true }) })(f.request("admin"), res, () => { throw new Error("Unauthorized next"); }); assert.equal(res.code, 401);
});
test("private REST tenant helper does not inherit platform-wide scope", () => {
  const f = fixture(); const scope = context(f).partnerTenantScope(f.request("admin")); assert.equal(String(scope.tenantId), ids.tenant); assert.notDeepEqual(scope, {});
});
test("actual pending kitchen orders remain denied before any order mutation sink", async () => {
  const f = fixture(); const ctx = context(f); const r = f.request("admin", f.rows[5]._id); r.body = { status: "accepted" }; r.params = { id: ids.order };
  const forbidden = () => { throw new Error("Pending sink reached"); }; ctx.z = z; ctx.Order = { find: forbidden, findOne: forbidden };
  for (const [method, path] of [["get", "/api/v1/partners/kitchen/orders"], ["get", "/api/v1/partners/kitchen/orders/archive"], ["patch", "/api/v1/partners/kitchen/orders/:id/status"]]) { const res = response(); await route(path, method, ctx)(r, res); assert.equal(res.code, 403, path); }
});
test("actual kitchen ACK remains bound to selected restaurant and private tenant; delivered is not a Partner transition", async () => {
  const f = fixture(); const ctx = context(f); const r = f.request("admin", f.rows[0]._id); r.body = { status: "accepted", preparationMinutes: 30 }; r.params = { id: ids.order };
  let saves = 0; let publications = 0; let dispatch = 0;
  const order: any = { _id: ids.order, restaurantId: f.rows[0]._id, tenantId: ids.tenant, status: "pending", paymentState: "authorized", paymentMethod: "stripe", statusHistory: [], save: async () => { saves++; } };
  ctx.z = z; ctx.mongoose = mongoose; ctx.Order = { findOne(filter: any) { assert.equal(String(filter.restaurantId), f.rows[0]._id); assert.equal(String(filter.tenantId), ids.tenant); return order; } };
  ctx.enqueueOrderForDispatch = async () => { dispatch++; }; ctx.publishOrderStatusEvents = async (v: any, status: string) => { assert.equal(v.tenantId, ids.tenant); assert.equal(status, "accepted"); publications++; }; ctx.scheduleCustomerOrderPush = () => undefined;
  const status = route("/api/v1/partners/kitchen/orders/:id/status", "patch", ctx); const res = response(); await status(r, res);
  assert.equal(res.body.order._id, ids.order); assert.equal(res.body.order.status, "accepted"); assert.equal(res.body.order.preparationMinutes, 30); assert.equal(saves, 1); assert.equal(publications, 1); assert.equal(dispatch, 1);
  const denied = response(); await status({ ...r, body: { status: "delivered" } }, denied); assert.equal(denied.code, 400); assert.equal(saves, 1);
});

test("Owner other-tenant membership never expands current portfolio or replaces frozen-tenant authority", async () => {
  const f = fixture(); f.setMemberships([{ employeeId: ids.owner, tenantId: ids.tenant, role: "owner", status: "active" }, { employeeId: ids.owner, tenantId: ids.otherTenant, role: "owner", status: "active" }]);
  const access = await partnerAccessForRequest(f.request("admin"), f.deps); assert.equal(access?.restaurantIds.length, 7); assert.equal(access?.tenantId, ids.tenant);
  f.setMemberships([{ employeeId: ids.owner, tenantId: ids.tenant, role: "owner", status: "revoked" }, { employeeId: ids.owner, tenantId: ids.otherTenant, role: "owner", status: "active" }]);
  assert.equal(await partnerAccessForRequest(f.request("admin"), f.deps), null);
});
test("actual Partner menu-read queries pending tenant-local draft; publication guard still rejects stock PATCH", async () => {
  const f = fixture(); const ctx = context(f); const pending = f.rows[5]; const r = f.request("admin", pending._id); r.body = { available: true }; r.params = { id: pending._id, itemId: "offline-item" };
  let reads = 0; ctx.setPartnerMenuResponseHeaders = () => undefined; ctx.canonicalRestaurantMenu = (row: any) => row.menu; ctx.currentMenuRevision = () => 1; ctx.menuAvailabilitySchema = z.object({ available: z.boolean() });
  ctx.Restaurant.findOne = (filter: any) => { reads++; assert.equal(String(filter.tenantId), ids.tenant); assert.equal(String(filter._id), pending._id); return query(pending); };
  ctx.Restaurant.findOneAndUpdate = () => query(null);
  const menu = response(); await route("/api/v1/partners/menu", "get", ctx)(r, menu); assert.equal(menu.code, 200); assert.equal(reads, 1);
  const denied = response(); await route("/api/v1/restaurants/:id/menu/items/:itemId/availability", "patch", ctx)(r, denied); assert.equal(denied.code, 404); assert.equal(reads, 2);
});
test("actual Owner consultative profile truth does not call a stale active pending local open", async () => {
  const f = fixture(); const ctx = context(f); const pending = f.rows[5]; pending.isActive = true;
  ctx.partnerCan = () => true; ctx.publicPartnerCode = () => "OFFLINE"; ctx.customerCommissionRate = () => .2; ctx.DEFAULT_PARTNER_COMMISSION_BPS = 2000; ctx.Restaurant.findOne = () => query(pending);
  const res = response(); await route("/api/v1/partners/profile", "get", ctx)(f.request("admin", pending._id), res);
  assert.equal(res.body.profile.isOpen, false); assert.equal(res.body.profile.readOnly, true); assert.equal(res.body.profile.ordersEnabled, false); assert.equal(res.body.profile.reason, "not_approved");
});
