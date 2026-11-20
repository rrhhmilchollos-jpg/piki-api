import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { GovernanceAuditEvent } from "./models.js";
import { registerXativaOperationsRoutes, xativaAssignmentSchema, XATIVA_ASSIGNMENT_CONFIRMATION, XATIVA_CANONICAL_ZONE, type XativaOperationsDependencies } from "./xativaOperationsRoutes.js";

// Offline synthetic IDs and contacts only. No dotenv, server import or DB calls.
const id = (n: number) => n.toString(16).padStart(24, "0");
const ids = { tenant: id(1), otherTenant: id(2), actor: id(3), root: id(4), manager: id(5), fleet: id(6), source: id(7), foreign: id(8) };
const time = new Date("2026-10-01T12:00:00Z");
const now = new Date("2026-11-20T12:00:00Z");
const rootEmail = "root@example.test";
const admin = { role: "admin", employeeId: ids.actor, tenantId: ids.tenant, isRootOwner: false };
const root = { role: "admin", employeeId: ids.root, tenantId: ids.otherTenant, isRootOwner: true };
const names = ["Jackson Andres", "Ivan Rubio", "Orelbys Cabrera", "Jonathan Rincon"];
const codes = ["PIKI-R-785531", "PIKI-R-894110", "PIKI-R-OFFLINE-3", "PIKI-R-OFFLINE-4"];
const clone = <T>(value: T): T => structuredClone(value);
function equal(a: any, b: any): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a && b && typeof a === "object" && typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}
function match(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (key === "$or") return expected.some((item: any) => match(row, item));
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !Array.isArray(expected)) {
      if ("$exists" in expected && (actual !== undefined) !== expected.$exists) return false;
      if ("$eq" in expected && !equal(actual, expected.$eq)) return false;
      if ("$in" in expected && !expected.$in.some((item: any) => equal(actual, item))) return false;
      if ("$nin" in expected && expected.$nin.some((item: any) => equal(actual, item))) return false;
      if ("$ne" in expected && equal(actual, expected.$ne)) return false;
      if ("$gt" in expected && !(actual > expected.$gt)) return false;
      return true;
    }
    return equal(actual, expected) || expected === null && actual === undefined;
  });
}
const project = (row: any, projection: any) => row ? Object.fromEntries(Object.entries(row).filter(([key]) => projection[key] === 1)) : null;
function compile(code: string, context: Record<string, any>) {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${js}; return subject;`)(...Object.values(context));
}
const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const requireRoleNode = authSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "requireRole");
assert(requireRoleNode);
function harness(options: { coordinator?: boolean; acquireFails?: boolean; failure?: string; race?: string; unavailable?: boolean; retry?: boolean; onRetry?: (db: any) => void; injectCrossTenant?: string } = {}) {
  const employee = (employeeId: string, name: string, role: string, fleetId: string | null) => ({ _id: employeeId, tenantId: ids.tenant, name, apiRole: role, roles: [role], jobRole: role, active: true, authorizationStatus: "approved", accessLevel: "subadmin", ownerProtected: false, mustChangePassword: false, fleetId, zoneSlugs: ["xativa-centro"], updatedAt: time, __v: 3, email: `${employeeId}@example.test`, passwordHash: "SYNTHETIC_PASSWORD", sessionHash: "SYNTHETIC_SESSION", contract: "DO_NOT_TOUCH" });
  let db: any = {
    tenants: [{ _id: ids.tenant, status: "active", updatedAt: time, __v: 1 }],
    employees: [employee(ids.actor, "Offline Administrator", "admin", null), { ...employee(ids.root, "Offline Owner", "admin", null), tenantId: ids.otherTenant, ownerProtected: true, accessLevel: "superadmin", email: rootEmail }, employee(ids.manager, "María   Deseada Solas Sanchis", "fleet", ids.fleet), ...names.map((name, index) => employee(id(30 + index), name, "rider", ids.source))],
    fleets: [{ _id: ids.fleet, tenantId: ids.tenant, name: "Offline destination", managerEmployeeId: ids.manager, isActive: true, serviceZones: ["xativa-centro"], vehicleTypes: ["bike", "motorcycle"], maxRiders: 4, updatedAt: time, __v: 2, contactEmail: "secret@example.test", contactPhone: "SYNTHETIC_PHONE", managerDni: "SYNTHETIC_DNI" }, { _id: ids.source, tenantId: ids.tenant, name: "Offline source", isActive: true, serviceZones: ["xativa-centro"], vehicleTypes: ["bike"], maxRiders: 50, updatedAt: time, __v: 2 }],
    riders: names.map((name, index) => ({ _id: id(20 + index), tenantId: ids.tenant, name, riderCode: codes[index], email: `${id(30 + index)}@example.test`, fleetId: ids.source, zoneSlug: "xativa-centro", vehicle: "bike", status: "offline", lifecycleStatus: "active", isTestRider: false, activeOrderId: null, locationPrivacyExpiresAt: null, lastLocationAt: null, updatedAt: time, __v: 5, contractWeeklyHours: 40, hourlyPayEnabled: true, geofence: { untouched: true }, location: { coordinates: [0, 0] }, phone: "SYNTHETIC_PHONE" })),
    zones: [{ _id: id(50), tenantId: ids.tenant, name: "Offline center", slug: "xativa-centro", isActive: true, allowedVehicleTypes: ["bike", "motorcycle"], serviceFeeCents: 127, polygon: { untouched: true }, updatedAt: time, __v: 1 }],
    slots: [], orders: [], reservations: [], tracking: [], employeeSessions: [], audits: [],
    payments: [{ tenantId: ids.tenant, zoneSlug: "xativa-centro", guarantee: 700 }], contracts: [{ riderId: id(20), unchanged: true }], gps: [{ orderId: "OFFLINE", unchanged: true }],
  };
  const reads: any[] = []; const writes: any[] = []; const effects: string[] = []; const acquisitions: any[] = [];
  let version = 0; let retry = options.retry;
  function checkRead(name: string, filter: any, opts: any) {
    assert(opts.session?.state, "All reads use the snapshot transaction");
    assert(opts.projection, "Explicit allowlisted projection required");
    assert(!Object.keys(opts.projection).some((key) => /passwordHash|sessionHash|token|phone|contact|dni|location$|polygon|contentBase64/i.test(key)), "No secret/contact/GPS projections");
    if (opts.projection.email) assert.equal(name, "riders", "Email is internal only for the selected Rider binding");
    if (name === "tenants") assert.equal(filter._id, ids.tenant);
    else assert(Object.hasOwn(filter, "tenantId"), `${name} requires an explicit tenant predicate`);
    reads.push({ name, filter: clone(filter), projection: clone(opts.projection) });
  }
  const collection = (name: string) => ({
    async findOne(filter: any, opts: any) {
      checkRead(name, filter, opts);
      return clone(project(opts.session.state[name].find((row: any) => match(row, filter)), opts.projection));
    },
    find(filter: any, opts: any) {
      checkRead(name, filter, opts); let limit = Infinity; let sorted = false;
      const cursor: any = {
        sort(order: any) { assert.deepEqual(order, { _id: 1 }); sorted = true; return cursor; },
        limit(count: number) { assert(count <= 1001 && count >= 3); limit = count; return cursor; },
        async toArray() {
          assert(sorted && Number.isFinite(limit));
          const rows = opts.session.state[name].filter((row: any) => match(row, filter));
          if (options.injectCrossTenant === name && rows.length) rows.push({ ...clone(rows[0]), tenantId: ids.otherTenant });
          return clone(rows.sort((a: any, b: any) => String(a._id).localeCompare(String(b._id))).slice(0, limit).map((row: any) => project(row, opts.projection)));
        },
      }; return cursor;
    },
    async updateOne(filter: any, update: any, opts: any) {
      assert(opts.session?.state); assert.equal(opts.upsert, false);
      assert(["riders", "employees"].includes(name));
      assert.deepEqual(Object.keys(update), ["$set"]); assert.deepEqual(Object.keys(update.$set), ["fleetId"]);
      assert.equal(update.$set.fleetId, ids.fleet); assert.equal(filter.tenantId, ids.tenant); assert(filter._id); assert(filter.updatedAt instanceof Date);
      writes.push({ name, filter: clone(filter), update: clone(update) }); effects.push(`write:${name}`);
      if (options.failure === `cas:${name}`) return { matchedCount: 0, modifiedCount: 0 };
      if (options.failure === `unmodified:${name}`) return { matchedCount: 1, modifiedCount: 0 };
      const rows = opts.session.state[name];
      if (options.failure === `fourth:${name}` && writes.filter((row) => row.name === name).length === 4) return { matchedCount: 0, modifiedCount: 0 };
      if (options.race === `${name}:timestamp`) rows.find((row: any) => row._id === filter._id).updatedAt = now;
      if (options.race === `${name}:scope`) rows.find((row: any) => row._id === filter._id)[name === "riders" ? "zoneSlug" : "zoneSlugs"] = name === "riders" ? "other-zone" : ["other-zone"];
      const row = rows.find((row: any) => match(row, filter));
      if (!row) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, clone(update.$set)); return { matchedCount: 1, modifiedCount: 1 };
    },
  });
  const deps: XativaOperationsDependencies = {
    requireRole: compile(`${requireRoleNode!.getText(authSource).replace("export function", "function")}; const subject = requireRole;`, {
      resolveRole: async (req: any) => req.auth,
      isTemporaryPasswordAllowedPath: () => false,
    }),
    ownerEmail: rootEmail, objectId: (value) => value,
    tenants: collection("tenants"), employees: collection("employees"), fleets: collection("fleets"), riders: collection("riders"), zones: collection("zones"), slots: collection("slots"), orders: collection("orders"), reservations: collection("reservations"), tracking: collection("tracking"), employeeSessions: collection("employeeSessions"),
    transferCoordinator: options.coordinator === false ? null : { revision: "OFFLINE_COORDINATED_WRITERS_V1", async acquire(input: any) { assert(input.session.state); acquisitions.push({ ...input, session: undefined }); effects.push("coordinate"); return !options.acquireFails; } },
    now: () => now,
    startSession: async () => {
      effects.push("session");
      const session: any = { state: null,
        async withTransaction(callback: () => Promise<void>, opts: any) {
          assert.deepEqual(opts, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
          if (options.unavailable) throw new Error("OFFLINE_TRANSACTIONS_UNAVAILABLE");
          for (let attempt = 0; attempt < 8; attempt++) {
            const oldVersion = version; session.state = clone(db); effects.push("begin");
            try {
              await callback(); await new Promise<void>((resolve) => setImmediate(resolve));
              if (retry || oldVersion !== version) { retry = false; effects.push("retry"); options.onRetry?.(db); continue; }
              db = session.state; version++; effects.push("commit"); return;
            } catch (error) { effects.push("abort"); throw error; }
          }
          throw new Error("OFFLINE_RETRIES_EXHAUSTED");
        },
        async endSession() { effects.push("end"); },
      }; return session;
    },
    createAudit: async (row, session: any) => {
      assert(session.state); effects.push("audit");
      if (options.failure === "audit") throw new Error("OFFLINE_AUDIT_FAILURE");
      assert.equal(new GovernanceAuditEvent(row).validateSync(), undefined);
      session.state.audits.push(clone(row));
    },
  };
  const handlers: Record<string, any[]> = {};
  const app = { get(path: string, ...args: any[]) { handlers[`get:${path}`] = args; }, post(path: string, ...args: any[]) { handlers[`post:${path}`] = args; } };
  registerXativaOperationsRoutes(app as any, deps);
  async function call(method: "get" | "post", payload: any, auth: any = admin, bypass = false) {
    const path = `/api/v1/admin/xativa-operations/${method === "get" ? "preview" : "assign-riders"}`;
    let status = 200; let body: any; let allowed = bypass;
    const headers: Record<string, string> = {};
    const res: any = { status(value: number) { status = value; return this; }, json(value: any) { body = value; return this; }, setHeader(key: string, value: string) { headers[key] = value; } };
    const req: any = { path, auth, body: method === "post" ? payload : undefined, query: method === "get" ? payload : undefined };
    const [guard, route] = handlers[`${method}:${path}`];
    if (!bypass) await guard(req, res, () => { allowed = true; });
    if (allowed) await route(req, res);
    return { status, body, headers };
  }
  const preview = (query: any = { tenantId: ids.tenant }, auth: any = admin, bypass = false) => call("get", query, auth, bypass);
  const assign = (manifestHash: string, auth: any = admin, extra: any = {}) => call("post", { tenantId: ids.tenant, manifestHash, confirmation: XATIVA_ASSIGNMENT_CONFIRMATION, ...extra }, auth);
  const forceRetry = (onRetry: (state: any) => void) => { retry = true; options.onRetry = onRetry; };
  return { deps, preview, assign, call, reads, writes, effects, acquisitions, forceRetry, get db() { return db; } };
}
function assertPreserved(before: any, after: any) {
  for (const key of Object.keys(before).filter((key) => !["riders", "employees", "audits"].includes(key))) assert.deepEqual(after[key], before[key], `${key} preserved`);
  assert.equal(after.riders.length, before.riders.length); assert.equal(after.employees.length, before.employees.length);
  for (const collection of ["riders", "employees"]) for (let index = 0; index < before[collection].length; index++) {
    assert.deepEqual({ ...after[collection][index], fleetId: before[collection][index].fleetId }, before[collection][index], "Only fleetId may change");
  }
}
function hasBlocker(result: any, code: string) { assert(result.body.blockers.some((row: any) => row.code === code), `${code}: ${JSON.stringify(result.body)}`); }

test("preview uses exact tenant, minimal public fields, stable before-image and no writes", async () => {
  const h = harness(); const before = clone(h.db); const result = await h.preview();
  assert.equal(result.status, 200); assert.equal(result.headers["Cache-Control"], "no-store"); assert.equal(result.body.assignmentReady, true);
  assert.equal(result.body.consolidationReady, false); assert.deepEqual(result.body.canonical, XATIVA_CANONICAL_ZONE);
  assert.equal(result.body.manager.id, ids.manager); assert.equal(result.body.fleet.id, ids.fleet); assert.equal(result.body.riders.length, 4);
  assert.deepEqual(Object.keys(result.body.riders[0]).sort(), ["id", "name", "riderCode", "fleetId", "zoneSlug", "vehicle"].sort());
  assert.deepEqual(result.body.destination.vehicleTypes, ["bike", "motorcycle"]); assert.equal(result.body.destination.maxRiders, 4);
  assert.equal(result.body.expectedAssignments[0].updatedAt, time.toISOString()); assert.equal(result.body.expectedAssignments[0].revision, 5);
  assert.match(result.body.manifestHash, /^[a-f0-9]{64}$/); assert.equal((await h.preview()).body.manifestHash, result.body.manifestHash);
  assert(!JSON.stringify(result.body).match(/@|email|phone|password|sessionHash|tokenHash|SYNTHETIC|coordinates|employeeCode/i));
  assert(!JSON.stringify(result.body).includes(id(30)), "Rider employee binding IDs are private");
  hasBlocker(result, "ZONE_CONSOLIDATION_REQUIRES_REFERENCE_MIGRATION"); assert.match(result.body.blockers.at(-1).message, /xativa-centro.*monetary.*historical.*static/i);
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
  for (const read of h.reads) if (read.name !== "tenants") assert.equal(read.filter.tenantId, ids.tenant);
  for (const read of h.reads.filter((row) => row.projection.email)) { assert(read.filter._id); assert.deepEqual(Object.keys(read.projection).sort(), ["_id", "tenantId", "email"].sort()); }
});

test("coordinated assignment updates exactly four Rider IDs and their four accounts atomically, no other data", async () => {
  const h = harness(); h.db.slots.push({ _id: id(60), tenantId: ids.tenant, riderId: id(20), zoneSlug: "xativa-centro", status: "completed", startedAt: time, stoppedAt: time, assignmentRevision: 8 });
  const before = clone(h.db); const preview = await h.preview(); const result = await h.assign(preview.body.manifestHash);
  assert.equal(result.status, 200); assert.deepEqual(result.body, { assigned: true, tenantId: ids.tenant, fleetId: ids.fleet, managerEmployeeId: ids.manager, riderIds: [20, 21, 22, 23].map(id) });
  assertPreserved(before, h.db); assert.equal(h.db.audits.length, 1); assert.equal(h.writes.length, 8);
  assert.deepEqual(h.writes.filter((row) => row.name === "riders").map((row) => row.filter._id), [20, 21, 22, 23].map(id));
  assert.deepEqual(h.writes.filter((row) => row.name === "employees").map((row) => row.filter._id), [30, 31, 32, 33].map(id));
  for (const write of h.writes) { assert.equal(write.filter.fleetId, ids.source); assert.equal(write.filter.updatedAt.getTime(), time.getTime()); assert.equal(write.filter.__v, write.name === "riders" ? 5 : 3); }
  assert.equal(h.acquisitions.length, 1); assert.deepEqual(h.acquisitions[0].riderIds, [20, 21, 22, 23].map(id));
  assert(!JSON.stringify(h.db.audits).match(/@|SYNTHETIC|password|phone|coordinates/i));
  assert.equal(h.db.audits[0].before.assignments.length, 4); assert(h.db.audits[0].after.assignments.every((row: any) => row.fleetId === ids.fleet));
});

test("fresh already-assigned manifest is an idempotent no-op; pre-assignment hash remains stale", async () => {
  const h = harness(); const initial = await h.preview(); await h.assign(initial.body.manifestHash);
  const before = clone(h.db); const writes = h.writes.length; const fresh = await h.preview();
  assert.equal(fresh.body.destination.currentRiders, 4); assert.equal(fresh.body.destination.incomingRiders, 0);
  assert.equal((await h.assign(initial.body.manifestHash)).body.error, "STALE_MANIFEST");
  assert.equal((await h.assign(fresh.body.manifestHash)).body.assigned, true); assert.deepEqual(h.db, before); assert.equal(h.writes.length, writes); assert.equal(h.db.audits.length, 1);
});

test("production-equivalent missing coordinator reports gaps and denies all mutation", async () => {
  const h = harness({ coordinator: false }); const before = clone(h.db); const preview = await h.preview();
  assert.equal(preview.status, 200); assert.equal(preview.body.assignmentReady, false); assert.equal(preview.body.activity.guaranteesAvailable, false);
  hasBlocker(preview, "ACTIVE_WORK_GUARD_UNAVAILABLE"); assert.match(preview.body.blockers.find((row: any) => row.code === "ACTIVE_WORK_GUARD_UNAVAILABLE").message, /legacy rider_locations.*LocationSample.*tenant/i);
  const result = await h.assign(preview.body.manifestHash); assert.equal(result.status, 409); assert.equal(result.body.error, "XATIVA_ASSIGNMENT_BLOCKED"); hasBlocker(result, "ACTIVE_WORK_GUARD_UNAVAILABLE"); assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});

test("already-assigned production no-op needs fresh exact identities but no transfer coordinator or writes", async () => {
  const h = harness({ coordinator: false });
  for (const rider of h.db.riders) rider.fleetId = ids.fleet;
  for (const employee of h.db.employees.slice(3)) employee.fleetId = ids.fleet;
  const before = clone(h.db); const preview = await h.preview();
  assert.equal((await h.assign(preview.body.manifestHash)).body.assigned, true);
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0); assert.equal(h.db.audits.length, 0);
});

for (const [label, auth, status] of [
  ["anonymous", null, 401], ["Fleet", { ...admin, role: "fleet" }, 403], ["Rider", { ...admin, role: "rider" }, 403],
  ["emergency admin token", { role: "admin", isRootOwner: true }, 403], ["wrong tenant admin", { ...admin, tenantId: ids.otherTenant }, 403],
  ["missing tenant admin", { ...admin, tenantId: undefined }, 403], ["temporary password", { ...admin, mustChangePassword: true }, 428],
] as const) test(`${label} cannot preview or assign before transaction IO`, async () => {
  const h = harness(); const before = clone(h.db);
  assert.equal((await h.preview({ tenantId: ids.tenant }, auth)).status, status); assert.equal((await h.assign("a".repeat(64), auth)).status, status);
  assert(!h.effects.includes("session")); assert.equal(h.reads.length, 0); assert.deepEqual(h.db, before);
});

test("handler independently denies non-admin/unpersisted auth even if middleware is bypassed", async () => {
  for (const auth of [null, { ...admin, role: "fleet" }, { role: "admin", isRootOwner: true }, { ...admin, employeeId: "bad" }, { ...admin, tenantId: ids.otherTenant }]) {
    const h = harness(); assert([401, 403].includes((await h.preview({ tenantId: ids.tenant }, auth, true)).status)); assert.equal(h.reads.length, 0);
  }
});

for (const query of [{}, { tenantId: "" }, { tenantId: "bad" }, { tenantId: [ids.tenant] }, { tenantId: { $ne: null } }, { tenantId: ids.tenant, global: true }]) test(`invalid explicit preview tenant fails with no global fallback: ${JSON.stringify(query)}`, async () => {
  const h = harness(); assert.equal((await h.preview(query, root)).status, 400); assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
});

test("persisted root can target explicit foreign tenant but actor verification stays in exact home tenant", async () => {
  const h = harness(); const preview = await h.preview({ tenantId: ids.tenant }, root); assert.equal(preview.body.assignmentReady, true);
  const result = await h.assign(preview.body.manifestHash, root); assert.equal(result.status, 200);
  for (const read of h.reads) if (read.name !== "tenants") assert.equal(read.filter.tenantId, read.filter._id === ids.root ? ids.otherTenant : ids.tenant);
  const actorReads = h.reads.filter((row) => row.filter._id === ids.root); assert(actorReads.every((row) => row.filter.email === rootEmail && row.filter.ownerProtected === true));
});

test("protected root with explicit null home tenant is ID-bound, not a root global fallback", async () => {
  const h = harness(); h.db.employees[1].tenantId = null;
  const result = await h.preview({ tenantId: ids.tenant }, { ...root, tenantId: undefined }); assert.equal(result.status, 200);
  const actorRead = h.reads.find((row) => row.filter._id === ids.root); assert.equal(actorRead.filter.tenantId, null); assert(actorRead.filter._id);
  assert(h.reads.filter((row) => row.filter._id !== ids.root && row.name !== "tenants").every((row) => row.filter.tenantId === ids.tenant));
});

for (const [label, change, status] of [
  ["missing actor", (db: any) => { db.employees.shift(); }, 403], ["actor suspended", (db: any) => { db.employees[0].active = false; }, 403],
  ["actor admin role removed", (db: any) => { db.employees[0].roles = ["fleet"]; }, 403], ["actor approval revoked", (db: any) => { db.employees[0].authorizationStatus = "revoked"; }, 403],
  ["persisted actor must change password", (db: any) => { db.employees[0].mustChangePassword = true; }, 428],
  ["actor moved tenant", (db: any) => { db.employees[0].tenantId = ids.otherTenant; }, 403], ["inactive tenant", (db: any) => { db.tenants[0].status = "suspended"; }, 404],
  ["missing tenant", (db: any) => { db.tenants = []; }, 404],
] as const) test(`${label} fails persisted authorization`, async () => {
  const h = harness(); change(h.db); const before = clone(h.db); assert.equal((await h.preview()).status, status); assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});

test("claimed root status does not upgrade an ordinary persisted admin", async () => {
  const h = harness(); assert.equal((await h.preview({ tenantId: ids.tenant }, { ...admin, isRootOwner: true })).status, 403); assert.equal(h.writes.length, 0);
});

const blockedCases: Array<[string, (db: any) => void, string]> = [
  ["missing manager", (db) => { db.employees.splice(2, 1); }, "MANAGER_MISSING_OR_AMBIGUOUS"],
  ["manager fuzzy name", (db) => { db.employees[2].name += " extra"; }, "MANAGER_MISSING_OR_AMBIGUOUS"],
  ["duplicate normalized manager", (db) => { db.employees.push({ ...clone(db.employees[2]), _id: id(90), name: "MARIA DESEADA SOLAS SANCHIS" }); }, "MANAGER_MISSING_OR_AMBIGUOUS"],
  ["manager cross tenant", (db) => { db.employees[2].tenantId = ids.otherTenant; }, "MANAGER_MISSING_OR_AMBIGUOUS"],
  ["manager inactive", (db) => { db.employees[2].active = false; }, "MANAGER_BINDING_INVALID"],
  ["manager not approved", (db) => { db.employees[2].authorizationStatus = "pending"; }, "MANAGER_BINDING_INVALID"],
  ["manager wrong role", (db) => { db.employees[2].apiRole = "admin"; }, "MANAGER_BINDING_INVALID"],
  ["manager admin role", (db) => { db.employees[2].roles.push("admin"); }, "MANAGER_BINDING_INVALID"],
  ["manager protected", (db) => { db.employees[2].ownerProtected = true; }, "MANAGER_BINDING_INVALID"],
  ["nonreciprocal manager", (db) => { db.fleets[0].managerEmployeeId = ids.actor; }, "MANAGER_FLEET_NOT_RECIPROCAL"],
  ["inactive destination", (db) => { db.fleets[0].isActive = false; }, "MANAGER_FLEET_NOT_RECIPROCAL"],
  ["cross tenant destination", (db) => { db.fleets[0].tenantId = ids.otherTenant; }, "MANAGER_FLEET_NOT_RECIPROCAL"],
  ["missing rider", (db) => { db.riders.shift(); }, "RIDER_MISSING_OR_AMBIGUOUS"],
  ["rider cross tenant", (db) => { db.riders[2].tenantId = ids.otherTenant; }, "RIDER_MISSING_OR_AMBIGUOUS"],
  ["Jackson code changed", (db) => { db.riders[0].riderCode = "WRONG"; }, "RIDER_MISSING_OR_AMBIGUOUS"],
  ["Ivan name mismatches code", (db) => { db.riders[1].name = "Someone Else"; }, "RIDER_MISSING_OR_AMBIGUOUS"],
  ["unknown rider fuzzy token", (db) => { db.riders[2].name = "Orelbys Cabreraz"; }, "RIDER_MISSING_OR_AMBIGUOUS"],
  ["ambiguous unknown rider", (db) => { db.riders.push({ ...clone(db.riders[3]), _id: id(90), name: "Jonnathan Rincón" }); }, "RIDER_MISSING_OR_AMBIGUOUS"],
  ["ambiguous known rider name", (db) => { db.riders.push({ ...clone(db.riders[0]), _id: id(90), riderCode: "DIFFERENT" }); }, "RIDER_MISSING_OR_AMBIGUOUS"],
  ["inactive rider", (db) => { db.riders[0].lifecycleStatus = "suspended"; }, "RIDER_NOT_ACTIVE"],
  ["test rider", (db) => { db.riders[0].isTestRider = true; }, "RIDER_NOT_ACTIVE"],
  ["missing timestamp", (db) => { delete db.riders[0].updatedAt; }, "RIDER_REVISION_MISSING"],
  ["source cross tenant", (db) => { db.fleets[1].tenantId = ids.otherTenant; }, "SOURCE_FLEET_INVALID"],
  ["source inactive", (db) => { db.fleets[1].isActive = false; }, "SOURCE_FLEET_INVALID"],
  ["missing rider account", (db) => { db.employees.splice(3, 1); }, "RIDER_EMPLOYEE_BINDING_INVALID"],
  ["cross tenant rider account", (db) => { db.employees[3].tenantId = ids.otherTenant; }, "RIDER_EMPLOYEE_BINDING_INVALID"],
  ["duplicate rider binding", (db) => { db.employees.push({ ...clone(db.employees[3]), _id: id(90) }); }, "RIDER_EMPLOYEE_BINDING_INVALID"],
  ["different bound Fleet", (db) => { db.employees[3].fleetId = ids.fleet; }, "RIDER_EMPLOYEE_BINDING_INVALID"],
  ["unsafe email casing", (db) => { db.riders[0].email = db.riders[0].email.toUpperCase(); }, "RIDER_EMPLOYEE_BINDING_INVALID"],
  ["pending Rider account", (db) => { db.employees[3].authorizationStatus = "pending"; }, "RIDER_EMPLOYEE_BINDING_INVALID"],
  ["Rider account additional role", (db) => { db.employees[3].roles.push("fleet"); }, "RIDER_EMPLOYEE_BINDING_INVALID"],
  ["capacity too small", (db) => { db.fleets[0].maxRiders = 3; }, "DESTINATION_CAPACITY_CONFLICT"],
  ["vehicle mismatch", (db) => { db.fleets[0].vehicleTypes = ["car"]; }, "DESTINATION_VEHICLE_CONFLICT"],
  ["malformed destination vehicles", (db) => { db.fleets[0].vehicleTypes = ["spaceship"]; }, "DESTINATION_VEHICLE_CONFLICT"],
  ["zone vehicle restriction", (db) => { db.zones[0].allowedVehicleTypes = []; }, "ZONE_VEHICLE_CONFLICT"],
  ["explicit malformed zone restriction", (db) => { db.zones[0].allowedVehicleTypes = null; }, "ZONE_VEHICLE_CONFLICT"],
  ["missing existing zone", (db) => { db.zones = []; }, "EXISTING_ZONE_SCOPE_CONFLICT"],
  ["cross tenant existing zone", (db) => { db.zones[0].tenantId = ids.otherTenant; }, "EXISTING_ZONE_SCOPE_CONFLICT"],
  ["inactive existing zone", (db) => { db.zones[0].isActive = false; }, "EXISTING_ZONE_SCOPE_CONFLICT"],
  ["destination scope missing", (db) => { db.fleets[0].serviceZones = []; }, "EXISTING_ZONE_SCOPE_CONFLICT"],
  ["manager scope missing", (db) => { db.employees[2].zoneSlugs = []; }, "EXISTING_ZONE_SCOPE_CONFLICT"],
  ["manager extra scope", (db) => { db.employees[2].zoneSlugs.push("other-zone"); }, "DESTINATION_SCOPE_INVALID"],
];
for (const [label, change, code] of blockedCases) test(`${label}: blocked preview cannot be applied`, async () => {
  const h = harness(); change(h.db); const before = clone(h.db); const preview = await h.preview();
  assert.equal(preview.status, 200); assert.equal(preview.body.assignmentReady, false); hasBlocker(preview, code);
  const result = await h.assign(preview.body.manifestHash); assert.equal(result.status, 409); assert.equal(result.body.error, "XATIVA_ASSIGNMENT_BLOCKED"); hasBlocker(result, code);
  assert.deepEqual(h.db, before); assert.equal(h.writes.length, 0);
});

for (const first of ["Orelbis", "Orelbys"]) for (const lastFirst of ["Jonnathan", "Jonathan"]) test(`exact authorized spelling variants ${first}/${lastFirst} normalize accents safely`, async () => {
  const h = harness(); h.db.riders[2].name = `${first} Cabrera`; h.db.riders[3].name = `${lastFirst} Rincón`;
  assert.equal((await h.preview()).body.assignmentReady, true);
});

test("cross-tenant names and codes do not create ambiguity or leak through the response", async () => {
  const h = harness();
  h.db.riders.push(...clone(h.db.riders).map((row: any, index: number) => ({ ...row, _id: id(100 + index), tenantId: ids.otherTenant })));
  h.db.employees.push({ ...clone(h.db.employees[2]), _id: id(109), tenantId: ids.otherTenant });
  const result = await h.preview(); assert.equal(result.body.assignmentReady, true); assert.equal(result.body.riders.length, 4);
  assert(!JSON.stringify(result.body).includes(id(100))); assert(!JSON.stringify(result.body).includes(ids.otherTenant));
});

for (const collection of ["riders", "employees", "zones"]) test(`untrusted collection returning cross-tenant ${collection} rows fails closed`, async () => {
  const h = harness({ injectCrossTenant: collection }); const preview = await h.preview(); assert.equal(preview.body.assignmentReady, false); hasBlocker(preview, "INVALID_TENANT_ROWS");
  assert.equal((await h.assign(preview.body.manifestHash)).status, 409); assert.equal(h.writes.length, 0);
});

for (const collection of ["riders", "employees", "zones", "slots"]) test(`bounded ${collection} truncation is an explicit blocker`, async () => {
  const h = harness(); const count = collection === "zones" ? 251 : 1001;
  const sample = collection === "slots" ? { tenantId: ids.tenant, riderId: id(20), status: "completed" } : h.db[collection][0];
  h.db[collection].push(...Array.from({ length: count }, (_, index) => ({ ...clone(sample), _id: id(2000 + index), name: "Other offline", riderCode: `OFFLINE-${index}`, slug: `offline-${index}` })));
  const result = await h.preview(); assert.equal(result.body.assignmentReady, false); hasBlocker(result, "BOUNDED_LIST_TRUNCATED");
  assert.equal((await h.assign(result.body.manifestHash)).status, 409); assert.equal(h.writes.length, 0);
});

const activeCases: Array<[string, (db: any) => void, string]> = [
  ["busy", (db) => { db.riders[0].status = "busy"; }, "ACTIVE_OPERATIONAL_WORK"],
  ["available", (db) => { db.riders[0].status = "available"; }, "ACTIVE_OPERATIONAL_WORK"],
  ["active order link", (db) => { db.riders[0].activeOrderId = id(70); }, "ACTIVE_OPERATIONAL_WORK"],
  ["active slot", (db) => { db.slots.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "active", assignmentRevision: 2 }); }, "ACTIVE_OPERATIONAL_WORK"],
  ["inconsistent open slot", (db) => { db.slots.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "completed", startedAt: time, stoppedAt: null }); }, "ACTIVE_OPERATIONAL_WORK"],
  ["order", (db) => { db.orders.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "pending", assignmentState: "assigned" }); }, "ACTIVE_OPERATIONAL_WORK"],
  ["offer", (db) => { db.orders.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "preparing", assignmentState: "offered", offerId: "OFFLINE" }); }, "ACTIVE_OPERATIONAL_WORK"],
  ["QA live target", (db) => { db.orders.push({ _id: id(70), tenantId: ids.tenant, qaRiderId: id(20), status: "pending" }); }, "ACTIVE_OPERATIONAL_WORK"],
  ["reservation", (db) => { db.reservations.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "reserved" }); }, "ACTIVE_OPERATIONAL_WORK"],
  ["unknown reservation state", (db) => { db.reservations.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "unknown" }); }, "ACTIVE_OPERATIONAL_WORK"],
  ["tracking", (db) => { db.tracking.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "active", stoppedAt: null }); }, "ACTIVE_TRACKING"],
  ["degraded tracking", (db) => { db.tracking.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "degraded", stoppedAt: null }); }, "ACTIVE_TRACKING"],
  ["privacy lease", (db) => { db.riders[0].locationPrivacyExpiresAt = new Date(now.getTime() + 1000); }, "ACTIVE_TRACKING"],
  ["fresh GPS", (db) => { db.riders[0].lastLocationAt = now; }, "ACTIVE_TRACKING"],
  ["malformed GPS timestamp", (db) => { db.riders[0].lastLocationAt = "invalid"; }, "ACTIVE_TRACKING"],
  ["malformed privacy timestamp", (db) => { db.riders[0].locationPrivacyExpiresAt = "invalid"; }, "ACTIVE_TRACKING"],
  ["live Rider session", (db) => { db.employeeSessions.push({ _id: id(70), tenantId: ids.tenant, employeeId: id(30), role: "rider", issuedAt: time, expiresAt: new Date(now.getTime() + 1000), tokenHash: "SYNTHETIC_TOKEN" }); }, "ACTIVE_OPERATIONAL_WORK"],
];
for (const [label, change, code] of activeCases) test(`ongoing ${label} prevents transferring operational work`, async () => {
  const h = harness(); change(h.db); const before = clone(h.db); const preview = await h.preview(); hasBlocker(preview, code); assert.equal(preview.body.assignmentReady, false);
  assert.equal((await h.assign(preview.body.manifestHash)).status, 409); assert.equal(h.writes.length, 0); assert.deepEqual(h.db, before);
});

test("future planned slots and historical completed orders/closed tracking are preserved, never migrated", async () => {
  const h = harness(); h.db.slots.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), zoneSlug: "xativa-centro", status: "planned", assignmentRevision: 8, startedAt: null, stoppedAt: null });
  h.db.orders.push({ _id: id(71), tenantId: ids.tenant, riderId: id(20), status: "delivered", paymentState: "paid", version: 12 });
  h.db.tracking.push({ _id: id(72), tenantId: ids.tenant, riderId: id(20), status: "stopped", stoppedAt: time });
  const before = clone(h.db); const preview = await h.preview(); assert.equal(preview.body.assignmentReady, true); assert.equal((await h.assign(preview.body.manifestHash)).status, 200); assertPreserved(before, h.db);
});

for (const [label, change] of [
  ["Rider revision", (db: any) => { db.riders[0].updatedAt = now; }], ["Rider Fleet", (db: any) => { db.riders[0].fleetId = null; }],
  ["Rider employee revision", (db: any) => { db.employees[3].updatedAt = now; }], ["destination capacity", (db: any) => { db.fleets[0].maxRiders = 5; }],
  ["destination vehicles", (db: any) => { db.fleets[0].vehicleTypes.push("car"); }], ["source Fleet revision", (db: any) => { db.fleets[1].updatedAt = now; }],
  ["destination count", (db: any) => { db.riders.push({ ...clone(db.riders[0]), _id: id(90), name: "Other Offline", riderCode: "OFFLINE", fleetId: ids.fleet }); }],
  ["slot revision", (db: any) => { db.slots.push({ _id: id(70), tenantId: ids.tenant, riderId: id(20), status: "planned", assignmentRevision: 2 }); }],
  ["zone monetary reference", (db: any) => { db.zones[0].serviceFeeCents++; }], ["active work", (db: any) => { db.riders[0].status = "busy"; }],
] as const) test(`stale hash rejects changed ${label} before writes`, async () => {
  const h = harness(); const preview = await h.preview(); change(h.db); const before = clone(h.db);
  const result = await h.assign(preview.body.manifestHash); assert.equal(result.status, 409); assert.equal(result.body.error, "STALE_MANIFEST"); assert.equal(h.writes.length, 0); assert.deepEqual(h.db, before);
});

test("snapshot hashing ignores directory order, scope-set order and unrelated contacts", async () => {
  const h = harness(); const preview = await h.preview(); h.db.riders.reverse(); h.db.employees.reverse(); h.db.fleets[0].vehicleTypes.reverse(); h.db.fleets[0].contactEmail = "changed@example.test";
  assert.equal((await h.preview()).body.manifestHash, preview.body.manifestHash);
});

test("unbound Riders require matching unbound accounts and are safe without inventing any source or zone", async () => {
  const h = harness(); for (const row of h.db.riders) row.fleetId = null; for (const row of h.db.employees.slice(3)) row.fleetId = null;
  const preview = await h.preview(); assert.equal(preview.body.assignmentReady, true); assert.equal((await h.assign(preview.body.manifestHash)).status, 200);
  assert.equal(h.writes.length, 8); for (const write of h.writes) assert.deepEqual(write.filter.fleetId, { $eq: null, $exists: true });
});

test("capacity counts every existing destination Rider and the exact incoming subset", async () => {
  const h = harness(); h.db.riders[0].fleetId = ids.fleet; h.db.employees[3].fleetId = ids.fleet;
  h.db.riders.push({ ...clone(h.db.riders[0]), _id: id(90), name: "Other Offline", riderCode: "OTHER_OFFLINE", lifecycleStatus: "suspended" });
  const preview = await h.preview(); assert.equal(preview.body.destination.currentRiders, 2); assert.equal(preview.body.destination.incomingRiders, 3); hasBlocker(preview, "DESTINATION_CAPACITY_CONFLICT");
  assert.equal((await h.assign(preview.body.manifestHash)).status, 409); assert.equal(h.writes.length, 0);
});

test("a partially already-assigned set still requires all four valid bindings; only three pairs need mutation", async () => {
  const h = harness(); h.db.riders[0].fleetId = ids.fleet; h.db.employees[3].fleetId = ids.fleet;
  const before = clone(h.db); const preview = await h.preview(); assert.equal(preview.body.assignmentReady, true);
  assert.equal((await h.assign(preview.body.manifestHash)).body.assigned, true); assert.equal(h.writes.length, 6);
  assert(h.db.riders.every((row: any) => row.fleetId === ids.fleet)); assertPreserved(before, h.db);
});

for (const failure of ["cas:riders", "cas:employees", "unmodified:riders", "unmodified:employees", "fourth:riders", "fourth:employees"]) test(`${failure} aborts all four, accounts and audit`, async () => {
  const h = harness({ failure }); const preview = await h.preview(); const before = clone(h.db); const result = await h.assign(preview.body.manifestHash);
  assert.equal(result.status, 409); assert.equal(result.body.error, failure.endsWith("employees") ? "RIDER_EMPLOYEE_CAS_FAILED" : "RIDER_ASSIGNMENT_CAS_FAILED"); assert.deepEqual(h.db, before); assert.equal(h.db.audits.length, 0); assert.equal(h.effects.at(-1), "end");
});
for (const race of ["riders:timestamp", "riders:scope", "employees:timestamp", "employees:scope"]) test(`exact timestamp/scope CAS rejects ${race} and rolls back`, async () => {
  const h = harness({ race }); const preview = await h.preview(); const before = clone(h.db); const result = await h.assign(preview.body.manifestHash);
  assert.equal(result.status, 409); assert.equal(result.body.error, race.startsWith("employees") ? "RIDER_EMPLOYEE_CAS_FAILED" : "RIDER_ASSIGNMENT_CAS_FAILED"); assert.deepEqual(h.db, before);
});

test("audit failure aborts eight writes, unavailable transactions never fall back", async () => {
  const h = harness({ failure: "audit" }); const preview = await h.preview(); const before = clone(h.db);
  await assert.rejects(h.assign(preview.body.manifestHash), /OFFLINE_AUDIT_FAILURE/); assert.equal(h.writes.length, 8); assert.deepEqual(h.db, before); assert.equal(h.effects.at(-1), "end");
  const unavailable = harness({ unavailable: true }); await assert.rejects(unavailable.preview(), /OFFLINE_TRANSACTIONS_UNAVAILABLE/); assert.equal(unavailable.writes.length, 0); assert.equal(unavailable.effects.at(-1), "end");
});

test("coordinator refusing acquisition cannot be bypassed by an otherwise ready preview", async () => {
  const h = harness({ acquireFails: true }); const preview = await h.preview(); const before = clone(h.db); assert.equal(preview.body.assignmentReady, true);
  assert.equal((await h.assign(preview.body.manifestHash)).body.error, "ACTIVE_WORK_GUARD_UNAVAILABLE"); assert.equal(h.writes.length, 0); assert.deepEqual(h.db, before);
});

test("transaction retry recomputes exact snapshot; changed preview aborts rather than reusing approval", async () => {
  const h = harness(); const preview = await h.preview();
  h.forceRetry((db) => { db.riders[0].updatedAt = now; });
  const result = await h.assign(preview.body.manifestHash);
  assert.equal(result.status, 409); assert.equal(result.body.error, "STALE_MANIFEST"); assert.equal(h.db.audits.length, 0);
  assert(h.effects.includes("retry")); assert(h.db.riders.every((row: any) => row.fleetId === ids.source));
});

test("strict POST contract rejects extra setters, arrays, absent tenant/hash and wrong confirmation", async () => {
  const h = harness(); const valid = { tenantId: ids.tenant, manifestHash: "a".repeat(64), confirmation: XATIVA_ASSIGNMENT_CONFIRMATION };
  assert.equal(xativaAssignmentSchema.safeParse(valid).success, true);
  for (const extra of ["fleetId", "riderIds", "zoneSlug", "roles", "tenantScope", "password", "serviceZones", "contract", "dryRun", "upsert"]) {
    const body = { ...valid, [extra]: [] }; assert.equal(xativaAssignmentSchema.safeParse(body).success, false); assert.equal((await h.call("post", body)).status, 400);
  }
  for (const body of [null, {}, { ...valid, tenantId: undefined }, { ...valid, tenantId: "bad" }, { ...valid, manifestHash: undefined }, { ...valid, manifestHash: "bad" }, { ...valid, confirmation: "yes" }]) assert.equal((await h.call("post", body)).status, 400);
  assert.equal(h.reads.length, 0); assert.equal(h.writes.length, 0);
});

test("SOURCE: real server mounts native adapters behind requireRole(admin) with NO production coordinator or global scope helper", async () => {
  const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const imports = source.statements.filter((node) => ts.isImportDeclaration(node) && (node.moduleSpecifier as ts.StringLiteral).text === "./xativaOperationsRoutes.js"); assert.equal(imports.length, 1);
  const mounts = source.statements.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "registerXativaOperationsRoutes") as ts.ExpressionStatement[]; assert.equal(mounts.length, 1);
  let mounted: any;
  const context: any = { app: {}, requireRole: () => null, ownerEmail: rootEmail, objectId: (value: string) => value,
    mongoose: { startSession: async () => "offline-session" }, GovernanceAuditEvent: { create: async (rows: any, options: any) => ({ rows, options }) },
    registerXativaOperationsRoutes: (_app: any, deps: any) => { mounted = deps; } };
  for (const name of ["Tenant", "EmployeeAccount", "Fleet", "Rider", "Zone", "RiderSlot", "Order", "RiderAssignmentReservation", "TrackingSession", "EmployeeSession"]) context[name] = { collection: name };
  compile(`${mounts[0].getText(source)}; const subject = null;`, context);
  assert.equal(mounted.requireRole, context.requireRole); assert.equal(mounted.transferCoordinator, null);
  const expected = { tenants: "Tenant", employees: "EmployeeAccount", fleets: "Fleet", riders: "Rider", zones: "Zone", slots: "RiderSlot", orders: "Order", reservations: "RiderAssignmentReservation", tracking: "TrackingSession", employeeSessions: "EmployeeSession" };
  for (const [key, value] of Object.entries(expected)) assert.equal(mounted[key], value);
  assert.equal(await mounted.startSession(), "offline-session"); assert.deepEqual(await mounted.createAudit({ action: "offline" }, "offline-session"), { rows: [{ action: "offline" }], options: { session: "offline-session" } });
  const module = readFileSync(new URL("./xativaOperationsRoutes.ts", import.meta.url), "utf8");
  assert(!module.includes('from "./tenantScope.js"')); assert(!module.match(/deleteMany|insertMany|bulkWrite|\$push|\$pull|\.connect\(/));
  assert(module.includes('deps.requireRole("admin")')); assert(!module.includes('deps.requireRole("fleet")'));
  assert(!mounts[0].getText(source).includes("LocationSample.collection"), "Do not pretend unscoped GPS can be safely tenant-queried");
});
