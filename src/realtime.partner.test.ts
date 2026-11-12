import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import mongoose from "mongoose";
import { EmployeeAccount, Order, RealtimeEvent, Restaurant, Rider, Tenant, TenantMembership } from "./models.js";
import { EmployeeSession, OWNER_EMAIL } from "./employeeSessions.js";
import { hashSessionToken } from "./employeeAuth.js";
import { partnerRequestAccess } from "./partnerOperationalAccess.js";
import { publishRealtimeEvent, servePartnerRealtimeEvents, serveRealtimeEvents, type PartnerRealtimeDependencies } from "./realtime.js";

// Synthetic data only. No app/bootstrap import, listening socket or database.
const ids = { employee: "65d000000000000000000001", tenant: "65d000000000000000000002", restaurant: "65d000000000000000000003", otherTenant: "65d000000000000000000004", otherRestaurant: "65d000000000000000000005", order: "65d000000000000000000006" };
const token = "OFFLINE_SYNTHETIC_SESSION_NOT_A_REAL_CREDENTIAL";
const clone = <T>(value: T): T => structuredClone(value);
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !(expected instanceof mongoose.Types.ObjectId)) {
      if ("$gt" in expected) return actual instanceof Date ? actual > expected.$gt : String(actual) > String(expected.$gt);
      if ("$in" in expected) return expected.$in.some((v: unknown) => String(v) === String(actual));
      if ("$exists" in expected) return (actual !== undefined) === expected.$exists;
    }
    return actual === expected || (actual != null && expected != null && String(actual) === String(expected));
  });
}
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
function event(sequence: number, override: Record<string, unknown> = {}) {
  return { _id: new mongoose.Types.ObjectId(`65e0000000000000${sequence.toString(16).padStart(8, "0")}`), tenantId: new mongoose.Types.ObjectId(ids.tenant), channel: "partner" as const, audienceKey: `restaurant:${ids.restaurant}`, type: "order.status_changed", payload: { orderId: ids.order, restaurantId: ids.restaurant, status: "preparing" }, createdAt: new Date("2026-01-01T00:00:00Z"), ...override };
}
function request(headers: Record<string, string> = {}, query: Record<string, string> = {}): any {
  return Object.assign(new EventEmitter(), { query, path: "/realtime/events", destroyed: false,
    headers: { authorization: `Bearer ${token}`, "x-piki-surface": "partner", ...headers },
    header(this: any, key: string) { return this.headers[key.toLowerCase()] || ""; },
  });
}
function response(): any {
  return Object.assign(new EventEmitter(), { statusCode: 200, headers: {} as Record<string, string>, chunks: [] as string[], body: null as any, flushed: false, writableEnded: false, destroyed: false,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(key: string, value: string) { this.headers[key] = value; },
    json(body: any) { this.body = body; return this; },
    flushHeaders() { this.flushed = true; },
    write(chunk: string) { assert.equal(this.writableEnded, false); this.chunks.push(chunk); return true; },
    end(this: any) { this.writableEnded = true; this.emit("close"); },
  });
}
const deliveredIds = (res: any) => res.chunks.filter((v: string) => v.startsWith("id: ")).map((v: string) => v.slice(4).trim());
function fixture(t: TestContext) {
  const db: any = {
    employees: [{ _id: ids.employee, email: "kitchen@example.test", tenantId: ids.tenant, restaurantId: ids.restaurant, restaurantIds: [ids.restaurant], jobRole: "partner", apiRole: "partner", primaryRole: "partner", roles: ["partner"], partnerRoles: ["kitchen"], kitchenAccessSetupVersion: 1, accessLevel: "subadmin", ownerProtected: false, active: true, authorizationStatus: "approved", mustChangePassword: false, fleetId: null, zoneSlugs: [] }],
    sessions: [{ _id: "65d000000000000000000010", tokenHash: hashSessionToken(token), employeeId: ids.employee, tenantId: ids.tenant, role: "partner", surface: "partner", issuedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 60_000) }],
    tenants: [{ _id: ids.tenant, status: "active" }],
    restaurants: [{ _id: ids.restaurant, tenantId: ids.tenant, email: "kitchen@example.test", listingType: "official_partner", internalDemo: false, onboardingStatus: "approved", isActive: true, availabilityStatus: "available", marketplaceCompliance: { pikiStatus: "verified" }, menu: [{ available: true, allergens: ["soy"] }] }],
    memberships: [{ employeeId: ids.employee, tenantId: ids.tenant, status: "active", role: "partner", restaurantIds: [ids.restaurant], scopes: ["orders:read", "orders:prepare"] }],
    orders: [{ _id: ids.order, restaurantId: ids.restaurant, tenantId: ids.tenant }], events: [],
  };
  const reads: any[] = [];
  const query = (read: () => any) => ({ select() { return this; }, lean() { return this; }, limit() { return this; }, sort() { return this; }, exec: async () => clone(read()) });
  const model = (target: any, table: string) => {
    t.mock.method(target, "findOne", (filter: any) => query(() => db[table].find((row: any) => matches(row, filter)) || null));
    t.mock.method(target, "findById", (id: any) => query(() => db[table].find((row: any) => String(row._id) === String(id)) || null));
    t.mock.method(target, "find", (filter: any) => query(() => db[table].filter((row: any) => matches(row, filter))));
  };
  model(EmployeeAccount, "employees"); model(EmployeeSession, "sessions"); model(Restaurant, "restaurants"); model(Tenant, "tenants"); model(Order, "orders");
  for (const [target, table] of [[Restaurant, "restaurants"], [Tenant, "tenants"], [TenantMembership, "memberships"]] as const) {
    t.mock.method(target.collection, "findOne", async (filter: any) => clone(db[table].find((row: any) => matches(row, filter)) || null));
    t.mock.method(target.collection, "find", (filter: any) => ({ toArray: async () => clone(db[table].filter((row: any) => matches(row, filter))) }));
  }
  t.mock.method(RealtimeEvent, "find", (filter: any) => {
    reads.push(filter); let direction = 1; let limit = Infinity;
    return { select() { return this; }, lean() { return this; }, limit(n: number) { limit = n; return this; }, sort(s: any) { direction = s._id; return this; }, exec: async () => db.events.filter((row: any) => matches(row, filter)).sort((a: any, b: any) => direction * String(a._id).localeCompare(String(b._id))).slice(0, limit) };
  });
  const events = new EventEmitter();
  let heartbeat: (() => void) | null = null;
  let cancelled = false;
  const deps: PartnerRealtimeDependencies = {
    authorize: (req) => partnerRequestAccess(req, "orders:read"), events,
    replay: async (filter, after) => after ? await RealtimeEvent.find(filter).sort({ _id: 1 }).limit(100).lean().exec() as any : (await RealtimeEvent.find(filter).sort({ _id: -1 }).limit(100).lean().exec() as any[]).reverse(),
    heartbeat: (callback) => { heartbeat = callback; return () => { cancelled = true; }; },
  };
  return { db, reads, events, deps, tick: () => { assert(heartbeat); heartbeat(); }, get cancelled() { return cancelled; } };
}

