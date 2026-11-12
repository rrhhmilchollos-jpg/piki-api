import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import mongoose from "mongoose";
import { EmployeeAccount, TenantMembership } from "./models.js";
import { canIssueEmployeeSession, sessionRole, sessionTenantMatchesEmployee } from "./employeeSessions.js";
import { corporateRecipientAccepted } from "./corporateEmail.js";
import { kitchenAccessSchema, KitchenAccessError, kitchenBindingForEmployee, kitchenRestaurantCanOperate, registerPartnerKitchenAccessRoutes, validateKitchenActivation, type KitchenAccessDependencies } from "./partnerKitchenAccess.js";
import { partnerCan, partnerRolesForEmployee, permissionsForPartnerRoles } from "./partnerAccess.js";
import { isPartnerEmployee, partnerBindingForEmployee, partnerBindingErrorResponse, validatePartnerCredentialTarget } from "./employeePartnerBinding.js";
// Synthetic IDs are mocks, never production targets.
const ids = { owner: "64b000000000000000000001", tenant: "64b000000000000000000002", restaurant: "64b000000000000000000003", employee: "64b000000000000000000004", membership: "64b000000000000000000005", otherTenant: "64b000000000000000000006", xativa: "64b000000000000000000007" };
const email = "jose888628@hotmail.com";
const ownerEmail = "rrhh.milchollos@gmail.com";
const input = { restaurantId: ids.restaurant, email, displayName: "José", sendActivation: false };
const clone = <T>(value: T): T => structuredClone(value);
function match(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    const actual = row[key];
    if (expected && typeof expected === "object") {
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
      if ("$in" in expected) return expected.$in.includes(actual);
    }
    return actual === expected;
  });
}
function harness(options: { fail?: string; commitConflict?: boolean; afterCommit?: (db: any) => void; accepted?: any[]; auditFail?: boolean } = {}) {
  let db: any = {
    employees: [{ _id: ids.owner, email: ownerEmail, tenantId: ids.tenant, active: true, ownerProtected: true, authorizationStatus: "approved", accessLevel: "superadmin" }],
    tenants: [{ _id: ids.tenant, status: "active" }],
    memberships: [{ _id: ids.membership, tenantId: ids.tenant, employeeId: ids.owner, role: "admin", status: "active", scopes: [] }],
    restaurants: [{ _id: ids.restaurant, tenantId: ids.tenant, name: "OFFLINE Kazoku Algemesí", email, onboardingStatus: "pending_review", isActive: false, availabilityStatus: "coming_soon", listingType: "official_partner", internalDemo: false, partnerProfile: null, menu: [], marketplaceCompliance: { pikiStatus: "pending", stripeStatus: "not_created", chargesEnabled: false, payoutsEnabled: false } }],
    authorizations: [],
  };
  let version = 0;
  let conflict = options.commitConflict;
  const effects: string[] = [];
  const state = (opts?: any) => opts?.session?.state ?? db;
  const collection = (name: string) => ({
    async findOne(filter: any, opts?: any) { return clone(state(opts)[name].find((row: any) => match(row, filter)) ?? null); },
    find(filter: any, opts?: any) { return { toArray: async () => clone(state(opts)[name].filter((row: any) => match(row, filter))) }; },
    async updateOne(filter: any, update: any, opts?: any) {
      assert(opts?.session, "Every setup fence must be transactional");
      effects.push(`fence:${name}`);
      if (options.fail === `fence:${name}`) return { matchedCount: 0, modifiedCount: 0 };
      const row = state(opts)[name].find((row: any) => match(row, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      for (const [key, value] of Object.entries(update.$inc ?? {})) row[key] = (row[key] ?? 0) + Number(value);
      for (const [key, value] of Object.entries(update.$set ?? {})) {
        const path = key.split(".");
        let parent = row;
        for (const part of path.slice(0, -1)) parent = parent[part];
        parent[path.at(-1)!] = clone(value);
      }
      return { matchedCount: 1, modifiedCount: 1 };
    },
    async indexes() { return [{ unique: true, key: name === "employees" ? { email: 1 } : { tenantId: 1, employeeId: 1 } }]; },
  });
  const create = (name: string) => async (row: any, session?: any) => {
    effects.push(`insert:${name}`);
    if (options.fail === `insert:${name}`) throw new Error("OFFLINE_INSERT_FAILURE");
    if (name === "authorizations" && !session && options.auditFail) throw new Error("OFFLINE_AUDIT_FAILURE");
    const target = state({ session });
    if (name === "employees" && target.employees.some((r: any) => r.email === row.email)) throw Object.assign(new Error("Duplicate"), { code: 11000 });
    const saved = clone({ _id: row._id ?? "64b000000000000000000009", ...row });
    target[name].push(saved);
    return saved;
  };
  const deps: KitchenAccessDependencies = {
    requireOwner: () => ((_req: any, _res: any, next: any) => next()), ownerEmail,
    objectId: (id) => id, newId: () => ids.employee, employeeCodeFor: () => "PIKI-E-OFFLINE", passwordHash: () => "OFFLINE_HASH_NOT_A_PASSWORD",
    employees: collection("employees"), memberships: collection("memberships"), tenants: collection("tenants"), restaurants: collection("restaurants"),
    createEmployee: create("employees"), createMembership: create("memberships"), createAuthorization: create("authorizations"),
    startSession: async () => {
      const session: any = {
        state: null,
        async withTransaction(callback: any, transactionOptions: any) {
          assert.deepEqual(transactionOptions, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
          for (let attempt = 0; attempt < 4; attempt++) {
            const originalVersion = version;
            session.state = clone(db);
            effects.push("begin");
            try {
              await callback();
              // Give parallel attempts the same snapshot, then enforce optimistic conflicts.
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (conflict || originalVersion !== version) {
                conflict = false; effects.push("abort:retry"); continue;
              }
              db = session.state; version++; effects.push("commit");
              options.afterCommit?.(db);
              return;
            } catch (error) { effects.push("abort"); throw error; }
          }
          throw new Error("OFFLINE_RETRY_EXHAUSTED");
        },
        async endSession() { effects.push("end"); },
      };
      return session;
    },
    sendActivation: async (employee) => {
      assert(effects.includes("commit"));
      assert.equal(effects.at(-1), "end", "First email must follow committed transaction/endSession");
      assert(db.employees.some((row: any) => row._id === employee._id));
      assert(db.memberships.some((row: any) => row.employeeId === employee._id && row.restaurantIds[0] === ids.restaurant));
      effects.push("email");
      return { sent: corporateRecipientAccepted(options.accepted ?? [email], employee.email) };
    },
  };
  let route: any;
  let registeredOwner = false;
  const originalGuard = deps.requireOwner;
  deps.requireOwner = () => { registeredOwner = true; return originalGuard(); };
  registerPartnerKitchenAccessRoutes({ post(path: string, ...handlers: any[]) { assert.equal(path, "/api/v1/admin/partners/kitchen-access"); assert.equal(handlers.length, 2); route = handlers[1]; } } as any, deps);
  assert(registeredOwner);
  async function call(body: any = input, auth: any = { role: "admin", employeeId: ids.owner, tenantId: ids.tenant }) {
    let status = 200; let response: any;
    const res = { status(code: number) { status = code; return this; }, json(value: any) { response = value; return this; } };
    await route({ body, auth }, res);
    return { status, body: response };
  }
  return { deps, call, effects, get db() { return db; } };
}

test("explicit kitchen jobRole Partner has only read/prepare; legacy fallback remains", () => {
  const roles = partnerRolesForEmployee({ jobRole: "partner", roles: ["partner"], partnerRoles: ["kitchen"] });
  assert.deepEqual(roles, ["kitchen"]);
  assert.deepEqual([...permissionsForPartnerRoles(roles)], ["orders:read", "orders:prepare"]);
  for (const permission of ["orders:cancel", "orders:write", "store:write", "menu:write", "metrics:read"] as const) assert.equal(partnerCan(roles, permission), false);
  assert(permissionsForPartnerRoles(partnerRolesForEmployee({ jobRole: "partner", roles: ["rider"] })).has("*"));
  assert(permissionsForPartnerRoles(partnerRolesForEmployee({ jobRole: "partner", partnerRoles: [] })).has("*"));
  assert.deepEqual(partnerRolesForEmployee({ jobRole: "partner", partnerRoles: [" "] }), []);
  assert.deepEqual(partnerRolesForEmployee({ jobRole: "partner", partnerRoles: ["catalog"] }), ["catalog"]);
});

test("strict schema accepts no tenant/role/jobRole/password/global assignment trick", () => {
  assert.deepEqual(kitchenAccessSchema.parse({ ...input, email: " JOSE888628@HOTMAIL.COM ", restaurantId: ids.restaurant.toUpperCase(), sendActivation: undefined }), input);
  for (const extra of [{ tenantId: ids.otherTenant }, { roles: ["admin"] }, { partnerRoles: ["partner_admin"] }, { restaurantIds: [ids.xativa] }, { jobRole: "support" }, { password: "notallowed" }, { approved: true }]) assert.equal(kitchenAccessSchema.safeParse({ ...input, ...extra }).success, false);
});

test("pending/inactive setup atomically approves account only, with one real membership and no email", async () => {
  const h = harness(); const before = clone(h.db.restaurants[0]); const ownerBefore = clone(h.db.employees[0]);
  const result = await h.call();
  assert.equal(result.status, 201); assert.equal(result.body.created, true); assert.equal(result.body.bindingPersisted, true);
  assert.equal(result.body.employee.authorizationStatus, "approved"); assert.equal(result.body.employee.active, true);
  assert.deepEqual(result.body.employee.restaurantIds, [ids.restaurant]); assert.equal(result.body.employee.tenantId, ids.tenant);
  assert.deepEqual(result.body.employee.permissions, ["orders:read", "orders:prepare"]);
  assert.equal(result.body.activationEmail.sent, false); assert(!h.effects.includes("email"));
  const { kitchenAccessRevision, ...restaurant } = h.db.restaurants[0]; assert.deepEqual(restaurant, before);
  assert.deepEqual(h.db.employees[0], ownerBefore);
  const membership = h.db.memberships.find((r: any) => r.employeeId === ids.employee);
  assert.deepEqual(membership.restaurantIds, [ids.restaurant]); assert.deepEqual(membership.scopes, ["orders:read", "orders:prepare"]);
  assert.equal(h.db.memberships[0].role, "admin"); assert.deepEqual(h.db.memberships[0].scopes, []);
  assert.equal(h.db.authorizations.length, 1); assert.equal(h.db.authorizations[0].actorEmployeeId, ids.owner);
  assert.equal(canIssueEmployeeSession(h.db.employees[1]), true); assert.equal(sessionRole(h.db.employees[1], "partner"), "partner");
  assert.equal(sessionRole(h.db.employees[1], "partner", "admin"), null); assert.equal(sessionTenantMatchesEmployee(ids.otherTenant, ids.tenant), false);
  assert.equal(kitchenRestaurantCanOperate(h.db.restaurants[0]), false);
});

test("schema persists kitchen marker and actual restaurantIds on tenant membership", async () => {
  const h = harness(); await h.call();
  const employee = new EmployeeAccount({ ...h.db.employees[1], _id: new mongoose.Types.ObjectId(ids.employee), passwordHash: "OFFLINE_ONLY" });
  assert.equal(employee.validateSync(), undefined); assert.equal(employee.kitchenAccessSetupVersion, 1);
  const membership = new TenantMembership(h.db.memberships[1]);
  assert.equal(membership.validateSync(), undefined); assert.deepEqual(membership.toObject().restaurantIds.map(String), [ids.restaurant]);
});

for (const [name, auth] of Object.entries({ "shared Admin env token": { role: "admin", isRootOwner: true }, "missing tenant": { role: "admin", employeeId: ids.owner }, "other tenant": { role: "admin", employeeId: ids.owner, tenantId: ids.otherTenant }, "ordinary Admin": { role: "admin", employeeId: ids.employee, tenantId: ids.tenant }, "temporary Root credential": { role: "admin", employeeId: ids.owner, tenantId: ids.tenant, mustChangePassword: true } })) {
  test(`${name} is denied without account or email`, async () => { const h = harness(); const result = await h.call(input, auth); assert(result.status >= 400); assert.equal(h.db.employees.length, 1); assert(!h.effects.includes("email")); });
}

test("Root identity and tenant membership are independently validated; no membership promotion", async () => {
  for (const mutation of [(h: any) => h.db.employees[0].ownerProtected = false, (h: any) => h.db.tenants[0].status = "suspended", (h: any) => h.db.memberships[0].role = "partner", (h: any) => h.db.memberships[0].status = "revoked", (h: any) => h.db.memberships[0].tenantId = ids.otherTenant]) {
    const h = harness(); mutation(h); const result = await h.call(); assert.equal(result.status, 403); assert.equal(h.db.employees.length, 1); assert(!h.effects.includes("email"));
  }
});

test("same-tenant Xàtiva cannot receive José through restaurantId/email mismatch", async () => {
  const h = harness(); h.db.restaurants.push({ ...clone(h.db.restaurants[0]), _id: ids.xativa, name: "OFFLINE Xàtiva", email: "comercial.kazoku@gmail.com" });
  const result = await h.call({ ...input, restaurantId: ids.xativa, sendActivation: true });
  assert.equal(result.status, 409); assert.equal(result.body.error, "KITCHEN_RESTAURANT_CONTACT_CONFLICT"); assert.equal(h.db.employees.length, 1); assert(!h.effects.includes("email"));
});

test("nonexistent, cross-tenant, directory, demo, suspended or rejected restaurant cannot bind", async () => {
  for (const mutation of [(h: any) => h.db.restaurants = [], (h: any) => h.db.restaurants[0].tenantId = ids.otherTenant, (h: any) => h.db.restaurants[0].listingType = "local_directory", (h: any) => h.db.restaurants[0].internalDemo = true, (h: any) => h.db.restaurants[0].onboardingStatus = "suspended", (h: any) => h.db.restaurants[0].onboardingStatus = "rejected"]) {
    const h = harness(); mutation(h); const result = await h.call({ ...input, sendActivation: true }); assert(result.status >= 400); assert.equal(h.db.employees.length, 1); assert(!h.effects.includes("email"));
  }
});

test("existing conflicting identity is never updated, approved, rebound or sent credentials", async () => {
  for (const extra of [{ kitchenAccessSetupVersion: undefined }, { tenantId: ids.otherTenant }, { restaurantId: ids.xativa }, { partnerRoles: ["partner_admin"] }, { ownerProtected: true }, { roles: ["admin", "partner"] }, { authorizationStatus: "pending" }, { active: false }, { restaurantIds: [ids.restaurant, ids.xativa] }]) {
    const h = harness(); await h.call(); Object.assign(h.db.employees[1], extra); const before = clone(h.db);
    const result = await h.call({ ...input, sendActivation: true }); assert(result.status >= 400); assert.deepEqual(h.db, before); assert(!h.effects.includes("email"));
  }
  const h = harness(); const result = await h.call({ ...input, email: ownerEmail }); assert.equal(result.body.error, "OWNER_ACCOUNT_PROTECTED");
});

for (const failure of ["fence:tenants", "fence:memberships", "fence:restaurants", "insert:employees", "insert:memberships", "insert:authorizations"]) {
  test(`${failure} aborts entire binding with zero email`, async () => {
    const h = harness({ fail: failure }); const before = clone(h.db);
    try { const result = await h.call({ ...input, sendActivation: true }); assert.equal(result.body.error, "KITCHEN_BINDING_CHANGED"); }
    catch (error) { assert.match(String(error), /OFFLINE_INSERT_FAILURE/); }
    assert.deepEqual(h.db, before); assert(h.effects.includes("abort")); assert(!h.effects.includes("email")); assert(!h.effects.includes("commit"));
  });
}

test("missing unique email/membership index fails closed before any transaction", async () => {
  const h = harness(); h.deps.employees.indexes = async () => [];
  assert.equal((await h.call()).body.error, "KITCHEN_ACCESS_UNIQUE_INDEX_REQUIRED"); assert.deepEqual(h.effects, []);
});

test("exact duplicate retry returns created=false and never resends or resets password", async () => {
  const h = harness(); await h.call({ ...input, sendActivation: true }); const before = clone(h.db);
  const result = await h.call({ ...input, sendActivation: true }); assert.equal(result.status, 200); assert.equal(result.body.created, false);
  assert.equal(result.body.activationEmail.skipped, "EXACT_RETRY_NO_EMAIL"); assert.deepEqual(h.db, before); assert.equal(h.effects.filter((effect) => effect === "email").length, 1);
});

test("driver retry/fencing discards aborted creation and sends once only after successful commit", async () => {
  const h = harness({ commitConflict: true }); const result = await h.call({ ...input, sendActivation: true });
  assert.equal(result.status, 201); assert(h.effects.includes("abort:retry")); assert.equal(h.db.employees.length, 2); assert.equal(h.db.memberships.length, 2); assert.equal(h.db.authorizations.length, 2); assert.equal(h.effects.filter((effect) => effect === "email").length, 1);
});

test("two concurrent requests serialize to one new account and one exact retry with one email", async () => {
  const h = harness(); const result = await Promise.all([h.call({ ...input, sendActivation: true }), h.call({ ...input, sendActivation: true })]);
  assert.deepEqual(result.map((r) => r.status).sort(), [200, 201]); assert.equal(result.filter((r) => r.body.created).length, 1);
  assert.equal(h.db.employees.length, 2); assert.equal(h.db.memberships.length, 2); assert.equal(h.effects.filter((effect) => effect === "email").length, 1);
});

test("unique insert racing another actor returns conflict and no first email", async () => {
  const h = harness(); h.deps.createEmployee = async () => { throw Object.assign(new Error("OFFLINE_DUP"), { code: 11000 }); };
  const result = await h.call({ ...input, sendActivation: true }); assert.equal(result.status, 409); assert.equal(result.body.error, "KITCHEN_ACCOUNT_CONCURRENT_CONFLICT"); assert.equal(h.db.employees.length, 1); assert(!h.effects.includes("email"));
});

test("postcommit changed binding fails activation but truthfully reports persisted new account", async () => {
  const h = harness({ afterCommit(db) { db.memberships[1].restaurantIds = [ids.xativa]; } });
  const result = await h.call({ ...input, sendActivation: true }); assert.equal(result.status, 201); assert.equal(result.body.created, true); assert.equal(result.body.bindingPersisted, true); assert.equal(result.body.activationEmail.sent, false); assert.equal(result.body.activationEmail.error, "KITCHEN_MEMBERSHIP_CONFLICT"); assert(!h.effects.includes("email"));
});

test("SMTP must accept exact recipient on Partner surface; audit failure does not turn sent into false", async () => {
  const wrong = harness({ accepted: ["other@example.test"] }); const result = await wrong.call({ ...input, sendActivation: true });
  assert.equal(result.body.activationEmail.sent, false); assert.equal(result.body.activationEmail.surface, "partner"); assert.equal(result.body.activationEmail.recipient, email); assert.equal(wrong.db.authorizations.length, 1);
  const right = harness({ accepted: [{ address: email.toUpperCase() }], auditFail: true }); const success = await right.call({ ...input, sendActivation: true }); assert.equal(success.body.activationEmail.sent, true); assert.equal(success.body.activationEmail.error, "CREDENTIAL_EMAIL_OR_AUDIT_FAILED");
});

test("activation on pending restaurant is valid; cross tenant and extra membership are not", async () => {
  const h = harness(); await h.call(); assert.equal((await validateKitchenActivation({ auth: { role: "admin", employeeId: ids.owner, tenantId: ids.tenant } } as any, h.db.employees[1], h.deps))._id, ids.employee);
  h.db.memberships.push({ ...clone(h.db.memberships[1]), tenantId: ids.otherTenant });
  await assert.rejects(kitchenBindingForEmployee(h.db.employees[1], h.deps), /KITCHEN_MEMBERSHIP_CONFLICT/);
  await assert.rejects(validateKitchenActivation({ auth: { role: "admin", employeeId: ids.owner, tenantId: ids.otherTenant } } as any, h.db.employees[1], h.deps), /SUPERADMIN_ONLY|OWNER_TENANT_MEMBERSHIP_REQUIRED/);
});

test("new kitchen operation gate requires approved/active/published menu and known allergens/compliance", () => {
  const h = harness(); const live = { ...h.db.restaurants[0], onboardingStatus: "approved", isActive: true, availabilityStatus: "available", marketplaceCompliance: { pikiStatus: "verified" }, menu: [{ available: true, allergens: ["fish"] }] };
  assert.equal(kitchenRestaurantCanOperate(live), true);
  for (const override of [{ isActive: false }, { onboardingStatus: "pending_review" }, { availabilityStatus: "coming_soon" }, { menu: [] }, { menu: [{ available: true, allergens: null }] }, { menu: [{ available: false, allergens: [] }] }, { marketplaceCompliance: { pikiStatus: "pending" } }]) assert.equal(kitchenRestaurantCanOperate({ ...live, ...override }), false);
});

const serverSource = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compile(code: string, context: Record<string, any>) {
  context = { isPartnerEmployee, partnerBindingForEmployee, partnerBindingErrorResponse, validatePartnerCredentialTarget, ...context };
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${javascript}; return subject;`)(...Object.values(context));
}
function helper(name: string, context: Record<string, any>) {
  const node = serverSource.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name); assert(node);
  return compile(`${node.getText(serverSource)}; const subject = ${name};`, context);
}
function handler(path: string, context: Record<string, any>) {
  for (const s of serverSource.statements) {
    if (!ts.isExpressionStatement(s) || !ts.isCallExpression(s.expression)) continue;
    const c = s.expression;
    if (c.arguments.length && ts.isStringLiteral(c.arguments[0]) && c.arguments[0].text === path) return compile(`const subject = ${c.arguments[c.arguments.length - 1].getText(serverSource)};`, context);
  }
  throw new Error("Route missing");
}
const query = (row: any) => ({ select() { return this; }, lean() { return this; }, exec: async () => row });

test("real runtime scope denies inactive orders before any Order read or write, and rejects X header", async () => {
  const h = harness(); await h.call(); const employee = h.db.employees[1];
  const context: any = { EmployeeAccount: { findById: () => query(employee) }, kitchenAccessDependencies: h.deps, KitchenAccessError, kitchenBindingForEmployee, partnerRolesForEmployee, permissionsForPartnerRoles, assignedRestaurantIds: (e: any) => e.restaurantIds, kitchenRestaurantCanOperate, partnerCan };
  context.partnerAccessForRequest = helper("partnerAccessForRequest", context);
  context.partnerRequestAccess = helper("partnerRequestAccess", context);
  const req: any = { auth: { employeeId: ids.employee, tenantId: ids.tenant }, header: (key: string) => key === "x-piki-restaurant-id" ? ids.xativa : "" };
  const selected = helper("employeeRestaurant", context);
  assert.equal(await selected(req), null);
  assert.equal(await context.partnerAccessForRequest({ auth: { ...req.auth, tenantId: ids.otherTenant } }), null);
  let orderQueries = 0; const orders = { find() { orderQueries++; throw new Error("Order read forbidden"); }, findOne() { orderQueries++; throw new Error("Order write forbidden"); } };
  const routeContext = { ...context, z: (await import("zod")).z, Order: orders, employeeRestaurant: selected };
  for (const path of ["/api/v1/partners/kitchen/orders", "/api/v1/partners/kitchen/orders/archive", "/api/v1/partners/kitchen/orders/:id/status"]) {
    let code = 200; const res = { status(c: number) { code = c; return this; }, json() { return this; } };
    await handler(path, routeContext)({ ...req, body: { status: "preparing" }, params: { id: ids.employee }, query: {} }, res); assert.equal(code, 403);
  }
  assert.equal(orderQueries, 0);
});

test("real explicit send-activation checks binding and never emails failed membership", async () => {
  const h = harness(); await h.call(); h.db.memberships[1].restaurantIds = [ids.xativa]; let emails = 0;
  const context = { objectId: (id: string) => id, EmployeeAccount: { findById: () => query(h.db.employees[1]) }, ownerEmail, KitchenAccessError, validateKitchenActivation, kitchenAccessDependencies: h.deps, preferredCredentialSurface: () => "partner", sendEmployeePasswordLink: async () => { emails++; throw new Error("Unexpected email"); } };
  let code = 200; const res = { status(c: number) { code = c; return this; }, json() { return this; } };
  await handler("/api/v1/admin/employees/:id/send-activation", context)({ params: { id: ids.employee }, auth: { role: "admin", employeeId: ids.owner, tenantId: ids.tenant } }, res);
  assert.equal(code, 409); assert.equal(emails, 0);
});

test("first credential helper remains Partner-branded with 24h TTL and SMTP exact recipient", async () => {
  let ttl = 0; let message: any;
  const send = helper("sendEmployeePasswordLink", { createEmployeePasswordReset: async (_e: any, surface: string, duration: number) => { assert.equal(surface, "partner"); ttl = duration; return { tokenHash: "OFFLINE_HASH", resetUrl: "https://partners.pikidelivery.com/?reset=OFFLINE" }; }, employeeCredentialLabels: { partner: "PIKI Partner Orders" }, escapeCorporateHtml: (v: string) => v, sendCorporateEmail: async (m: any) => { message = m; return { sent: corporateRecipientAccepted([email], m.recipientEmail) }; } });
  const result = await send({ _id: ids.employee, name: "José", email }, "partner", "activation");
  assert.equal(ttl, 24 * 60 * 60_000); assert.equal(result.delivery.sent, true); assert.equal(message.department, "admin"); assert.equal(message.recipientEmail, email); assert.match(message.subject, /PIKI Partner Orders/); assert.match(message.text, /24 horas/); assert.match(message.text, /https:\/\/partners\.pikidelivery\.com\/\?reset=/);
});

test("real Owner middleware still rejects env-token Root bypass and ordinary admin", async () => {
  const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const node = authSource.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "requireOwner"); assert(node);
  for (const [auth, row, expected] of [[{ role: "admin", isRootOwner: true }, null, 403], [{ role: "admin", employeeId: ids.employee }, null, 403], [{ role: "admin", employeeId: ids.owner, tenantId: ids.tenant }, { _id: ids.owner }, 200]] as const) {
    const factory = compile(`${node.getText(authSource).replace(/^export\s+/, "")}; const subject = requireOwner;`, { resolveRole: async () => auth, PIKI_OWNER_EMAIL: ownerEmail, EmployeeAccount: { findOne(filter: any) { assert.equal(filter.email, ownerEmail); assert.equal(filter.active, true); assert.equal(filter.authorizationStatus, "approved"); assert.equal(filter.accessLevel, "superadmin"); return query(row); } } });
    let code = 200; let next = false; const res = { setHeader() {}, status(c: number) { code = c; return this; }, json() { return this; } };
    await factory()({}, res, () => { next = true; }); assert.equal(code, expected); assert.equal(next, expected === 200);
  }
});

test("real Partner locations offers only exact real same-tenant assignment, with no fallback discovery", async () => {
  const h = harness(); await h.call(); const employee = h.db.employees[1]; let reads = 0;
  const locations = helper("partnerLocationsFor", { partnerRolesForEmployee, permissionsForPartnerRoles, assignedRestaurantIds: (e: any) => e.restaurantIds, onboardingCode: () => "OFFLINE", Restaurant: { find(filter: any) { reads++; assert.equal(filter.tenantId, ids.tenant); assert.deepEqual(filter._id.$in, [ids.restaurant]); return query(h.db.restaurants.filter((r: any) => filter._id.$in.includes(r._id) && r.tenantId === filter.tenantId)); } } });
  const result = await locations(employee); assert.deepEqual(result.map((r: any) => r.id), [ids.restaurant]); assert.equal(result[0].isOpen, false); assert.deepEqual(result[0].permissions, ["orders:read", "orders:prepare"]);
  h.db.restaurants[0].tenantId = ids.otherTenant; assert.deepEqual(await locations(employee), []); assert.equal(reads, 2);
  employee.restaurantId = null; employee.restaurantIds = []; assert.deepEqual(await locations(employee), []); assert.equal(reads, 2);
});

test("real explicit first activation sends Partner 24h helper on safe pending account", async () => {
  const h = harness(); await h.call(); let emails = 0; let audits = 0;
  const context = { objectId: (id: string) => id, EmployeeAccount: { findById: () => query(h.db.employees[1]) }, ownerEmail, KitchenAccessError, validateKitchenActivation, kitchenAccessDependencies: h.deps, preferredCredentialSurface: helper("preferredCredentialSurface", { employeeCredentialSurface: (s: string) => ["partner", "admin", "rider", "fleet"].includes(s) ? s : null, employeeCanUseCredentialSurface: (e: any, s: string) => Boolean(sessionRole(e, s)) }), employeeCredentialLabels: { partner: "PIKI Partner Orders" }, sendEmployeePasswordLink: async (target: any, surface: string, purpose: string) => { emails++; assert.equal(surface, "partner"); assert.equal(purpose, "activation"); assert.equal(target.restaurantId, ids.restaurant); assert.equal(target.tenantId, ids.tenant); return { delivery: { sent: corporateRecipientAccepted([email.toUpperCase()], target.email) } }; }, AccessAuthorization: { create: async (row: any) => { audits++; assert.equal(row.tenantId, ids.tenant); assert.equal(row.action, "credentials_sent"); } } };
  let code = 200; let body: any; const res = { status(c: number) { code = c; return this; }, json(b: any) { body = b; return this; } };
  await handler("/api/v1/admin/employees/:id/send-activation", context)({ params: { id: ids.employee }, auth: { role: "admin", employeeId: ids.owner, tenantId: ids.tenant } }, res);
  assert.equal(code, 200); assert.equal(emails, 1); assert.equal(audits, 1); assert.equal(body.sent, true); assert.equal(body.surface, "partner"); assert.equal(body.recipient, email);
});

test("optional authorized 7-day split hours initialize null profile only, before binding commit", async () => {
  const { normalizeOpeningHours, evaluateOpeningHours } = await import("./openingHours.js");
  const hours = { timeZone: "Europe/Madrid", regular: Object.fromEntries(["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"].map((day) => [day, [{ open: "11:30", close: "16:30", endsNextDay: false }, { open: "19:30", close: "00:00", endsNextDay: true }]])), overrides: [], source: { mode: "piki" } };
  const h = harness(); const before = clone(h.db.restaurants[0]);
  const result = await h.call({ ...input, openingHours: hours }); assert.equal(result.status, 201); assert.equal(result.body.openingHoursPersisted, true);
  const profile = h.db.restaurants[0].partnerProfile; assert.deepEqual(Object.keys(profile), ["openingHours"]); assert.deepEqual(profile.openingHours, normalizeOpeningHours(hours));
  assert.equal(evaluateOpeningHours(profile.openingHours, new Date("2026-11-09T23:01:00Z")).open, false);
  assert.equal(evaluateOpeningHours(profile.openingHours, new Date("2026-11-09T22:59:00Z")).open, true);
  assert.equal(evaluateOpeningHours(profile.openingHours, new Date("2026-11-09T17:00:00Z")).open, false);
  const { kitchenAccessRevision, partnerProfile, ...unchanged } = h.db.restaurants[0]; const { partnerProfile: originalProfile, ...original } = before; assert.deepEqual(unchanged, original);
  const snap = clone(h.db); const retry = await h.call({ ...input, openingHours: hours, sendActivation: true }); assert.equal(retry.body.created, false); assert.deepEqual(h.db, snap); assert(!h.effects.includes("email"));
  const conflict = await h.call({ ...input, openingHours: { ...hours, regular: {} } }); assert.equal(conflict.body.error, "KITCHEN_OPENING_HOURS_CONFLICT"); assert.deepEqual(h.db, snap);
});

test("optional hours change only nested field on existing profile and rollback all fields on failed binding", async () => {
  const hours = { timeZone: "Europe/Madrid", regular: { lunes: [{ open: "11:30", close: "16:30" }, { open: "19:30", close: "00:00" }] }, overrides: [] };
  const h = harness(); h.db.restaurants[0].partnerProfile = { legalName: "OFFLINE_PRESERVE", taxId: "OFFLINE_PRESERVE", documents: [{ unknown: "OFFLINE_PRESERVE" }], openingHours: { old: true } };
  const before = clone(h.db.restaurants[0].partnerProfile); await h.call({ ...input, openingHours: hours }); const { openingHours, ...kept } = h.db.restaurants[0].partnerProfile; const { openingHours: old, ...original } = before; assert.deepEqual(kept, original); assert.equal(openingHours.regular.lunes[1].endsNextDay, true);
  const failed = harness({ fail: "insert:memberships" }); const snap = clone(failed.db);
  await assert.rejects(failed.call({ ...input, openingHours: hours, sendActivation: true }), /OFFLINE_INSERT_FAILURE/); assert.deepEqual(failed.db, snap); assert(!failed.effects.includes("email"));
  for (const override of [{ onboardingStatus: "approved", isActive: true }, { onboardingStatus: "pending_review", isActive: true }]) {
    const denied = harness(); Object.assign(denied.db.restaurants[0], override); const result = await denied.call({ ...input, openingHours: hours }); assert.equal(result.body.error, "KITCHEN_HOURS_PENDING_SETUP_ONLY"); assert.equal(denied.db.employees.length, 1);
  }
  const invalid = harness(); assert.equal((await invalid.call({ ...input, openingHours: { lunes: { open: "25:00", close: "00:00", closed: false } } })).status, 400); assert.deepEqual(invalid.effects, []);
});
