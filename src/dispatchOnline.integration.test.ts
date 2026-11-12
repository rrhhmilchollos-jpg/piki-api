import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";

function copy(value: any): any {
  if (value instanceof Date) return new Date(value);
  if (value instanceof mongoose.Types.ObjectId) return value;
  if (Array.isArray(value)) return value.map(copy);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copy(v)]));
  return value;
}
function same(a: any, b: any): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (a instanceof mongoose.Types.ObjectId || b instanceof mongoose.Types.ObjectId) return String(a) === String(b);
  return typeof a === "object" ? JSON.stringify(a) === JSON.stringify(b) : a === b;
}
function matches(doc: any, filter: any): boolean {
  if (!doc) return false;
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (key === "$or") return expected.some((part: any) => matches(doc, part));
    const actual = doc[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date) && !(expected instanceof mongoose.Types.ObjectId)
      && Object.keys(expected).some((k) => k.startsWith("$"))) {
      return Object.entries(expected).every(([op, v]: [string, any]) => {
        if (op === "$near") return true; // Ranking owns distance; not a spatial DB emulator.
        if (op === "$in") return v.some((item: any) => same(actual, item));
        if (op === "$nin") return !v.some((item: any) => same(actual, item));
        if (op === "$ne") return !same(actual, v);
        if (op === "$exists") return (actual !== undefined) === v;
        if (actual == null) return false;
        if (op === "$gt") return actual > v;
        if (op === "$gte") return actual >= v;
        if (op === "$lt") return actual < v;
        if (op === "$lte") return actual <= v;
        throw new Error(`Unsupported mock predicate ${op}`);
      });
    }
    return same(actual, expected);
  });
}
function query(value: any): any {
  const q: any = { select: () => q, lean: () => q, sort: () => q, limit: () => q, session: () => q,
    exec: async () => copy(value), then: (yes: any, no: any) => Promise.resolve(copy(value)).then(yes, no) };
  return q;
}
function response() {
  const state: any = { status: 200 };
  const res: any = { status: (status: number) => { state.status = status; return res; }, json: (body: any) => { state.body = body; return res; }, setHeader: () => {} };
  return { state, res };
}