for (const [name, change, status] of [
  ["temporary password", (db: any) => { db.employees[0].mustChangePassword = true; }, 428],
  ["inactive account", (db: any) => { db.employees[0].active = false; }, 401],
  ["suspended account", (db: any) => { db.employees[0].authorizationStatus = "suspended"; }, 401],
  ["revoked session", (db: any) => { db.sessions = []; }, 401],
  ["expired session", (db: any) => { db.sessions[0].expiresAt = new Date(0); }, 401],
  ["password changed after issuance", (db: any) => { db.employees[0].passwordChangedAt = new Date(); }, 401],
  ["missing tenant", (db: any) => { db.sessions[0].tenantId = null; db.employees[0].tenantId = null; }, 401],
  ["session tenant moved", (db: any) => { db.employees[0].tenantId = ids.otherTenant; }, 401],
  ["restaurant foreign tenant", (db: any) => { db.restaurants[0].tenantId = ids.otherTenant; }, 403],
  ["tenant suspended", (db: any) => { db.tenants[0].status = "suspended"; }, 403],
  ["membership revoked", (db: any) => { db.memberships[0].status = "revoked"; }, 403],
  ["membership missing", (db: any) => { db.memberships = []; }, 403],
  ["membership foreign tenant", (db: any) => { db.memberships[0].tenantId = ids.otherTenant; }, 403],
  ["membership wrong restaurant", (db: any) => { db.memberships[0].restaurantIds = [ids.otherRestaurant]; }, 403],
  ["membership wrong scope", (db: any) => { db.memberships[0].scopes = ["orders:prepare"]; }, 403],
  ["binding contact changed", (db: any) => { db.restaurants[0].email = "other@example.test"; }, 403],
  ["orders:read absent", (db: any) => { delete db.employees[0].kitchenAccessSetupVersion; db.employees[0].partnerRoles = ["catalog"]; }, 403],
  ["pending active 101 unavailable products/null allergens", (db: any) => { Object.assign(db.restaurants[0], { onboardingStatus: "pending_review", isActive: true, menu: Array.from({ length: 101 }, () => ({ available: false, allergens: null })) }); }, 403],
  ["available product unknown allergens", (db: any) => { db.restaurants[0].menu[0].allergens = null; }, 403],
] as const) {
  test(`Partner SSE initial denies ${name} before replay/listener`, async (t) => {
    const f = fixture(t); change(f.db); const req = request(); const res = response();
    await serveRealtimeEvents(req, res);
    assert.equal(res.statusCode, status); assert.equal(res.flushed, false); assert.deepEqual(deliveredIds(res), []); assert.equal(f.reads.length, 0);
    assert.equal(f.events.listenerCount("event"), 0);
  });
}

