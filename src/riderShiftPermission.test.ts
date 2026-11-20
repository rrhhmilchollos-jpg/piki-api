import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import ts from "typescript";
import { Rider, RiderSlot, Order } from "./models.js";
import { RiderShiftPlanModel } from "./shiftPlans.js";
import { riderShiftPermission, riderShiftPermissionError } from "./riderShiftPermission.js";

// Compile actual callbacks only: server.ts is never imported or bootstrapped.
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function handler(path: string, context: Record<string, any>) {
  const statement = source.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
    && s.expression.arguments[0]?.getText(source) === JSON.stringify(path)) as ts.ExpressionStatement;
  assert(statement && ts.isCallExpression(statement.expression));
  const callback = statement.expression.arguments.at(-1)!;
  const js = ts.transpileModule(`return ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), js)(...Object.values(context));
}
function query(value: any): any {
  return { select() { return this; }, lean() { return this; }, sort() { return this; }, limit() { return this; }, exec: async () => value,
    then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject) };
}
function response() {
  return { code: 200, body: null as any, setHeader() {}, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
}
function expression(value: any, document: any): any {
  if (typeof value === "string" && value.startsWith("$")) return document[value.slice(1)];
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  if (value.$cond) return expression(value.$cond[expression(value.$cond[0], document) ? 1 : 2], document);
  if (value.$eq) return expression(value.$eq[0], document) === expression(value.$eq[1], document);
  if (value.$ifNull) return expression(value.$ifNull[0], document) ?? expression(value.$ifNull[1], document);
  throw new Error("UNSUPPORTED_MOCK_EXPRESSION");
}
function harness(t: TestContext, worked = 2437) {
  const instant = Date.parse("2026-11-20T19:43:00Z");
  t.mock.timers.enable({ apis: ["Date"], now: instant });
  const forbidden = () => { throw new Error("EXTERNAL_IO_FORBIDDEN"); };
  t.mock.method(net.Socket.prototype, "connect", forbidden);
  t.mock.method(net.Server.prototype, "listen", forbidden);
  t.mock.method(http, "request", forbidden);
  t.mock.method(https, "request", forbidden);
  t.mock.method(globalThis, "fetch", forbidden);
  t.mock.method(mongoose, "connect", forbidden);
  t.mock.method(mongoose.Query.prototype as any, "exec", forbidden);
  const riderId = new mongoose.Types.ObjectId("6ab743b6c9ebf588e740e506");
  const tenantId = new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
  const rider: any = { _id: riderId, tenantId, status: "offline", riderCode: "OFFLINE", lastLocationAt: new Date(), lifecycleStatus: "active" };
  const state: any = {
    rider, access: true, hasOrders: false, startRace: false, slotWrites: 0, riderWrites: 0, incentiveWrites: 0,
    plan: { riderId, tenantId, weeklyHours: 40, shifts: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "12:00", end: "20:00" })) },
    slot: { _id: new mongoose.Types.ObjectId(), riderId, tenantId, date: "2026-11-20", startTime: "18:30", endTime: "00:00", status: "planned", startedAt: null, stoppedAt: null },
    historical: [] as any[], sessions: [{ token: "OFFLINE_UNCHANGED_TOKEN" }],
  };
  let remaining = worked;
  for (const date of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"]) {
    const minutes = Math.min(720, remaining);
    if (minutes > 0) state.historical.push({ riderId, tenantId, date, startTime: "12:00", endTime: "00:00", status: "completed", startedAt: new Date(`${date}T11:00:00Z`), stoppedAt: new Date(Date.parse(`${date}T11:00:00Z`) + minutes * 60_000) });
    remaining -= minutes;
  }
  assert.equal(remaining, 0);
  t.mock.method(RiderShiftPlanModel as any, "findOne", () => query(state.plan));
  t.mock.method(Rider as any, "findById", () => query({ ...state.rider }));
  t.mock.method(Rider as any, "findByIdAndUpdate", (_id: any, update: any) => { state.riderWrites++; Object.assign(state.rider, update.$set); return query(state.rider); });
  t.mock.method(RiderSlot as any, "find", () => query([...state.historical, ...(state.slot && ["active", "completed"].includes(state.slot.status) ? [state.slot] : [])]));
  t.mock.method(RiderSlot as any, "findOneAndUpdate", (filter: any, update: any) => {
    if (state.startRace || !state.slot || !filter.status.$in.includes(state.slot.status)) return query(null);
    state.slotWrites++;
    const original = { ...state.slot };
    for (const [key, value] of Object.entries(update[0].$set)) state.slot[key] = expression(value, original);
    return query({ ...state.slot });
  });
  t.mock.method(Order as any, "exists", () => query(state.hasOrders));
  const context = {
    objectId: (value: string) => mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null,
    Rider, RiderSlot, Order, riderShiftPermission, riderShiftPermissionError,
    canAccessRiderShift: async () => state.access,
    findCurrentRiderSlot: async () => ({ now: { date: "2026-11-20", time: "20:43", iso: new Date().toISOString(), timeZone: "Europe/Madrid" }, slot: state.slot ? { ...state.slot } : null, selfStartAllowed: Boolean(state.slot) }),
    findNextRiderSlot: async () => null,
    trackRiderShiftStart: async () => { state.incentiveWrites++; },
    publishRealtimeEvent: async () => {}, tenantAudienceKey: () => "offline",
  };
  const request: any = { params: { id: String(riderId) }, auth: { role: "rider", tenantId: String(tenantId) }, body: {} };
  return { state, request,
    get: async () => { const res = response(); await handler("/api/v1/riders/:id/shift", context)(request, res); return res; },
    start: async () => { const res = response(); await handler("/api/v1/riders/:id/shift/start", context)(request, res); return res; },
  };
}
function assertUntouched(state: any, original: any) {
  assert.equal(state.slotWrites, 0); assert.equal(state.riderWrites, 0); assert.equal(state.incentiveWrites, 0);
  assert.deepEqual(structuredClone(state.slot), original); assert.deepEqual(state.sessions, [{ token: "OFFLINE_UNCHANGED_TOKEN" }]);
}
for (const role of ["rider", "admin", "fleet"]) test(`${role}: exhausted 40h quota disables GET start and returns 409 without writes or revocation`, async (t) => {
  const h = harness(t); h.request.auth.role = role;
  const original = structuredClone(h.state.slot);
  const get = await h.get();
  assert.equal(get.code, 200); assert.equal(get.body.eligible, false); assert.equal(get.body.selfStartAllowed, false);
  assert.equal(get.body.blockReason, "jornada_completa"); assert.match(get.body.blockMessage, /40 horas/);
  assert.equal(get.body.weeklyHours, 40); assert.equal(get.body.workedMinutesThisWeek, 2437); assert.equal(get.body.remainingMinutes, 0);
  for (let i = 0; i < 2; i++) {
    const start = await h.start(); assert.equal(start.code, 409); assert.equal(start.body.error, "SHIFT_WEEKLY_LIMIT_REACHED");
    assert.equal(start.body.blockReason, "jornada_completa"); assert.match(start.body.message, /próxima semana/);
  }
  assertUntouched(h.state, original);
});
test("quota denial keeps a current open punch distinct from start permission until the sweep closes it", async (t) => {
  const h = harness(t);
  h.state.slot.status = "active";
  h.state.slot.startedAt = new Date("2026-11-20T19:42:00Z");
  const original = structuredClone(h.state.slot);
  const get = await h.get();
  assert.equal(get.body.eligible, false); assert.equal(get.body.selfStartAllowed, false);
  assert.equal(get.body.hasActiveShift, true); assert.equal(get.body.shift.status, "active");
  assert.equal(get.body.blockReason, "jornada_completa");
  assert.equal((await h.start()).body.error, "SHIFT_WEEKLY_LIMIT_REACHED");
  assertUntouched(h.state, original);
});
for (const minutes of [2399, 2400]) test(`weekly quota threshold remains ${minutes < 2400 ? "allowed" : "blocked"} at ${minutes} minutes`, async (t) => {
  const h = harness(t, minutes);
  const get = await h.get(); assert.equal(get.body.eligible, minutes < 2400); assert.equal(get.body.remainingMinutes, Math.max(0, 2400 - minutes));
  const start = await h.start(); assert.equal(start.code, minutes < 2400 ? 200 : 409);
});
for (const [label, mutate, error, reason] of [
  ["missing plan", (s: any) => { s.plan = null; }, "SHIFT_PLAN_REQUIRED", "sin_plan"],
  ["empty plan", (s: any) => { s.plan.shifts = []; }, "SHIFT_PLAN_INVALID", "plan_invalido"],
  ["invalid weekly hours", (s: any) => { s.plan.weeklyHours = 25; }, "SHIFT_PLAN_INVALID", "plan_invalido"],
  ["overplanned contract", (s: any) => { s.plan.weeklyHours = 10; }, "SHIFT_PLAN_INVALID", "plan_invalido"],
  ["another tenant", (s: any) => { s.plan.tenantId = new mongoose.Types.ObjectId(); }, "SHIFT_PLAN_INVALID", "plan_invalido"],
  ["legacy unbound plan", (s: any) => { s.plan.tenantId = null; }, "SHIFT_PLAN_INVALID", "plan_invalido"],
] as const) test(`${label} fails closed for query and start without changing punches or credentials`, async (t) => {
  const h = harness(t, 120); mutate(h.state); const original = structuredClone(h.state.slot);
  const get = await h.get(); assert.equal(get.body.eligible, false); assert.equal(get.body.selfStartAllowed, false); assert.equal(get.body.blockReason, reason);
  const start = await h.start(); assert.equal(start.code, 409); assert.equal(start.body.error, error);
  assertUntouched(h.state, original);
});
test("Jackson corrected 19:30–23 slot stays eligible after recurrent plan's 20:00 end", async (t) => {
  const h = harness(t, 120); h.state.slot.startTime = "19:30"; h.state.slot.endTime = "23:00";
  const get = await h.get(); assert.equal(get.body.eligible, true); assert.equal(get.body.selfStartAllowed, true); assert.equal(get.body.blockReason, null);
  const start = await h.start(); assert.equal(start.code, 200); assert.equal(h.state.slot.status, "active"); assert.equal(h.state.rider.status, "available");
});
test("start and active replay preserve server punch and ignore client timestamps", async (t) => {
  const h = harness(t, 120); h.request.body.startedAt = "2026-11-20T11:00:00Z";
  const first = await h.start(); assert.equal(first.code, 200); const punch = h.state.slot.startedAt.toISOString();
  t.mock.timers.setTime(Date.now() + 60_000); h.state.rider.lastLocationAt = new Date();
  const replay = await h.start(); assert.equal(replay.code, 200); assert.equal(h.state.slot.startedAt.toISOString(), punch);
});
test("legacy active replay never fabricates a startedAt", async (t) => {
  const h = harness(t, 120); h.state.slot.status = "active"; delete h.state.slot.startedAt;
  const start = await h.start(); assert.equal(start.code, 200); assert.equal(h.state.slot.startedAt, null);
});
test("GPS still blocks a planned start even with valid remaining quota", async (t) => {
  const h = harness(t, 120); h.state.rider.lastLocationAt = null; const original = structuredClone(h.state.slot);
  const get = await h.get(); assert.equal(get.body.eligible, true);
  const start = await h.start(); assert.equal(start.code, 409); assert.equal(start.body.error, "FRESH_LOCATION_REQUIRED"); assertUntouched(h.state, original);
});
test("ownership denial still precedes contractual lookup and any start writes", async (t) => {
  const h = harness(t, 120); h.state.access = false; const original = structuredClone(h.state.slot);
  t.mock.method(RiderShiftPlanModel as any, "findOne", () => { throw new Error("CONTRACT_READ_BEFORE_ACCESS_FORBIDDEN"); });
  assert.equal((await h.get()).code, 403); assert.equal((await h.start()).code, 403); assertUntouched(h.state, original);
});
test("no current assigned slot or another tenant's slot never uses recurrent plan as start permission", async (t) => {
  const h = harness(t, 120); h.state.slot.tenantId = new mongoose.Types.ObjectId(); const original = structuredClone(h.state.slot);
  assert.equal((await h.get()).body.eligible, false); assert.equal((await h.start()).body.error, "SHIFT_OUTSIDE_SCHEDULE"); assertUntouched(h.state, original);
  h.state.slot = null; assert.equal((await h.get()).body.eligible, false); assert.equal((await h.start()).body.error, "SHIFT_OUTSIDE_SCHEDULE");
});
test("concurrent slot closure still returns 409 without bringing rider online", async (t) => {
  const h = harness(t, 120); h.state.startRace = true; const original = structuredClone(h.state.slot);
  const start = await h.start(); assert.equal(start.code, 409); assertUntouched(h.state, original);
});