test("dispatch online P0: guarded real handlers, memory CAS and forbidden external I/O", async (t) => {
  const models = await import("./models.js");
  const sessions = await import("./employeeSessions.js");
  const shifts = await import("./shiftPlans.js");
  const policy = await import("./dispatchOnlinePolicy.js");
  const { RiderShiftIncentiveMetric } = await import("./riderIncentivesModels.js");
  const reservation = await import("./dispatchReservation.js");
  const { hashSessionToken } = await import("./employeeAuth.js");
  const server = await import("./server.js"); // PIKI_NO_LISTEN from offline-validation; never import worker.
  const RealDate = Date;
  let now = RealDate.parse("2026-11-13T18:00:00Z"); // Friday 19:00 Madrid.
  class FixedDate extends RealDate { constructor(value?: any) { super(value === undefined ? now : value); } static now() { return now; } }
  (globalThis as any).Date = FixedDate;
  const previousDb = Object.getOwnPropertyDescriptor(mongoose.connection, "db");
  const previousState = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
  Object.defineProperty(mongoose.connection, "db", { configurable: true, value: { admin: () => ({ ping: async () => ({ ok: 1 }) }) } });
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
  t.after(() => {
    (globalThis as any).Date = RealDate;
    if (previousDb) Object.defineProperty(mongoose.connection, "db", previousDb); else delete (mongoose.connection as any).db;
    if (previousState) Object.defineProperty(mongoose.connection, "readyState", previousState); else delete (mongoose.connection as any).readyState;
  });
  const id = () => new mongoose.Types.ObjectId();
  const paths = ["/api/v1/riders/:riderId/orders/:orderId/accept-offer", "/api/v1/dispatch/orders/:id/offer-response"];
  function handler(path: string) {
    const route = (server.app as any)._router.stack.find((layer: any) => layer.route?.path === path).route;
    return route.stack.at(-1).handle;
  }
  function fixture(s: any, offered = false) {
    now = RealDate.parse("2026-11-13T18:00:00Z");
    const tenantId = id(), riderId = id(), orderId = id(), employeeId = id(), restaurantId = id();
    const point = { type: "Point", coordinates: [-0.521111, 38.990276] };
    const tenant: any = { _id: tenantId, status: "active" };
    const rider: any = { _id: riderId, tenantId, email: "rider@offline.invalid", lifecycleStatus: "active", status: offered ? "busy" : "available",
      vehicle: "electric_bike", location: point, lastLocationAt: new Date(), activeOrderId: offered ? orderId : null, updatedAt: new Date(now - 100) };
    const employee: any = { _id: employeeId, tenantId, email: rider.email, active: true, authorizationStatus: "approved", mustChangePassword: false, apiRole: "rider", roles: ["rider"], passwordChangedAt: null };
    const token = "offline-rider-token";
    const session: any = { _id: id(), employeeId, tenantId, role: "rider", surface: "rider", tokenHash: hashSessionToken(token), issuedAt: new Date(now - 3600_000), expiresAt: new Date(now + 3600_000) };
    const plan: any = { _id: id(), riderId, tenantId, weeklyHours: 40, shifts: [{ weekday: 5, start: "12:00", end: "00:00" }] };
    const slots: any[] = [{ _id: id(), riderId, tenantId, date: "2026-11-13", startTime: "12:00", endTime: "00:00", status: "active", startedAt: new Date("2026-11-13T11:00:00Z"), stoppedAt: null }];
    const order: any = { _id: orderId, tenantId, restaurantId, publicCode: "OFFLINE-P0", status: "pending", paymentState: "authorized", paymentMethod: "stripe", totalCents: 899,
      version: 1, riderId: offered ? riderId : null, assignmentState: offered ? "offered" : "unassigned", offerId: offered ? "offer-p0" : null,
      assignmentExpiresAt: offered ? new Date(now + 180_000) : null, deliveryLocation: point, pickupLocation: point, routeDistanceKm: 1, routingDegraded: false, dispatchAttempts: 0 };
    const reservations: any[] = offered ? [{ _id: id(), tenantId, riderId, orderId, status: "reserved", slot: 1, expiresAt: new Date(now + 180_000) }] : [];
    const orders = [order];
    const events: any[] = [];
    const controls: any = { beforeRiderCas: null, beforeOrderCas: null, beforeSessionExists: null, beforeUnlock: null, reservationWrites: 0, orderWrites: 0, riderCas: [], unlockWrites: 0 };
    let revision = 0;
    function update(doc: any, change: any) {
      Object.assign(doc, copy(change.$set || {}));
      for (const [k, v] of Object.entries(change.$inc || {})) doc[k] = (doc[k] || 0) + Number(v);
      doc.updatedAt = new Date(now + ++revision);
      return doc;
    }
    function find(model: any, rows: any[]) {
      s.mock.method(model, "find", (filter: any) => query(rows.filter((row) => matches(row, filter))));
      s.mock.method(model, "findOne", (filter: any) => query(rows.find((row) => matches(row, filter)) || null));
      s.mock.method(model, "findById", (key: any) => query(rows.find((row) => same(row._id, key)) || null));
      s.mock.method(model, "exists", (filter: any) => query(rows.some((row) => matches(row, filter))));
      s.mock.method(model, "countDocuments", (filter: any) => query(rows.filter((row) => matches(row, filter)).length));
    }
    find(models.Tenant as any, [tenant]); find(models.EmployeeAccount as any, [employee]);
    find(sessions.EmployeeSession as any, [session]); find(shifts.RiderShiftPlanModel as any, [plan]);
    find(models.Rider as any, [rider]); find(models.RiderSlot as any, slots);
    find(models.Order as any, orders); find(models.RiderAssignmentReservation as any, reservations);
    s.mock.method(sessions.EmployeeSession as any, "exists", (filter: any) => { controls.beforeSessionExists?.(); return query(matches(session, filter)); });
    s.mock.method(models.Rider as any, "findOneAndUpdate", (filter: any, change: any) => {
      controls.riderCas.push(copy(filter)); controls.beforeRiderCas?.(filter, change);
      return query(matches(rider, filter) ? update(rider, change) : null);
    });
    s.mock.method(models.Rider as any, "updateOne", (filter: any, change: any) => {
      controls.beforeUnlock?.();
      const matched = matches(rider, filter);
      if (matched) { update(rider, change); controls.unlockWrites++; }
      return query({ matchedCount: Number(matched), modifiedCount: Number(matched) });
    });
    s.mock.method(models.Order as any, "findOneAndUpdate", (filter: any, change: any) => {
      controls.beforeOrderCas?.();
      if (!matches(order, filter)) return query(null);
      controls.orderWrites++; return query(update(order, change));
    });
    s.mock.method(models.Order as any, "aggregate", async () => {
      const count = orders.filter((row) => same(row.riderId, riderId) && ["offered", "assigned"].includes(row.assignmentState) && !["cancelled", "delivered"].includes(row.status)).length;
      return count ? [{ _id: riderId, count }] : [];
    });
    s.mock.method(models.RiderAssignmentReservation as any, "findOneAndUpdate", (filter: any, change: any) => {
      if (reservations.some((row) => same(row.orderId, filter.orderId) && row.status === "reserved")) throw Object.assign(new Error("duplicate"), { code: 11000 });
      let row = reservations.find((r) => matches(r, filter));
      if (!row) { row = { _id: id(), tenantId: filter.tenantId, ...change.$setOnInsert }; reservations.push(row); }
      if (reservations.some((r) => r !== row && same(r.riderId, change.$set.riderId) && r.status === "reserved" && r.slot === change.$set.slot)) throw Object.assign(new Error("slot duplicate"), { code: 11000 });
      controls.reservationWrites++; return query(update(row, change));
    });
    s.mock.method(models.RiderAssignmentReservation as any, "updateOne", (filter: any, change: any) => {
      const row = reservations.find((r) => matches(r, filter));
      if (row) update(row, change);
      return query({ matchedCount: Number(Boolean(row)), modifiedCount: Number(Boolean(row)) });
    });
    s.mock.method(models.Restaurant as any, "findOne", () => query({ _id: restaurantId, tenantId, location: point }));
    s.mock.method(models.Restaurant as any, "find", () => query([]));
    s.mock.method(models.CustomerAccount as any, "find", () => query([]));
    s.mock.method(models.DispatchDecision as any, "create", async () => ({}));
    s.mock.method(models.DispatchDecision as any, "updateMany", () => query({ matchedCount: 1 }));
    s.mock.method(models.DispatchDecision as any, "insertMany", async () => []);
    s.mock.method(models.RealtimeEvent as any, "findOneAndUpdate", (_filter: any, change: any) => {
      const event = { _id: id(), ...change.$setOnInsert, createdAt: new Date() }; events.push(event);
      return query({ toObject: () => event });
    });
    const principal = { employeeId: String(employeeId), tenantId: String(tenantId), tokenHash: session.tokenHash };
    const req: any = { params: { riderId: String(riderId), orderId: String(orderId), id: String(orderId) }, auth: { role: "rider", employeeId: String(employeeId), tenantId: String(tenantId) }, body: { accept: true }, header: (key: string) => key === "authorization" ? `Bearer ${token}` : undefined };
    return { tenantId, riderId, orderId, tenant, rider, employee, session, plan, slots, order, orders, reservations, events, controls, req, principal };
  }
  const negatives: Array<[string, (f: any) => void]> = [
    ["offline", (f) => { f.rider.status = "offline"; }],
    ["paused", (f) => { f.rider.status = "paused"; }],
    ["stale GPS", (f) => { f.rider.lastLocationAt = new Date(now - 90_001); }],
    ["future GPS", (f) => { f.rider.lastLocationAt = new Date(now + 1); }],
    ["missing GPS", (f) => { f.rider.location = undefined; }],
    ["expired session", (f) => { f.session.expiresAt = new Date(now); }],
    ["missing session", (f) => { f.session.role = "partner"; }],
    ["future session", (f) => { f.session.issuedAt = new Date(now + 1); }],
    ["frozen tenant mismatch", (f) => { f.session.tenantId = new mongoose.Types.ObjectId(); }],
    ["employee rebound", (f) => { f.employee.tenantId = new mongoose.Types.ObjectId(); }],
    ["inactive account", (f) => { f.employee.active = false; }],
    ["revoked account", (f) => { f.employee.authorizationStatus = "revoked"; }],
    ["revoked role", (f) => { f.employee.roles = ["partner"]; }],
    ["password changed", (f) => { f.employee.passwordChangedAt = new Date(now - 1); }],
    ["temporary password", (f) => { f.employee.mustChangePassword = true; }],
    ["suspended lifecycle", (f) => { f.rider.lifecycleStatus = "suspended"; }],
    ["suspended tenant", (f) => { f.tenant.status = "suspended"; }],
    ["planned 12–00", (f) => { f.slots[0].status = "planned"; }],
    ["slot without real punch", (f) => { f.slots[0].startedAt = null; }],
    ["ended slot", (f) => { f.slots[0].endTime = "19:00"; }],
    ["wrong-tenant slot", (f) => { f.slots[0].tenantId = new mongoose.Types.ObjectId(); }],
    ["no weekly plan", (f) => { f.plan.riderId = new mongoose.Types.ObjectId(); }],
    ["wrong-tenant plan", (f) => { f.plan.tenantId = new mongoose.Types.ObjectId(); }],
    ["invalid weekly plan", (f) => { f.plan.shifts[0].end = "99:00"; }],
    ["weekly quota exhausted", (f) => {
      f.plan.weeklyHours = 10; f.plan.shifts[0].start = "18:00"; f.plan.shifts[0].end = "20:00";
      f.slots.push({ ...f.slots[0], _id: new mongoose.Types.ObjectId(), date: "2026-11-12", status: "completed", startTime: "00:00", endTime: "12:00", startedAt: new Date("2026-11-11T23:00:00Z"), stoppedAt: new Date("2026-11-12T11:00:00Z") });
    }],
  ];
  for (const [name, change] of negatives) {
    await t.test(`selection and reservation reject ${name} without reserving`, async (s) => {
      const f = fixture(s); change(f);
      assert.equal(await policy.loadDispatchOnlineGuard(f.riderId, f.tenantId, 1), null);
      assert.equal(await reservation.reserveRiderOrderSlot(f.riderId, f.orderId, { tenantId: f.tenantId }), null);
      assert.equal(f.controls.reservationWrites, 0); assert.equal(f.controls.orderWrites, 0);
    });
    for (const path of paths) await t.test(`${path.split("/").at(-1)} rejects ${name}`, async (s) => {
      const f = fixture(s, true); change(f);
      const r = response(); await handler(path)(f.req, r.res);
      assert.ok(r.state.status >= 400, JSON.stringify(r.state.body)); assert.equal(f.controls.orderWrites, 0); assert.equal(f.events.length, 0);
    });
  }
  await t.test("active punched 12–00 slot stays eligible after the shorter recurrent plan end without modifying the contract", async (s) => {
    const f = fixture(s); f.plan.shifts[0].end = "18:00";
    const guard = await policy.loadDispatchOnlineGuard(f.riderId, f.tenantId, 1);
    assert.ok(guard); assert.equal(guard.slot.endTime, "00:00");
    assert.equal(f.plan.shifts[0].end, "18:00"); assert.equal(f.plan.weeklyHours, 40);
    assert.equal(f.controls.reservationWrites, 0); assert.equal(f.controls.orderWrites, 0);
  });
  for (const path of paths) await t.test(`${path.split("/").at(-1)} honours the actually punched 12–00 slot after recurrent plan end`, async (s) => {
    const f = fixture(s, true); f.plan.shifts[0].end = "18:00";
    const r = response(); await handler(path)(f.req, r.res);
    assert.equal(r.state.status, 200, JSON.stringify(r.state.body));
    assert.equal(f.order.assignmentState, "assigned"); assert.equal(f.plan.shifts[0].end, "18:00");
  });
  for (const [name, change] of [
    ["expired offer", (f: any) => { f.order.assignmentExpiresAt = new Date(now); }],
    ["missing TTL", (f: any) => { f.order.assignmentExpiresAt = null; }],
    ["unpaid cash", (f: any) => { f.order.paymentState = "pending"; f.order.paymentMethod = "cash"; }],
    ["terminal", (f: any) => { f.order.status = "cancelled"; }],
    ["wrong tenant", (f: any) => { f.order.tenantId = id(); }],
    ["wrong rider", (f: any) => { f.order.riderId = id(); }],
    ["missing reservation", (f: any) => { f.reservations.length = 0; }],
    ["wrong caller token", (f: any) => { f.req.header = () => "Bearer revoked-token"; }],
    ["already assigned", (f: any) => { f.order.assignmentState = "assigned"; }],
    ["expired reservation", (f: any) => { f.reservations[0].expiresAt = new Date(now); }],
    ["incompatible vehicle", (f: any) => { f.order.routingDegraded = true; }],
    ["capacity exceeded", (f: any) => {
      for (let slot = 2; slot <= 3; slot++) f.reservations.push({ ...copy(f.reservations[0]), _id: id(), orderId: id(), slot });
    }],
  ] as Array<[string, (f: any) => void]>) {
    for (const path of paths) await t.test(`accept rejects ${name}: ${path}`, async (s) => {
      const f = fixture(s, true); change(f); const r = response(); await handler(path)(f.req, r.res);
      assert.ok(r.state.status >= 400); assert.equal(f.controls.orderWrites, 0);
    });
  }
  await t.test("available authenticated active rider gets an automatic offer; no synthetic ONLINE", async (s) => {
    const f = fixture(s); const result = await server.queueAutomaticDispatch(f.orderId);
    assert.equal(result.state, "offered"); assert.equal(f.rider.status, "busy"); assert.equal(f.reservations.filter((r) => r.status === "reserved").length, 1);
    assert.ok(f.order.assignmentExpiresAt > new Date()); assert.equal(f.controls.orderWrites, 1);
    assert.ok(f.controls.riderCas.every((filter: any) => filter.email && filter.lastLocationAt && filter.lifecycleStatus === "active"));
  });
  for (const path of paths) await t.test(`valid offer accepted with operative payment and exact token: ${path}`, async (s) => {
    const f = fixture(s, true); const r = response(); await handler(path)(f.req, r.res);
    assert.equal(r.state.status, 200, JSON.stringify(r.state.body)); assert.equal(f.order.assignmentState, "assigned"); assert.equal(f.order.assignmentExpiresAt, null);
  });
  await t.test("saturation permits second reservation, never third or normal-load second", async (s) => {
    const f = fixture(s, true); const next = { ...copy(f.order), _id: id(), riderId: null, assignmentState: "unassigned", offerId: null }; f.orders.push(next);
    assert.equal(await reservation.reserveRiderOrderSlot(f.riderId, next._id, { tenantId: f.tenantId }, 1), null);
    const second = await reservation.reserveRiderOrderSlot(f.riderId, next._id, { tenantId: f.tenantId }, 2);
    assert.ok(second); assert.equal(second!.reservation.slot, 2);
    const third = { ...copy(next), _id: id() }; f.orders.push(third);
    assert.equal(await reservation.reserveRiderOrderSlot(f.riderId, third._id, { tenantId: f.tenantId }, 2), null);
  });
  for (const mutate of ["offline", "GPS", "identity", "link"]) await t.test(`reservation Rider CAS loses concurrent ${mutate}`, async (s) => {
    const f = fixture(s); f.controls.beforeRiderCas = (_filter: any, change: any) => {
      if (change.$set.status !== "busy") return;
      if (mutate === "offline") f.rider.status = "offline";
      if (mutate === "GPS") f.rider.lastLocationAt = new Date(now - 100_000);
      if (mutate === "identity") f.rider.email = "rebound@offline.invalid";
      if (mutate === "link") f.rider.activeOrderId = id();
    };
    assert.equal(await reservation.reserveRiderOrderSlot(f.riderId, f.orderId, { tenantId: f.tenantId }), null);
    assert.equal(f.reservations.filter((r) => r.status === "reserved").length, 0);
  });
  await t.test("revocation on final session confirmation blocks reservation before slot write", async (s) => {
    const f = fixture(s); f.controls.beforeSessionExists = () => { f.session.expiresAt = new Date(now); };
    assert.equal(await reservation.reserveRiderOrderSlot(f.riderId, f.orderId, { tenantId: f.tenantId }), null);
    assert.equal(f.controls.reservationWrites, 0);
  });
  for (const mutate of ["payment", "terminal", "version", "offer", "expiry"]) await t.test(`accept Order CAS rejects concurrent ${mutate}`, async (s) => {
    const f = fixture(s, true); f.controls.beforeOrderCas = () => {
      if (mutate === "payment") f.order.paymentState = "refunded";
      if (mutate === "terminal") f.order.status = "delivered";
      if (mutate === "version") f.order.version++;
      if (mutate === "offer") f.order.offerId = "replacement-offer";
      if (mutate === "expiry") f.order.assignmentExpiresAt = new Date(now);
    };
    const r = response(); await handler(paths[0])(f.req, r.res);
    assert.equal(r.state.status, 409); assert.equal(f.controls.orderWrites, 0);
  });
  await t.test("payment CAS change after reservation releases capacity, not an unpaid offer", async (s) => {
    const f = fixture(s); f.controls.beforeOrderCas = () => { f.order.paymentState = "refunded"; };
    const result = await server.queueAutomaticDispatch(f.orderId);
    assert.equal(result.state, "not_dispatchable"); assert.equal(f.controls.orderWrites, 0); assert.equal(f.reservations.filter((r) => r.status === "reserved").length, 0);
  });
  for (const status of ["offline", "paused", "busy"]) await t.test(`release preserves ${status} after disconnect/revoke`, async (s) => {
    const f = fixture(s, true); f.order.status = "delivered"; f.rider.status = status;
    if (status === "busy") f.employee.authorizationStatus = "revoked";
    await reservation.releaseRiderOrderSlot(f.orderId, f.riderId);
    assert.equal(f.rider.status, status); assert.equal(f.rider.activeOrderId, null);
  });
  await t.test("release retains second order link and busy capacity", async (s) => {
    const f = fixture(s, true); f.order.status = "delivered";
    const second = { ...copy(f.order), _id: id(), status: "on_the_way", assignmentState: "assigned" }; f.orders.push(second);
    f.reservations.push({ ...copy(f.reservations[0]), _id: id(), orderId: second._id, slot: 2 });
    await reservation.releaseRiderOrderSlot(f.orderId, f.riderId);
    assert.equal(f.rider.status, "busy"); assert.equal(String(f.rider.activeOrderId), String(second._id));
  });
  await t.test("unlock snapshot CAS preserves concurrent status/link changes", async (s) => {
    const f = fixture(s, true); f.order.status = "delivered"; const other = id();
    f.controls.beforeUnlock = () => { f.rider.status = "offline"; f.rider.activeOrderId = other; };
    await reservation.releaseRiderOrderSlot(f.orderId, f.riderId);
    assert.equal(f.rider.status, "offline"); assert.equal(String(f.rider.activeOrderId), String(other)); assert.equal(f.controls.unlockWrites, 0);
  });
  await t.test("busy assigned GPS after midnight updates telemetry, not status/slot/session TTL", async (s) => {
    const f = fixture(s, true); f.order.assignmentState = "assigned"; f.order.status = "on_the_way";
    now = RealDate.parse("2026-11-13T23:30:00Z"); f.session.expiresAt = new Date(now + 3600_000); const expiry = f.session.expiresAt.toISOString();
    s.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (fn: any) => fn(), endSession: async () => {} }) as any);
    s.mock.method(RiderShiftIncentiveMetric as any, "findOne", () => query(null));
    const req = { ...f.req, params: { id: String(f.riderId) }, body: { latitude: 38.990276, longitude: -0.521111 } };
    const r = response(); await handler("/api/v1/riders/:id/location")(req, r.res);
    assert.equal(r.state.status, 200); assert.equal(f.rider.status, "busy"); assert.equal(f.session.expiresAt.toISOString(), expiry); assert.equal(f.slots[0].status, "active");
    assert.equal(await policy.loadDispatchOnlineGuard(f.riderId, f.tenantId, 2, { phase: "accept", orderId: f.orderId }), null);
  });
  await t.test("GPS cannot resurrect offline or bypass revoked real session", async (s) => {
    const f = fixture(s, true); f.rider.status = "offline";
    s.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (fn: any) => fn(), endSession: async () => {} }) as any);
    s.mock.method(RiderShiftIncentiveMetric as any, "findOne", () => query(null));
    const req = { ...f.req, params: { id: String(f.riderId) }, body: { latitude: 38.990276, longitude: -0.521111 } };
    const r = response(); await handler("/api/v1/riders/:id/location")(req, r.res);
    assert.equal(r.state.status, 200); assert.equal(f.rider.status, "offline");
    f.session.expiresAt = new Date(now); const denied = response(); await handler("/api/v1/riders/:id/location")(req, denied.res);
    assert.equal(denied.state.status, 409); assert.equal(f.rider.status, "offline");
  });
  await t.test("manual dispatch applies the same guard and finite TTL; cash pending is not a bypass", async (s) => {
    const f = fixture(s); f.req.auth.role = "admin";
    const r = response(); await handler("/api/v1/dispatch/orders/:id/assign")(f.req, r.res);
    assert.equal(r.state.status, 201, JSON.stringify(r.state.body)); assert.ok(r.state.body.assignment.expiresAt > new Date());
    assert.ok(f.order.assignmentExpiresAt > new Date());
    f.order.riderId = null; f.order.assignmentState = "unassigned"; f.order.paymentMethod = "cash"; f.order.paymentState = "pending";
    const denied = response(); await handler("/api/v1/dispatch/orders/:id/assign")(f.req, denied.res);
    assert.equal(denied.state.status, 409); assert.equal(f.controls.orderWrites, 1);
  });
  await t.test("manual preview does not label planned/offline sessions as eligible ONLINE", async (s) => {
    const f = fixture(s); f.req.auth.role = "admin"; f.req.query = {}; f.slots[0].status = "planned";
    const r = response(); await handler("/api/v1/dispatch/orders/:id/preview")(f.req, r.res);
    assert.equal(r.state.status, 200); assert.equal(r.state.body.diagnostic.onlineRiders, 0); assert.equal(r.state.body.candidates.length, 0);
  });
  await t.test("radar filters offered cards by TTL/ACTIVE/quota, retains assigned nonterminal continuity only with real identity", async (s) => {
    const f = fixture(s, true); f.req.params.id = String(f.riderId);
    let r = response(); await handler("/api/v1/riders/:id/offers")(f.req, r.res); assert.equal(r.state.body.offers.length, 1);
    f.slots[0].status = "planned";
    r = response(); await handler("/api/v1/riders/:id/offers")(f.req, r.res); assert.equal(r.state.body.offers.length, 0);
    f.order.assignmentState = "assigned"; f.order.status = "on_the_way"; now = RealDate.parse("2026-11-13T23:30:00Z"); f.session.expiresAt = new Date(now + 3600_000);
    r = response(); await handler("/api/v1/riders/:id/offers")(f.req, r.res); assert.equal(r.state.body.offers.length, 1);
    f.session.expiresAt = new Date(now);
    r = response(); await handler("/api/v1/riders/:id/offers")(f.req, r.res); assert.equal(r.state.status, 409);
  });
  for (const status of ["busy", "offline", "paused"]) await t.test(`two session GETs preserve ${status} with an assigned order`, async (s) => {
    const f = fixture(s, true); f.rider.status = status;
    for (let call = 0; call < 2; call++) {
      const r = response(); await handler("/api/v1/riders/session")(f.req, r.res);
      assert.equal(r.state.status, 200); assert.equal(r.state.body.rider.status, status); assert.equal(f.rider.status, status);
    }
  });
  for (const status of ["busy", "offline"]) await t.test(`batch GPS preserves ${status} and real-session revocation blocks writes`, async (s) => {
    const f = fixture(s, true); f.rider.status = status; const trackingId = id(); let sampleWrites = 0;
    s.mock.method(models.TrackingSession as any, "findOne", () => query({ _id: trackingId, riderId: f.riderId, tenantId: f.tenantId, status: "active" }));
    s.mock.method(models.TrackingSession as any, "updateOne", () => query({ matchedCount: 1 }));
    s.mock.method(models.LocationSample as any, "find", () => query([]));
    s.mock.method(models.LocationSample as any, "insertMany", async () => { sampleWrites++; return []; });
    s.mock.method(RiderShiftIncentiveMetric as any, "findOne", () => query(null));
    s.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (fn: any) => fn(), endSession: async () => {} }) as any);
    const req = { ...f.req, params: { id: String(f.riderId) }, body: { sessionId: String(trackingId), samples: [{ sampleId: "offline-gps-0001", latitude: 38.990276, longitude: -0.521111, accuracyMeters: 4, recordedAt: new Date().toISOString() }] } };
    const r = response(); await handler("/api/v1/riders/:id/location/batch")(req, r.res);
    assert.equal(r.state.status, 202, JSON.stringify(r.state.body)); assert.equal(f.rider.status, status); assert.equal(sampleWrites, 1);
    f.session.expiresAt = new Date(now);
    const denied = response(); await handler("/api/v1/riders/:id/location/batch")(req, denied.res);
    assert.equal(denied.state.status, 409); assert.equal(sampleWrites, 1);
  });
  await t.test("revocation during batch preparation is re-read before transaction effects", async (s) => {
    const f = fixture(s, true); const trackingId = id(); let writes = 0;
    s.mock.method(models.TrackingSession as any, "findOne", () => query({ _id: trackingId }));
    s.mock.method(models.LocationSample as any, "find", () => query([]));
    s.mock.method(models.LocationSample as any, "insertMany", async () => { writes++; return []; });
    s.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (fn: any) => { f.session.expiresAt = new Date(now); await fn(); }, endSession: async () => {} }) as any);
    const req = { ...f.req, params: { id: String(f.riderId) }, body: { sessionId: String(trackingId), samples: [{ sampleId: "offline-gps-race", latitude: 38.990276, longitude: -0.521111, accuracyMeters: 4, recordedAt: new Date().toISOString() }] } };
    const r = response(); await handler("/api/v1/riders/:id/location/batch")(req, r.res);
    assert.equal(r.state.status, 409); assert.equal(writes, 0);
  });
  await t.test("offer replay repairs publication without reserving twice, but revoked identity is not republished", async (s) => {
    const f = fixture(s); let fail = true;
    s.mock.method(models.RealtimeEvent as any, "findOneAndUpdate", (_filter: any, change: any) => {
      if (fail) throw new Error("OFFLINE_PUBLICATION_FAILURE");
      const event = { _id: id(), ...change.$setOnInsert }; f.events.push(event); return query({ toObject: () => event });
    });
    await assert.rejects(server.queueAutomaticDispatch(f.orderId), /OFFLINE_PUBLICATION_FAILURE/);
    assert.equal(f.order.assignmentState, "offered"); fail = false;
    assert.equal((await server.queueAutomaticDispatch(f.orderId)).state, "already_assigned"); assert.equal(f.controls.reservationWrites, 1); assert.equal(f.events.length, 1);
    f.employee.authorizationStatus = "revoked";
    await server.queueAutomaticDispatch(f.orderId); assert.equal(f.events.length, 1);
  });
});