test("Partner initial denies unassigned header and never trusts req.auth instead of bearer", async (t) => {
  const f = fixture(t);
  for (const req of [request({ "x-piki-restaurant-id": ids.otherRestaurant }), Object.assign(request({ authorization: "" }), { auth: { role: "partner", employeeId: ids.employee, tenantId: ids.tenant } })]) {
    const res = response(); await serveRealtimeEvents(req, res); assert([401, 403].includes(res.statusCode)); assert.equal(res.flushed, false);
  }
  assert.equal(f.reads.length, 0);
});

test("Partner replay and live events require exact explicit tenant/channel/selected audience, ordered and deduplicated", async (t) => {
  const f = fixture(t); const req = request({ "last-event-id": String(event(1)._id) }); const res = response();
  // Deliberately return foreign records despite the query to prove defense in depth.
  f.deps.replay = async (query, after) => {
    assert.equal(query.channel, "partner"); assert.equal(query.audienceKey, `restaurant:${ids.restaurant}`); assert.equal(String(query.tenantId), ids.tenant); assert.equal(String((query._id as any).$gt), String(event(1)._id)); assert.equal(after, true);
    f.events.emit("event", event(4)); f.events.emit("event", event(2));
    return [event(3), event(2), event(1), event(5, { tenantId: null }), event(6, { tenantId: new mongoose.Types.ObjectId(ids.otherTenant) }), event(7, { audienceKey: `restaurant:${ids.otherRestaurant}` }), event(8, { channel: "rider" })] as any;
  };
  await servePartnerRealtimeEvents(req, res, f.deps);
  assert.deepEqual(deliveredIds(res), [2, 3, 4].map((n) => String(event(n)._id)));
  f.events.emit("event", event(4)); f.events.emit("event", event(9, { tenantId: null })); f.events.emit("event", event(10, { tenantId: new mongoose.Types.ObjectId(ids.otherTenant) })); f.events.emit("event", event(11));
  await settle(); assert.deepEqual(deliveredIds(res), [2, 3, 4, 11].map((n) => String(event(n)._id)));
  assert.equal(f.events.listenerCount("event"), 1); req.emit("close"); assert.equal(f.events.listenerCount("event"), 0); assert.equal(f.cancelled, true);
});

