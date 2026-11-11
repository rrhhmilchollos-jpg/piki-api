import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createHmac } from "node:crypto";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import mongoose from "mongoose";

function query(value: any): any {
  const q: any = { select: () => q, lean: () => q, sort: () => q, limit: () => q, session: () => q, exec: async () => value, then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject) };
  return q;
}
function response() {
  const state: any = { status: 200 };
  const res: any = { status: (code: number) => { state.status = code; return res; }, json: (body: any) => { state.body = body; return res; }, setHeader: () => res };
  return { state, res };
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
  const { startRealtimeRelay, stopRealtimeRelay } = await import("./realtime.js");
  const server = await import("./server.js");
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
  const restaurant: any = { _id: restaurantId, tenantId, name: "Ficticio", slug: "offline-ficticio", location: { type: "Point", coordinates: point }, partnerProfile: {}, priceIncludesCommission: true, menu: [{ id: "item-1", name: "Producto", price: 6, category: "Comida" }] };
  const rider: any = { _id: riderId, tenantId, status: "available", vehicle: "electric_bike", location: restaurant.location, lastLocationAt: new Date() };
  const paidOrder = (): any => ({ _id: id(), tenantId, restaurantId, publicCode: "OFFLINE-ORDER", totalCents: 899, status: "pending", paymentMethod: "stripe", paymentState: "paid", assignmentState: "unassigned", riderId: null, version: 0, dispatchAttempts: 0, pickupLocation: restaurant.location, deliveryLocation: restaurant.location, routeDistanceKm: 1, routingDegraded: false });
  const slot: any = { _id: id(), riderId, tenantId, date: "2026-11-10", startTime: "20:00", endTime: "02:00", status: "active" };
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

  for (const procedure of ["order.create", "order.checkout"]) {
    await t.test(`${procedure}: saves the resolved pickup snapshot, routing and cash gate`, async (s) => {
      let stored: any;
      s.mock.method(Order as any, "create", async (input: any[]) => { stored = new Order(input[0]).toObject(); return [new Order(stored)]; });
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
      assert.equal(evaluateDispatchVehicleEligibility("electric_bike", dispatchVehicleInputForOrder(stored)).eligible, true);
    });
  }

  await t.test("Customer snapshots the geocoded point, even when the original row has no location", async (s) => {
    const missing = { ...restaurant, location: undefined, address: "Calle ficticia 123", locality: "Xativa" };
    s.mock.method(Restaurant as any, "findOne", () => query(missing));
    s.mock.method(Restaurant as any, "updateOne", () => query({ modifiedCount: 1 }));
    s.mock.method(globalThis, "fetch", async (url: any) => {
      assert.match(String(url), /^https:\/\/nominatim\.openstreetmap\.org\/search\?/);
      return new Response(JSON.stringify([{ lat: String(point[1]), lon: String(point[0]) }]), { status: 200 });
    });
    let stored: any;
    s.mock.method(Order as any, "create", async (input: any[]) => { stored = new Order(input[0]).toObject(); return [new Order(stored)]; });
    const req: any = { path: "/api/trpc/order.create", originalUrl: "/api/trpc/order.create", params: { procedure: "order.create" }, query: {}, body: { json: { restaurantId: String(restaurantId), items: [{ id: "item-1", quantity: 1 }], paymentMethod: "stripe", address: "Calle ficticia 1", deliveryLocation: { latitude: point[1], longitude: point[0] } } }, header: () => "offline-session" };
    const { res, state } = response();
    await customer.handleCustomerTrpc(req, res);
    assert.equal(state.status, 200);
    assert.deepEqual(stored.pickupLocation.coordinates, point);
    assert.equal(missing.location, undefined);
  });

  function dispatchFixture(s: any, initial = paidOrder()) {
    let stored = initial;
    let assignments = 0;
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
  async function sync(input: any) {
    const { state, res } = response();
    await handler("/api/v1/internal/customer-orders/sync")({ body: input, header: () => "offline-test-only" }, res, forbidden);
    return state;
  }
  await t.test("sync insertion derives pickup/routing server-side; ignores client vehicle claims", async (s) => {
    s.mock.method(Order as any, "findOne", () => query(null));
    let written: any;
    s.mock.method(Order as any, "findOneAndUpdate", (_filter: any, update: any) => { written = update; return query({ _id: id(), ...update.$setOnInsert, ...update.$set }); });
    const result = await sync({ ...syncInput, pickupLocation: { coordinates: [0, 0] }, routeDistanceKm: 0.01, withinMunicipality: false });
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
