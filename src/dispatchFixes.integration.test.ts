import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";
import { CUSTOMER_ORDERABLE_RESTAURANT_FILTER } from "./customerCatalogPolicy.js";

function query(value: any): any {
  const q: any = { select: () => q, lean: () => q, sort: () => q, limit: () => q, session: () => q, exec: async () => value, then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject) };
  return q;
}
function response() {
  const state: any = { status: 200 };
  const res: any = { status: (code: number) => { state.status = code; return res; }, json: (body: any) => { state.body = body; return res; }, setHeader: () => res };
  return { state, res };
}

// Evaluate the actual Mongo predicates, including persisted legacy listingType.
function matchesRestaurant(row: any, filter: any): boolean {
  const equal = (a: any, b: any) => a?.toHexString || b?.toHexString ? String(a) === String(b) : a === b;
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (key === "$or") return expected.some((clause: any) => matchesRestaurant(row, clause));
    const actual = key.split(".").reduce((value, part) => value?.[part], row);
    if (expected && typeof expected === "object" && !expected.toHexString) {
      return Object.entries(expected).every(([operator, value]: [string, any]) => {
        if (operator === "$in") return value.some((candidate: any) => equal(actual, candidate));
        if (operator === "$nin") return !value.some((candidate: any) => equal(actual, candidate));
        if (operator === "$ne") return !equal(actual, value);
        if (operator === "$exists") return (actual !== undefined) === value;
        assert.fail(`Unsupported Restaurant fixture predicate: ${operator}`);
      });
    }
    return equal(actual, expected);
  });
}