test("Partner replay with no cursor reads latest 100 in ascending order and never a null tenant", async (t) => {
  const f = fixture(t); f.db.events = Array.from({ length: 105 }, (_, n) => event(n + 1)); const res = response(); const req = request();
  await servePartnerRealtimeEvents(req, res, f.deps);
  assert.equal(String(f.reads[0].tenantId), ids.tenant); assert.equal(f.reads[0]._id, undefined);
  assert.deepEqual(deliveredIds(res), Array.from({ length: 100 }, (_, n) => String(event(n + 6)._id))); req.emit("close");
});

for (const [name, revoke] of [
  ["session logout", (db: any) => { db.sessions = []; }],
  ["session expiry", (db: any) => { db.sessions[0].expiresAt = new Date(0); }],
  ["password changed", (db: any) => { db.employees[0].passwordChangedAt = new Date(); }],
  ["mustChangePassword", (db: any) => { db.employees[0].mustChangePassword = true; }],
  ["active", (db: any) => { db.employees[0].active = false; }],
  ["authorizationStatus", (db: any) => { db.employees[0].authorizationStatus = "revoked"; }],
  ["membership", (db: any) => { db.memberships[0].status = "revoked"; }],
  ["frozen tenant", (db: any) => { db.sessions[0].tenantId = ids.otherTenant; db.employees[0].tenantId = ids.otherTenant; }],
  ["selected restaurant", (db: any) => { db.employees[0].restaurantIds = [ids.otherRestaurant]; db.employees[0].restaurantId = ids.otherRestaurant; }],
  ["orders:read", (db: any) => { delete db.employees[0].kitchenAccessSetupVersion; db.employees[0].partnerRoles = ["catalog"]; }],
  ["commercial readiness", (db: any) => { db.restaurants[0].onboardingStatus = "pending_review"; }],
] as const) {
  test(`Partner live revalidates/closes on ${name} before delivery; heartbeat also revokes idle stream`, async (t) => {
    const f = fixture(t); const req = request(); const res = response(); await servePartnerRealtimeEvents(req, res, f.deps);
    f.events.emit("event", event(1)); await settle(); assert.deepEqual(deliveredIds(res), [String(event(1)._id)]);
    revoke(f.db); f.events.emit("event", event(2)); f.tick(); await settle();
    assert.equal(res.writableEnded, true); assert.deepEqual(deliveredIds(res), [String(event(1)._id)]); assert.equal(f.events.listenerCount("event"), 0); assert.equal(f.cancelled, true);
  });
}

test("Partner idle heartbeat closes expired session without waiting for an event", async (t) => {
  const f = fixture(t); const req = request(); const res = response(); await servePartnerRealtimeEvents(req, res, f.deps);
  f.db.sessions[0].expiresAt = new Date(0); f.tick(); await settle(); assert.equal(res.writableEnded, true); assert.equal(f.events.listenerCount("event"), 0); assert.equal(f.cancelled, true);
});

test("Partner revalidates between replay records and closes on authorization/read errors", async (t) => {
  const f = fixture(t); f.db.events = [event(1), event(2)]; const res = response(); const req = request();
  const write = res.write; res.write = function (chunk: string) { const result = write.call(this, chunk); if (chunk.startsWith("data: ") && chunk.includes("occurredAt")) f.db.memberships[0].status = "revoked"; return result; };
  await servePartnerRealtimeEvents(req, res, f.deps); assert.deepEqual(deliveredIds(res), [String(event(1)._id)]); assert.equal(res.writableEnded, true);
  const initial = response(); await servePartnerRealtimeEvents(request(), initial, { ...f.deps, authorize: async () => { throw new Error("OFFLINE_DB_FAILURE"); } }); assert.equal(initial.statusCode, 503); assert.equal(initial.flushed, false);
  f.db.memberships[0].status = "active";
  const failedReplay = response(); await servePartnerRealtimeEvents(request(), failedReplay, { ...f.deps, replay: async () => { throw new Error("OFFLINE_REPLAY_FAILURE"); } }); assert.equal(failedReplay.writableEnded, true); assert.equal(f.events.listenerCount("event"), 0);
});

test("Partner disconnect during replay cleans up and emits no later records", async (t) => {
  const f = fixture(t); const req = request(); const res = response();
  f.deps.replay = async () => { req.emit("close"); return [event(1)]; };
  await servePartnerRealtimeEvents(req, res, f.deps); assert.deepEqual(deliveredIds(res), []); assert.equal(f.events.listenerCount("event"), 0); assert.equal(f.cancelled, true);
});

