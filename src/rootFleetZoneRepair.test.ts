import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { GovernanceAuditEvent } from "./models.js";
import { registerRootFleetZoneRepairRoutes, rootFleetZoneRepairSchema, type RootFleetZoneRepairDependencies } from "./rootFleetZoneRepair.js";
import { operationalZoneInputSchema } from "./coverage/zoneInput.js";

// Entirely synthetic offline records: no production IDs, photos or identity documents.
const ids = { owner: "64c000000000000000000001", tenant: "64c000000000000000000002", zone: "64c000000000000000000003", fleet: "64c000000000000000000004", manager: "64c000000000000000000005", other: "64c000000000000000000006" };
const ownerEmail = "owner@example.test";
const sourceTime = new Date("2026-10-01T12:00:00.000Z");
const input = { tenantId: ids.tenant, fleetId: ids.fleet, managerEmployeeId: ids.manager, expectedZoneUpdatedAt: sourceTime.toISOString(), expectedSlug: "offline-municipality" };
const rootAuth = { role: "admin", employeeId: ids.owner, isRootOwner: true };
const clone = <T>(value: T): T => structuredClone(value);
function match(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (key === "$or") return expected.some((item: any) => match(row, item));
    const actual = row[key];
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (expected && typeof expected === "object") {
      if ("$in" in expected) return expected.$in.includes(actual);
      if ("$ne" in expected) return actual !== expected.$ne;
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
    }
    return Array.isArray(actual) ? actual.includes(expected) : actual === expected;
  });
}
function project(row: any, projection?: any) {
  if (!row) return null;
  return projection ? Object.fromEntries(Object.entries(row).filter(([key]) => key === "_id" || projection[key] === 1)) : row;
}
const serverSource = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compile(code: string, context: Record<string, any>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${js}; return subject;`)(...Object.values(context));
}
function serverHandler(method: string, path: string, context: Record<string, any>) {
  const statement = serverSource.statements.find((item) => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression)
    && item.expression.expression.getText(serverSource) === `app.${method}`
    && ts.isStringLiteral(item.expression.arguments[0]) && item.expression.arguments[0].text === path) as ts.ExpressionStatement;
  assert(statement, `Actual ${method} ${path} registration must exist`);
  const call = statement.expression as ts.CallExpression;
  return { node: call.arguments.at(-1)!, handler: compile(`const subject = ${call.arguments.at(-1)!.getText(serverSource)};`, context) };
}
function realOwnerGuard(context: Record<string, any>) {
  const node = authSource.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "requireOwner");
  assert(node);
  return compile(`${node.getText(authSource).replace("export function", "function")}; const subject = requireOwner;`, context);
}
function harness(options: { fail?: string; retry?: boolean; transactionUnavailable?: boolean } = {}) {
  let db: any = {
    tenants: [{ _id: ids.tenant, status: "active" }],
    zones: [{ _id: ids.zone, tenantId: null, slug: input.expectedSlug, name: "Offline municipality", updatedAt: sourceTime, createdAt: sourceTime,
      polygon: { type: "MultiPolygon", coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]], [[[2, 2], [3, 2], [3, 3], [2, 2]]]] },
      allowedVehicleTypes: ["bike", "motorcycle"], vehicleCatalogVersion: 2, isActive: true, serviceFeeCents: 123, maxEtaMinutes: 45 }],
    fleets: [{ _id: ids.fleet, tenantId: ids.tenant, managerEmployeeId: ids.manager, isActive: true, serviceZones: [input.expectedSlug], contactEmail: "personal@example.test", updatedAt: sourceTime, name: "Offline fleet", vehicleTypes: ["bike"], managerName: "Offline manager" }],
    employees: [{ _id: ids.manager, tenantId: ids.tenant, fleetId: ids.fleet, apiRole: "fleet", roles: ["fleet"], primaryRole: "fleet", active: true, authorizationStatus: "approved", ownerProtected: false, accessLevel: "subadmin", zoneSlugs: [input.expectedSlug], email: "personal@example.test", passwordHash: "OFFLINE_HASH", sessionHash: "OFFLINE_SESSION_HASH", mustChangePassword: true, restaurantIds: [], partnerRoles: [], createdAt: sourceTime, updatedAt: sourceTime }],
    resets: [{ employeeId: ids.manager, tokenHash: "OFFLINE_RESET_HASH", usedAt: null, expiresAt: new Date("2030-01-01T00:00:00.000Z") }],
    restaurants: [{ tenantId: ids.tenant, isActive: false, onboardingStatus: "pending_review" }], memberships: [{ employeeId: ids.manager, role: "fleet" }],
    riders: [{ status: "offline" }], orders: [{ status: "pending", paymentState: "pending" }], people: [{ name: "Unrelated offline record" }], audits: [],
  };
  const effects: string[] = [];
  const reads: any[] = [];
  const writes: any[] = [];
  let version = 0;
  let retry = options.retry;
  const collection = (name: string) => ({
    async findOne(filter: any, opts: any) {
      assert(opts.session?.state, "Every maintenance read is in the transaction snapshot");
      assert(opts.projection, "Read only the explicit safe projection");
      assert(!Object.keys(opts.projection).some((field) => /password|session|reset|photo|dni|nie/i.test(field)));
      reads.push({ name, filter: clone(filter), projection: clone(opts.projection) });
      return clone(project(opts.session.state[name].find((row: any) => match(row, filter)), opts.projection));
    },
    async updateOne(filter: any, update: any, opts: any) {
      assert(opts.session?.state);
      assert.equal(opts.upsert, false, "Never duplicate/create a zone or fleet");
      writes.push({ name, filter: clone(filter), update: clone(update) });
      effects.push(`write:${name}`);
      if (options.fail === `cas:${name}`) return { matchedCount: 0, modifiedCount: 0 };
      if (options.fail === "duplicate" && name === "zones") throw Object.assign(new Error("Offline duplicate"), { code: 11000 });
      const row = opts.session.state[name].find((item: any) => match(item, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, clone(update.$set));
      return { matchedCount: 1, modifiedCount: 1 };
    },
  });
  const deps: RootFleetZoneRepairDependencies = {
    requireOwner: realOwnerGuard({
      resolveRole: async (req: any) => req.auth,
      PIKI_OWNER_EMAIL: ownerEmail,
      EmployeeAccount: { findOne(filter: any) {
        effects.push("guard:owner-read");
        const owner = { _id: ids.owner, email: ownerEmail, active: true, authorizationStatus: "approved", accessLevel: "superadmin" };
        return { select() { return this; }, lean() { return this; }, exec: async () => match(owner, filter) ? { _id: ids.owner } : null };
      } },
    }),
    ownerEmail, objectId: (id) => id,
    tenants: collection("tenants"), employees: collection("employees"), fleets: collection("fleets"), zones: collection("zones"),
    startSession: async () => {
      effects.push("session");
      const session: any = { state: null,
        async withTransaction(callback: () => Promise<void>, opts: any) {
          assert.deepEqual(opts, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
          if (options.transactionUnavailable) throw new Error("OFFLINE_TRANSACTIONS_UNAVAILABLE");
          for (let attempt = 0; attempt < 4; attempt++) {
            const beforeVersion = version;
            session.state = clone(db); effects.push("begin");
            try {
              await callback();
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (retry || version !== beforeVersion) { retry = false; effects.push("abort:retry"); continue; }
              db = session.state; version++; effects.push("commit"); return;
            } catch (error) { effects.push("abort"); throw error; }
          }
          throw new Error("OFFLINE_RETRIES_EXHAUSTED");
        },
        async endSession() { effects.push("end"); },
      };
      return session;
    },
    createAudit: async (row, session: any) => {
      effects.push("audit"); assert(session.state);
      if (options.fail === "audit") throw new Error("OFFLINE_AUDIT_FAILURE");
      assert.equal(new GovernanceAuditEvent(row).validateSync(), undefined, "Fits the existing real audit schema");
      session.state.audits.push(clone(row));
    },
  };
  let route: any;
  let guard: any;
  registerRootFleetZoneRepairRoutes({ post(path: string, ...handlers: any[]) {
    assert.equal(path, "/api/v1/admin/zones/:id/repair-fleet-scope");
    assert.equal(handlers.length, 2); [guard, route] = handlers;
  } } as any, deps);
  async function call(body: any = input, auth: any = rootAuth, id = ids.zone, bypassGuard = false) {
    let status = 200; let response: any; let allowed = bypassGuard;
    const res = { setHeader() {}, status(code: number) { status = code; return this; }, json(value: any) { response = value; return this; } };
    const req = { body, auth, params: { id } };
    if (!bypassGuard) await guard(req, res, () => { allowed = true; });
    if (allowed) await route(req, res);
    return { status, body: response };
  }
  return { call, effects, reads, writes, get db() { return db; } };
}

function assertUnchangedAccounts(before: any, after: any) {
  for (const key of ["employees", "resets", "restaurants", "memberships", "riders", "orders", "people", "tenants"]) assert.deepEqual(after[key], before[key], `${key} must remain wholly unchanged`);
}

test("actual Owner repair moves the SAME zone without duplication and preserves geometry, vehicles, passwords, roles and active reset", async () => {
  const h = harness(); const before = clone(h.db);
  const result = await h.call();
  assert.deepEqual(result, { status: 200, body: { zone: { id: ids.zone, tenantId: ids.tenant, slug: input.expectedSlug }, result: "repaired", contactEmailRestored: false } });
  assert.equal(h.db.zones.length, 1); assert.equal(h.db.zones[0]._id, before.zones[0]._id); assert.equal(h.db.zones[0].tenantId, ids.tenant);
  assert.deepEqual({ ...h.db.zones[0], tenantId: null, updatedAt: sourceTime }, before.zones[0]);
  assert.equal(h.db.zones.filter((row: any) => row.tenantId === null).length, 0);
  assertUnchangedAccounts(before, h.db); assert.deepEqual(h.db.fleets, before.fleets);
  assert.equal(h.db.employees[0].mustChangePassword, true); assert.equal(h.db.resets[0].usedAt, null);
  assert.deepEqual(h.writes.map((write) => write.name), ["zones"]);
  assert.deepEqual(h.writes[0].filter, { _id: ids.zone, tenantId: null, slug: input.expectedSlug, updatedAt: sourceTime });
  assert.deepEqual(Object.keys(h.writes[0].update.$set).sort(), ["tenantId", "updatedAt"]);
  assert.equal(h.db.audits.length, 1); assert.equal(h.db.audits[0].targetType, "system"); assert.equal(h.db.audits[0].targetId, ids.zone);
  assert(!JSON.stringify(result.body).match(/password|token|session|@|personal/i));
  assert.equal(h.effects.at(-1), "end");
});

test("business Fleet contact is restored separately from the manager personal email; repeat is safe and audit is PII-free", async () => {
  const h = harness(); const before = clone(h.db);
  const body = { ...input, contactEmail: " BUSINESS@example.test " };
  assert.equal((await h.call(body)).body.contactEmailRestored, true);
  assert.equal(h.db.fleets[0].contactEmail, "business@example.test");
  assert.deepEqual({ ...h.db.fleets[0], contactEmail: before.fleets[0].contactEmail }, before.fleets[0]);
  assertUnchangedAccounts(before, h.db);
  assert.deepEqual(h.writes[1].update, { $set: { contactEmail: "business@example.test" } });
  const after = clone(h.db);
  assert.deepEqual(await h.call(body), { status: 200, body: { zone: { id: ids.zone, tenantId: ids.tenant, slug: input.expectedSlug }, result: "already_scoped", contactEmailRestored: false } });
  assert.deepEqual(h.db, after); assert.equal(h.writes.length, 2);
  assert(!JSON.stringify(h.db.audits).includes("@"));
});

test("same existing target zone is idempotent with the pre-move timestamp and no new zone or audit", async () => {
  const h = harness();
  h.db.zones[0].tenantId = ids.tenant; h.db.zones[0].updatedAt = new Date("2026-10-02T12:00:00Z");
  const before = clone(h.db);
  assert.equal((await h.call()).body.result, "already_scoped");
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});

test("contact-only repair on already scoped zone preserves its updatedAt and the complete employee", async () => {
  const h = harness(); h.db.zones[0].tenantId = ids.tenant;
  const before = clone(h.db);
  const result = await h.call({ ...input, contactEmail: "business@example.test" });
  assert.equal(result.body.result, "already_scoped"); assert.equal(result.body.contactEmailRestored, true);
  assert.deepEqual(h.db.zones, before.zones); assertUnchangedAccounts(before, h.db);
  assert.deepEqual(h.writes.map((write) => write.name), ["fleets"]);
});

for (const [name, auth, status] of [
  ["unauthenticated", null, 401], ["emergency root token without employee", { role: "admin", isRootOwner: true }, 403],
  ["non-root persisted Owner", { ...rootAuth, isRootOwner: false }, 403], ["tenant admin", { ...rootAuth, employeeId: ids.other, isRootOwner: false }, 403],
  ["fake root employee", { ...rootAuth, employeeId: ids.other }, 403], ["fleet actor", { ...rootAuth, role: "fleet" }, 403],
  ["Owner temporary password", { ...rootAuth, mustChangePassword: true }, 428],
] as const) test(`real requireOwner + handler denies ${name} before transactions`, async () => {
  const h = harness(); const before = clone(h.db);
  assert.equal((await h.call(input, auth)).status, status); assert(!h.effects.includes("session")); assert.equal(h.reads.length, 0); assert.deepEqual(h.db, before);
});

test("handler itself requires admin + valid employeeId + explicit isRootOwner, not only mounted middleware", async () => {
  for (const auth of [{ role: "admin", isRootOwner: true }, { ...rootAuth, employeeId: "bad" }, { ...rootAuth, isRootOwner: undefined }, { ...rootAuth, role: "fleet" }]) {
    const h = harness(); assert.equal((await h.call(input, auth, ids.zone, true)).status, 403); assert.equal(h.effects.length, 0);
  }
});

for (const [name, body, id] of [
  ["unknown keys", { ...input, polygon: {} }, ids.zone], ["malformed tenant ID", { ...input, tenantId: "bad" }, ids.zone],
  ["malformed fleet ID", { ...input, fleetId: "bad" }, ids.zone], ["malformed manager ID", { ...input, managerEmployeeId: "bad" }, ids.zone],
  ["missing tenant", { ...input, tenantId: undefined }, ids.zone], ["non-ISO timestamp", { ...input, expectedZoneUpdatedAt: "2026-10-01" }, ids.zone],
  ["invalid calendar date", { ...input, expectedZoneUpdatedAt: "2026-02-30T12:00:00Z" }, ids.zone],
  ["invalid email", { ...input, contactEmail: "not-email" }, ids.zone], ["invalid slug", { ...input, expectedSlug: "Bad Slug" }, ids.zone],
  ["invalid zone ID", input, "bad"], ["null body", null, ids.zone],
] as const) test(`strict request rejects ${name} without maintenance IO`, async () => {
  const h = harness(); assert.equal((await h.call(body, rootAuth, id)).status, 400); assert.equal(h.reads.length, 0); assert(!h.effects.includes("session"));
});

test("strict repair schema does not accept credential/account/geometry/permission modifications", () => {
  for (const field of ["password", "mustChangePassword", "roles", "restaurantId", "zoneSlugs", "serviceZones", "polygon", "name", "slug", "upsert"]) assert.equal(rootFleetZoneRepairSchema.safeParse({ ...input, [field]: true }).success, false);
});

const invalidCases: Array<[string, (db: any) => void, string, number?]> = [
  ["missing tenant", (db) => { db.tenants = []; }, "TENANT_NOT_ACTIVE", 404],
  ["inactive tenant", (db) => { db.tenants[0].status = "suspended"; }, "TENANT_NOT_ACTIVE", 404],
  ["different tenant record", (db) => { db.tenants[0]._id = ids.other; }, "TENANT_NOT_ACTIVE", 404],
  ["missing source zone", (db) => { db.zones = []; }, "ROOT_ZONE_NOT_FOUND", 404],
  ["different zone ID with same slug", (db) => { db.zones[0]._id = ids.other; }, "ROOT_ZONE_NOT_FOUND", 404],
  ["zone already in another tenant", (db) => { db.zones[0].tenantId = ids.other; }, "ROOT_ZONE_NOT_FOUND", 404],
  ["changed slug", (db) => { db.zones[0].slug = "changed"; }, "ZONE_SLUG_CHANGED"],
  ["changed timestamp", (db) => { db.zones[0].updatedAt = new Date("2026-10-02T12:00:00Z"); }, "ZONE_CAS_FAILED"],
  ["missing timestamp", (db) => { delete db.zones[0].updatedAt; }, "ZONE_CAS_FAILED"],
  ["wrong fleet ID", (db) => { db.fleets[0]._id = ids.other; }, "FLEET_BINDING_INVALID"],
  ["fleet different tenant", (db) => { db.fleets[0].tenantId = ids.other; }, "FLEET_BINDING_INVALID"],
  ["inactive fleet", (db) => { db.fleets[0].isActive = false; }, "FLEET_BINDING_INVALID"],
  ["fleet different manager", (db) => { db.fleets[0].managerEmployeeId = ids.other; }, "FLEET_BINDING_INVALID"],
  ["wrong person ID", (db) => { db.employees[0]._id = ids.other; }, "MANAGER_BINDING_INVALID"],
  ["person different tenant", (db) => { db.employees[0].tenantId = ids.other; }, "MANAGER_BINDING_INVALID"],
  ["person different fleet", (db) => { db.employees[0].fleetId = ids.other; }, "MANAGER_BINDING_INVALID"],
  ["inactive person", (db) => { db.employees[0].active = false; }, "MANAGER_BINDING_INVALID"],
  ["pending person", (db) => { db.employees[0].authorizationStatus = "pending"; }, "MANAGER_BINDING_INVALID"],
  ["revoked person", (db) => { db.employees[0].authorizationStatus = "revoked"; }, "MANAGER_BINDING_INVALID"],
  ["person lacks Fleet API role", (db) => { db.employees[0].apiRole = "rider"; }, "MANAGER_BINDING_INVALID"],
  ["person lacks Fleet roles", (db) => { db.employees[0].roles = ["rider"]; }, "MANAGER_BINDING_INVALID"],
  ["person protected Owner", (db) => { db.employees[0].ownerProtected = true; }, "MANAGER_BINDING_INVALID"],
  ["person superadmin", (db) => { db.employees[0].accessLevel = "superadmin"; }, "MANAGER_BINDING_INVALID"],
  ["person Owner email", (db) => { db.employees[0].email = ownerEmail; }, "MANAGER_BINDING_INVALID"],
  ["person admin role", (db) => { db.employees[0].roles = ["fleet", "admin"]; }, "MANAGER_BINDING_INVALID"],
  ["missing Fleet slug", (db) => { db.fleets[0].serviceZones = []; }, "ZONE_LINKS_REQUIRED"],
  ["missing Employee slug", (db) => { db.employees[0].zoneSlugs = []; }, "ZONE_LINKS_REQUIRED"],
  ["target slug collision", (db) => { db.zones.push({ _id: ids.other, tenantId: ids.tenant, slug: input.expectedSlug, name: "Other" }); }, "TARGET_ZONE_CONFLICT"],
  ["target name collision", (db) => { db.zones.push({ _id: ids.other, tenantId: ids.tenant, slug: "other", name: db.zones[0].name }); }, "TARGET_ZONE_CONFLICT"],
];
for (const [name, change, error, status = 409] of invalidCases) test(`${name} aborts without any repair, duplicate, merge or fallback`, async () => {
  const h = harness(); change(h.db); const before = clone(h.db);
  assert.deepEqual(await h.call({ ...input, contactEmail: "business@example.test" }), { status, body: { error } });
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0); assert.equal(h.effects.at(-1), "end");
});

test("target idempotence still validates slug, manager and target collisions", async () => {
  for (const [name, change, error, status = 409] of invalidCases.filter(([name]) => /changed slug|person different fleet|target slug collision|inactive tenant/.test(name))) {
    const h = harness(); h.db.zones[0].tenantId = ids.tenant; change(h.db); const before = clone(h.db);
    assert.deepEqual(await h.call(), { status, body: { error } }, name); assert.deepEqual(h.db, before);
  }
});

test("homonymous zones in other tenants are never selected, changed or treated as target conflicts", async () => {
  const h = harness(); const other = { ...clone(h.db.zones[0]), _id: ids.other, tenantId: ids.other };
  h.db.zones.push(other);
  assert.equal((await h.call()).body.result, "repaired"); assert.deepEqual(h.db.zones[1], other); assert.equal(h.db.zones.length, 2);
  for (const read of h.reads.filter((item) => item.name === "zones")) assert("tenantId" in read.filter);
  for (const read of h.reads.filter((item) => ["fleets", "employees"].includes(item.name))) assert.equal(read.filter.tenantId, ids.tenant);
});

for (const [failure, code] of [["cas:zones", "ZONE_CAS_FAILED"], ["cas:fleets", "FLEET_CONTACT_CAS_FAILED"], ["duplicate", "TARGET_ZONE_CONFLICT"]]) test(`${failure} rolls back zone/contact/audit together`, async () => {
  const h = harness({ fail: failure }); const before = clone(h.db);
  assert.deepEqual(await h.call({ ...input, contactEmail: "business@example.test" }), { status: 409, body: { error: code } });
  assert.deepEqual(h.db, before); assert(h.effects.includes("abort")); assert.equal(h.effects.at(-1), "end");
});

test("audit failure rolls back both mutations and never returns success", async () => {
  const h = harness({ fail: "audit" }); const before = clone(h.db);
  await assert.rejects(h.call({ ...input, contactEmail: "business@example.test" }), /OFFLINE_AUDIT_FAILURE/);
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 2); assert.equal(h.effects.at(-1), "end");
});

test("unavailable Mongo transactions fail closed without nontransactional fallback", async () => {
  const h = harness({ transactionUnavailable: true }); const before = clone(h.db);
  await assert.rejects(h.call(), /OFFLINE_TRANSACTIONS_UNAVAILABLE/); assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0); assert.equal(h.effects.at(-1), "end");
});

test("transaction retry revalidates with a fresh snapshot, commits once and creates one audit/zone", async () => {
  const h = harness({ retry: true });
  assert.equal((await h.call()).body.result, "repaired"); assert(h.effects.includes("abort:retry"));
  assert.equal(h.reads.filter((read) => read.name === "tenants").length, 2); assert.equal(h.db.zones.length, 1); assert.equal(h.db.audits.length, 1);
});

test("concurrent repairs converge to repaired + already_scoped without duplicating", async () => {
  const h = harness(); const results = await Promise.all([h.call(), h.call()]);
  assert.deepEqual(results.map((result) => result.body.result).sort(), ["already_scoped", "repaired"]);
  assert.equal(h.db.zones.length, 1); assert.equal(h.db.audits.length, 1); assert(h.effects.includes("abort:retry"));
});

test("real server mounts only the intended collection/adaptor dependencies and original POST zone schema/handler", async () => {
  const mounts = serverSource.statements.filter((item) => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression)
    && item.expression.expression.getText(serverSource) === "registerRootFleetZoneRepairRoutes") as ts.ExpressionStatement[];
  assert.equal(mounts.length, 1);
  const object = (mounts[0].expression as ts.CallExpression).arguments[1] as ts.ObjectLiteralExpression;
  assert.deepEqual(object.properties.map((property) => property.name!.getText(serverSource)), ["requireOwner", "ownerEmail", "objectId", "tenants", "employees", "fleets", "zones", "startSession", "createAudit"]);
  let mountedDeps: any;
  const depsContext = { app: {}, requireOwner: () => undefined, ownerEmail, objectId: (id: string) => id, Tenant: { collection: "tenants" }, EmployeeAccount: { collection: "employees" }, Fleet: { collection: "fleets" }, Zone: { collection: "zones" },
    mongoose: { startSession: async () => "offline-session" }, GovernanceAuditEvent: { create: async (rows: any, opts: any) => ({ rows, opts }) },
    registerRootFleetZoneRepairRoutes: (_app: any, deps: any) => { mountedDeps = deps; },
  };
  compile(`${mounts[0].getText(serverSource)}; const subject = null;`, depsContext);
  assert.equal(mountedDeps.zones, "zones"); assert.equal(mountedDeps.employees, "employees"); assert.equal(await mountedDeps.startSession(), "offline-session");
  assert.deepEqual(await mountedDeps.createAudit({ action: "offline" }, "offline-session"), { rows: [{ action: "offline" }], opts: { session: "offline-session" } });
  const schemaDeclaration = serverSource.statements.flatMap((item) => ts.isVariableStatement(item) ? [...item.declarationList.declarations] : []).find((item) => item.name.getText(serverSource) === "zoneSchema");
  assert.equal(schemaDeclaration?.initializer?.getText(serverSource), "operationalZoneInputSchema");
  let write: any;
  const original = serverHandler("post", "/api/v1/zones", { zoneSchema: operationalZoneInputSchema, tenantScope: () => ({ tenantId: ids.other }),
    Zone: { findOneAndUpdate(filter: any, update: any, opts: any) { write = { filter, update, opts }; return { lean() { return this; }, exec: async () => ({ _id: ids.other }) }; } },
  });
  assert(!original.node.getText(serverSource).includes("requestedTenantId"));
  let status = 200;
  const res = { status(code: number) { status = code; return this; }, json() {} };
  await original.handler({ body: { name: "Offline", slug: "offline", tenantId: ids.tenant, polygon: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] } } }, res);
  assert.equal(status, 201); assert.deepEqual(write.filter, { tenantId: ids.other, slug: "offline" }); assert.equal(write.update.$set.tenantId, ids.other);
  assert.deepEqual(write.opts, { upsert: true, new: true }); // Original creation behavior is not repurposed as a repair.
});

test("real GET employee/me projection includes ONLY fleetId addition and reports bound fleet instead of null", async () => {
  const originalProjection = "name email employeeCode tenantId ownerProtected accessLevel authorizationStatus jobRole apiRole roles partnerRoles primaryRole zoneSlugs restaurantId restaurantIds kitchenAccessSetupVersion";
  for (const linked of [true, false]) {
    const employee = { _id: ids.manager, email: "personal@example.test", name: "Offline manager", fleetId: linked ? ids.fleet : null };
    let projection = ""; let fleetReads = 0; let response: any;
    const query = (row: any) => ({ select() { return this; }, lean() { return this; }, exec: async () => row });
    const actual = serverHandler("get", "/api/v1/auth/employee/me", {
      EmployeeAccount: { findOne(filter: any) {
        assert.deepEqual(filter, { _id: ids.manager, tenantId: ids.tenant });
        return { select(fields: string) { projection = fields; return this; }, lean() { return this; }, exec: async () => project(employee, Object.fromEntries(projection.split(" ").map((field) => [field, 1]))) };
      }, findById(id: string) { assert.equal(id, ids.manager); return query({ name: employee.name, email: employee.email }); } },
      tenantScope: () => ({ tenantId: ids.tenant }), partnerRolesForEmployee: () => ["fleet"], permissionsForPartnerRoles: () => [], partnerLocationsFor: async () => [], employeeCodeFor: () => "OFFLINE-E",
      Fleet: { findById(id: string) { fleetReads++; assert.equal(id, ids.fleet); return query({ _id: ids.fleet, name: "Offline fleet", city: "Offline city", managerEmployeeId: ids.manager }); } },
    });
    await actual.handler({ auth: { role: "fleet", employeeId: ids.manager } }, { json(value: any) { response = value; } });
    assert.equal(projection, `${originalProjection} fleetId`);
    assert.equal(response.employee.fleetId, linked ? ids.fleet : null); assert.equal(response.employee.isFleetManager, linked);
    assert.equal(fleetReads, linked ? 1 : 0); assert.equal(response.employee.fleetName, linked ? "Offline fleet" : null);
  }
});
