import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import mongoose from "mongoose";
import { z } from "zod";
import { EmployeeAccount } from "./models.js";
import { isPartnerEmployee, partnerBindingForEmployee, partnerBindingErrorResponse, persistPartnerBinding, validatePartnerCredentialTarget } from "./employeePartnerBinding.js";
import { partnerRolesForEmployee, permissionsForPartnerRoles, partnerCan } from "./partnerAccess.js";
import { kitchenRestaurantCanOperate, type KitchenAccessDependencies } from "./partnerKitchenAccess.js";
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const ids = { employee: "64c000000000000000000001", owner: "64c000000000000000000002", tenant: "64c000000000000000000003", restaurant: "64c000000000000000000004", second: "64c000000000000000000005", otherTenant: "64c000000000000000000006", membership: "64c000000000000000000007" };
const ownerEmail = "rrhh.milchollos@gmail.com";
const req: any = { params: { id: ids.employee }, auth: { employeeId: ids.owner, role: "admin", tenantId: ids.tenant }, body: {}, header: () => "" };
const clone = <T>(v: T): T => structuredClone(v);
function compile(code: string, context: Record<string, any>) {
  context = { isPartnerEmployee, partnerBindingForEmployee, partnerBindingErrorResponse, persistPartnerBinding, validatePartnerCredentialTarget, partnerRolesForEmployee, permissionsForPartnerRoles, z, ...context };
  return new Function(...Object.keys(context), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(context));
}
function route(path: string) {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === path) return call;
  }
  throw new Error(`Missing ${path}`);
}
function handler(path: string, context: Record<string, any>) { return compile(`return ${route(path).arguments.at(-1)!.getText(source)};`, context); }
function helper(name: string, context: Record<string, any>) {
  const statement = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name); assert(statement);
  return compile(`${statement.getText(source)}; return ${name};`, context);
}
const query = (row: any) => ({ select() { return this; }, lean() { return this; }, sort() { return this; }, exec: async () => row });
const response = () => ({ code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } });
function match(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (expected && typeof expected === "object") {
      if ("$exists" in expected) return (row[key] !== undefined) === expected.$exists;
      if ("$in" in expected) return expected.$in.includes(row[key]);
    }
    return row[key] === expected;
  });
}
function harness(failure = "") {
  let db: any = {
    employees: [{ _id: ids.owner, email: ownerEmail, tenantId: ids.tenant, active: true, authorizationStatus: "approved", ownerProtected: true, accessLevel: "superadmin" }],
    tenants: [{ _id: ids.tenant, status: "active" }],
    memberships: [{ _id: ids.membership, tenantId: ids.tenant, employeeId: ids.owner, role: "owner", status: "active", scopes: ["*"] }],
    restaurants: [ids.restaurant, ids.second].map((_id) => ({ _id, name: `OFFLINE ${_id}`, tenantId: ids.tenant, onboardingStatus: "pending_review", isActive: false, listingType: "official_partner", internalDemo: false, menu: [], partnerProfile: null })), authorizations: [],
  };
  const effects: string[] = [];
  const state = (options?: any) => options?.session?.state || db;
  const collection = (name: string) => ({
    async findOne(filter: any, options?: any) { return clone(state(options)[name].find((row: any) => match(row, filter)) || null); },
    find(filter: any, options?: any) { return { toArray: async () => clone(state(options)[name].filter((row: any) => match(row, filter))) }; },
    async indexes() { return failure === "indexes" ? [] : [{ unique: true, key: name === "employees" ? { email: 1 } : { tenantId: 1, employeeId: 1 } }]; },
    async updateOne(filter: any, update: any, options?: any) {
      assert(options?.session, "Binding writes must be transactional"); effects.push(`fence:${name}`);
      const row = state(options)[name].find((r: any) => match(r, filter));
      if (!row || failure === `fence:${name}`) return { matchedCount: 0, modifiedCount: 0 };
      for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + Number(value);
      Object.assign(row, clone(update.$set || {})); return { matchedCount: 1, modifiedCount: 1 };
    },
  });
  const insert = (name: string) => async (row: any, session?: any) => {
    effects.push(`insert:${name}`); if (failure === `insert:${name}`) throw new Error("OFFLINE_INSERT_FAILED");
    const saved = clone({ _id: ids.employee, ...row }); state({ session })[name].push(saved); return saved;
  };
  const deps: KitchenAccessDependencies = {
    ownerEmail, requireOwner: () => ((_q: any, _s: any, next: any) => next()), objectId: (v) => v, newId: () => ids.employee, employeeCodeFor: () => "PIKI-E-OFFLINE", passwordHash: () => "OFFLINE_HASH",
    employees: collection("employees"), memberships: collection("memberships"), tenants: collection("tenants"), restaurants: collection("restaurants"),
    createEmployee: insert("employees"), createMembership: insert("memberships"), createAuthorization: insert("authorizations"),
    startSession: async () => {
      const session: any = { state: null, async withTransaction(fn: () => Promise<void>) {
        session.state = clone(db); await fn(); if (failure === "commit") throw new Error("OFFLINE_COMMIT_FAILED"); db = session.state; effects.push("commit");
      }, async endSession() { effects.push("end"); } }; return session;
    },
    sendActivation: async () => { throw new Error("Unexpected mail"); },
  };
  const account = (overrides: any = {}) => ({ _id: ids.employee, name: "OFFLINE Partner", email: "partner@example.test", jobRole: "partner", apiRole: "partner", roles: ["partner"], primaryRole: "partner", partnerRoles: ["kitchen"], tenantId: null, restaurantId: null, restaurantIds: [], accessLevel: "subadmin", active: true, authorizationStatus: "approved", ...overrides });
  const create = (overrides: any = {}) => persistPartnerBinding(req, deps, { newEmployee: account(overrides), restaurantIds: [ids.restaurant], partnerRoles: overrides.partnerRoles || ["kitchen"], reason: "OFFLINE explicit Owner target" });
  return { get db() { return db; }, deps, effects, account, create };
}
function routeContext(h: ReturnType<typeof harness>, target: any, email: (target: any) => Promise<any>) {
  return { objectId: (v: string) => v, EmployeeAccount: { findById: () => query(target) }, ownerEmail, kitchenAccessDependencies: h.deps, preferredCredentialSurface: () => "partner", sendEmployeePasswordLink: email, AccessAuthorization: { create: async () => {} }, employeeCredentialLabels: { partner: "PIKI Partner Orders" } };
}
test("common send-activation refuses a historical unbound Partner before any email", async () => {
  const h = harness(); h.db.employees.push(h.account()); let emails = 0; const res = response();
  await handler("/api/v1/admin/employees/:id/send-activation", routeContext(h, h.account(), async () => { emails++; return { delivery: { sent: true } }; }))(req, res);
  assert.equal(emails, 0); assert.equal(res.code, 403);
});
test("maintenance credential bypass must use real Owner middleware, not a shared admin token", () => {
  assert.equal(route("/api/v1/admin/maintenance/employees/:id/send-activation").arguments[1].getText(source), "requireOwner()");
  assert.equal(route("/api/v1/admin/maintenance/employees/:id/email").arguments[1].getText(source), "requireOwner()");
});
test("new kitchen binding persists employee, exact membership and audit before mail, pending unchanged", async () => {
  const h = harness(); const before = clone(h.db.restaurants); const employee = await h.create();
  assert.deepEqual(employee.restaurantIds, [ids.restaurant]); assert.equal(employee.tenantId, ids.tenant); assert.equal(employee.partnerBindingVersion, 1);
  const binding = await partnerBindingForEmployee(employee, h.deps); assert.deepEqual(binding.membership.scopes, ["orders:read", "orders:prepare"]);
  assert(!permissionsForPartnerRoles(partnerRolesForEmployee(employee)).has("*")); assert(h.effects.includes("commit"));
  h.db.restaurants.forEach((row: any, i: number) => { const { kitchenAccessRevision, ...kept } = row; assert.deepEqual(kept, before[i]); });
  assert.equal(h.db.authorizations.length, 1);
  let emails = 0; const res = response();
  await handler("/api/v1/admin/employees/:id/send-activation", routeContext(h, employee, async (current) => { emails++; assert(h.effects.includes("commit")); assert.deepEqual(current.restaurantIds, [ids.restaurant]); return { delivery: { sent: true } }; }))(req, res);
  assert.equal(res.code, 200); assert.equal(emails, 1);
});
for (const role of ["partner_admin", "manager", "store_manager"]) test(`legitimate ${role} preserves roles and multiple restaurants`, async () => {
  const h = harness(); const employee = await persistPartnerBinding(req, h.deps, { newEmployee: h.account({ partnerRoles: [role] }), restaurantIds: [ids.restaurant, ids.second], partnerRoles: [role], reason: "OFFLINE Owner multi-site" });
  assert.deepEqual(partnerRolesForEmployee(employee), [role]); assert.equal((await partnerBindingForEmployee(employee, h.deps)).restaurants.length, 2); assert(partnerCan([role], "menu:write"));
});
for (const failure of ["insert:memberships", "insert:authorizations", "fence:restaurants", "fence:tenants", "commit", "indexes"]) test(`binding abort ${failure} leaves no partial employee or membership`, async () => {
  const h = harness(failure); const before = clone(h.db); await assert.rejects(h.create()); assert.deepEqual(h.db, before);
});
for (const override of [{ tenantId: ids.otherTenant }, { listingType: "local_directory" }, { internalDemo: true }, { onboardingStatus: "rejected" }]) test(`invalid target ${JSON.stringify(override)} rejected without mutation`, async () => {
  const h = harness(); Object.assign(h.db.restaurants[0], override); const before = clone(h.db); await assert.rejects(h.create()); assert.deepEqual(h.db, before);
});
for (const auth of [{ role: "admin", isRootOwner: true }, { role: "admin", employeeId: ids.employee, tenantId: ids.tenant }, { ...req.auth, tenantId: ids.otherTenant }]) test(`untrusted Owner context ${JSON.stringify(auth)} cannot persist binding`, async () => {
  const h = harness(); const before = clone(h.db); await assert.rejects(persistPartnerBinding({ ...req, auth, body: { owner: true, isRootOwner: true } }, h.deps, { newEmployee: h.account(), restaurantIds: [ids.restaurant], reason: "OFFLINE" })); assert.deepEqual(h.db, before);
});
test("existing unbound Partner can receive exact Owner assignment without fiscal/profile defaults", async () => {
  const h = harness(); const account = h.account({ partnerRoles: ["manager"], roles: ["partner", "support"] }); h.db.employees.push(account);
  const employee = await persistPartnerBinding(req, h.deps, { employeeId: ids.employee, restaurantIds: [ids.restaurant, ids.second], reason: "OFFLINE explicit repair" });
  assert.deepEqual(employee.partnerRoles, ["manager"]); assert.deepEqual(employee.roles, ["partner", "support"]); assert.equal(employee.tenantId, ids.tenant); assert.equal(h.db.employees.length, 2);
  assert.equal(h.db.restaurants[0].partnerProfile, null); assert.equal(h.db.restaurants[0].isActive, false);
});
test("historical bound accounts do not require a fabricated membership or get downgraded", async () => {
  const h = harness(); const account = h.account({ tenantId: ids.tenant, restaurantId: ids.restaurant, restaurantIds: [ids.restaurant], partnerRoles: [] }); h.db.employees.push(account);
  const before = clone(h.db); const binding = await partnerBindingForEmployee(account, h.deps); assert.equal(binding.membership, undefined); assert.deepEqual(h.db, before); assert(permissionsForPartnerRoles(partnerRolesForEmployee(account)).has("*"));
  const res = response(); let emails = 0; await handler("/api/v1/admin/employees/:id/send-activation", routeContext(h, account, async () => { emails++; return { delivery: { sent: true } }; }))(req, res); assert.equal(res.code, 200); assert.equal(emails, 1); assert.deepEqual(h.db, before);
});
test("existing nonpartner membership authority is retained on explicit Partner binding", async () => {
  const h = harness(); h.db.employees.push(h.account({ tenantId: ids.tenant, roles: ["partner", "fleet"] }));
  h.db.memberships.push({ _id: ids.employee, tenantId: ids.tenant, employeeId: ids.employee, role: "fleet", status: "active", scopes: ["fleet:historical"] });
  const employee = await persistPartnerBinding(req, h.deps, { employeeId: ids.employee, restaurantIds: [ids.restaurant], reason: "OFFLINE" });
  const member = (await partnerBindingForEmployee(employee, h.deps)).membership; assert.equal(member.role, "fleet"); assert.deepEqual(member.scopes, ["fleet:historical"]);
});
test("existing mismatched employee tenant or membership aborts explicit assignment", async () => {
  for (const memberConflict of [false, true]) {
    const h = harness(); h.db.employees.push(h.account({ tenantId: memberConflict ? ids.tenant : ids.otherTenant }));
    if (memberConflict) h.db.memberships.push({ employeeId: ids.employee, tenantId: ids.otherTenant });
    const before = clone(h.db); await assert.rejects(persistPartnerBinding(req, h.deps, { employeeId: ids.employee, restaurantIds: [ids.restaurant], reason: "OFFLINE" })); assert.deepEqual(h.db, before);
  }
});
test("API43 kitchen-marked account is not rewritten by general assignment", async () => {
  const h = harness(); h.db.employees.push(h.account({ kitchenAccessSetupVersion: 1, tenantId: ids.tenant })); const before = clone(h.db);
  await assert.rejects(persistPartnerBinding(req, h.deps, { employeeId: ids.employee, restaurantIds: [ids.restaurant], reason: "OFFLINE" }), /KITCHEN_ACCOUNT_CONTRACT_PROTECTED/); assert.deepEqual(h.db, before);
});
test("new-bound membership corruption blocks explicit, maintenance and Owner reset before effects", async () => {
  for (const path of ["/api/v1/admin/employees/:id/send-activation", "/api/v1/admin/maintenance/employees/:id/send-activation", "/api/v1/admin/employees/:id/reset-password"]) {
    const h = harness(); const account = await h.create(); h.db.memberships[1].restaurantIds = [ids.second]; let emails = 0; let writes = 0;
    const context: any = routeContext(h, account, async () => { emails++; throw new Error("Unexpected email"); });
    context.EmployeeAccount.findByIdAndUpdate = () => { writes++; throw new Error("Unexpected write"); };
    const res = response(); await handler(path, context)({ ...req, body: { newPassword: "OfflinePassword123" } }, res); assert.equal(res.code, 409); assert.equal(emails, 0); assert.equal(writes, 0);
  }
});
test("public recovery hides invalid binding and neither creates reset nor changes password", async () => {
  const h = harness(); const account = h.account({ tenantId: ids.tenant }); h.db.employees.push(account); let resets = 0;
  const context: any = { employeePasswordResetRequestSchema: z.object({ email: z.string().email() }), employeeCredentialSurface: () => "partner", passwordResetMessage: "neutral", EmployeeAccount: { findOne: () => query(account) }, employeeCanUseCredentialSurface: () => true, kitchenAccessDependencies: h.deps, sendEmployeePasswordLink: helper("sendEmployeePasswordLink", { kitchenAccessDependencies: h.deps, createEmployeePasswordReset: () => { resets++; throw new Error("Unexpected token"); } }) };
  const res = response(); await handler("/api/v1/auth/employee/password-reset/request", context)({ body: { email: account.email }, header: () => "partner" }, res); assert.equal(res.code, 202); assert.equal(resets, 0);
});
test("common create fails before employee write/mail when Partner target is missing; nonPartner stays intact", async () => {
  const h = harness(); let writes = 0; let emails = 0;
  const schema = z.object({ name: z.string(), email: z.string(), jobRole: z.string(), apiRole: z.string().optional(), roles: z.array(z.string()).optional(), primaryRole: z.string().optional(), restaurantId: z.string().nullable().optional(), restaurantIds: z.array(z.string()).optional(), partnerRoles: z.array(z.string()).optional(), fleetId: z.string().nullable().optional(), sendActivation: z.boolean().default(true), zoneSlugs: z.array(z.string()).default([]) });
  const context: any = { employeePartnerCreateSchema: schema, objectId: (v: string) => v, mongoose, EmployeeAccount: { create: async (row: any) => { writes++; return row; } }, kitchenAccessDependencies: h.deps, employeeCodeFor: () => "PIKI-E-OFFLINE", generateTemporaryPassword: () => "OFFLINE", hashPassword: () => "OFFLINE_HASH", preferredCredentialSurface: () => "rider", AccessAuthorization: { create: async () => {} }, sendEmployeePasswordLink: async () => { emails++; return { delivery: { sent: true } }; }, employeeCredentialLabels: { rider: "PIKI Riders" } };
  const create = handler("/api/v1/admin/employees", context); const res = response();
  await create({ ...req, body: { name: "OFFLINE", email: "new@example.test", jobRole: "partner", partnerRoles: ["kitchen"] } }, res); assert.equal(res.code, 409); assert.equal(writes, 0); assert.equal(emails, 0);
  const other = response(); await create({ ...req, body: { name: "OFFLINE", email: "rider@example.test", jobRole: "rider" } }, other); assert.equal(other.code, 201); assert.equal(writes, 1); assert.equal(emails, 1);
});
test("common create mails once only after atomic binding commit; SMTP/audit failure never recreates account", async () => {
  const h = harness(); const schemaStatement = source.statements.find((s) => s.getText(source).startsWith("const employeeCreateSchema =")); assert(schemaStatement);
  const schema = compile(`${schemaStatement.getText(source)}; return employeeCreateSchema.extend({ restaurantIds: z.array(z.string()).optional(), partnerRoles: z.array(z.string()).optional(), sendActivation: z.boolean().default(true) });`, {});
  let emails = 0; const context: any = { employeePartnerCreateSchema: schema, objectId: (v: any) => String(v), mongoose: { Types: { ObjectId: class { constructor() { return new String(ids.employee) as any; } } } }, kitchenAccessDependencies: h.deps, employeeCodeFor: () => "PIKI-E-OFFLINE", generateTemporaryPassword: () => "OFFLINE", hashPassword: () => "OFFLINE_HASH", preferredCredentialSurface: () => "partner", AccessAuthorization: { create: async () => { throw new Error("OFFLINE_AUDIT_FAILURE"); } }, sendEmployeePasswordLink: async (employee: any) => { assert(h.effects.includes("commit")); assert.equal(h.db.memberships.length, 2); assert.equal(employee.tenantId, ids.tenant); emails++; return { delivery: { sent: true } }; }, employeeCredentialLabels: { partner: "PIKI Partner" } };
  h.deps.createEmployee = async (row, session: any) => { const employee = { ...row, _id: ids.employee }; session.state.employees.push(employee); return employee; };
  const res = response(); await handler("/api/v1/admin/employees", context)({ ...req, body: { name: "OFFLINE", email: "new@example.test", jobRole: "partner", restaurantId: ids.restaurant, partnerRoles: ["kitchen"] } }, res);
  assert.equal(res.code, 201); assert.equal(emails, 1); assert.equal(res.body.bindingPersisted, true); assert.equal(res.body.activationEmail.sent, true); assert.equal(h.db.employees.length, 2);
});
test("new pending Partner cannot read or mutate orders but manager may maintain permitted setup", async () => {
  const h = harness(); const employee = await h.create({ partnerRoles: ["manager"] });
  const access = { employee, restaurantIds: [ids.restaurant], roles: ["manager"], kitchenRestaurant: null, bindingRestaurants: h.db.restaurants };
  const resolver = helper("partnerRequestAccess", { partnerAccessForRequest: async () => access, kitchenRestaurantCanOperate, partnerCan });
  assert.equal((await resolver(req, "orders:read")).allowed, false); assert.equal((await resolver(req, "orders:prepare")).allowed, false); assert.equal((await resolver(req, "menu:write")).allowed, true);
  const live = h.db.restaurants[0]; Object.assign(live, { onboardingStatus: "approved", isActive: true, availabilityStatus: "available", marketplaceCompliance: { pikiStatus: "verified" }, menu: [{ available: true, allergens: ["fish"] }] });
  assert.equal((await resolver(req, "orders:read")).allowed, true);
  live.menu[0].allergens = null; assert.equal((await resolver(req, "orders:read")).allowed, false);
  assert.equal((await resolver({ ...req, header: () => ids.second }, "orders:read")).allowed, false);
});
test("new binding marker is persisted by schema; no legacy or kitchen marker is overwritten", async () => {
  const employee = new EmployeeAccount({ name: "OFFLINE", email: "offline@example.test", jobRole: "partner", apiRole: "partner", passwordHash: "OFFLINE_HASH", partnerBindingVersion: 1 }); await employee.validate(); assert.equal(employee.partnerBindingVersion, 1); assert.equal(employee.kitchenAccessSetupVersion, null);
});
test("exact bound locations never discover more restaurants from email", async () => {
  let reads = 0; const fn = helper("partnerLocationsFor", { assignedRestaurantIds: () => [], Restaurant: { find: () => { reads++; throw new Error("Unexpected discovery"); } } });
  assert.deepEqual(await fn({ tenantId: ids.tenant, email: "shared@example.test" }), []); assert.equal(reads, 0);
});

