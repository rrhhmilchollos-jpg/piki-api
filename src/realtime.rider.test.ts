import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test, { type TestContext } from "node:test";
import mongoose from "mongoose";
import { EmployeeAccount, RealtimeEvent, Rider } from "./models.js";
import { EmployeeSession } from "./employeeSessions.js";
import { hashSessionToken } from "./employeeAuth.js";
import { serveRealtimeEvents } from "./realtime.js";

// Run through scripts/offline-validation.mjs: no bootstrap, network, real DB or real timers.
const ids = {
  employee: "65d000000000000000000101", tenant: "65d000000000000000000102",
  rider: "65d000000000000000000103", otherTenant: "65d000000000000000000104",
  otherRider: "65d000000000000000000105",
};
const token = "OFFLINE_SYNTHETIC_RIDER_SSE_TOKEN";
const clone = <T>(value: T): T => structuredClone(value);
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof mongoose.Types.ObjectId)) {
      if ("$gt" in expected) return actual instanceof Date ? actual > expected.$gt : String(actual) > String(expected.$gt);
      if ("$in" in expected) return expected.$in.some((value: unknown) => String(value) === String(actual));
    }
    return actual === expected || (actual != null && expected != null && String(actual) === String(expected));
  });
}
function event(sequence: number, override: Record<string, unknown> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(`65e0000000000000${sequence.toString(16).padStart(8, "0")}`),
    tenantId: new mongoose.Types.ObjectId(ids.tenant), channel: "rider", audienceKey: `rider:${ids.rider}`,
    type: "order.rider_offer", payload: { orderId: "65d000000000000000000106" },
    createdAt: new Date("2026-01-01T00:00:00Z"), ...override,
  };
}
function request(headers: Record<string, string> = {}, query: Record<string, string> = {}): any {
  return Object.assign(new EventEmitter(), {
    query, destroyed: false, headers: { authorization: `Bearer ${token}`, "x-piki-surface": "rider", ...headers },
    header(this: any, key: string) { return this.headers[key.toLowerCase()] || ""; },
  });
}
function response(): any {
  return Object.assign(new EventEmitter(), {
    statusCode: 200, headers: {} as Record<string, string>, chunks: [] as string[], body: null as any,
    flushed: false, writableEnded: false, destroyed: false, ends: 0,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(key: string, value: string) { this.headers[key] = value; },
    json(body: any) { this.body = body; return this; },
    flushHeaders() { this.flushed = true; },
    write(chunk: string) { assert.equal(this.writableEnded || this.destroyed, false); this.chunks.push(chunk); return true; },
    end(this: any) { this.ends++; this.writableEnded = true; this.emit("close"); },
  });
}
const deliveredIds = (res: any) => res.chunks.filter((chunk: string) => chunk.startsWith("id: ")).map((chunk: string) => chunk.slice(4).trim());
function fixture(t: TestContext) {
  const email = "rider@example.test";
  const db: any = {
    employee: { _id: ids.employee, email, tenantId: ids.tenant, jobRole: "rider", apiRole: "rider", primaryRole: "rider", roles: ["rider"], active: true, authorizationStatus: "approved", mustChangePassword: false },
    session: { _id: "65d000000000000000000110", tokenHash: hashSessionToken(token), employeeId: ids.employee, tenantId: ids.tenant, role: "rider", surface: "rider", issuedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 60_000) },
    // Foreign duplicate email comes first: the old unscoped findOne selected it.
    riders: [{ _id: ids.otherRider, email, tenantId: ids.otherTenant }, { _id: ids.rider, email, tenantId: ids.tenant }],
    events: [],
  };
  const state = { reads: [] as any[], riderReads: [] as any[], replay: null as null | (() => Promise<any[]>), employeeSnapshot: undefined as any };
  const query = (read: () => any) => ({ select() { return this; }, lean() { return this; }, exec: async () => clone(read()) });
  t.mock.method(EmployeeSession, "findOne", (filter: any) => query(() => db.session && matches(db.session, filter) ? db.session : null));
  t.mock.method(EmployeeSession, "updateOne", () => query(() => ({ modifiedCount: 1 })));
  t.mock.method(EmployeeAccount, "findOne", (filter: any) => query(() => matches(db.employee, filter) ? db.employee : null));
  t.mock.method(EmployeeAccount, "findById", (id: any) => query(() => String(id) === ids.employee ? state.employeeSnapshot ?? db.employee : null));
  t.mock.method(Rider, "exists", async (filter: any) => {
    const row = db.riders.find((rider: any) => matches(rider, filter)); return row ? { _id: row._id } : null;
  });
  t.mock.method(Rider, "findOne", (filter: any) => {
    state.riderReads.push(filter); return query(() => db.riders.find((rider: any) => matches(rider, filter)) || null);
  });
  t.mock.method(RealtimeEvent, "find", (filter: any) => {
    state.reads.push(filter); let direction = 1; let limit = Infinity;
    return {
      lean() { return this; }, sort(value: any) { direction = value._id; return this; }, limit(value: number) { limit = value; return this; },
      exec: async () => state.replay ? state.replay() : db.events.filter((row: any) => matches(row, filter)).sort((a: any, b: any) => direction * String(a._id).localeCompare(String(b._id))).slice(0, limit),
    };
  });
  const timers: Array<{ callback: () => void; cancellations: number }> = [];
  t.mock.method(globalThis, "setInterval", ((callback: () => void, delay: number) => {
    assert.equal(delay, 20_000); const timer = { callback, cancellations: 0 }; timers.push(timer); return timer;
  }) as any);
  t.mock.method(globalThis, "clearInterval", ((timer: any) => { assert(timers.includes(timer)); timer.cancellations++; }) as any);
  // Observe only SSE's in-memory event subscription, without exposing a production test API.
  const subscriptions: Array<{ source: EventEmitter; listener: (...args: any[]) => void }> = [];
  const on = EventEmitter.prototype.on;
  t.mock.method(EventEmitter.prototype, "on", function (this: EventEmitter, name: string | symbol, listener: (...args: any[]) => void) {
    if (name === "event") subscriptions.push({ source: this, listener });
    return on.call(this, name, listener);
  });
  t.after(() => { for (const subscription of subscriptions) subscription.source.off("event", subscription.listener); });
  return {
    db, state, timers, subscriptions,
    emit(value: any) { assert.equal(subscriptions.length, 1); subscriptions[0].source.emit("event", value); },
    listenerCount() { return subscriptions.length ? subscriptions[0].source.listenerCount("event") : 0; },
  };
}
function assertClean(f: ReturnType<typeof fixture>, req: any, res: any) {
  assert.equal(f.listenerCount(), 0); assert.equal(req.listenerCount("close"), 0); assert.equal(res.listenerCount("close"), 0);
  for (const timer of f.timers) assert.equal(timer.cancellations, 1);
}