test("legacy real Partner keeps permitted role fallback, absent legacy membership/listingType and first-location REST selection", async (t) => {
  const f = fixture(t); const employee = f.db.employees[0]; delete employee.kitchenAccessSetupVersion; employee.partnerRoles = []; f.db.memberships = []; delete f.db.restaurants[0].listingType;
  f.db.restaurants.push({ ...clone(f.db.restaurants[0]), _id: ids.otherRestaurant }); employee.restaurantIds.push(ids.otherRestaurant);
  const req = request(); const res = response(); await servePartnerRealtimeEvents(req, res, f.deps);
  assert.equal(res.statusCode, 200); assert.equal(f.reads[0].audienceKey, `restaurant:${ids.restaurant}`);
  f.events.emit("event", event(1, { audienceKey: `restaurant:${ids.otherRestaurant}` })); f.events.emit("event", event(2)); await settle(); assert.deepEqual(deliveredIds(res), [String(event(2)._id)]); req.emit("close");
  f.db.memberships.push({ employeeId: ids.employee, tenantId: ids.tenant, status: "revoked" }); assert.equal((await partnerRequestAccess(request(), "orders:read")).allowed, false);
});

test("versioned non-kitchen Partner preserves orders readiness and its current membership/scopes", async (t) => {
  const f = fixture(t); const employee = f.db.employees[0]; delete employee.kitchenAccessSetupVersion; employee.partnerBindingVersion = 1; employee.partnerRoles = ["manager"];
  f.db.memberships[0].scopes = ["store:write", "orders:read", "orders:write", "orders:prepare", "orders:cancel", "menu:read", "menu:write", "metrics:read"];
  assert.equal((await partnerRequestAccess(request(), "orders:read")).allowed, true);
  f.db.restaurants[0].onboardingStatus = "pending_review"; assert.equal((await partnerRequestAccess(request(), "orders:read")).allowed, false); assert.equal((await partnerRequestAccess(request(), "menu:write")).allowed, true);
  f.db.restaurants[0].onboardingStatus = "approved"; f.db.memberships[0].scopes = ["*"]; assert.equal((await partnerRequestAccess(request(), "orders:read")).allowed, false);
});

test("real protected Owner may use assigned Partner session, but admin/environmental/root-null context grants no Partner data", async (t) => {
  const f = fixture(t); Object.assign(f.db.employees[0], { email: OWNER_EMAIL, jobRole: "admin", apiRole: "admin", primaryRole: "admin", roles: ["admin"], partnerRoles: [], kitchenAccessSetupVersion: null, ownerProtected: true, accessLevel: "superadmin" });
  Object.assign(f.db.memberships[0], { role: "owner", scopes: ["*"], restaurantIds: [] });
  assert.equal((await partnerRequestAccess(request(), "orders:read")).allowed, true);
  f.db.sessions[0].role = "admin"; f.db.sessions[0].surface = "admin"; assert.equal((await partnerRequestAccess(request(), "orders:read")).allowed, false);
  f.db.sessions[0].tenantId = null; f.db.employees[0].tenantId = null; assert.equal((await partnerRequestAccess(request(), "orders:read")).allowed, false);
  const res = response(); await servePartnerRealtimeEvents(request(), res, { ...f.deps, authorize: (req) => partnerRequestAccess(req, "orders:read", { resolveAuth: async () => ({ role: "admin", isRootOwner: true }), employeeById: async () => { throw new Error("No employee lookup authorized"); }, binding: {} as any }) }); assert.equal(res.statusCode, 401); assert.equal(res.flushed, false);
});