test("authorization edits persist role and restaurant changes through the same atomic binding transaction", async () => {
  const h = harness(); h.db.employees.push(h.account({ tenantId: ids.tenant, restaurantId: ids.restaurant, restaurantIds: [ids.restaurant], partnerRoles: ["manager"], passwordHash: "OFFLINE_HASH_MUST_NOT_LEAK", sessionHash: "OFFLINE_SESSION_MUST_NOT_LEAK" })); let revoked = 0;
  const context: any = { objectId: (id: string) => id, ownerEmail, EmployeeAccount: { findById: () => query(h.db.employees[1]), findByIdAndUpdate: () => { throw new Error("Nontransactional update forbidden"); } }, employeeSessionRoles: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"], partnerOperationalRoles: ["kitchen", "manager", "partner_admin"], assignedRestaurantIds: (e: any) => e.restaurantIds, kitchenAccessDependencies: h.deps, revokeEmployeeSessions: async () => { revoked++; } };
  const res = response(); await handler("/api/v1/admin/employees/:id/authorization", context)({ ...req, body: { status: "approved", restaurantIds: [ids.restaurant, ids.second], partnerRoles: ["kitchen"], reason: "OFFLINE explicit kitchen permission" } }, res);
  assert.equal(res.code, 200); assert.equal(res.body.bindingPersisted, true); assert.equal(revoked, 1); assert.deepEqual(h.db.employees[1].partnerRoles, ["kitchen"]); assert.deepEqual(h.db.memberships[1].scopes, ["orders:read", "orders:prepare"]); assert.deepEqual(h.db.employees[1].restaurantIds, [ids.restaurant, ids.second]);
  assert.equal(res.body.employee.passwordHash, undefined); assert.equal(res.body.employee.sessionHash, undefined);
});
test("public reset confirmation cannot set password after losing restaurant association", async () => {
  const h = harness(); const account: any = h.account({ tenantId: ids.tenant }); let saves = 0; account.save = async () => { saves++; };
  const context = { employeePasswordResetConfirmSchema: z.object({ token: z.string(), newPassword: z.string() }), employeeCredentialSurface: () => "partner", createHash: () => ({ update() { return this; }, digest: () => "OFFLINE_HASH" }), EmployeePasswordReset: { findOneAndUpdate: () => query({ employeeId: ids.employee }) }, EmployeeAccount: { findOne: () => query(account) }, employeeCanUseCredentialSurface: () => true, kitchenAccessDependencies: h.deps };
  const res = response(); await handler("/api/v1/auth/employee/password-reset/confirm", context)({ body: { token: "OFFLINE_TOKEN", newPassword: "OfflinePassword123" }, header: () => "partner" }, res); assert.equal(res.code, 400); assert.equal(saves, 0);
});
test("explicit activation preserves sent=true when SMTP accepted but audit failed", async () => {
  const h = harness(); const employee = await h.create(); let emails = 0; const context: any = routeContext(h, employee, async () => { emails++; return { delivery: { sent: true } }; });
  context.AccessAuthorization.create = async () => { throw new Error("OFFLINE_AUDIT_FAILED"); };
  const res = response(); await handler("/api/v1/admin/employees/:id/send-activation", context)(req, res); assert.equal(res.code, 200); assert.equal(res.body.sent, true); assert.equal(res.body.warning, "CREDENTIAL_AUDIT_FAILED_AFTER_SEND"); assert.equal(emails, 1);
});
