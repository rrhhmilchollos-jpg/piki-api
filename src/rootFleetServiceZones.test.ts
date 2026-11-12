import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { GovernanceAuditEvent } from "./models.js";
import { VEHICLE_CATALOG_VERSION, VEHICLE_TYPES } from "./vehicleCatalog.js";
import { registerRootFleetServiceZonesRoutes, rootFleetServiceZonesSchema, type RootFleetServiceZonesDependencies } from "./rootFleetServiceZones.js";

// Synthetic fixtures only; never production IDs, personal data or credentials.
const ids = { owner: "64d000000000000000000001", tenant: "64d000000000000000000002", fleet: "64d000000000000000000003", manager: "64d000000000000000000004", other: "64d000000000000000000005", zone: "64d000000000000000000006" };
const ownerEmail = "owner@example.test";
const time = new Date("2026-10-01T12:00:00Z");
const input = { addZoneSlugs: ["offline-beta", "offline-gamma"], expectedManagerEmployeeId: ids.manager };
const rootAuth = { role: "admin", employeeId: ids.owner, isRootOwner: true };
const clone = <T>(value: T): T => structuredClone(value);
const serverSource = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compile(code: string, context: Record<string, any>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${js}; return subject;`)(...Object.values(context));
}
function match(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    const actual = row[key];
    if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
    if (Array.isArray(expected)) return Array.isArray(actual) && JSON.stringify(actual) === JSON.stringify(expected);
    if (expected && typeof expected === "object" && "$exists" in expected) return (actual !== undefined) === expected.$exists;
    return actual === expected;
  });
}
function project(row: any, projection: any) {
  return row ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] === 1)) : null;
}
function harness(options: { fail?: string; retry?: boolean; unavailable?: boolean; race?: string; onRetry?: (db: any) => void } = {}) {
  let db: any = {
    tenants: [{ _id: ids.tenant, status: "active" }],
    fleets: [{ _id: ids.fleet, tenantId: ids.tenant, managerEmployeeId: ids.manager, isActive: true, serviceZones: ["offline-alpha"], vehicleTypes: ["bike", "motorcycle"], vehicleCatalogVersion: 1, updatedAt: time, createdAt: time,
      name: "Offline fleet", address: "Offline address", contactEmail: "business@example.test", contactPhone: "OFFLINE_PHONE", maxRiders: 50, notes: "Unchanged", city: "Offline city", localityCode: "00001", createdBy: ids.owner },
      { _id: ids.other, tenantId: ids.tenant, managerEmployeeId: ids.other, isActive: true, serviceZones: ["offline-beta"], vehicleTypes: ["car"], maxRiders: 50, name: "Other offline fleet", updatedAt: time }],
    employees: [{ _id: ids.manager, tenantId: ids.tenant, fleetId: ids.fleet, apiRole: "fleet", roles: ["fleet"], primaryRole: "fleet", jobRole: "fleet", ownerProtected: false, accessLevel: "subadmin", active: true, authorizationStatus: "approved", email: "manager@example.test", zoneSlugs: ["offline-alpha"], updatedAt: time, createdAt: time,
      passwordHash: "SYNTHETIC_HASH", sessionHash: "SYNTHETIC_SESSION", mustChangePassword: true, passwordChangedAt: null, restaurantId: null, restaurantIds: [], partnerRoles: [], authorizationReason: "Offline reason" },
      { _id: ids.other, tenantId: ids.tenant, fleetId: ids.other, roles: ["fleet"], zoneSlugs: ["offline-beta"], email: "other@example.test" }],
    zones: ["offline-alpha", "offline-beta", "offline-gamma"].map((slug) => ({ _id: ids.zone, tenantId: ids.tenant, slug, isActive: true, allowedVehicleTypes: [...VEHICLE_TYPES], vehicleCatalogVersion: 1,
      polygon: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, serviceFeeCents: 123, maxEtaMinutes: 45, updatedAt: time })),
    resets: [{ employeeId: ids.manager, tokenHash: "SYNTHETIC_RESET", usedAt: null, expiresAt: time }],
    riders: [{ fleetId: ids.fleet, tenantId: ids.tenant, zoneSlug: "offline-alpha", status: "offline" }, ...Array.from({ length: 4 }, (_, index) => ({ fleetId: ids.other, tenantId: ids.tenant, zoneSlug: "offline-beta", status: "available", index }))],
    restaurants: [{ tenantId: ids.tenant, isActive: false, onboardingStatus: "pending_review" }], orders: [{ status: "pending", paymentState: "pending" }], memberships: [{ employeeId: ids.manager, role: "fleet" }],
    coverage: [{ policy: "offline", active: true }], audits: [],
  };
  const effects: string[] = []; const reads: any[] = []; const writes: any[] = [];
  let version = 0; let retry = options.retry;
  const collection = (name: string) => ({
    async findOne(filter: any, opts: any) {
      assert(opts.session?.state, "All reads must use the transaction snapshot");
      assert(opts.projection, "Safe explicit projection required");
      assert(!Object.keys(opts.projection).some((field) => /password|session|reset|photo|dni/i.test(field)));
      reads.push({ name, filter: clone(filter), projection: clone(opts.projection) });
      return clone(project(opts.session.state[name].find((row: any) => match(row, filter)), opts.projection));
    },
    async updateOne(filter: any, update: any, opts: any) {
      assert(opts.session?.state); assert.equal(opts.upsert, false);
      assert(["fleets", "employees"].includes(name), "No other resource may be written");
      assert.deepEqual(Object.keys(update), ["$set"]);
      assert.deepEqual(Object.keys(update.$set).sort(), [name === "fleets" ? "serviceZones" : "zoneSlugs", "updatedAt"].sort());
      writes.push({ name, filter: clone(filter), update: clone(update) }); effects.push(`write:${name}`);
      if (options.fail === `cas:${name}`) return { matchedCount: 0, modifiedCount: 0 };
      if (options.fail === `unmodified:${name}`) return { matchedCount: 1, modifiedCount: 0 };
      const state = opts.session.state[name];
      if (options.race === `${name}:timestamp`) state[0].updatedAt = new Date("2026-10-02T12:00:00Z");
      if (options.race === `${name}:array`) state[0][name === "fleets" ? "serviceZones" : "zoneSlugs"].push("racing-scope");
      const row = state.find((item: any) => match(item, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, clone(update.$set)); return { matchedCount: 1, modifiedCount: 1 };
    },
  });
  const ownerNode = authSource.statements.find((item) => ts.isFunctionDeclaration(item) && item.name?.text === "requireOwner");
  assert(ownerNode);
  const deps: RootFleetServiceZonesDependencies = {
    requireOwner: compile(`${ownerNode.getText(authSource).replace("export function", "function")}; const subject = requireOwner;`, {
      resolveRole: async (req: any) => req.auth, PIKI_OWNER_EMAIL: ownerEmail,
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
          if (options.unavailable) throw new Error("OFFLINE_TRANSACTIONS_UNAVAILABLE");
          for (let attempt = 0; attempt < 8; attempt++) {
            const beforeVersion = version; session.state = clone(db); effects.push("begin");
            try {
              await callback(); await new Promise<void>((resolve) => setImmediate(resolve));
              if (retry || version !== beforeVersion) { retry = false; effects.push("abort:retry"); options.onRetry?.(db); continue; }
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
      assert.equal(new GovernanceAuditEvent(row).validateSync(), undefined, "Uses the real existing GovernanceAuditEvent schema");
      session.state.audits.push(clone(row));
    },
  };
  let route: any; let guard: any;
  registerRootFleetServiceZonesRoutes({ patch(path: string, ...handlers: any[]) {
    assert.equal(path, "/api/v1/admin/fleets/:id/service-zones"); assert.equal(handlers.length, 2); [guard, route] = handlers;
  } } as any, deps);
  async function call(body: any = input, auth: any = rootAuth, id = ids.fleet, bypassGuard = false) {
    let status = 200; let response: any; let allowed = bypassGuard;
    const res = { setHeader() {}, status(code: number) { status = code; return this; }, json(value: any) { response = value; return this; } };
    const req = { body, auth, params: { id } };
    if (!bypassGuard) await guard(req, res, () => { allowed = true; });
    if (allowed) await route(req, res);
    return { status, body: response };
  }
  return { call, reads, writes, effects, get db() { return db; } };
}
function assertPreserved(before: any, after: any) {
  for (const name of ["tenants", "zones", "riders", "restaurants", "orders", "resets", "memberships", "coverage"]) assert.deepEqual(after[name], before[name], `${name} unchanged`);
  assert.deepEqual(after.fleets.slice(1), before.fleets.slice(1)); assert.deepEqual(after.employees.slice(1), before.employees.slice(1));
  assert.deepEqual({ ...after.fleets[0], serviceZones: before.fleets[0].serviceZones, updatedAt: before.fleets[0].updatedAt }, before.fleets[0]);
  assert.deepEqual({ ...after.employees[0], zoneSlugs: before.employees[0].zoneSlugs, updatedAt: before.employees[0].updatedAt }, before.employees[0]);
}

test("actual handler extends one existing Fleet and manager atomically; every other attribute/fleet/four riders is preserved", async () => {
  const h = harness(); const before = clone(h.db);
  assert.deepEqual(await h.call(), { status: 200, body: { fleetId: ids.fleet, managerEmployeeId: ids.manager, tenantId: ids.tenant, serviceZones: ["offline-alpha", ...input.addZoneSlugs], result: "extended" } });
  assert.deepEqual(h.db.fleets[0].serviceZones, h.db.employees[0].zoneSlugs);
  assert.equal(h.db.fleets[0].maxRiders, 50); assert.equal(h.db.employees[0].fleetId, ids.fleet); assert.equal(h.db.employees[0].mustChangePassword, true);
  assertPreserved(before, h.db); assert.deepEqual(h.writes.map((write) => write.name), ["fleets", "employees"]);
  assert.equal(h.db.audits.length, 1); assert.equal(h.db.audits[0].targetType, "system"); assert.equal(h.db.audits[0].targetId, ids.fleet);
  assert(!JSON.stringify(h.db.audits).match(/@|SYNTHETIC|contactEmail|phone|password|sessionHash|tokenHash/i));
  assert(!JSON.stringify((await h.call()).body).match(/@|password|token|SYNTHETIC/i));
  assert.equal(h.effects.at(-1), "end");
});

test("already equal scopes are idempotent with no writes, new timestamps or audit", async () => {
  const h = harness(); await h.call(); const before = clone(h.db); const count = h.writes.length;
  assert.equal((await h.call()).body.result, "already_scoped"); assert.deepEqual(h.db, before); assert.equal(h.writes.length, count);
});

test("an already-covered addition fills a manager subset with paired CAS and no Fleet scope change", async () => {
  const h = harness(); h.db.fleets[0].serviceZones.push("offline-beta"); const before = clone(h.db);
  assert.equal((await h.call({ ...input, addZoneSlugs: ["offline-beta"] })).body.result, "extended");
  assert.deepEqual(h.db.fleets[0].serviceZones, before.fleets[0].serviceZones);
  assert.deepEqual(h.writes.map((write) => write.name), ["fleets", "employees"]); assertPreserved(before, h.db);
});

test("filling a manager subset still rejects a concurrent Fleet scope change through exact CAS", async () => {
  const h = harness({ race: "fleets:array" }); h.db.fleets[0].serviceZones.push("offline-beta"); const before = clone(h.db);
  assert.deepEqual(await h.call({ ...input, addZoneSlugs: ["offline-beta"] }), { status: 409, body: { error: "FLEET_SCOPE_CAS_FAILED" } });
  assert.deepEqual(h.db, before); assert.equal(h.db.audits.length, 0);
});

test("duplicate stored scopes become unique without removing any legitimate zone", async () => {
  const h = harness(); h.db.fleets[0].serviceZones.push("offline-alpha"); h.db.employees[0].zoneSlugs.push("offline-alpha");
  assert.equal((await h.call()).status, 200); assert.deepEqual(h.db.fleets[0].serviceZones, ["offline-alpha", ...input.addZoneSlugs]); assert.deepEqual(h.db.employees[0].zoneSlugs, h.db.fleets[0].serviceZones);
});

test("equal sets with different ordering are a no-op and preserve both original arrays", async () => {
  const h = harness(); h.db.fleets[0].serviceZones.push(...input.addZoneSlugs); h.db.employees[0].zoneSlugs = [...h.db.fleets[0].serviceZones].reverse();
  const before = clone(h.db); assert.equal((await h.call()).body.result, "already_scoped"); assert.deepEqual(h.db, before);
});

for (const [name, auth, status] of [
  ["unauthenticated", null, 401], ["env token", { role: "admin", isRootOwner: true }, 403], ["tenant admin", { ...rootAuth, isRootOwner: false }, 403],
  ["fake root employee", { ...rootAuth, employeeId: ids.other }, 403], ["Fleet actor", { ...rootAuth, role: "fleet" }, 403], ["temporary Owner password", { ...rootAuth, mustChangePassword: true }, 428],
] as const) test(`real requireOwner and handler deny ${name} before transactions`, async () => {
  const h = harness(); const before = clone(h.db); assert.equal((await h.call(input, auth)).status, status);
  assert(!h.effects.includes("session")); assert.equal(h.reads.length, 0); assert.deepEqual(h.db, before);
});

test("handler independently enforces root, real employee ID and password-change gate", async () => {
  for (const [auth, status] of [[{ role: "admin", isRootOwner: true }, 403], [{ ...rootAuth, employeeId: "bad" }, 403], [{ ...rootAuth, isRootOwner: undefined }, 403], [{ ...rootAuth, role: "fleet" }, 403], [{ ...rootAuth, mustChangePassword: true }, 428]] as const) {
    const h = harness(); assert.equal((await h.call(input, auth, ids.fleet, true)).status, status); assert.equal(h.effects.length, 0);
  }
});

for (const [name, body, id] of [
  ["empty additions", { ...input, addZoneSlugs: [] }, ids.fleet], ["101 additions", { ...input, addZoneSlugs: Array.from({ length: 101 }, (_, i) => `zone-${i}`) }, ids.fleet],
  ["duplicate additions", { ...input, addZoneSlugs: ["offline-beta", "offline-beta"] }, ids.fleet], ["malformed slug", { ...input, addZoneSlugs: ["Bad Slug"] }, ids.fleet],
  ["empty slug", { ...input, addZoneSlugs: [""] }, ids.fleet], ["long slug", { ...input, addZoneSlugs: ["a".repeat(201)] }, ids.fleet],
  ["missing manager", { addZoneSlugs: input.addZoneSlugs }, ids.fleet], ["bad manager ID", { ...input, expectedManagerEmployeeId: "bad" }, ids.fleet],
  ["missing additions", { expectedManagerEmployeeId: ids.manager }, ids.fleet], ["null body", null, ids.fleet], ["malformed Fleet ID", input, "bad"],
] as const) test(`strict request rejects ${name} without transaction IO`, async () => {
  const h = harness(); assert.equal((await h.call(body, rootAuth, id)).status, 400); assert.equal(h.reads.length, 0); assert(!h.effects.includes("session"));
});

test("strict schema rejects every replacement, tenant, account, role and contact field", async () => {
  for (const field of ["tenantId", "fleetId", "serviceZones", "zoneSlugs", "roles", "apiRole", "active", "name", "address", "contactEmail", "contactPhone", "maxRiders", "vehicleTypes", "password", "mustChangePassword", "upsert"]) {
    assert.equal(rootFleetServiceZonesSchema.safeParse({ ...input, [field]: true }).success, false);
    const h = harness(); assert.equal((await h.call({ ...input, [field]: true })).status, 400); assert.equal(h.reads.length, 0);
  }
  assert.equal(rootFleetServiceZonesSchema.safeParse({ ...input, addZoneSlugs: Array.from({ length: 100 }, (_, i) => `zone-${i}`) }).success, true);
});

const invalidCases: Array<[string, (db: any) => void, string, number?]> = [
  ["missing Fleet", (db) => { db.fleets.shift(); }, "FLEET_BINDING_INVALID"], ["inactive Fleet", (db) => { db.fleets[0].isActive = false; }, "FLEET_BINDING_INVALID"],
  ["unexpected manager", (db) => { db.fleets[0].managerEmployeeId = ids.other; }, "FLEET_BINDING_INVALID"], ["Fleet without tenant", (db) => { db.fleets[0].tenantId = null; }, "FLEET_BINDING_INVALID"],
  ["Fleet malformed tenant", (db) => { db.fleets[0].tenantId = "bad"; }, "FLEET_BINDING_INVALID"], ["missing tenant", (db) => { db.tenants = []; }, "TENANT_NOT_ACTIVE", 404],
  ["suspended tenant", (db) => { db.tenants[0].status = "suspended"; }, "TENANT_NOT_ACTIVE", 404],
  ["missing manager", (db) => { db.employees.shift(); }, "MANAGER_BINDING_INVALID"], ["manager other tenant", (db) => { db.employees[0].tenantId = ids.other; }, "MANAGER_BINDING_INVALID"],
  ["manager other primary Fleet", (db) => { db.employees[0].fleetId = ids.other; }, "MANAGER_BINDING_INVALID"], ["inactive manager", (db) => { db.employees[0].active = false; }, "MANAGER_BINDING_INVALID"],
  ["pending manager", (db) => { db.employees[0].authorizationStatus = "pending"; }, "MANAGER_BINDING_INVALID"], ["revoked manager", (db) => { db.employees[0].authorizationStatus = "revoked"; }, "MANAGER_BINDING_INVALID"],
  ["suspended manager", (db) => { db.employees[0].authorizationStatus = "suspended"; }, "MANAGER_BINDING_INVALID"], ["wrong API role", (db) => { db.employees[0].apiRole = "partner"; }, "MANAGER_BINDING_INVALID"],
  ["no Fleet role", (db) => { db.employees[0].roles = ["rider"]; }, "MANAGER_BINDING_INVALID"], ["missing roles", (db) => { delete db.employees[0].roles; }, "MANAGER_BINDING_INVALID"],
  ["admin role included", (db) => { db.employees[0].roles = ["fleet", "admin"]; }, "MANAGER_BINDING_INVALID"], ["protected Owner", (db) => { db.employees[0].ownerProtected = true; }, "MANAGER_BINDING_INVALID"],
  ["superadmin", (db) => { db.employees[0].accessLevel = "superadmin"; }, "MANAGER_BINDING_INVALID"], ["root email normalized", (db) => { db.employees[0].email = ` ${ownerEmail.toUpperCase()} `; }, "MANAGER_BINDING_INVALID"],
  ["employee extra scope requested too", (db) => { db.employees[0].zoneSlugs.push("offline-beta"); }, "INCONSISTENT_SCOPE"],
  ["missing Fleet array", (db) => { delete db.fleets[0].serviceZones; }, "INCONSISTENT_SCOPE"], ["missing employee array", (db) => { delete db.employees[0].zoneSlugs; }, "INCONSISTENT_SCOPE"],
  ["malformed stored slug", (db) => { db.fleets[0].serviceZones.push("Bad Slug"); }, "INCONSISTENT_SCOPE"],
  ["missing existing zone", (db) => { db.zones.shift(); }, "INVALID_FLEET_ZONES", 400], ["existing inactive zone", (db) => { db.zones[0].isActive = false; }, "INVALID_FLEET_ZONES", 400],
  ["missing requested zone", (db) => { db.zones.pop(); }, "INVALID_FLEET_ZONES", 400], ["requested inactive zone", (db) => { db.zones[2].isActive = false; }, "INVALID_FLEET_ZONES", 400],
  ["requested global zone only", (db) => { db.zones[2].tenantId = null; }, "INVALID_FLEET_ZONES", 400], ["requested other-tenant zone only", (db) => { db.zones[2].tenantId = ids.other; }, "INVALID_FLEET_ZONES", 400],
  ["existing global zone only", (db) => { db.zones[0].tenantId = null; }, "INVALID_FLEET_ZONES", 400],
  ["missing vehicle list", (db) => { delete db.fleets[0].vehicleTypes; }, "INVALID_FLEET_VEHICLES"], ["empty vehicle list", (db) => { db.fleets[0].vehicleTypes = []; }, "INVALID_FLEET_VEHICLES"],
  ["invalid vehicle", (db) => { db.fleets[0].vehicleTypes.push("spaceship"); }, "INVALID_FLEET_VEHICLES"], ["null allowed vehicles", (db) => { db.zones[1].allowedVehicleTypes = null; }, "INVALID_FLEET_ZONES", 400],
  ["malformed allowed vehicles", (db) => { db.zones[1].allowedVehicleTypes = ["spaceship"]; }, "INVALID_FLEET_ZONES", 400],
];
for (const [name, change, error, status = 409] of invalidCases) test(`${name} fails closed without changing or legitimizing any scope`, async () => {
  const h = harness(); change(h.db); const before = clone(h.db);
  assert.deepEqual(await h.call(), { status, body: { error } }); assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0); assert.equal(h.effects.at(-1), "end");
});

test("all existing Fleet zones plus requested zones are validated in the same active tenant; no global fallback", async () => {
  const h = harness(); h.db.employees[0].zoneSlugs = []; h.db.zones.push({ ...clone(h.db.zones[1]), tenantId: ids.other }, { ...clone(h.db.zones[1]), tenantId: null });
  const before = clone(h.db); assert.equal((await h.call()).status, 200); assertPreserved(before, h.db);
  const zoneReads = h.reads.filter((read) => read.name === "zones"); assert.deepEqual(zoneReads.map((read) => read.filter.slug), ["offline-alpha", ...input.addZoneSlugs]);
  for (const read of zoneReads) assert.deepEqual(read.filter, { tenantId: ids.tenant, slug: read.filter.slug, isActive: true });
  for (const read of h.reads.filter((item) => item.name === "employees")) assert.deepEqual(read.filter, { _id: ids.manager, tenantId: ids.tenant, fleetId: ids.fleet, active: true, authorizationStatus: "approved" });
});

for (const zoneIndex of [0, 1, 2]) test(`vehicle intersection checks zone ${zoneIndex}, including existing coverage`, async () => {
  const h = harness(); h.db.zones[zoneIndex].allowedVehicleTypes = ["bike"]; const before = clone(h.db);
  assert.deepEqual(await h.call(), { status: 400, body: { error: "INCOMPATIBLE_FLEET_VEHICLES", details: { vehicleTypes: ["motorcycle"], catalogVersion: VEHICLE_CATALOG_VERSION } } });
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});

test("legacy absent restrictions use catalog, but explicit empty restrictions never gain fallback permission", async () => {
  const h = harness(); for (const zone of h.db.zones) delete zone.allowedVehicleTypes;
  assert.equal((await h.call()).status, 200);
  const denied = harness(); denied.db.zones[1].allowedVehicleTypes = []; const before = clone(denied.db);
  assert.deepEqual(await denied.call(), { status: 400, body: { error: "INCOMPATIBLE_FLEET_VEHICLES", details: { vehicleTypes: ["bike", "motorcycle"], catalogVersion: VEHICLE_CATALOG_VERSION } } });
  assert.deepEqual(denied.db, before);
});

for (const vehicle of VEHICLE_TYPES) test(`real vehicle catalog supports compatible ${vehicle} without changing vehicle policy`, async () => {
  const h = harness(); h.db.fleets[0].vehicleTypes = [vehicle]; for (const zone of h.db.zones) zone.allowedVehicleTypes = [vehicle];
  const before = clone(h.db); assert.equal((await h.call()).status, 200); assertPreserved(before, h.db);
});

test("idempotence still validates existing zones, roles and active tenant", async () => {
  for (const [name, change, error, status = 409] of invalidCases.filter(([name]) => /existing inactive|suspended tenant|admin role included/.test(name))) {
    const h = harness(); await h.call(); change(h.db); const before = clone(h.db);
    assert.deepEqual(await h.call(), { status, body: { error } }, name); assert.deepEqual(h.db, before);
  }
});

for (const [failure, error] of [["cas:fleets", "FLEET_SCOPE_CAS_FAILED"], ["cas:employees", "MANAGER_SCOPE_CAS_FAILED"], ["unmodified:fleets", "FLEET_SCOPE_CAS_FAILED"], ["unmodified:employees", "MANAGER_SCOPE_CAS_FAILED"]]) test(`${failure} rolls back the paired scopes and audit`, async () => {
  const h = harness({ fail: failure }); const before = clone(h.db);
  assert.deepEqual(await h.call(), { status: 409, body: { error } }); assert.deepEqual(h.db, before); assert(h.effects.includes("abort")); assert.equal(h.effects.at(-1), "end");
});

for (const race of ["fleets:timestamp", "fleets:array", "employees:timestamp", "employees:array"]) test(`exact CAS blocks ${race} race without overwriting it`, async () => {
  const h = harness({ race }); const before = clone(h.db);
  assert.deepEqual(await h.call(), { status: 409, body: { error: race.startsWith("fleets") ? "FLEET_SCOPE_CAS_FAILED" : "MANAGER_SCOPE_CAS_FAILED" } }); assert.deepEqual(h.db, before);
});

test("CAS filters include both exact original arrays and updatedAt plus immutable binding", async () => {
  const h = harness(); const before = clone(h.db); await h.call();
  const [fleet, employee] = h.writes;
  assert.deepEqual(fleet.filter.serviceZones, before.fleets[0].serviceZones); assert.deepEqual(fleet.filter.updatedAt, time);
  assert.equal(fleet.filter.tenantId, ids.tenant); assert.equal(fleet.filter.managerEmployeeId, ids.manager); assert.deepEqual(fleet.filter.vehicleTypes, before.fleets[0].vehicleTypes);
  assert.deepEqual(employee.filter.zoneSlugs, before.employees[0].zoneSlugs); assert.deepEqual(employee.filter.updatedAt, time);
  assert.equal(employee.filter.fleetId, ids.fleet); assert.equal(employee.filter.tenantId, ids.tenant); assert.deepEqual(employee.filter.roles, ["fleet"]);
});

test("legacy missing updatedAt uses exact field-absence CAS, never unguarded writes", async () => {
  const h = harness(); delete h.db.fleets[0].updatedAt; delete h.db.employees[0].updatedAt;
  assert.equal((await h.call()).status, 200); for (const write of h.writes) assert.deepEqual(write.filter.updatedAt, { $exists: false });
});

test("audit failure aborts both mutations and transaction unavailability has no fallback", async () => {
  for (const [options, message] of [[{ fail: "audit" }, /OFFLINE_AUDIT_FAILURE/], [{ unavailable: true }, /OFFLINE_TRANSACTIONS_UNAVAILABLE/]] as const) {
    const h = harness(options); const before = clone(h.db); await assert.rejects(h.call(), message); assert.deepEqual(h.db, before); assert.equal(h.effects.at(-1), "end");
    if (options.unavailable) assert.equal(h.writes.length, 0);
  }
});

test("transaction retry revalidates every record and commits one scope union and one audit", async () => {
  const h = harness({ retry: true }); assert.equal((await h.call()).status, 200); assert(h.effects.includes("abort:retry"));
  assert.equal(h.reads.filter((read) => read.name === "tenants").length, 2); assert.equal(h.db.audits.length, 1);
});

test("retry cannot reuse a previously approved manager snapshot after role revocation", async () => {
  const h = harness({ retry: true, onRetry(db) { db.employees[0].authorizationStatus = "revoked"; } }); const before = clone(h.db);
  assert.deepEqual(await h.call(), { status: 409, body: { error: "MANAGER_BINDING_INVALID" } });
  before.employees[0].authorizationStatus = "revoked"; assert.deepEqual(h.db, before); assert.equal(h.db.audits.length, 0);
});

test("concurrent identical additions converge to extended plus no-op without duplicate audits", async () => {
  const h = harness(); const results = await Promise.all([h.call(), h.call()]);
  assert.deepEqual(results.map((result) => result.body.result).sort(), ["already_scoped", "extended"]); assert.equal(h.db.audits.length, 1); assert(h.effects.includes("abort:retry"));
});

test("concurrent different additions preserve the full unique union and the manager primary Fleet", async () => {
  const h = harness(); const before = clone(h.db);
  const results = await Promise.all([h.call({ ...input, addZoneSlugs: ["offline-beta"] }), h.call({ ...input, addZoneSlugs: ["offline-gamma"] })]);
  assert(results.every((result) => result.status === 200)); assert.deepEqual([...h.db.fleets[0].serviceZones].sort(), ["offline-alpha", "offline-beta", "offline-gamma"]);
  assert.deepEqual(h.db.fleets[0].serviceZones, h.db.employees[0].zoneSlugs); assert.equal(h.db.audits.length, 2); assertPreserved(before, h.db);
});

test("SOURCE regression: actual server imports and mounts only native transaction adapters behind requireOwner", async () => {
  const imports = serverSource.statements.filter((item) => ts.isImportDeclaration(item) && ts.isStringLiteral(item.moduleSpecifier) && item.moduleSpecifier.text === "./rootFleetServiceZones.js"); assert.equal(imports.length, 1);
  const mounts = serverSource.statements.filter((item) => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.getText(serverSource) === "registerRootFleetServiceZonesRoutes") as ts.ExpressionStatement[];
  assert.equal(mounts.length, 1);
  const object = (mounts[0].expression as ts.CallExpression).arguments[1] as ts.ObjectLiteralExpression;
  assert.deepEqual(object.properties.map((property) => property.name!.getText(serverSource)), ["requireOwner", "ownerEmail", "objectId", "tenants", "employees", "fleets", "zones", "startSession", "createAudit"]);
  let mounted: any; const requireOwner = () => undefined;
  compile(`${mounts[0].getText(serverSource)}; const subject = null;`, { app: {}, requireOwner, ownerEmail, objectId: (id: string) => id,
    Tenant: { collection: "tenants" }, EmployeeAccount: { collection: "employees" }, Fleet: { collection: "fleets" }, Zone: { collection: "zones" },
    mongoose: { startSession: async () => "offline-session" }, GovernanceAuditEvent: { create: async (rows: any, opts: any) => ({ rows, opts }) },
    registerRootFleetServiceZonesRoutes: (_app: any, deps: any) => { mounted = deps; },
  });
  assert.equal(mounted.requireOwner, requireOwner); assert.equal(mounted.ownerEmail, ownerEmail); assert.equal(mounted.objectId(ids.fleet), ids.fleet);
  for (const name of ["tenants", "employees", "fleets", "zones"]) assert.equal(mounted[name], name);
  assert.equal(await mounted.startSession(), "offline-session"); assert.deepEqual(await mounted.createAudit({ action: "offline" }, "offline-session"), { rows: [{ action: "offline" }], opts: { session: "offline-session" } });
  const directRoutes = serverSource.statements.filter((item) => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.getText(serverSource) === "app.patch" && ts.isStringLiteral(item.expression.arguments[0]) && item.expression.arguments[0].text === "/api/v1/admin/fleets/:id/service-zones"); assert.equal(directRoutes.length, 0, "No alternate weaker registration");
  const original = serverSource.statements.find((item) => ts.isExpressionStatement(item) && ts.isCallExpression(item.expression) && item.expression.expression.getText(serverSource) === "app.post" && ts.isStringLiteral(item.expression.arguments[0]) && item.expression.arguments[0].text === "/api/v1/fleets") as ts.ExpressionStatement;
  assert(original); assert((original.expression as ts.CallExpression).arguments[1].getText(serverSource).includes('requireRole("admin", "fleet")'));
  assert(!original.getText(serverSource).includes("addZoneSlugs"), "Creation is not repurposed as an extension");
  const moduleSource = ts.createSourceFile("rootFleetServiceZones.ts", readFileSync(new URL("./rootFleetServiceZones.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  assert.deepEqual(moduleSource.statements.filter(ts.isImportDeclaration).map((node) => (node.moduleSpecifier as ts.StringLiteral).text), ["express", "zod", "./tenantScope.js", "./vehicleCatalog.js"]);
});