// This file invokes handlers directly. No port, database or outbound transport is allowed.
test("dispatch fixes: real handlers with in-memory persistence and forbidden external I/O", async (t) => {
  process.env.PIKI_NO_LISTEN = "true";
  process.env.NODE_ENV = "test";
  process.env.DOTENV_CONFIG_PATH = "/dev/null";
  process.env.PIKI_CUSTOMER_SYNC_SECRET = "offline-test-only";
  delete process.env.GOOGLE_MAPS_API_KEY;
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

  const RealDate = Date;
  const fixed = RealDate.parse("2026-11-10T23:30:00.000Z"); // Madrid 11 November, 00:30
  class FixedDate extends RealDate {
    constructor(value?: any) { super(value === undefined ? fixed : value); }
    static now() { return fixed; }
  }
  t.after(() => { (globalThis as any).Date = RealDate; });

  const models = await import("./models.js");
  const { Order, Restaurant, Rider, RiderSlot, RiderAssignmentReservation, DispatchDecision, RealtimeEvent, CustomerAccount, DispatchOutbox, EmployeeAccount } = models;
  const customer = await import("./customerCompat.js");
  const { dispatchVehicleInputForOrder } = await import("./dispatchVehiclePolicy.js");
  const { evaluateDispatchVehicleEligibility } = await import("./dispatch.js");
  const { isDispatchablePayment } = await import("./dispatchEligibility.js");
  const { EmployeeSession } = await import("./employeeSessions.js");
  const { RiderShiftPlanModel } = await import("./shiftPlans.js");
  const { startRealtimeRelay, stopRealtimeRelay } = await import("./realtime.js");
  const server = await import("./server.js");
  const paymentPolicy = await import("./paymentPolicy.js");
  (globalThis as any).Date = FixedDate;
  const previousDb = Object.getOwnPropertyDescriptor(mongoose.connection, "db");
  const previousState = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
  Object.defineProperty(mongoose.connection, "db", { configurable: true, value: { admin: () => ({ ping: async () => ({ ok: 1 }) }) } });
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, get: () => 1 });
  t.after(() => {
    stopRealtimeRelay();
    if (previousDb) Object.defineProperty(mongoose.connection, "db", previousDb); else delete (mongoose.connection as any).db;
    if (previousState) Object.defineProperty(mongoose.connection, "readyState", previousState); else delete (mongoose.connection as any).readyState;
  });
  const id = () => new mongoose.Types.ObjectId();
  const tenantId = id(), restaurantId = id(), riderId = id(), customerId = id();
  const point: [number, number] = [-0.521111, 38.990276];
  const restaurant: any = { _id: restaurantId, tenantId, name: "Ficticio", slug: "offline-ficticio", isActive: true, onboardingStatus: "approved", availabilityStatus: "available", listingType: "restaurant", location: { type: "Point", coordinates: point }, partnerProfile: {}, priceIncludesCommission: true, menu: [{ id: "item-1", name: "Producto", price: 6, category: "Comida" }] };
  const rider: any = { _id: riderId, tenantId, email: "offline@example.invalid", lifecycleStatus: "active", status: "available", vehicle: "electric_bike", location: restaurant.location, lastLocationAt: new Date() };
  const paidOrder = (): any => ({ _id: id(), tenantId, restaurantId, publicCode: "OFFLINE-ORDER", totalCents: 899, status: "pending", paymentMethod: "stripe", paymentState: "paid", assignmentState: "unassigned", riderId: null, version: 0, dispatchAttempts: 0, pickupLocation: restaurant.location, deliveryLocation: restaurant.location, routeDistanceKm: 1, routingDegraded: false });
  const slot: any = { _id: id(), riderId, tenantId, date: "2026-11-10", startTime: "20:00", endTime: "02:00", status: "active", startedAt: new Date("2026-11-10T19:00:00Z") };
  const sessionEmployee = { _id: customerId, tenantId, email: rider.email, active: true, authorizationStatus: "approved", mustChangePassword: false, apiRole: "rider", roles: ["rider"] };
  t.mock.method(models.Tenant as any, "findOne", () => query({ _id: tenantId, status: "active" }));
  t.mock.method(EmployeeAccount as any, "findOne", () => query(sessionEmployee));
  t.mock.method(EmployeeSession as any, "find", () => query([{ _id: customerId, employeeId: customerId, tenantId, tokenHash: "offline-only", role: "rider", surface: "rider", issuedAt: new Date(fixed - 60_000), expiresAt: new Date(fixed + 3600_000) }]));
  t.mock.method(EmployeeSession as any, "exists", () => query(true));
  t.mock.method(RiderShiftPlanModel as any, "findOne", () => query({ riderId, tenantId, weeklyHours: 40, shifts: [{ weekday: 2, start: "20:00", end: "02:00" }] }));
  t.mock.method(Order as any, "find", () => query([]));
  t.mock.method(Restaurant as any, "findOne", () => query(restaurant));
  t.mock.method(Restaurant as any, "findById", () => query(null));
  t.mock.method(CustomerAccount as any, "findOne", () => query({ _id: customerId, name: "Ficticio", email: "offline@example.invalid" }));
  t.mock.method(CustomerAccount as any, "findById", () => query(null));
  t.mock.method(EmployeeAccount as any, "find", () => query([]));
  t.mock.method(Rider as any, "findById", () => query(null));
  t.mock.method(DispatchOutbox as any, "updateOne", () => query({ modifiedCount: 1 }));
  t.mock.method(DispatchOutbox as any, "findOne", () => query({ eventId: "offline-event" }));
  t.mock.method(mongoose, "startSession", async () => ({ withTransaction: async (fn: any) => fn(), endSession: async () => {} }) as any);
  t.mock.method(RealtimeEvent as any, "findOneAndUpdate", (_filter: any, update: any) => query({ toObject: () => ({ _id: id(), ...update.$setOnInsert, createdAt: new Date() }) }));
  t.mock.method(Order as any, "countDocuments", () => query(1));
  t.mock.method(Rider as any, "countDocuments", () => query(1));
  t.mock.method(Order as any, "aggregate", async () => []);
  t.mock.method(RiderSlot as any, "find", () => query([{ ...slot }]));
  t.mock.method(Rider as any, "find", () => query([rider]));
  t.mock.method(RiderAssignmentReservation as any, "find", () => query([]));
  t.mock.method(RiderAssignmentReservation as any, "findOneAndUpdate", () => query({ _id: id(), riderId, slot: 1 }));
  t.mock.method(Rider as any, "findOneAndUpdate", () => query({ ...rider, status: "busy" }));
  t.mock.method(DispatchDecision as any, "create", async () => ({ _id: id() }));

  function customerRestaurantFixture(s: any, initial = restaurant) {
    let persisted = { ...initial };
    let inTransaction = false, ended = false, locks = 0;
    const session = { withTransaction: async (fn: any) => { inTransaction = true; try { return await fn(); } finally { inTransaction = false; } }, endSession: async () => { ended = true; } };
    s.mock.method(mongoose, "startSession", async () => session as any);
    s.mock.method(Restaurant as any, "findOne", (filter: any) => query(matchesRestaurant(persisted, filter) ? { ...persisted } : null));
    s.mock.method(Restaurant as any, "updateOne", (filter: any, update: any, options: any) => {
      if (update.$inc) {
        assert.deepEqual(filter, { _id: initial._id, ...CUSTOMER_ORDERABLE_RESTAURANT_FILTER });
        assert.deepEqual(update, { $inc: { __v: 1 } });
        assert.equal(options?.session, session);
        assert.equal(options?.timestamps, false);
        assert.equal(inTransaction, true);
        assert.equal(persisted.menu[0].price, 6);
        assert.equal(persisted.priceIncludesCommission, true);
      } else {
        assert.equal(inTransaction, false, "legacy geocode repair precedes checkout transaction");
        assert.deepEqual(filter, { _id: restaurantId });
        assert.deepEqual(update, { $set: { location: { type: "Point", coordinates: point } } });
      }
      const matchedCount = matchesRestaurant(persisted, filter) ? 1 : 0;
      if (matchedCount) {
        if ("$inc" in update) { locks++; persisted = { ...persisted, __v: (persisted.__v || 0) + 1 }; }
        else persisted = { ...persisted, ...update.$set };
      }
      return query({ matchedCount, modifiedCount: matchedCount });
    });
    return { session, assertComplete() { assert.equal(locks, 1); assert.equal(ended, true); assert.equal(inTransaction, false); }, assertCreating() { assert.equal(inTransaction, true); assert.equal(locks, 1); } };
  }

  for (const procedure of ["order.create", "order.checkout"]) {
    await t.test(`${procedure}: saves the resolved pickup snapshot, routing and cash gate`, async (s) => {
      const previousCashPaymentsEnabled = paymentPolicy.CASH_PAYMENTS_ENABLED;
      paymentPolicy.setCashPaymentsEnabled(true);
      s.after(() => paymentPolicy.setCashPaymentsEnabled(previousCashPaymentsEnabled));
      const fixture = customerRestaurantFixture(s);
      let stored: any;
      let creations = 0;
      s.mock.method(Order as any, "create", async (input: any[], options: any) => { fixture.assertCreating(); assert.equal(options?.session, fixture.session); creations++; stored = new Order(input[0]).toObject(); return [new Order(stored)]; });
      s.mock.method(globalThis, "fetch", async (url: any) => {
        assert.match(String(url), /^https:\/\/router\.project-osrm\.org\/route\/v1\/driving\//);
        return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 1000, duration: 180 }] }), { status: 200 });
      });
      const req: any = { path: `/api/trpc/${procedure}`, originalUrl: `/api/trpc/${procedure}`, params: { procedure }, query: {}, body: { json: { restaurantId: String(restaurantId), items: [{ id: "item-1", quantity: 1 }], paymentMethod: "cash", address: "Calle ficticia 1", deliveryLocation: { latitude: point[1], longitude: point[0] } } }, header: (name: string) => name === "x-piki-session" ? "offline-session" : undefined };
      const { res, state } = response();
      await customer.handleCustomerTrpc(req, res);
      assert.equal(state.status, 200, JSON.stringify(state.body));
      assert.deepEqual(stored.pickupLocation, restaurant.location);
      assert.equal(stored.routeDistanceKm, 1);
      assert.equal(stored.paymentState, "pending");
      assert.equal(isDispatchablePayment(stored.paymentState, "cash", stored.totalCents), false);
      assert.equal(stored.cashWithoutCardApproved, false, "default policy never approves unsecured cash");
      assert.equal(evaluateDispatchVehicleEligibility("electric_bike", dispatchVehicleInputForOrder(stored)).eligible, true);
      assert.equal(stored.subtotalCents, 600);
      assert.equal(stored.creditAppliedCents, 0);
      assert.equal(stored.totalCents, 899);
      assert.equal(creations, 1);
      assert.equal(state.body.result.data.json.checkoutUrl, null);
      fixture.assertComplete();
    });
  }

  const cashScope = await import("./cashCardGuaranteeScope.js");
  for (const merchantId of cashScope.CASH_WITHOUT_CARD_RESTAURANT_IDS) for (const procedure of ["order.create", "order.checkout"]) {
    await t.test(`${procedure}: persists approved pending cash only for Kazoku ${merchantId}`, async (s) => {
      const previous = paymentPolicy.CASH_PAYMENTS_ENABLED;
      paymentPolicy.setCashPaymentsEnabled(true); s.after(() => paymentPolicy.setCashPaymentsEnabled(previous));
      const kazoku = { ...restaurant, _id: new mongoose.Types.ObjectId(merchantId), tenantId: new mongoose.Types.ObjectId(cashScope.CASH_WITHOUT_CARD_TENANT_ID), cashPaymentsEnabled: true, partnerProfile: { cashCardGuaranteeRequired: false } };
      const fixture = customerRestaurantFixture(s, kazoku); let stored: any;
      s.mock.method(Order as any, "create", async (input: any[], options: any) => { fixture.assertCreating(); assert.equal(options.session, fixture.session); const doc = new Order(input[0]); stored = doc.toObject(); return [doc]; });
      s.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 1000, duration: 180 }] }), { status: 200 }));
      const req: any = { path: `/api/trpc/${procedure}`, originalUrl: `/api/trpc/${procedure}`, params: { procedure }, query: {}, body: { json: { restaurantId: merchantId, items: [{ id: "item-1", quantity: 1 }], paymentMethod: "cash", cashWithoutCardApproved: false, address: "Calle ficticia 1", deliveryLocation: { latitude: point[1], longitude: point[0] } } }, header: (name: string) => name === "x-piki-session" ? "offline-session" : undefined };
      const { res, state } = response(); await customer.handleCustomerTrpc(req, res);
      assert.equal(state.status, 200, JSON.stringify(state.body)); assert.equal(stored.cashWithoutCardApproved, true);
      assert.equal(stored.paymentState, "pending"); assert.equal(stored.customerId, String(customerId));
      assert.equal(stored.stripePaymentIntentId, null); assert.equal(stored.stripeCheckoutSessionId, null);
      assert.equal(isDispatchablePayment(stored.paymentState, stored.paymentMethod, stored.totalCents, stored), true);
      assert.equal(state.body.result.data.json.cashWithoutCardApproved, true); assert.equal(state.body.result.data.json.checkoutUrl, null);
      fixture.assertComplete();
    });
  }
  await t.test("client approval claim cannot bypass missing customer authentication in checkout or REST create", async (s) => {
    s.mock.method(CustomerAccount as any, "findOne", () => query(null));
    const kazoku = { ...restaurant, _id: new mongoose.Types.ObjectId(cashScope.CASH_WITHOUT_CARD_RESTAURANT_IDS[0]), tenantId: new mongoose.Types.ObjectId(cashScope.CASH_WITHOUT_CARD_TENANT_ID), cashPaymentsEnabled: true, partnerProfile: { cashCardGuaranteeRequired: false } };
    s.mock.method(Restaurant as any, "findOne", () => query(kazoku));
    const input = { restaurantId: String(kazoku._id), cashWithoutCardApproved: true, paymentMethod: "cash", items: [{ id: "item-1", itemId: "item-1", quantity: 1 }], deliveryAddress: "Calle ficticia 1", deliveryLocation: { latitude: point[1], longitude: point[0] } };
    for (const procedure of ["order.create", "order.checkout"]) {
      const { res, state } = response();
      await customer.handleCustomerTrpc({ path: `/api/trpc/${procedure}`, originalUrl: `/api/trpc/${procedure}`, params: { procedure }, query: {}, body: { json: input }, header: () => undefined } as any, res);
      assert.ok(state.status >= 400);
    }
    const { res, state } = response();
    const route = (server.app as any)._router.stack.find((layer: any) => layer.route?.path === "/api/v1/orders" && layer.route?.methods?.post).route;
    await route.stack.at(-1).handle({ body: input, header: () => undefined }, res);
    assert.equal(state.status, 401); assert.equal(state.body.error, "AUTH_REQUIRED");
  });

  await t.test("REST create persists server-approved cash and scoped payments/status capabilities", async (s) => {
    const { PikiPassSubscription, CustomerDeliverySaving } = await import("./customerEngagement.js");
    s.mock.method(PikiPassSubscription as any, "findOne", () => query(null));
    s.mock.method(CustomerDeliverySaving as any, "find", () => query([]));
    const kazoku = { ...restaurant, _id: new mongoose.Types.ObjectId(cashScope.CASH_WITHOUT_CARD_RESTAURANT_IDS[0]), tenantId: new mongoose.Types.ObjectId(cashScope.CASH_WITHOUT_CARD_TENANT_ID), cashPaymentsEnabled: true, partnerProfile: { cashCardGuaranteeRequired: false } };
    s.mock.method(Restaurant as any, "findOne", () => query(kazoku));
    s.mock.method(Restaurant as any, "updateOne", () => query({ matchedCount: 1 }));
    s.mock.method(Order as any, "exists", () => query(false));
    s.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 1000, duration: 180 }] }), { status: 200 }));
    let stored: any;
    s.mock.method(Order as any, "create", async (input: any[], options: any) => { assert.ok(options.session); const doc = new Order(input[0]); stored = doc.toObject(); return [doc]; });
    const input = { restaurantId: String(kazoku._id), paymentMethod: "cash", cashWithoutCardApproved: false, items: [{ itemId: "item-1", quantity: 1 }], deliveryAddress: "Calle ficticia 1", deliveryLocation: { latitude: point[1], longitude: point[0] } };
    const route = (server.app as any)._router.stack.find((layer: any) => layer.route?.path === "/api/v1/orders" && layer.route?.methods?.post).route;
    const { res, state } = response(); await route.stack.at(-1).handle({ body: input, header: (name: string) => name === "x-piki-session" ? "offline-session" : undefined }, res);
    assert.equal(state.status, 201, JSON.stringify(state.body)); assert.equal(stored.cashWithoutCardApproved, true);
    assert.equal(stored.paymentState, "pending"); assert.equal(isDispatchablePayment(stored.paymentState, stored.paymentMethod, stored.totalCents, stored), true);
    const scoped = response(); await handler("/api/v1/payments/status")({ query: { restaurantId: String(kazoku._id) } }, scoped.res);
    assert.equal(scoped.state.body.cashCardGuaranteeRequired, false); assert.equal(scoped.state.body.cashPaymentsEnabled, true);
    assert.equal(scoped.state.body.tenantId, undefined);
  });

  await t.test("order.get and customer.orders.list select/publish canonical cash approval booleans", async (s) => {
    let selected: string[] = [];
    const rows = [true, false, undefined, null, "true"].map((flag, index) => ({ _id: id(), publicCode: `OFFLINE-READ-${index}`, restaurantId, tenantId, customerId: String(customerId), status: "pending", paymentMethod: "cash", paymentState: "pending", cashWithoutCardApproved: flag, totalCents: 899, riderId: null }));
    const projected = (value: any) => { const q = query(value); q.select = (fields: string) => { selected.push(fields); return q; }; return q; };
    s.mock.method(Order as any, "find", (filter: any) => { assert.equal(filter.customerId, String(customerId)); return projected(rows); });
    s.mock.method(Order as any, "findOne", (filter: any) => { assert.equal(filter.customerId, String(customerId)); return projected(rows.find((row) => row.publicCode === filter.publicCode)); });
    s.mock.method(Restaurant as any, "find", () => query([]));
    const req = (procedure: string, input = {}) => ({ path: `/api/trpc/${procedure}`, originalUrl: `/api/trpc/${procedure}`, params: { procedure }, query: {}, body: { json: input }, header: (name: string) => name === "x-piki-session" ? "offline-session" : undefined });
    let r = response(); await customer.handleCustomerTrpc(req("customer.orders.list") as any, r.res);
    assert.equal(r.state.status, 200, JSON.stringify(r.state.body));
    assert.deepEqual(r.state.body.result.data.json.map((row: any) => row.cashWithoutCardApproved), [true, false, false, false, false]);
    for (const [index, row] of rows.entries()) {
      r = response(); await customer.handleCustomerTrpc(req("order.get", { id: row.publicCode, cashWithoutCardApproved: true }) as any, r.res);
      assert.equal(r.state.body.result.data.json.cashWithoutCardApproved, index === 0);
      assert.equal(r.state.body.result.data.json.paymentState, index === 0 ? "pending_cash_collection" : "pending");
    }
    assert.equal(selected.length, 6); assert.ok(selected.every((fields) => fields.split(" ").includes("cashWithoutCardApproved")));
  });

  await t.test("Customer snapshots the geocoded point, even when the original row has no location", async (s) => {
    const missing = { ...restaurant, location: undefined, address: "Calle ficticia 123", locality: "Xativa" };
    const fixture = customerRestaurantFixture(s, missing);
    s.mock.method(globalThis, "fetch", async (url: any) => {
      assert.match(String(url), /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
      return new Response(JSON.stringify([{ lat: String(point[1]), lon: String(point[0]) }]), { status: 200 });
    });
    let stored: any;
    let creations = 0;
    s.mock.method(Order as any, "create", async (input: any[], options: any) => { fixture.assertCreating(); assert.equal(options?.session, fixture.session); creations++; stored = new Order(input[0]).toObject(); return [new Order(stored)]; });
    const req: any = { path: "/api/trpc/order.create", originalUrl: "/api/trpc/order.create", params: { procedure: "order.create" }, query: {}, body: { json: { restaurantId: String(restaurantId), items: [{ id: "item-1", quantity: 1 }], paymentMethod: "stripe", address: "Calle ficticia 1", deliveryLocation: { latitude: point[1], longitude: point[0] } } }, header: () => "offline-session" };
    const { res, state } = response();
    await customer.handleCustomerTrpc(req, res);
    assert.equal(state.status, 200, JSON.stringify(state.body));
    assert.deepEqual(stored.pickupLocation.coordinates, point);
    assert.equal(missing.location, undefined);
    assert.equal(stored.subtotalCents, 600);
    assert.equal(stored.creditAppliedCents, 0);
    assert.equal(stored.totalCents, 899);
    assert.equal(creations, 1);
    fixture.assertComplete();
  });

  function dispatchFixture(s: any, initial = paidOrder()) {
    let stored = initial;
    let assignments = 0;
    let busy = Boolean(initial.riderId);
    let reserved: any = initial.riderId ? { _id: id(), tenantId, riderId, orderId: initial._id, slot: 1, status: "reserved" } : null;
    s.mock.method(Rider as any, "findOne", () => query({ ...rider, status: busy ? "busy" : "available", activeOrderId: busy ? stored._id : null }));
    s.mock.method(Rider as any, "exists", () => query(true));
    s.mock.method(Rider as any, "findOneAndUpdate", (_filter: any, update: any) => {
      if (update.$set.status === "busy") busy = true;
      return query({ ...rider, status: busy ? "busy" : "available", activeOrderId: busy ? stored._id : null });
    });
    s.mock.method(RiderAssignmentReservation as any, "find", () => query(reserved?.status === "reserved" ? [reserved] : []));
    s.mock.method(RiderAssignmentReservation as any, "findOneAndUpdate", () => {
      reserved = { _id: id(), tenantId, riderId, orderId: stored._id, slot: 1, status: "reserved" };
      return query(reserved);
    });
    s.mock.method(RiderAssignmentReservation as any, "exists", () => query(Boolean(reserved)));
    s.mock.method(RiderAssignmentReservation as any, "updateOne", (_filter: any, update: any) => {
      if (reserved) Object.assign(reserved, update.$set); return query({ modifiedCount: 1 });
    });
    s.mock.method(Order as any, "findOne", () => query(stored));
    s.mock.method(Order as any, "find", () => query(stored.riderId ? [stored] : []));
    s.mock.method(Order as any, "exists", () => query(true));
    s.mock.method(Order as any, "findById", () => query(stored));
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => {
      assignments++;
      stored = { ...stored, ...update.$set, dispatchAttempts: (stored.dispatchAttempts || 0) + 1, version: (stored.version || 0) + 1 };
      return query(stored);
    });
    return { get stored() { return stored; }, get assignments() { return assignments; } };
  }
  await t.test("paid Customer-shaped order gets a real automatic offer with fresh light vehicle and night slot", async (s) => {
    const f = dispatchFixture(s);
    const result = await server.queueAutomaticDispatch(f.stored._id);
    assert.equal(result.state, "offered");
    assert.equal(f.stored.assignmentState, "offered");
    assert.equal(String(f.stored.riderId), String(riderId));
    assert.equal(f.assignments, 1);
  });
  for (const failurePoint of ["realtime", "decision"]) {
    await t.test(`offer survives ${failurePoint} failure and retry republishes without another reservation`, async (s) => {
      const f = dispatchFixture(s);
      let failing = true;
      let publishAttempts = 0;
      const events = new Map<string, any>();
      s.mock.method(DispatchDecision as any, "create", async () => {
        if (failurePoint === "decision" && failing) throw new Error("MOCK_DECISION_FAILURE");
        return { _id: id() };
      });
      s.mock.method(RealtimeEvent as any, "findOneAndUpdate", (filter: any, update: any) => {
        publishAttempts++;
        if (failurePoint === "realtime" && failing) throw new Error("MOCK_REALTIME_FAILURE");
        if (!events.has(filter.dedupeKey)) events.set(filter.dedupeKey, { _id: id(), ...update.$setOnInsert, createdAt: new Date() });
        return query({ toObject: () => events.get(filter.dedupeKey) });
      });
      await assert.rejects(server.queueAutomaticDispatch(f.stored._id), /MOCK_(REALTIME|DECISION)_FAILURE/);
      assert.equal(f.stored.assignmentState, "offered");
      const offerId = f.stored.offerId;
      failing = false;
      assert.equal((await server.queueAutomaticDispatch(f.stored._id)).state, "already_assigned");
      assert.equal((await server.queueAutomaticDispatch(f.stored._id)).state, "already_assigned");
      assert.equal(f.assignments, 1);
      assert.equal(f.stored.offerId, offerId);
      assert.equal(events.size, 1);
      assert.ok(publishAttempts >= 2);
      assert.equal([...events.values()][0].audienceKey, `rider:${riderId}`);
      assert.equal(String([...events.values()][0].tenantId), String(tenantId));
    });
  }
  await t.test("publication keeps failing on retry: exception is not acknowledged as already_assigned", async (s) => {
    const initial = { ...paidOrder(), riderId, assignmentState: "offered", offerId: "offline-offer", assignmentExpiresAt: new Date(fixed + 60_000) };
    const f = dispatchFixture(s, initial);
    s.mock.method(RealtimeEvent as any, "findOneAndUpdate", () => { throw new Error("MOCK_PERSIST_FAILURE"); });
    await assert.rejects(server.queueAutomaticDispatch(f.stored._id), /MOCK_PERSIST_FAILURE/);
    await assert.rejects(server.queueAutomaticDispatch(f.stored._id), /MOCK_PERSIST_FAILURE/);
    assert.equal(f.assignments, 0);
  });
  await t.test("never republishes expired/accepted/terminal/unpaid offers", async (s) => {
    let publications = 0;
    s.mock.method(RealtimeEvent as any, "findOneAndUpdate", () => { publications++; return query(null); });
    for (const override of [
      { assignmentState: "offered", assignmentExpiresAt: new Date(fixed) },
      { assignmentState: "assigned", assignmentExpiresAt: new Date(fixed + 60_000) },
      { assignmentState: "offered", status: "cancelled", assignmentExpiresAt: new Date(fixed + 60_000) },
      { assignmentState: "offered", paymentMethod: "cash", paymentState: "pending", assignmentExpiresAt: new Date(fixed + 60_000) },
    ]) {
      const stored = { ...paidOrder(), riderId, ...override };
      s.mock.method(Order as any, "findById", () => query(stored));
      await server.queueAutomaticDispatch(stored._id);
    }
    assert.equal(publications, 0);
  });

  function handler(path: string) {
    const route = (server.app as any)._router.stack.find((layer: any) => layer.route?.path === path).route;
    return route.stack[route.stack.length - 1].handle;
  }
  await t.test("real confirm-delivery accepts auto-captured paid Stripe and replay does not charge or settle twice", async (s) => {
    let stored = { ...paidOrder(), riderId, assignmentState: "assigned", status: "on_the_way", isTestOrder: true, stripePaymentIntentId: "pi_offline_paid", partnerPayoutCents: 899 };
    let deliveries = 0;
    let ledgerEntries = 0;
    s.mock.method(EmployeeAccount as any, "findOne", () => query({ email: "offline@example.invalid", tenantId }));
    s.mock.method(Rider as any, "findOne", () => query(rider));
    s.mock.method(Rider as any, "findById", () => query(rider));
    s.mock.method(Order as any, "findOne", () => query(stored));
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => {
      if (update.$set.status === "delivered") { deliveries++; stored = { ...stored, ...update.$set }; }
      return query(stored);
    });
    s.mock.method(Order as any, "updateOne", () => query({ modifiedCount: 1 }));
    s.mock.method(models.MarketplaceLedgerEntry as any, "updateOne", () => { ledgerEntries++; return query({ modifiedCount: 1 }); });
    s.mock.method(models.RiderOrderMessage as any, "deleteMany", () => query({ deletedCount: 0 }));
    s.mock.method(RiderAssignmentReservation as any, "updateOne", () => query({ modifiedCount: 1 }));
    s.mock.method(RiderAssignmentReservation as any, "countDocuments", () => query(0));
    s.mock.method(Rider as any, "updateOne", () => query({ modifiedCount: 1 }));
    s.mock.method(models.CashLedgerEntry as any, "findOneAndUpdate", forbidden);
    const pin = createHmac("sha256", "development-only-delivery-qr-secret").update(`delivery:${stored.publicCode}`).digest("hex").slice(0, 24).slice(-6).toUpperCase();
    const req: any = { params: { riderId: String(riderId), orderId: String(stored._id) }, auth: { employeeId: String(customerId), tenantId, role: "rider" }, body: { method: "pin", credential: pin, idempotencyKey: "offline-delivery-1" } };
    const first = response();
    await handler("/api/v1/riders/:riderId/orders/:orderId/confirm-delivery")(req, first.res, forbidden);
    assert.equal(first.state.status, 200, JSON.stringify(first.state.body));
    assert.equal(first.state.body.order.status, "delivered");
    assert.equal(first.state.body.idempotent, false);
    const replay = response();
    await handler("/api/v1/riders/:riderId/orders/:orderId/confirm-delivery")(req, replay.res, forbidden);
    assert.equal(replay.state.status, 200);
    assert.equal(replay.state.body.idempotent, true);
    assert.equal(deliveries, 1);
    assert.equal(ledgerEntries, 4, "one settlement set only");
    assert.equal(stored.paymentState, "paid");
    // No Stripe client is configured and network transports throw. A capture
    // attempt would have returned PAYMENT_CAPTURE_FAILED rather than HTTP 200.
  });
  await t.test("two real session GETs at 00:30 retain yesterday's active shift and online rider", async (s) => {
    let status = "available";
    const storedSlot = { ...slot };
    s.mock.method(EmployeeAccount as any, "findOne", () => query({ email: "offline@example.invalid", tenantId }));
    s.mock.method(Rider as any, "findOne", () => query({ ...rider, status }));
    s.mock.method(Order as any, "exists", () => query(false));
    s.mock.method(RiderSlot as any, "find", (filter: any) => query((filter.status?.$in || [filter.status]).includes(storedSlot.status) ? [{ ...storedSlot }] : []));
    s.mock.method(RiderSlot as any, "updateMany", (filter: any) => {
      if (filter._id?.$in?.some((value: any) => String(value) === String(storedSlot._id)) || (filter.date?.$lt && storedSlot.date < filter.date.$lt)) storedSlot.status = "completed";
      return query({ modifiedCount: 1 });
    });
    s.mock.method(Rider as any, "updateOne", (_filter: any, update: any) => { status = update.$set.status; return query({ modifiedCount: 1 }); });
    for (let call = 0; call < 2; call++) {
      const { state, res } = response();
      await handler("/api/v1/riders/session")({ auth: { employeeId: String(customerId), tenantId, role: "rider" } }, res, forbidden);
      assert.equal(state.body.slot?.status, "active");
      assert.equal(state.body.rider.status, "available");
      assert.equal(storedSlot.status, "active");
    }
  });

  const syncInput: any = { publicCode: "OFFLINE-SYNC", restaurantSlug: restaurant.slug, deliveryAddress: "Calle ficticia 1", deliveryLocation: { latitude: point[1], longitude: point[0] }, items: [{ itemId: "item-1", name: "Producto", quantity: 1, unitPriceCents: 600 }], subtotalCents: 600, deliveryFeeCents: 299, serviceFeeCents: 0, totalCents: 899, paymentMethod: "stripe", paymentState: "pending" };
  async function sync(input: any, authenticated = false) {
    const { state, res } = response();
    await handler("/api/v1/internal/customer-orders/sync")({ body: input, header: (name: string) => name === "x-piki-customer-sync-secret" ? "offline-test-only" : name === "x-piki-session" && authenticated ? "offline-session" : undefined }, res, forbidden);
    return state;
  }
  await t.test("new sync needs actual customer auth, persists approval insert-only and cannot convert old Stripe", async (s) => {
    const kazoku = { ...restaurant, _id: new mongoose.Types.ObjectId(cashScope.CASH_WITHOUT_CARD_RESTAURANT_IDS[0]), tenantId: new mongoose.Types.ObjectId(cashScope.CASH_WITHOUT_CARD_TENANT_ID), cashPaymentsEnabled: true, partnerProfile: { cashCardGuaranteeRequired: false } };
    s.mock.method(Restaurant as any, "findOne", () => query(kazoku));
    s.mock.method(Restaurant as any, "updateOne", () => query({ matchedCount: 1 }));
    let existing: any = null; let stored: any; let writes = 0; let onReplayRead: (() => void) | null = null;
    s.mock.method(Order as any, "findOne", (filter: any) => {
      if (filter._id) { onReplayRead?.(); onReplayRead = null; return query(matchesRestaurant(existing, filter) ? existing : null); }
      return query(existing);
    });
    s.mock.method(Order as any, "findById", () => query(stored));
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => {
      writes++; assert.equal(update.$set.cashWithoutCardApproved, undefined);
      stored = { _id: id(), ...(existing || update.$setOnInsert), ...update.$set }; return query(stored);
    });
    s.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 1000, duration: 180 }] }), { status: 200 }));
    const input = { ...syncInput, restaurantSlug: String(kazoku._id), customerId: String(customerId), paymentMethod: "cash", cashWithoutCardApproved: true };
    const denied = await sync(input); assert.equal(denied.status, 401); assert.equal(writes, 0);
    const wrong = await sync({ ...input, customerId: String(id()) }, true); assert.equal(wrong.status, 401); assert.equal(writes, 0);
    const fakePaid = await sync({ ...input, paymentState: "paid" }, true); assert.equal(fakePaid.status, 409); assert.equal(writes, 0);
    const created = await sync(input, true); assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(stored.cashWithoutCardApproved, true); assert.equal(stored.paymentState, "pending");
    existing = stored;
    const noAuthReplay = await sync(input); assert.equal(noAuthReplay.status, 401); assert.equal(writes, 1);
    const validReplay = await sync(input, true); assert.equal(validReplay.status, 200, JSON.stringify(validReplay.body));
    assert.equal(validReplay.body.idempotent, true); assert.equal(validReplay.body.order.paymentState, "pending_cash_collection"); assert.equal(writes, 1);
    const oldPrice = kazoku.menu[0].price; kazoku.menu[0].price = oldPrice + 1;
    const stalePrice = await sync(input, true); assert.equal(stalePrice.status, 409); assert.equal(stalePrice.body.error, "SYNC_CASH_CANONICAL_SNAPSHOT_MISMATCH"); assert.equal(writes, 1);
    kazoku.menu[0].price = oldPrice;
    const changedCanonical = await sync({ ...input, items: [{ ...input.items[0], quantity: 2 }] }, true);
    assert.equal(changedCanonical.status, 409); assert.equal(writes, 1);
    onReplayRead = () => { existing.paymentState = "paid"; existing.version = (existing.version || 0) + 1; };
    const concurrentCollection = await sync(input, true); assert.equal(concurrentCollection.status, 409); assert.equal(concurrentCollection.body.error, "SYNC_CASH_SNAPSHOT_CHANGED");
    assert.equal(existing.paymentState, "paid"); assert.equal(writes, 1);
    const pendingAfterPaid = await sync(input, true); assert.equal(pendingAfterPaid.status, 409); assert.equal(existing.paymentState, "paid");
    const paidReplay = await sync({ ...input, paymentState: "paid" }, true); assert.equal(paidReplay.status, 200); assert.equal(paidReplay.body.order.paymentState, "paid"); assert.equal(writes, 1);
    const replay = await sync({ ...input, paymentMethod: "stripe" }, true); assert.equal(replay.status, 409); assert.equal(writes, 1);
    existing = { ...stored, paymentState: "pending", cashWithoutCardApproved: false, paymentMethod: "stripe", stripeCheckoutSessionId: "cs_original_pending" };
    const legacy = await sync(input, true); assert.equal(legacy.status, 409); assert.equal(writes, 1);
    assert.equal(existing.paymentMethod, "stripe"); assert.equal(existing.stripeCheckoutSessionId, "cs_original_pending");
    assert.equal(isDispatchablePayment(existing.paymentState, existing.paymentMethod, existing.totalCents, existing), false);
  });
  await t.test("sync insertion derives pickup/routing server-side; ignores client vehicle claims", async (s) => {
    s.mock.method(Order as any, "findOne", () => query(null));
    s.mock.method(globalThis, "fetch", async (url: any) => {
      assert.match(String(url), /^https:\/\/router\.project-osrm\.org\/route\/v1\/driving\//);
      return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 1000, duration: 180 }] }), { status: 200 });
    });
    let written: any;
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => { written = update; return query({ _id: id(), ...update.$setOnInsert, ...update.$set }); });
    const deliveryLocation = { latitude: point[1] + 0.001, longitude: point[0] + 0.001 };
    const result = await sync({ ...syncInput, deliveryLocation, pickupLocation: { coordinates: [0, 0] }, routeDistanceKm: 0.01, withinMunicipality: false });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.deepEqual(written.$setOnInsert.pickupLocation.coordinates, point);
    assert.equal(written.$setOnInsert.routeDistanceKm, 1);
    assert.equal(written.$setOnInsert.withinMunicipality, true);
    assert.equal(written.$set.routeDistanceKm, undefined, "routing is insert-only");
  });
  await t.test("new paid sync has no Mongo update-path conflict; payment replay never resets live assignment", async (s) => {
    let existing: any = null;
    let written: any;
    let stored: any;
    s.mock.method(Order as any, "findOne", () => query(existing));
    s.mock.method(Order as any, "findById", () => query(stored));
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => {
      written = update;
      for (const key of Object.keys(update.$set)) assert.equal(key in update.$setOnInsert, false, `conflicting Mongo path: ${key}`);
      stored = { _id: id(), ...(existing || update.$setOnInsert), ...update.$set };
      return query(stored);
    });
    const inserted = await sync({ ...syncInput, paymentState: "paid" });
    assert.equal(inserted.status, 201, JSON.stringify(inserted.body));
    assert.equal(stored.status, "pending");
    assert.equal(written.$set.assignmentState, undefined);
    existing = { ...paidOrder(), status: "preparing", paymentState: "pending", assignmentState: "offered", riderId };
    const replay = await sync({ ...syncInput, paymentState: "authorized" });
    assert.equal(replay.status, 200);
    assert.equal(stored.status, "preparing");
    assert.equal(stored.assignmentState, "offered");
    assert.equal(String(stored.riderId), String(riderId));
  });
  await t.test("sync replay without coordinates preserves existing destination and all routing", async (s) => {
    const existing = { ...paidOrder(), paymentState: "pending" };
    s.mock.method(Order as any, "findOne", () => query(existing));
    let written: any;
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => { written = update; return query({ ...existing, ...update.$set }); });
    const result = await sync({ ...syncInput, deliveryLocation: undefined });
    assert.equal(result.status, 200);
    assert.deepEqual(written.$set.deliveryLocation, existing.deliveryLocation);
    assert.equal(written.$set.pickupLocation, undefined);
    assert.equal(written.$setOnInsert.routeDistanceKm, undefined);
  });
  await t.test("sync rejects missing destination on new order, invalid coordinates and geography changes", async (s) => {
    let existing: any = null;
    s.mock.method(Order as any, "findOne", () => query(existing));
    s.mock.method(Order as any, "findOneAndUpdate", forbidden);
    assert.equal((await sync({ ...syncInput, deliveryLocation: undefined })).body.error, "DELIVERY_LOCATION_REQUIRED");
    assert.equal((await sync({ ...syncInput, deliveryLocation: { latitude: 100, longitude: 0 } })).body.error, "DELIVERY_LOCATION_REQUIRED");
    existing = paidOrder();
    assert.equal((await sync({ ...syncInput, deliveryLocation: { latitude: point[1] + 0.01, longitude: point[0] } })).body.error, "SYNC_GEOGRAPHY_CHANGE_REQUIRES_REQUOTE");
  });
  await t.test("sync routing failure remains degraded and excludes light vehicles", async (s) => {
    s.mock.method(Order as any, "findOne", () => query(null));
    let stored: any;
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => { stored = { _id: id(), ...update.$setOnInsert, ...update.$set }; return query(stored); });
    const destination = { latitude: point[1] + 0.001, longitude: point[0] };
    const result = await sync({ ...syncInput, deliveryLocation: destination });
    assert.equal(result.status, 201);
    assert.equal(stored.routeDistanceKm, null);
    assert.equal(stored.routingDegraded, true);
    assert.equal(evaluateDispatchVehicleEligibility("electric_bike", dispatchVehicleInputForOrder(stored)).eligible, false);
  });
  await t.test("real relay wiring retries watch after an error while DB stays connected", async (s) => {
    const changes: any[] = [];
    s.mock.method(RealtimeEvent as any, "watch", () => {
      const emitter = Object.assign(new EventEmitter(), { close: async () => {} });
      changes.push(emitter);
      return emitter;
    });
    startRealtimeRelay(); startRealtimeRelay();
    assert.equal(changes.length, 1);
    changes[0].emit("error", new Error("MOCK_STREAM_DROP"));
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(changes.length, 2);
    stopRealtimeRelay();
  });
});
