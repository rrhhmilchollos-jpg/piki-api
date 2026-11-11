import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";

function query(value: any): any {
  const q: any = {
    select: () => q, lean: () => q, sort: () => q, limit: () => q,
    exec: async () => value,
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject),
  };
  return q;
}
function response() {
  const state: any = { status: 200 };
  const res: any = {
    status: (code: number) => { state.status = code; return res; },
    json: (body: any) => { state.body = body; return res; },
    setHeader: () => res,
  };
  return { state, res };
}

// Minimal Mongo-expression evaluator for the atomic lifecycle pipeline, not a DB.
function expression(value: any, document: any): any {
  if (typeof value === "string" && value.startsWith("$")) return document[value.slice(1)];
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if (value.$cond) return expression(value.$cond[expression(value.$cond[0], document) ? 1 : 2], document);
  if (value.$eq) return expression(value.$eq[0], document) === expression(value.$eq[1], document);
  if (value.$ifNull) return expression(value.$ifNull[0], document) ?? expression(value.$ifNull[1], document);
  throw new Error("UNSUPPORTED_MOCK_EXPRESSION");
}

test("shift continuity: real handlers and sweep with no listener, database or network", async (t) => {
  const env = { PIKI_NO_LISTEN: "true", NODE_ENV: "test", DOTENV_CONFIG_PATH: "/dev/null" };
  const previousEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  mongoose.set("bufferCommands", false);
  mongoose.set("autoCreate", false);
  mongoose.set("autoIndex", false);
  const forbidden = () => { throw new Error("EXTERNAL_IO_FORBIDDEN"); };
  t.mock.method(mongoose, "connect", forbidden);
  t.mock.method(mongoose.Query.prototype as any, "exec", forbidden);
  t.mock.method(net.Socket.prototype, "connect", forbidden);
  t.mock.method(net.Server.prototype, "listen", forbidden);
  t.mock.method(http, "request", forbidden);
  t.mock.method(https, "request", forbidden);
  t.mock.method(globalThis, "fetch", forbidden);

  const models = await import("./models.js");
  const { Rider, RiderSlot, Order } = models;
  const { RiderShiftIncentiveMetric } = await import("./riderIncentivesModels.js");
  const shifts = await import("./shiftPlans.js");
  const server = await import("./server.js");
  const RealDate = Date;
  let now = RealDate.parse("2026-11-04T17:00:00Z"); // Wednesday 18:00 Madrid.
  class FixedDate extends RealDate {
    constructor(value?: any) { super(value === undefined ? now : value); }
    static now() { return now; }
  }
  (globalThis as any).Date = FixedDate;
  t.after(() => { (globalThis as any).Date = RealDate; });
  const riderId = new mongoose.Types.ObjectId(), tenantId = new mongoose.Types.ObjectId();
  const slotId = new mongoose.Types.ObjectId();
  let slot: any;
  let rider: any = { _id: riderId, tenantId, status: "offline", riderCode: "OFFLINE", isTestRider: true, lastLocationAt: new Date() };
  let access = true, hasOrders = false, startRace = false;
  let startWrites = 0, stopWrites = 0, incentiveStops = 0;
  t.mock.method(Rider as any, "findById", () => query({ ...rider }));
  t.mock.method(Rider as any, "exists", () => query(access));
  t.mock.method(Rider as any, "updateOne", (_filter: any, update: any) => { Object.assign(rider, update.$set); return query({ modifiedCount: 1 }); });
  t.mock.method(Rider as any, "findByIdAndUpdate", (_id: any, update: any) => { Object.assign(rider, update.$set); return query({ ...rider }); });
  t.mock.method(Order as any, "exists", () => query(hasOrders));
  t.mock.method(RiderSlot as any, "find", (filter: any) => {
    const statuses = filter.status?.$in || [filter.status];
    return query(slot && statuses.includes(slot.status) ? [{ ...slot }] : []);
  });
  t.mock.method(RiderSlot as any, "findOne", () => query(slot?.status === "active" ? { ...slot } : null));
  t.mock.method(RiderSlot as any, "findOneAndUpdate", (filter: any, update: any) => {
    assert.equal(String(filter.riderId), String(riderId));
    if (startRace || !slot || !filter.status.$in.includes(slot.status)) return query(null);
    assert.ok(Array.isArray(update), "start must use an atomic conditional update");
    const original = { ...slot };
    for (const [key, value] of Object.entries(update[0].$set)) slot[key] = expression(value, original);
    startWrites += 1;
    return query({ ...slot });
  });
  t.mock.method(RiderSlot as any, "updateOne", (filter: any, update: any) => {
    assert.equal(filter.status, "active");
    assert.equal(String(filter.riderId), String(riderId));
    if (!slot || slot.status !== filter.status) return query({ modifiedCount: 0 });
    Object.assign(slot, update.$set);
    stopWrites += 1;
    return query({ modifiedCount: 1 });
  });
  t.mock.method(RiderShiftIncentiveMetric as any, "updateOne", () => { incentiveStops += 1; return query({ modifiedCount: 1 }); });
  function handler(suffix: string) {
    const path = `/api/v1/riders/:id/shift/${suffix}`;
    const route = (server.app as any)._router.stack.find((layer: any) => layer.route?.path === path).route;
    return route.stack[route.stack.length - 1].handle;
  }
  const req: any = { params: { id: String(riderId) }, auth: { role: "admin", tenantId: String(tenantId) }, body: {} };
  function plannedSlot() {
    return { _id: slotId, riderId, tenantId, date: "2026-11-04", startTime: "12:00", endTime: "00:00", status: "planned", startedAt: null, stoppedAt: null };
  }

  await t.test("first start records server time; replay preserves it and ignores client timestamps", async () => {
    slot = plannedSlot();
    req.body.startedAt = "2026-11-04T11:00:00Z";
    const first = response();
    await handler("start")(req, first.res);
    assert.equal(first.state.status, 200);
    assert.equal(slot.startedAt.toISOString(), "2026-11-04T17:00:00.000Z");
    now += 60000;
    rider.lastLocationAt = new Date();
    await handler("start")(req, response().res);
    assert.equal(slot.startedAt.toISOString(), "2026-11-04T17:00:00.000Z");
    assert.equal(slot.status, "active");
  });
  await t.test("replaying a legacy active slot does not fabricate startedAt", async () => {
    slot = { ...plannedSlot(), status: "active" };
    delete slot.startedAt;
    await handler("start")(req, response().res);
    assert.equal(slot.startedAt, null);
  });
  await t.test("GPS and ownership guards prevent start writes", async () => {
    slot = plannedSlot();
    const before = startWrites;
    rider.lastLocationAt = null;
    const gps = response();
    await handler("start")(req, gps.res);
    assert.equal(gps.state.body.error, "FRESH_LOCATION_REQUIRED");
    rider.lastLocationAt = new Date();
    access = false;
    const denied = response();
    await handler("start")(req, denied.res);
    assert.equal(denied.state.status, 403);
    access = true;
    assert.equal(startWrites, before);
  });
  await t.test("a concurrent close cannot bring the rider online after a failed start", async () => {
    slot = plannedSlot();
    rider.status = "offline";
    startRace = true;
    const res = response();
    await handler("start")(req, res.res);
    assert.equal(res.state.status, 409);
    assert.equal(rider.status, "offline");
    startRace = false;
  });
  await t.test("stop records server timestamp/reason once and replay leaves them unchanged", async () => {
    slot = { ...plannedSlot(), status: "active", startedAt: new Date("2026-11-04T17:00:00Z") };
    now = RealDate.parse("2026-11-04T19:00:00Z");
    req.body.stoppedAt = "2026-11-04T11:00:00Z";
    await handler("stop")(req, response().res);
    assert.equal(slot.status, "completed");
    assert.equal(slot.stoppedAt.toISOString(), "2026-11-04T19:00:00.000Z");
    assert.equal(slot.stoppedReason, "rider_stopped");
    const before = stopWrites, incentivesBefore = incentiveStops;
    now += 60000;
    await handler("stop")(req, response().res);
    assert.equal(stopWrites, before);
    assert.equal(incentiveStops, incentivesBefore);
    assert.equal(slot.stoppedAt.toISOString(), "2026-11-04T19:00:00.000Z");
  });
  await t.test("stop does not count a never-started planned slot or bypass active delivery guard", async () => {
    slot = plannedSlot();
    const before = stopWrites;
    await handler("stop")(req, response().res);
    assert.equal(slot.status, "planned");
    slot.status = "active";
    hasOrders = true;
    const res = response();
    await handler("stop")(req, res.res);
    assert.equal(res.state.status, 409);
    assert.equal(res.state.body.error, "ACTIVE_DELIVERY_REQUIRES_SUPPORT");
    assert.equal(stopWrites, before);
    hasOrders = false;
  });

  await t.test("actual sweep loads startedAt and current interval, but still cuts at the real weekly quota", async (s) => {
    const sweepNow = new Date("2026-11-04T19:00:00Z");
    const plan: any = { riderId, tenantId, weeklyHours: 10, shifts: [{ weekday: 3, start: "12:00", end: "16:00" }] };
    const current = { ...plannedSlot(), status: "active", startedAt: new Date("2026-11-04T17:00:00Z") };
    const historical: any = { riderId, tenantId, date: "2026-11-02", startTime: "12:00", endTime: "00:00", status: "completed", startedAt: new Date("2026-11-02T11:00:00Z"), stoppedAt: new Date("2026-11-02T17:00:00Z") };
    let includeCurrent = true;
    const selections: string[] = [];
    s.mock.method(shifts.RiderShiftPlanModel as any, "find", () => query([plan]));
    s.mock.method(shifts.ShiftSweepRun as any, "create", async () => ({}));
    s.mock.method(Order as any, "find", () => query([]));
    s.mock.method(Rider as any, "find", () => query([{ ...rider, status: "available" }]));
    s.mock.method(RiderSlot as any, "find", (filter: any) => {
      const value = filter.$or ? (includeCurrent ? [current] : []) : (includeCurrent ? [historical, current] : []);
      const q = query(value);
      q.select = (fields: string) => { selections.push(fields); return q; };
      return q;
    });
    let report = await shifts.runShiftSweep({ apply: false, now: sweepNow });
    assert.equal(report.checked, 1);
    assert.equal(report.loggedOut, 0); // Six hours historical + two hours current.
    assert.ok(selections.some((fields) => fields.includes("startedAt") && fields.includes("stoppedAt")));
    historical.stoppedAt = new Date("2026-11-02T19:00:00Z"); // Eight + two = ten real hours.
    report = await shifts.runShiftSweep({ apply: false, now: sweepNow });
    assert.equal(report.loggedOut, 1);
    assert.equal(report.actions[0].reason, "jornada_completa");
    includeCurrent = false;
    report = await shifts.runShiftSweep({ apply: false, now: sweepNow });
    assert.equal(report.actions[0].reason, "fuera_de_tramo");
  });
});
