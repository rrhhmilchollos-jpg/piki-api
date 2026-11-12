import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { AccessAuthorization, GovernanceAuditEvent, TenantMembership } from "./models.js";
import { EmployeeSession, OWNER_EMAIL, isRootOwnerAccount, sessionTenantMatchesEmployee } from "./employeeSessions.js";
import { hashSessionToken } from "./employeeAuth.js";
import { registerOwnerOperatingTenantRoutes, ownerOperatingTenantSchema, type OwnerOperatingTenantDependencies } from "./ownerOperatingTenant.js";

const ids = { owner: "64d000000000000000000001", tenant: "64d000000000000000000002", other: "64d000000000000000000003", restaurant: "64d000000000000000000004", fleet: "64d000000000000000000005", rider: "64d000000000000000000006" };
const sourceTime = new Date("2026-10-01T00:00:00Z");
const input = { targetTenantId: ids.tenant, expectedTenantId: null, expectedUpdatedAt: sourceTime.toISOString() };
const rootAuth = { role: "admin", employeeId: ids.owner, isRootOwner: true };
const oldToken = "OFFLINE_ONLY_OLD_CREDENTIAL";
const clone = <T>(value: T): T => structuredClone(value);
function match(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (key === "$or") return expected.some((f: any) => match(row, f));
    const actual = row[key];
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object") return Object.entries(expected).every(([operator, value]: [string, any]) => {
      if (operator === "$gt") return actual > value;
      if (operator === "$exists") return (actual !== undefined) === value;
      if (operator === "$nin") return !value.includes(actual);
      throw new Error(`UNMOCKED_OPERATOR_${operator}`);
    });
    return expected === null ? actual == null : Array.isArray(actual) ? actual.includes(expected) : actual === expected;
  });
}
function project(row: any, projection: any) { return row ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] === 1)) : null; }
function compile(code: string, context: Record<string, any>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${js}; return subject;`)(...Object.values(context));
}
const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function harness(options: { failure?: string; retry?: boolean; auth?: any } = {}) {
  let db: any = {
    employees: [{ _id: ids.owner, email: OWNER_EMAIL, tenantId: null, name: "Synthetic owner", apiRole: "admin", jobRole: "admin", roles: ["admin"], primaryRole: "admin", ownerProtected: true, hiddenFromAdmin: true, accessLevel: "superadmin", active: true, authorizationStatus: "approved", mustChangePassword: false, updatedAt: sourceTime, createdAt: sourceTime, sessionHash: null, passwordHash: "x", zoneSlugs: ["offline-zone"], restaurantId: ids.restaurant, restaurantIds: [ids.restaurant], fleetId: ids.fleet },
      { _id: ids.other, tenantId: ids.tenant, email: "independent@example.test", roles: ["partner"], passwordHash: "y" }],
    tenants: [{ _id: ids.tenant, status: "active", name: "Synthetic tenant" }],
    memberships: [{ _id: ids.other, tenantId: ids.other, employeeId: ids.owner, role: "admin", status: "active", scopes: ["read"] }, { tenantId: ids.tenant, employeeId: ids.other, role: "partner", status: "active" }],
    restaurants: [{ _id: ids.restaurant, tenantId: ids.tenant, isActive: false, onboardingStatus: "pending_review", menu: [{ available: false, allergens: null }] }],
    fleets: [{ _id: ids.fleet, tenantId: ids.tenant, managerEmployeeId: ids.owner, serviceZones: ["offline-zone"] }],
    riders: [{ _id: ids.rider, email: OWNER_EMAIL, tenantId: ids.tenant, fleetId: ids.fleet, activeOrderId: null }],
    sessions: [{ _id: ids.owner, employeeId: ids.owner, tenantId: null, role: "admin", surface: "admin", tokenHash: hashSessionToken(oldToken), issuedAt: sourceTime, expiresAt: new Date("2030-01-01") }, { _id: ids.other, employeeId: ids.other, tenantId: ids.tenant, role: "partner" }],
    authorizations: [], audits: [], orders: [{ status: "pending", paymentState: "pending" }],
  };
  const effects: string[] = []; const reads: any[] = []; const writes: any[] = []; let version = 0; let retry = options.retry;
  let resolved: any = options.auth === undefined ? rootAuth : options.auth;
  const collection = (name: string): any => ({
    async findOne(filter: any, opts: any) { assert(opts.session?.state); assert(opts.projection); reads.push({ name, filter: clone(filter), projection: clone(opts.projection) }); return clone(project(opts.session.state[name].find((row: any) => match(row, filter)), opts.projection)); },
    find(filter: any, opts: any) { assert(opts.session?.state); assert(opts.projection); reads.push({ name, filter: clone(filter), projection: clone(opts.projection) }); return { toArray: async () => clone(opts.session.state[name].filter((row: any) => match(row, filter)).map((row: any) => project(row, opts.projection))) }; },
    async updateOne(filter: any, update: any, opts: any) {
      assert(opts.session?.state); assert.equal(opts.upsert, false); effects.push(`write:${name}`); writes.push({ name, filter, update });
      if (options.failure === "cas") return { matchedCount: 0, modifiedCount: 0 };
      const row = opts.session.state[name].find((row: any) => match(row, filter)); if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, clone(update.$set)); return { matchedCount: 1, modifiedCount: 1 };
    },
    async deleteMany(filter: any, opts: any) {
      assert(opts.session?.state); assert.deepEqual(filter, { employeeId: ids.owner }); effects.push("revoke");
      if (options.failure === "revoke") throw new Error("OFFLINE_SECRET_REVOKE_ERROR");
      const oldLength = opts.session.state[name].length;
      opts.session.state[name] = opts.session.state[name].filter((row: any) => !match(row, filter));
      return { acknowledged: options.failure !== "unacknowledged", deletedCount: oldLength - opts.session.state[name].length };
    },
  });
  const create = (name: string, model: any) => async (row: any, session: any) => {
    assert(session.state); effects.push(`create:${name}`);
    if (options.failure === name) throw new Error("OFFLINE_SECRET_WRITE_ERROR");
    if (options.failure === "duplicate" && name === "memberships") throw Object.assign(new Error("OFFLINE_DUPLICATE"), { code: 11000 });
    assert.equal(new model(row).validateSync(), undefined, "Uses the actual persisted schema offline");
    session.state[name].push(clone(row)); return options.failure === `invalid:${name}` ? null : clone(row);
  };
  const node = authSource.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "requireOwner")!;
  const requireOwner = compile(`${node.getText(authSource).replace("export function", "function")}; const subject = requireOwner;`, {
    resolveRole: async () => resolved, PIKI_OWNER_EMAIL: OWNER_EMAIL,
    EmployeeAccount: { findOne(filter: any) { return { select() { return this; }, lean() { return this; }, exec: async () => db.employees.find((row: any) => match(row, filter)) || null }; } },
  });
  const deps: OwnerOperatingTenantDependencies = {
    requireOwner, resolveAuth: async () => resolved, objectId: (id) => id,
    employees: collection("employees"), tenants: collection("tenants"), memberships: collection("memberships"), restaurants: collection("restaurants"), fleets: collection("fleets"), riders: collection("riders"), orders: collection("orders"), sessions: collection("sessions"),
    createMembership: create("memberships", TenantMembership), createSession: create("sessions", EmployeeSession), createAudit: create("audits", GovernanceAuditEvent), createAuthorization: create("authorizations", AccessAuthorization),
    startSession: async () => {
      effects.push("session");
      if (options.failure === "start") throw new Error("OFFLINE_START_ERROR");
      const session: any = { state: null,
        async withTransaction(callback: () => Promise<void>, opts: any) {
          assert.deepEqual(opts, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
          if (options.failure === "transaction") throw new Error("OFFLINE_TRANSACTIONS_UNAVAILABLE");
          for (let attempt = 0; attempt < 4; attempt++) {
            const beforeVersion = version; session.state = clone(db); effects.push("begin");
            try {
              await callback(); await new Promise<void>((resolve) => setImmediate(resolve));
              if (retry || version !== beforeVersion) { retry = false; effects.push("retry"); continue; }
              if (options.failure === "commit") throw new Error("OFFLINE_COMMIT_FAILURE");
              db = session.state; version++; effects.push("commit"); return;
            } catch (error) { effects.push("abort"); throw error; }
          }
          throw new Error("OFFLINE_RETRIES_EXHAUSTED");
        }, async endSession() { effects.push("end"); },
      }; return session;
    },
  };
  const routes: Record<string, any[]> = {};
  const mount = (method: string) => (path: string, ...handlers: any[]) => { assert.equal(path, "/api/v1/admin/owner/operating-tenant"); assert.equal(handlers.length, 3); routes[method] = handlers; };
  registerOwnerOperatingTenantRoutes({ post: mount("post"), get: mount("get") } as any, deps);
  async function call(body: any = input, method = "post", bypassGuard = false, requestAuth: any = resolved, credential = oldToken) {
    let status = 200; let response: any; const headers: Record<string, string> = {};
    const req: any = { body, query: method === "get" ? body : {}, auth: requestAuth, header: () => `Bearer ${credential}` };
    const res: any = { setHeader(key: string, value: string) { headers[key] = value; }, status(code: number) { status = code; return this; }, json(value: any) { response = value; return this; } };
    let allowed = false; routes[method][0](req, res, () => {});
    if (bypassGuard) allowed = true; else await routes[method][1](req, res, () => { allowed = true; });
    if (allowed) await routes[method][2](req, res);
    return { status, body: response, headers };
  }
  return { call, deps, effects, reads, writes, setAuth(auth: any) { resolved = auth; }, get db() { return db; } };
}
function assertPreserved(before: any, after: any) {
  for (const key of ["tenants", "restaurants", "fleets", "riders", "orders"]) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual({ ...after.employees[0], tenantId: null, updatedAt: sourceTime }, before.employees[0]);
  assert.deepEqual(after.employees[1], before.employees[1]);
  assert.deepEqual(after.memberships.slice(0, before.memberships.length), before.memberships);
  assert.deepEqual(after.sessions.find((row: any) => row.employeeId === ids.other), before.sessions[1]);
}
test("atomic root binding preserves all accounts, credentials, roles, resources and memberships; renews admin for exactly 24h", async () => {
  const h = harness(); const before = clone(h.db); const r = await h.call();
  assert.equal(r.status, 200); assert.equal(r.body.result, "bound"); assert.equal(r.body.sessionRotated, true);
  assert.equal(r.headers["Cache-Control"], "no-store"); assert.equal(r.body.employee.tenantId, ids.tenant);
  assertPreserved(before, h.db); assert(isRootOwnerAccount(h.db.employees[0]));
  const sessions = h.db.sessions.filter((row: any) => row.employeeId === ids.owner); assert.equal(sessions.length, 1);
  assert.equal(sessions[0].role, "admin"); assert.equal(sessions[0].surface, "admin"); assert.equal(sessions[0].tenantId, ids.tenant);
  assert.equal(sessions[0].expiresAt.getTime() - sessions[0].issuedAt.getTime(), 24 * 60 * 60 * 1000);
  assert.equal(sessions[0].tokenHash, hashSessionToken(r.body.accessToken)); assert.notEqual(r.body.accessToken, oldToken);
  assert.equal(h.db.audits.length, 1); assert.equal(h.db.authorizations.length, 1);
  assert(!JSON.stringify(h.db.audits).match(/password|hash|token|@/i));
  assert(!JSON.stringify(h.db.authorizations).match(/password|hash|token|@/i));
  assert.deepEqual(Object.keys(h.writes[0].update.$set).sort(), ["tenantId", "updatedAt"]);
  assert.equal(h.writes[0].filter.tenantId, null); assert.equal(h.writes[0].filter.updatedAt.getTime(), sourceTime.getTime());
});
test("GET own probe is PII-free, read-only and supplies mandatory CAS snapshot plus canonical IDs", async () => {
  const h = harness(); const before = clone(h.db); const r = await h.call({ targetTenantId: ids.tenant }, "get");
  assert.equal(r.status, 200); assert.equal(r.body.employee.id, ids.owner); assert.equal(r.body.employee.tenantId, null);
  assert.equal(r.body.employee.updatedAt, input.expectedUpdatedAt); assert.equal(r.body.bindingsMatchTarget, true);
  assert.equal(r.body.targetTenant.ownActiveOwnerMembership, false); assert.deepEqual(r.body.canonicalRestaurantBindingIds, [ids.restaurant]);
  assert(!JSON.stringify(r.body).match(/email|name|bank|nif|passwordHash|accessToken|tokenHash|@/i)); assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});
for (const [name, auth, expected] of [
  ["missing", null, 401], ["environment token", { role: "admin", isRootOwner: true }, 403],
  ["other employee", { ...rootAuth, employeeId: ids.other }, 403], ["nonroot admin", { ...rootAuth, isRootOwner: false }, 403],
  ["partner root", { ...rootAuth, role: "partner" }, 403], ["rider root", { ...rootAuth, role: "rider" }, 403], ["fleet root", { ...rootAuth, role: "fleet" }, 403],
  ["temporary password", { ...rootAuth, mustChangePassword: true }, 428],
] as const) test(`real Owner guard plus endpoint reject ${name}`, async () => {
  const h = harness({ auth }); const before = clone(h.db); assert.equal((await h.call()).status, expected); assert.deepEqual(h.db, before); assert(!h.effects.includes("session"));
});
test("handler rejects forged req.auth claims against independently resolved credential even with middleware bypass", async () => {
  for (const auth of [{ ...rootAuth, employeeId: ids.other }, { ...rootAuth, tenantId: ids.other }, { ...rootAuth, role: "partner" }, null]) {
    const h = harness(); assert.equal((await h.call(input, "post", true, auth)).status, 403); assert.equal(h.effects.length, 0);
  }
});
for (const field of ["email", "employeeId", "ownerProtected", "accessLevel", "roles", "password", "apiRole", "fleetId", "zoneSlugs", "restaurantIds"]) test(`strict body rejects self-elevation/reassignment field ${field}`, async () => {
  const h = harness(); assert.equal((await h.call({ ...input, [field]: true })).status, 400); assert(!h.effects.includes("session"));
});
for (const body of [{ ...input, expectedUpdatedAt: undefined }, { ...input, expectedTenantId: ids.other }, { ...input, targetTenantId: "bad" }, { ...input, expectedUpdatedAt: "2026-02-30T00:00:00Z" }]) test("malformed or incomplete CAS request has no IO", async () => {
  const h = harness(); assert.equal((await h.call(body)).status, 400); assert(!h.effects.includes("session"));
});
const negatives: Array<[string, (db: any) => void, string, number?]> = [
  ["unprotected persisted owner", (db) => { db.employees[0].ownerProtected = false; }, "ROOT_OWNER_REQUIRED", 403],
  ["wrong persisted identity", (db) => { db.employees[0].email = "spoof@example.test"; }, "ROOT_OWNER_REQUIRED", 403],
  ["persisted subadmin", (db) => { db.employees[0].accessLevel = "subadmin"; }, "ROOT_OWNER_REQUIRED", 403],
  ["inactive", (db) => { db.employees[0].active = false; }, "ROOT_OWNER_REQUIRED", 403],
  ["unapproved", (db) => { db.employees[0].authorizationStatus = "pending"; }, "ROOT_OWNER_REQUIRED", 403],
  ["persisted temporary", (db) => { db.employees[0].mustChangePassword = true; }, "PASSWORD_CHANGE_REQUIRED", 428],
  ["no persisted admin", (db) => { db.employees[0].roles = ["partner"]; db.employees[0].apiRole = "partner"; }, "ROOT_ADMIN_ROLE_REQUIRED", 403],
  ["frozen tenant mismatch", (db) => { db.employees[0].tenantId = ids.other; }, "SESSION_TENANT_CHANGED", 401],
  ["stale updatedAt", (db) => { db.employees[0].updatedAt = new Date("2026-10-02"); }, "OWNER_TENANT_CAS_FAILED"],
  ["absent updatedAt", (db) => { delete db.employees[0].updatedAt; }, "OWNER_TENANT_CAS_FAILED"],
  ["undefined rather than null tenant", (db) => { delete db.employees[0].tenantId; }, "OWNER_TENANT_CAS_FAILED"],
  ["tenant suspended", (db) => { db.tenants[0].status = "suspended"; }, "TENANT_NOT_ACTIVE", 404],
  ["tenant missing", (db) => { db.tenants = []; }, "TENANT_NOT_ACTIVE", 404],
  ["restaurant cross tenant", (db) => { db.restaurants[0].tenantId = ids.other; }, "EXISTING_BINDING_TENANT_CONFLICT"],
  ["restaurant missing", (db) => { db.restaurants = []; }, "EXISTING_BINDING_TENANT_CONFLICT"],
  ["invalid assigned ID", (db) => { db.employees[0].restaurantIds = ["bad"]; }, "EXISTING_BINDING_INVALID"],
  ["fleet cross tenant", (db) => { db.fleets[0].tenantId = ids.other; }, "EXISTING_BINDING_TENANT_CONFLICT"],
  ["reverse manager cross tenant", (db) => { db.fleets.push({ _id: ids.other, managerEmployeeId: ids.owner, tenantId: ids.other }); }, "EXISTING_BINDING_TENANT_CONFLICT"],
  ["rider cross tenant", (db) => { db.riders[0].tenantId = ids.other; }, "EXISTING_BINDING_TENANT_CONFLICT"],
  ["rider fleet cross tenant", (db) => { db.riders[0].fleetId = ids.other; db.fleets.push({ _id: ids.other, tenantId: ids.other }); }, "EXISTING_BINDING_TENANT_CONFLICT"],
  ["active Rider order", (db) => { db.riders[0].activeOrderId = ids.other; }, "OWNER_ACTIVE_ORDER"],
  ["conflicting member role", (db) => { db.memberships.push({ tenantId: ids.tenant, employeeId: ids.owner, role: "admin", status: "active" }); }, "OWNER_MEMBERSHIP_CONFLICT"],
  ["conflicting member status", (db) => { db.memberships.push({ tenantId: ids.tenant, employeeId: ids.owner, role: "owner", status: "suspended" }); }, "OWNER_MEMBERSHIP_CONFLICT"],
  ["duplicate members", (db) => { db.memberships.push(...[1, 2].map(() => ({ tenantId: ids.tenant, employeeId: ids.owner, role: "owner", status: "active" }))); }, "OWNER_MEMBERSHIP_CONFLICT"],
  ["legacy residual hash", (db) => { db.employees[0].sessionHash = "OFFLINE_LEGACY_HASH"; }, "OWNER_LEGACY_SESSION_CONFLICT"],
  ["old session expired", (db) => { db.sessions[0].expiresAt = sourceTime; }, "OWNER_SESSION_CHANGED", 401],
  ["old session missing frozen tenant", (db) => { delete db.sessions[0].tenantId; }, "OWNER_SESSION_CHANGED", 401],
  ["old session other role", (db) => { db.sessions[0].role = "partner"; }, "OWNER_SESSION_CHANGED", 401],
  ["old session another tenant", (db) => { db.sessions[0].tenantId = ids.other; }, "OWNER_SESSION_CHANGED", 401],
  ["password changed after issuance", (db) => { db.employees[0].passwordChangedAt = new Date("2026-10-02"); }, "OWNER_SESSION_CHANGED", 401],
];
for (const [name, change, error, status = 409] of negatives) test(`${name} fails closed against actual persisted snapshot`, async () => {
  const h = harness(); change(h.db); const before = clone(h.db); const r = await h.call(input, "post", true, rootAuth);
  assert.equal(r.status, status); assert.equal(r.body.error, error); assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});
for (const status of ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way", "assigned", "delivering"]) test(`own target Rider ${status} order blocks before session revocation with absent employee.riderId`, async () => {
  const h = harness(); h.db.orders.push({ _id: ids.other, tenantId: ids.tenant, riderId: ids.rider, status, assignmentState: "assigned" });
  assert(!("riderId" in h.db.employees[0])); assert.equal(h.db.riders[0].activeOrderId, null); const before = clone(h.db);
  const r = await h.call(); assert.equal(r.status, 409); assert.equal(r.body.error, "OWNER_ACTIVE_ORDER"); assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0); assert(!h.effects.includes("revoke"));
  const reads = h.reads.filter((read) => read.name === "orders"); assert.equal(reads.length, 1); assert.equal(reads[0].filter.tenantId, ids.tenant); assert.equal(reads[0].filter.riderId, ids.rider);
  assert(h.reads.some((read) => read.name === "riders" && read.filter.email === OWNER_EMAIL && read.filter.tenantId === ids.tenant));
});
for (const status of ["delivered", "cancelled"]) test(`own ${status} order is terminal and remains unchanged`, async () => {
  const h = harness(); h.db.orders.push({ _id: ids.other, tenantId: ids.tenant, riderId: ids.rider, status }); const orders = clone(h.db.orders);
  assert.equal((await h.call()).status, 200); assert.deepEqual(h.db.orders, orders);
});
test("foreign-tenant and other Rider active orders are never selected or changed", async () => {
  const h = harness(); h.db.orders.push({ _id: ids.other, tenantId: ids.other, riderId: ids.rider, status: "on_the_way" }, { tenantId: ids.tenant, riderId: ids.other, status: "picked_up" });
  const orders = clone(h.db.orders); assert.equal((await h.call()).status, 200); assert.deepEqual(h.db.orders, orders);
  for (const read of h.reads.filter((read) => read.name === "orders")) assert.equal(read.filter.tenantId, ids.tenant);
});
for (const failure of ["start", "transaction", "memberships", "sessions", "revoke", "unacknowledged", "audits", "authorizations", "invalid:memberships", "invalid:sessions", "invalid:audits", "invalid:authorizations", "commit", "cas", "duplicate"]) test(`${failure} failure rolls back employee/member/session/audits; response has no credential or raw driver message`, async () => {
  const h = harness({ failure }); const before = clone(h.db); const r = await h.call();
  assert.equal(r.status, failure === "cas" || failure === "duplicate" ? 409 : 503); assert.deepEqual(h.db, before);
  assert.deepEqual(Object.keys(r.body), ["error"]); assert(!JSON.stringify(r.body).includes("OFFLINE_SECRET"));
});
test("already-target owner active is a no-op only with a matching fresh admin session; does not rotate or rewrite scopes", async () => {
  const h = harness(); h.db.employees[0].tenantId = ids.tenant;
  h.db.memberships.push({ tenantId: ids.tenant, employeeId: ids.owner, role: "owner", status: "active", scopes: ["existing"], restaurantIds: [ids.restaurant] });
  h.setAuth({ ...rootAuth, tenantId: ids.tenant }); const before = clone(h.db);
  const r = await h.call(); assert.equal(r.body.result, "already_bound"); assert.equal(r.body.sessionRotated, false); assert(!("accessToken" in r.body));
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});
test("existing own active owner membership is preserved byte-for-byte on initial binding", async () => {
  const h = harness(); h.db.memberships.push({ tenantId: ids.tenant, employeeId: ids.owner, role: "owner", status: "active", scopes: ["existing"] });
  const members = clone(h.db.memberships); assert.equal((await h.call()).status, 200); assert.deepEqual(h.db.memberships, members);
});
test("no existing operational bindings is permitted without creating restaurant, fleet or rider links", async () => {
  const h = harness(); h.db.employees[0].restaurantId = null; h.db.employees[0].restaurantIds = []; h.db.employees[0].fleetId = null;
  h.db.fleets = []; h.db.riders = []; const before = clone(h.db); assert.equal((await h.call()).status, 200); assertPreserved(before, h.db);
});
test("absent legacy hash is not a residual credential and remains absent after binding", async () => {
  const h = harness(); delete h.db.employees[0].sessionHash;
  assert.equal((await h.call()).status, 200); assert(!("sessionHash" in h.db.employees[0]));
});
test("transaction callback retry issues one committed session and one audit, revalidating everything", async () => {
  const h = harness({ retry: true }); assert.equal((await h.call()).status, 200); assert(h.effects.includes("retry"));
  assert.equal(h.db.sessions.filter((row: any) => row.employeeId === ids.owner).length, 1); assert.equal(h.db.audits.length, 1); assert.equal(h.db.authorizations.length, 1);
  assert.equal(h.reads.filter((row) => row.name === "tenants").length, 2);
});
test("replay with old frozen-null admin cannot inherit new tenant or receive a second token", async () => {
  const h = harness(); assert.equal((await h.call()).status, 200); const before = clone(h.db); const r = await h.call();
  assert.equal(r.status, 401); assert.equal(r.body.error, "SESSION_TENANT_CHANGED"); assert.deepEqual(h.db, before);
  assert.equal(sessionTenantMatchesEmployee(null, h.db.employees[0].tenantId), false);
});
test("concurrent initial binds cannot commit two sessions; losing stale-null request fails on retry", async () => {
  const h = harness(); const results = await Promise.all([h.call(), h.call()]); assert.deepEqual(results.map((r) => r.status).sort(), [200, 401]);
  assert.equal(h.db.audits.length, 1); assert.equal(h.db.sessions.filter((row: any) => row.employeeId === ids.owner).length, 1);
});
test("GET rejects arbitrary employee selection, and reports inactive tenant/member conflicts without writes", async () => {
  const h = harness(); assert.equal((await h.call({ targetTenantId: ids.tenant, employeeId: ids.other }, "get")).status, 400);
  h.db.tenants[0].status = "suspended"; h.db.memberships.push({ tenantId: ids.tenant, employeeId: ids.owner, role: "partner", status: "active" });
  const before = clone(h.db); const r = await h.call({ targetTenantId: ids.tenant }, "get"); assert.equal(r.body.targetTenant.status, "suspended"); assert.equal(r.body.targetTenant.membershipConflict, true); assert.deepEqual(h.db, before);
});
test("membership uniqueness remains the actual existing tenant/employee index; no migration", () => {
  assert(TenantMembership.schema.indexes().some(([fields, opts]: any) => fields.tenantId === 1 && fields.employeeId === 1 && opts.unique === true));
  assert.equal(ownerOperatingTenantSchema.safeParse(input).success, true);
});
test("actual server injects real model transaction adaptors and no runtime bootstrap is imported", async () => {
  const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const mounts = source.statements.filter((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(source) === "registerOwnerOperatingTenantRoutes") as ts.ExpressionStatement[];
  assert.equal(mounts.length, 1); let deps: any;
  const model = (name: string) => ({ collection: name, create: async (rows: any, opts: any) => rows.map((row: any) => ({ toObject: () => ({ ...row, session: opts.session }) })) });
  const models = Object.fromEntries(["EmployeeAccount", "Tenant", "TenantMembership", "Restaurant", "Fleet", "Rider", "Order", "EmployeeSession", "AccessAuthorization", "GovernanceAuditEvent"].map((name) => [name, model(name)]));
  compile(`${mounts[0].getText(source)}; const subject = null;`, { app: {}, ...models, requireOwner: () => {}, resolveRole: async () => rootAuth, objectId: (id: string) => id,
    mongoose: { startSession: async () => "offline-session" }, registerOwnerOperatingTenantRoutes: (_app: any, value: any) => { deps = value; } });
  assert.equal(deps.orders, "Order"); assert.equal(deps.sessions, "EmployeeSession"); assert.equal(deps.memberships, "TenantMembership"); assert.equal(await deps.startSession(), "offline-session");
  for (const method of ["createMembership", "createSession"]) assert.deepEqual(await deps[method]({ safe: true }, "offline-session"), { safe: true, session: "offline-session" });
  for (const method of ["createAudit", "createAuthorization"]) assert.deepEqual((await deps[method]({ safe: true }, "offline-session"))[0].toObject(), { safe: true, session: "offline-session" });
});