test("legacy protected Owner token adoption retains actual Admin SSE and ordinary legacy token is rejected", async (t) => {
  const f = fixture(t); f.db.sessions = []; Object.assign(f.db.employees[0], { email: OWNER_EMAIL, sessionHash: hashSessionToken(token), jobRole: "admin", apiRole: "admin", primaryRole: "admin", roles: ["admin"], ownerProtected: true, accessLevel: "superadmin", kitchenAccessSetupVersion: null });
  t.mock.method(EmployeeSession, "updateOne", (_filter: any, update: any) => ({ exec: async () => { if (update.$setOnInsert) f.db.sessions.push({ tokenHash: hashSessionToken(token), ...update.$setOnInsert }); return {}; } }));
  t.mock.method(EmployeeAccount, "updateOne", (_filter: any, update: any) => ({ exec: async () => { Object.assign(f.db.employees[0], update.$set); return {}; } }));
  const req = request({ "x-piki-surface": "admin" }); const res = response(); await serveRealtimeEvents(req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.flushed, true); assert.equal(f.reads[0].channel, "admin"); assert(f.reads[0].audienceKey.$in.includes(`tenant:${ids.tenant}:role:admin`)); req.emit("close");
  f.db.sessions = []; Object.assign(f.db.employees[0], { email: "ordinary@example.test", ownerProtected: false, sessionHash: hashSessionToken(token) }); const denied = response(); await serveRealtimeEvents(request(), denied); assert.equal(denied.statusCode, 401); assert.equal(denied.flushed, false);
});

test("Partner publisher derives only persisted order tenant; null/foreign/payload/dedupe mismatch never persists or emits", async (t) => {
  const f = fixture(t); let persisted = 0;
  const input = { channel: "partner" as const, audienceKey: `restaurant:${ids.restaurant}`, type: "order.status_changed", payload: { orderId: ids.order, restaurantId: ids.restaurant }, dedupeKey: "OFFLINE_PARTNER_DEDUPE" };
  t.mock.method(RealtimeEvent, "findOneAndUpdate", (_filter: any, update: any) => ({ exec: async () => { persisted++; return { toObject: () => ({ ...event(50), ...update.$setOnInsert }) }; } }));
  // Notification fanout finds no ordinary Partner recipient: no SMTP/DB writes.
  t.mock.method(EmployeeAccount, "find", () => ({ select() { return this; }, limit() { return this; }, lean() { return this; }, exec: async () => [] }));
  const valid = await publishRealtimeEvent(input); assert(valid); assert.equal(String(valid.tenantId), ids.tenant); assert.equal(persisted, 1);
  for (const override of [{ tenantId: null }, { tenantId: ids.otherTenant }, { payload: { orderId: ids.order, restaurantId: ids.otherRestaurant } }, { audienceKey: `restaurant:${ids.otherRestaurant}` }]) assert.equal(await publishRealtimeEvent({ ...input, ...override }), null);
  assert.equal(persisted, 1);
  f.db.orders[0].tenantId = null; assert.equal(await publishRealtimeEvent(input), null); assert.equal(persisted, 1);
  f.db.orders[0].tenantId = ids.tenant; f.db.restaurants[0].tenantId = ids.otherTenant; assert.equal(await publishRealtimeEvent(input), null); assert.equal(persisted, 1);
  f.db.restaurants[0].tenantId = ids.tenant;
  const req = request(); const res = response(); await serveRealtimeEvents(req, res);
  t.mock.method(RealtimeEvent, "findOneAndUpdate", () => ({ exec: async () => ({ toObject: () => event(51, { tenantId: null }) }) }));
  assert.equal(await publishRealtimeEvent(input), null); await settle(); assert.deepEqual(deliveredIds(res), []); req.emit("close");
});

test("default Partner route still delivers legitimate published events exactly once and keeps controlled REST fallback on scope read failure", async (t) => {
  const f = fixture(t); const req = request(); const res = response(); await serveRealtimeEvents(req, res);
  t.mock.method(EmployeeAccount, "find", () => ({ select() { return this; }, limit() { return this; }, lean() { return this; }, exec: async () => [] }));
  t.mock.method(RealtimeEvent, "findOneAndUpdate", (_filter: any, update: any) => ({ exec: async () => ({ toObject: () => ({ ...event(1000), ...update.$setOnInsert }) }) }));
  const input = { channel: "partner" as const, audienceKey: `restaurant:${ids.restaurant}`, type: "order.status_changed", tenantId: ids.tenant, payload: { orderId: ids.order, restaurantId: ids.restaurant }, dedupeKey: "OFFLINE_VALID" };
  await publishRealtimeEvent(input); await publishRealtimeEvent(input); await settle(); assert.deepEqual(deliveredIds(res), [String(event(1000)._id)]);
  t.mock.method(Order, "findOne", () => { throw new Error("OFFLINE_SCOPE_UNAVAILABLE"); }); assert.equal(await publishRealtimeEvent(input), null); assert.equal(res.writableEnded, false); req.emit("close");
});