test("Rider resolves the same-email account only inside its frozen session tenant and preserves SSE API", async (t) => {
  const f = fixture(t); const req = request({ "x-piki-tenant-id": ids.otherTenant }, { tenantId: ids.otherTenant });
  req.auth = { role: "rider", employeeId: ids.employee, tenantId: ids.otherTenant };
  const res = response(); f.db.events = [event(1)]; await serveRealtimeEvents(req, res);
  assert.equal(res.statusCode, 200); assert.equal(res.flushed, true);
  assert.equal(res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["Cache-Control"], "no-cache, no-transform");
  assert.equal(res.chunks[0], 'event: ready\ndata: {"channel":"rider"}\n\n');
  assert.equal(f.state.riderReads[0].email, f.db.employee.email); assert.equal(String(f.state.riderReads[0].tenantId), ids.tenant);
  assert.equal(String(f.state.reads[0].tenantId), ids.tenant); assert.deepEqual(f.state.reads[0].audienceKey.$in, [`rider:${ids.rider}`]);
  assert.deepEqual(deliveredIds(res), [String(event(1)._id)]);
  f.emit(event(2, { audienceKey: `rider:${ids.otherRider}`, tenantId: new mongoose.Types.ObjectId(ids.otherTenant) }));
  f.emit(event(3)); assert.deepEqual(deliveredIds(res), [1, 3].map((id) => String(event(id)._id)));
  req.emit("close"); assertClean(f, req, res);
});

for (const [name, change] of [
  ["missing frozen tenant", (db: any) => { delete db.session.tenantId; }],
  ["null frozen tenant", (db: any) => { db.session.tenantId = null; db.employee.tenantId = null; }],
  ["invalid frozen tenant", (db: any) => { db.session.tenantId = "not-an-object-id"; db.employee.tenantId = "not-an-object-id"; }],
  ["employee moved tenant", (db: any) => { db.employee.tenantId = ids.otherTenant; }],
  ["only foreign same-email Rider", (db: any) => { db.riders = [db.riders[0]]; }],
] as const) {
  test(`Rider SSE denies ${name} before headers, replay, listener or timer`, async (t) => {
    const f = fixture(t); change(f.db); const req = request(); const res = response();
    await serveRealtimeEvents(req, res);
    assert.equal(res.statusCode, 401); assert.equal(res.body.error, "AUTHENTICATION_REQUIRED");
    assert.equal(res.flushed, false); assert.equal(f.state.reads.length, 0); assert.equal(f.timers.length, 0); assertClean(f, req, res);
  });
}