test("Partner async authorization is serialized; queued event cannot use an earlier authorized snapshot", async (t) => {
  const f = fixture(t); const req = request(); const res = response(); await servePartnerRealtimeEvents(req, res, f.deps);
  const authorize = f.deps.authorize; let calls = 0; let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  f.deps.authorize = async (r) => { calls++; await barrier; return authorize(r); };
  f.events.emit("event", event(1)); f.events.emit("event", event(2)); await settle(); assert.equal(calls, 1);
  f.db.sessions = []; release(); await settle(); assert.deepEqual(deliveredIds(res), []); assert.equal(res.writableEnded, true); assert.equal(f.events.listenerCount("event"), 0);
});

test("Partner live and idle authorization errors close cleanly with no later delivery", async (t) => {
  const f = fixture(t);
  for (const idle of [false, true]) {
    f.deps.authorize = (r) => partnerRequestAccess(r, "orders:read");
    const req = request(); const res = response(); await servePartnerRealtimeEvents(req, res, f.deps);
    f.deps.authorize = async () => { throw new Error("OFFLINE_SESSION_READ_FAILURE"); };
    if (idle) f.tick(); else f.events.emit("event", event(1));
    await settle(); assert.equal(res.writableEnded, true); assert.deepEqual(deliveredIds(res), []); assert.equal(f.events.listenerCount("event"), 0); assert.equal(f.cancelled, true);
  }
});

test("Partner header-flush disconnect and inconsistent historical payload never leak or leave listener behind", async (t) => {
  const f = fixture(t); const req = request(); const res = response();
  res.flushHeaders = () => { res.destroyed = true; res.emit("close"); };
  await servePartnerRealtimeEvents(req, res, f.deps); assert.equal(f.events.listenerCount("event"), 0); assert.equal(f.reads.length, 0); assert.deepEqual(res.chunks, []);
  const live = response(); const liveReq = request(); f.deps.replay = async () => [event(1, { payload: { orderId: ids.order, restaurantId: ids.otherRestaurant } }), event(2, { tenantId: undefined }), event(3, { payload: null })] as any;
  await servePartnerRealtimeEvents(liveReq, live, f.deps); assert.deepEqual(deliveredIds(live), []);
  f.events.emit("event", event(4, { payload: { restaurantId: ids.otherRestaurant } })); await settle(); assert.deepEqual(deliveredIds(live), []); liveReq.emit("close");
});

test("unrelated real Rider SSE still uses its existing audience/replay without Partner readiness or tenant-null changes", async (t) => {
  const f = fixture(t); const riderId = "65d000000000000000000020";
  Object.assign(f.db.employees[0], { apiRole: "rider", jobRole: "rider", primaryRole: "rider", roles: ["rider"], mustChangePassword: true });
  Object.assign(f.db.sessions[0], { role: "rider", surface: "rider" });
  t.mock.method(Rider, "exists", async () => ({ _id: riderId }));
  t.mock.method(Rider, "findOne", () => ({ select() { return this; }, lean() { return this; }, exec: async () => ({ _id: riderId }) }));
  t.mock.method(EmployeeSession, "updateOne", () => ({ exec: async () => ({ modifiedCount: 1 }) }));
  f.db.events = [event(4000, { channel: "rider", audienceKey: `rider:${riderId}`, tenantId: null })];
  const req = request({ "x-piki-surface": "rider" }); const res = response(); await serveRealtimeEvents(req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.flushed, true); assert.equal(f.reads[0].channel, "rider"); assert.deepEqual(f.reads[0].audienceKey.$in, [`rider:${riderId}`]); assert.deepEqual(deliveredIds(res), [String(event(4000)._id)]); req.emit("close");
});