test("Rider SSE rejects an employee tenant changed between session resolution and audience lookup", async (t) => {
  const f = fixture(t); f.state.employeeSnapshot = { ...f.db.employee, tenantId: ids.otherTenant };
  const req = request(); const res = response(); await serveRealtimeEvents(req, res);
  assert.equal(res.statusCode, 401); assert.equal(f.state.riderReads.length, 0); assert.equal(f.state.reads.length, 0); assertClean(f, req, res);
});

for (const tenantId of [null, undefined, ids.otherTenant, "invalid"]) {
  test(`Rider SSE fails closed on an inconsistent Rider lookup tenant ${String(tenantId)}`, async (t) => {
    const f = fixture(t);
    t.mock.method(Rider, "findOne", () => ({ select() { return this; }, lean() { return this; }, exec: async () => ({ _id: ids.rider, tenantId }) }));
    const req = request(); const res = response(); await serveRealtimeEvents(req, res);
    assert.equal(res.statusCode, 401); assert.equal(res.flushed, false); assert.equal(f.state.reads.length, 0); assertClean(f, req, res);
  });
}

test("Rider replay and live enforce explicit tenant/channel/audience/cursor and deduplicate without poisoning valid IDs", async (t) => {
  const f = fixture(t); const req = request({ "last-event-id": String(event(1)._id) }); const res = response();
  const denied = [event(1), event(2, { tenantId: null }), event(3, { tenantId: undefined }), event(4, { tenantId: new mongoose.Types.ObjectId(ids.otherTenant) }), event(5, { tenantId: "invalid" }), event(6, { channel: "fleet" }), event(7, { audienceKey: `rider:${ids.otherRider}` })];
  // Deliberately bypass model filtering to check defense in depth on historical delivery.
  f.state.replay = async () => [...denied, event(8), event(8)];
  await serveRealtimeEvents(req, res);
  assert.equal(String((f.state.reads[0]._id as any).$gt), String(event(1)._id));
  assert.equal(String(f.state.reads[0].tenantId), ids.tenant); assert.deepEqual(deliveredIds(res), [String(event(8)._id)]);
  for (const row of denied) f.emit(row);
  f.emit(event(8)); f.emit(event(2)); f.emit(event(9));
  assert.deepEqual(deliveredIds(res), [8, 2, 9].map((id) => String(event(id)._id)));
  req.emit("close"); assertClean(f, req, res);
});

test("Rider no-cursor replay retains latest 100 ascending records and excludes null/foreign tenants", async (t) => {
  const f = fixture(t); const req = request({}, { since: "invalid-cursor" }); const res = response();
  f.db.events = [...Array.from({ length: 105 }, (_, i) => event(i + 1)), event(106, { tenantId: null }), event(107, { tenantId: new mongoose.Types.ObjectId(ids.otherTenant) })];
  await serveRealtimeEvents(req, res);
  assert.equal(f.state.reads[0]._id, undefined); assert.equal(String(f.state.reads[0].tenantId), ids.tenant);
  assert.deepEqual(deliveredIds(res), Array.from({ length: 100 }, (_, i) => String(event(i + 6)._id)));
  req.emit("close"); assertClean(f, req, res);
});

for (const source of ["request", "response"] as const) {
  test(`Rider ${source} disconnect during pending replay immediately cleans once and prevents all late writes`, async (t) => {
    const f = fixture(t); const req = request(); const res = response(); let release!: (rows: any[]) => void;
    const barrier = new Promise<any[]>((resolve) => { release = resolve; }); f.state.replay = () => barrier;
    const serving = serveRealtimeEvents(req, res); await settle();
    assert.equal(f.state.reads.length, 1); assert.equal(f.listenerCount(), 1);
    assert.equal(req.listenerCount("close"), 1); assert.equal(res.listenerCount("close"), 1); assert.equal(f.timers[0].cancellations, 0);
    (source === "request" ? req : res).emit("close"); req.emit("close"); res.emit("close");
    assertClean(f, req, res); const chunks = [...res.chunks];
    f.emit(event(1)); f.subscriptions[0].listener(event(2)); f.timers[0].callback();
    release([event(3)]); await serving;
    assert.deepEqual(res.chunks, chunks); assert.deepEqual(deliveredIds(res), []); assert.equal(res.ends, 0); assertClean(f, req, res);
  });
}

test("Rider replay rejection is handled and ends the stream with no leaked listeners/timers", async (t) => {
  const f = fixture(t); const req = request(); const res = response();
  f.state.replay = async () => { throw new Error("OFFLINE_REPLAY_FAILURE"); };
  await assert.doesNotReject(serveRealtimeEvents(req, res));
  assert.equal(res.ends, 1); assert.equal(res.writableEnded, true); assertClean(f, req, res);
  const chunks = [...res.chunks]; f.emit(event(1)); f.timers[0].callback(); req.emit("close"); res.emit("close");
  assert.deepEqual(res.chunks, chunks); assertClean(f, req, res);
});

for (const source of ["request", "response", "response-destroyed"] as const) {
  test(`Rider replay rejection after ${source} close is swallowed without ending or writing again`, async (t) => {
    const f = fixture(t); const req = request(); const res = response(); let reject!: (error: Error) => void;
    f.state.replay = () => new Promise<any[]>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const serving = serveRealtimeEvents(req, res); await settle();
    if (source === "response-destroyed") res.destroyed = true;
    (source === "request" ? req : res).emit("close");
    const chunks = [...res.chunks]; reject(new Error("OFFLINE_LATE_REPLAY_FAILURE")); await assert.doesNotReject(serving);
    assert.deepEqual(res.chunks, chunks); assert.equal(res.ends, 0); assertClean(f, req, res);
  });
}

for (const stage of ["already-destroyed", "already-ended", "request-destroyed", "flush", "ready"] as const) {
  test(`Rider ${stage} disconnect allocates no replay/listener/timer`, async (t) => {
    const f = fixture(t); const req = request(); const res = response();
    if (stage === "already-destroyed") res.destroyed = true;
    if (stage === "already-ended") res.writableEnded = true;
    if (stage === "request-destroyed") req.destroyed = true;
    if (stage === "flush") res.flushHeaders = () => { res.emit("close"); };
    if (stage === "ready") { const write = res.write; res.write = function (chunk: string) { const result = write.call(this, chunk); req.emit("close"); return result; }; }
    await serveRealtimeEvents(req, res);
    assert.equal(f.state.reads.length, 0); assert.equal(f.subscriptions.length, 0); assert.equal(f.timers.length, 0); assert.deepEqual(deliveredIds(res), []); assertClean(f, req, res);
  });
}

test("Rider disconnect while draining replay stops subsequent records", async (t) => {
  const f = fixture(t); const req = request(); const res = response(); f.db.events = [event(1), event(2)];
  const write = res.write;
  res.write = function (chunk: string) { const result = write.call(this, chunk); if (chunk.startsWith("data: ") && chunk.includes("occurredAt")) req.emit("close"); return result; };
  await serveRealtimeEvents(req, res); assert.deepEqual(deliveredIds(res), [String(event(1)._id)]); assertClean(f, req, res);
});

for (const phase of ["live", "heartbeat"] as const) {
  test(`Rider ${phase} write error cleans up and ends once`, async (t) => {
    const f = fixture(t); const req = request(); const res = response(); await serveRealtimeEvents(req, res);
    res.write = () => { throw new Error("OFFLINE_SOCKET_WRITE_FAILURE"); };
    if (phase === "live") f.emit(event(1)); else f.timers[0].callback();
    assert.equal(res.ends, 1); assertClean(f, req, res);
  });
}

test("Rider stream keeps its initial tenant and heartbeat does not add background authentication/forced closure", async (t) => {
  const f = fixture(t); const req = request(); const res = response(); let release!: (rows: any[]) => void;
  f.state.replay = () => new Promise<any[]>((resolve) => { release = resolve; });
  const serving = serveRealtimeEvents(req, res); await settle();
  f.db.employee.tenantId = ids.otherTenant; f.db.session.tenantId = ids.otherTenant;
  req.headers["x-piki-tenant-id"] = ids.otherTenant; req.query.tenantId = ids.otherTenant;
  release([event(1), event(2, { tenantId: new mongoose.Types.ObjectId(ids.otherTenant) })]); await serving;
  f.emit(event(3, { tenantId: new mongoose.Types.ObjectId(ids.otherTenant) })); f.emit(event(4));
  f.db.session = null; f.timers[0].callback(); f.timers[0].callback();
  assert.deepEqual(deliveredIds(res), [1, 4].map((id) => String(event(id)._id)));
  assert.equal(res.chunks.filter((chunk: string) => chunk.startsWith(": heartbeat ")).length, 2);
  assert.equal(res.ends, 0); assert.equal(res.writableEnded, false); assert.equal(f.timers[0].cancellations, 0);
  req.emit("close"); assertClean(f, req, res);
});
