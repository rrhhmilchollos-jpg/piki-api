import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import mongoose from "mongoose";
import { Order as SchemaOrder, QA_RECEPTION_REQUEST_INDEX } from "./models.js";
import { kitchenRestaurantCanOperate } from "./partnerKitchenAccess.js";
import { validOperationalCoordinates } from "./partnerLocationBackfill.js";
import { buildTenantScope } from "./tenantScope.js";

// Actual route/middleware extraction, as in ownerPartnerPortfolio.test.ts.
// Never import server.ts: no boot, DB, credentials, live identities or sockets.
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const id = (n: number) => `65f0000000000000${n.toString(16).padStart(8, "0")}`;
const ids = { owner: id(1), tenant: id(2), otherTenant: id(3), restaurant: id(4), otherRestaurant: id(5) };
const path = "/api/v1/admin/qa/dispatch-orders";
const clone = (value: any) => structuredClone(value);
function compile(code: string, context: any) {
  const js = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("exports", ...Object.keys(context), `${js}; return subject;`)({}, ...Object.values(context));
}
function helper(file: ts.SourceFile, name: string, context: any) {
  const node = file.statements.find((value) => ts.isFunctionDeclaration(value) && value.name?.text === name);
  assert(node, `Missing actual helper ${name}`);
  return compile(`${node.getText(file)}; const subject = ${name};`, context);
}
function routeNode(method: string, routePath = path) {
  for (const node of source.statements) {
    if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) continue;
    const call = node.expression;
    if (ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === method && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === routePath) return call;
  }
  throw new Error(`Missing actual ${method} route ${routePath}`);
}
function handlers(method: string, context: any, routePath = path): any[] {
  return compile(`const subject = [${routeNode(method, routePath).arguments.slice(1).map((node) => node.getText(source)).join(",\n")}];`, context);
}
function response(): any {
  return { code: 200, body: null, ended: false, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; }, setHeader() {}, end() { this.ended = true; return this; } };
}
const query = (read: () => any) => ({ select() { return this; }, lean() { return this; }, exec: async () => clone(await read()) });
const matches = (row: any, filter: any) => Object.entries(filter).every(([key, value]) => row && String(row[key]) === String(value));
const duplicate = (indexName: string = QA_RECEPTION_REQUEST_INDEX.options.name) => Object.assign(new Error(`E11000 duplicate key error collection: offline.orders index: ${indexName} dup key`), { code: 11000 });
function fixture() {
  const restaurants: any[] = [{ _id: ids.restaurant, tenantId: ids.tenant, slug: "offline-restaurant", isActive: true, onboardingStatus: "approved", availabilityStatus: "available", listingType: "official_partner", location: { type: "Point", coordinates: [-0.5, 39] }, marketplaceCompliance: { pikiStatus: "verified" }, menu: [{ name: "Real menu not ordered", priceCents: 1450, available: true, allergens: [] }] }];
  const owner: any = { _id: ids.owner, email: "owner@example.test", active: true, authorizationStatus: "approved", accessLevel: "superadmin" };
  const orders: any[] = [];
  const calls = { indexes: 0, creates: 0, createAttempts: 0, events: 0, codes: 0, restaurantReads: [] as any[], orderReads: [] as any[], persistedOwnerReads: 0, forbidden: [] as string[], deletes: [] as string[] };
  const options: any = { indexError: null, createError: null, eventError: null, beforeCreate: null, beforeEvent: null };
  const forbidden = (name: string) => () => { calls.forbidden.push(name); throw new Error(`Forbidden sink ${name}`); };
  const cleanupModel = (name: string) => ({ create: forbidden(`${name}.create`), deleteMany: async () => { calls.deletes.push(name); }, deleteOne: async () => { calls.deletes.push(name); } });
  const ctx: any = {
    mongoose, QA_RECEPTION_REQUEST_INDEX, kitchenRestaurantCanOperate, validOperationalCoordinates,
    buildTenantScope, isTemporaryPasswordAllowedPath: () => false, PIKI_OWNER_EMAIL: owner.email,
    resolveRole: async (req: any) => req.auth || null,
    EmployeeAccount: { findOne(filter: any) { calls.persistedOwnerReads++; return query(() => matches(owner, filter) ? owner : null); } },
    tenantScope: (req: any) => buildTenantScope(req.auth?.tenantId),
    objectId: (value: string) => mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null,
    Restaurant: { findOne(filter: any) { calls.restaurantReads.push(filter); return query(() => restaurants.find((row) => matches(row, filter)) || null); } },
    Order: {
      collection: { createIndex: async (keys: any, indexOptions: any) => { calls.indexes++; assert.deepEqual(keys, QA_RECEPTION_REQUEST_INDEX.keys); assert.deepEqual(indexOptions, QA_RECEPTION_REQUEST_INDEX.options); if (options.indexError) throw options.indexError; return indexOptions.name; } },
      findOne(filter: any) { calls.orderReads.push(clone(filter)); return query(() => orders.find((row) => matches(row, filter)) || null); },
      async create(input: any) {
        calls.createAttempts++;
        if (options.beforeCreate) await options.beforeCreate();
        if (options.createError) throw options.createError;
        if (orders.some((row) => matches(row, { tenantId: input.tenantId, restaurantId: input.restaurantId, isTestOrder: true, qaReceptionRequestId: input.qaReceptionRequestId }))) throw duplicate();
        const document = new SchemaOrder({ ...input, _id: id(100 + calls.creates), createdAt: new Date("2026-01-01T00:00:00Z") });
        assert.equal(document.validateSync(), undefined, "actual Mongoose schema must accept the route order");
        const order = JSON.parse(JSON.stringify(document.toObject()));
        orders.push(order); calls.creates++; return clone(order);
      },
      deleteOne: async (filter: any) => { const index = orders.findIndex((row) => matches(row, filter)); if (index >= 0) orders.splice(index, 1); calls.deletes.push("Order"); },
    },
    createOrderCodes: async () => { calls.codes++; return { publicCode: String(12345000 + calls.codes), displayCode: String(calls.codes).padStart(3, "0"), displayCodeDate: "2026-01-01" }; },
    publishOrderIntakeEvents: async (order: any, settlement: any) => {
      calls.events++;
      assert.equal(order.restaurantId, ids.restaurant); assert.equal(order.tenantId, ids.tenant);
      assert.deepEqual(settlement, { settlement: "cash_due", message: "PRUEBA QA · sin cobro, no preparar ni entregar" });
      if (options.beforeEvent) await options.beforeEvent();
      if (options.eventError) throw options.eventError;
    },
    Rider: cleanupModel("Rider"), RiderSlot: cleanupModel("RiderSlot"), SupportTicket: cleanupModel("SupportTicket"),
    DispatchDecision: cleanupModel("DispatchDecision"), RiderAssignmentReservation: cleanupModel("RiderAssignmentReservation"),
    DispatchOutbox: { create: forbidden("DispatchOutbox") },
    notifyOrderPlaced: forbidden("notifyOrderPlaced"), enqueueOrderForDispatch: forbidden("enqueueOrderForDispatch"),
    enqueueDispatchOutbox: forbidden("enqueueDispatchOutbox"), queueAutomaticDispatch: forbidden("queueAutomaticDispatch"),
    postMarketplaceOrderLedger: forbidden("ledger"), stripeClient: forbidden("Stripe"), sendCorporateEmail: forbidden("corporateEmail"),
    employeeScope: forbidden("legacy employeeScope"), releaseRiderOrderSlot: forbidden("releaseRiderOrderSlot"),
  };
  ctx.requireRole = helper(authSource, "requireRole", ctx);
  ctx.requireOwner = helper(authSource, "requireOwner", ctx);
  const promiseDeclaration = source.statements.find((node) => ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === "qaReceptionRequestIndexPromise"));
  const guardDeclaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "ensureQaReceptionRequestIndex");
  assert(promiseDeclaration); assert(guardDeclaration);
  ctx.ensureQaReceptionRequestIndex = compile(`${promiseDeclaration.getText(source)}\n${guardDeclaration.getText(source)}\nconst subject = ensureQaReceptionRequestIndex;`, ctx);
  const request = (body: any = {}): any => ({ body: { mode: "partner_reception", restaurantSlug: restaurants[0].slug, requestId: "offline-reception-1", ...body }, auth: { role: "admin", employeeId: ids.owner, tenantId: ids.tenant, isRootOwner: true }, path, params: {}, headers: {} });
  async function invoke(req = request(), method = "post") {
    const res = response(); const list = handlers(method, ctx, method === "delete" ? `${path}/:id` : path);
    const run = async (index: number): Promise<any> => list[index] ? list[index](req, res, () => run(index + 1)) : undefined;
    await run(0); return res;
  }
  return { restaurants, owner, orders, calls, options, ctx, request, invoke };
}
function noWrites(f: ReturnType<typeof fixture>) {
  assert.equal(f.calls.creates, 0); assert.equal(f.calls.createAttempts, 0); assert.equal(f.calls.codes, 0); assert.equal(f.calls.events, 0); assert.deepEqual(f.calls.forbidden, []);
}

test("schema adds only optional bounded identity and exact partial unique index, without null default", () => {
  const field = SchemaOrder.schema.path("qaReceptionRequestId");
  assert.equal(field.instance, "String"); assert.equal(field.options.maxlength, 80); assert.equal(field.options.default, undefined); assert.equal(field.options.required, undefined);
  const indexes = SchemaOrder.schema.indexes().filter(([, options]: any) => options.name === QA_RECEPTION_REQUEST_INDEX.options.name);
  assert.equal(indexes.length, 1); assert.deepEqual(indexes[0][0], { tenantId: 1, restaurantId: 1, qaReceptionRequestId: 1 });
  assert.equal(indexes[0][1].unique, true); assert.deepEqual(indexes[0][1].partialFilterExpression, { isTestOrder: true, qaReceptionRequestId: { $type: "string" } });
  const document = new SchemaOrder(); assert.equal(document.qaReceptionRequestId, undefined);
  assert(new SchemaOrder({ qaReceptionRequestId: "x".repeat(81) }).validateSync()?.errors.qaReceptionRequestId);
});
for (const denied of ["missingEmployee", "sharedToken", "foreignEmployee", "inactive", "unapproved", "wrongEmail", "subadmin", "partner", "temporary"] as const) test(`actual persisted Owner/admin guards reject ${denied} before sinks`, async () => {
  const f = fixture(); const req = f.request({ email: f.owner.email, accessLevel: "superadmin" });
  if (denied === "missingEmployee" || denied === "sharedToken") delete req.auth.employeeId;
  if (denied === "foreignEmployee") req.auth.employeeId = id(50);
  if (denied === "inactive") f.owner.active = false;
  if (denied === "unapproved") f.owner.authorizationStatus = "pending";
  if (denied === "wrongEmail") f.owner.email = "ordinary@example.test";
  if (denied === "subadmin") f.owner.accessLevel = "subadmin";
  if (denied === "partner") req.auth.role = "partner";
  if (denied === "temporary") req.auth.mustChangePassword = true;
  const res = await f.invoke(req); assert.equal(res.code, denied === "temporary" ? 428 : 403); noWrites(f); assert.equal(f.calls.indexes, 0); assert.equal(f.calls.restaurantReads.length, 0);
});
test("legacy handler remains byte-identical after new conditional; no mode still bypasses Owner/index guard", async () => {
  const handler = routeNode("post").arguments.at(-1)!;
  assert(ts.isArrowFunction(handler) && ts.isBlock(handler.body));
  const branch = handler.body.statements[0]; assert(ts.isIfStatement(branch));
  const currentLegacy = source.text.slice(branch.end, handler.body.end - 1);
  // Original legacy starts with employeeScope; new behavior is prepended only.
  assert(currentLegacy.startsWith("\n  const employee = await employeeScope(req);"));
  // SHA-256 of the actual legacy handler body at approved clean HEAD 98bd10d.
  assert.equal(createHash("sha256").update(currentLegacy).digest("hex"), "5441ec1c20ccf4e5031eefc66c1c09e95e32f35d2f959e818fe6ef49a8547d76");
  assert(!currentLegacy.includes("qaReceptionRequestId"));
  const f = fixture(); const req = f.request(); delete req.body.mode; delete req.auth.employeeId;
  const firstTwo = handlers("post", f.ctx).slice(0, 2); let passes = 0;
  for (const guard of firstTwo) await guard(req, response(), () => { passes++; });
  assert.equal(passes, 2); assert.equal(f.calls.persistedOwnerReads, 0); assert.equal(f.calls.indexes, 0);
  await assert.rejects(f.invoke(req), /legacy employeeScope/); assert.equal(f.calls.indexes, 0);
});
for (const slug of [undefined, "", "OFFLINE-RESTAURANT", " offline-restaurant", "offline-restaurant ", "offline.restaurant", { slug: "offline-restaurant" }]) test(`required exact slug rejects ${JSON.stringify(slug)}`, async () => {
  const f = fixture(); const res = await f.invoke(f.request({ restaurantSlug: slug })); assert.equal(res.code, 400); assert.equal(res.body.error, "INVALID_QA_RESTAURANT_SLUG"); noWrites(f); assert.equal(f.calls.indexes, 0);
});
for (const requestId of [undefined, null, "", " ", 12, {}, [], "x".repeat(81)]) test(`requestId rejects ${JSON.stringify(requestId)}`, async () => {
  const f = fixture(); const res = await f.invoke(f.request({ requestId })); assert.equal(res.code, 400); assert.equal(res.body.error, "INVALID_QA_RECEPTION_REQUEST_ID"); noWrites(f); assert.equal(f.calls.indexes, 0);
});
for (const requestId of ["x", "x".repeat(80)]) test(`requestId length ${requestId.length} accepted exactly`, async () => {
  const f = fixture(); const res = await f.invoke(f.request({ requestId })); assert.equal(res.code, 201); assert.equal(res.body.order.qaReceptionRequestId, requestId);
});
for (const override of [{ isActive: false }, { onboardingStatus: "pending_review" }, { availabilityStatus: "paused" }, { availabilityStatus: "coming_soon" }, { menu: [] }, { menu: [{ available: false, allergens: [] }] }, { menu: [{ available: true, allergens: null }] }, { marketplaceCompliance: { pikiStatus: "pending" } }, { listingType: "local_directory" }, { fulfillmentMode: "assisted_purchase" }, { internalDemo: true }]) test(`not-ready local returns 409 before index/writes ${JSON.stringify(override)}`, async () => {
  const f = fixture(); Object.assign(f.restaurants[0], override); const res = await f.invoke(); assert.equal(res.code, 409); noWrites(f); assert.equal(f.calls.indexes, 0);
});
for (const location of [undefined, { type: "Point", coordinates: [0, 0] }, { type: "Point", coordinates: [181, 39] }, { type: "Point", coordinates: [-0.5, Infinity] }, { type: "Point", coordinates: [-0.5] }, { type: "Point", coordinates: ["-0.5", 39] }, { type: "LineString", coordinates: [-0.5, 39] }]) test(`invalid partner location returns 409 before writes ${JSON.stringify(location)}`, async () => {
  const f = fixture(); f.restaurants[0].location = location; const res = await f.invoke(); assert.equal(res.code, 409); noWrites(f); assert.equal(f.calls.indexes, 0);
});
test("selection uses exact slug and tenant, never name fallback or another tenant", async () => {
  const f = fixture(); f.restaurants.push({ ...clone(f.restaurants[0]), _id: ids.otherRestaurant, tenantId: ids.otherTenant }); f.restaurants[0].name = "Offline restaurant"; f.restaurants[0].slug = "different-slug";
  const res = await f.invoke(f.request({ restaurantSlug: "offline-restaurant" })); assert.equal(res.code, 409); noWrites(f);
  assert.deepEqual(f.calls.restaurantReads[0], { tenantId: ids.tenant, slug: "offline-restaurant", isActive: true, onboardingStatus: "approved" });
});
test("real-schema zero-value pending cash test order uses exact labels/location/tenant/codes, no real sinks", async () => {
  const f = fixture(); const before = clone(f.restaurants); const res = await f.invoke(); assert.equal(res.code, 201);
  const order = res.body.order; assert.equal(order.isTestOrder, true); assert.equal(order.riderId, null); assert.equal(order.qaRiderId, null); assert.equal(order.status, "pending"); assert.equal(order.assignmentState, "unassigned"); assert.equal(order.paymentMethod, "cash"); assert.equal(order.paymentState, "pending"); assert.equal(order.partnerPaymentRequired, false); assert.equal(order.paid, undefined);
  assert.equal(order.customerName, "PIKI QA · prueba recepción"); assert.equal(order.customerId, null);
  assert.deepEqual(order.items, [{ itemId: "qa-partner-reception", name: "PRUEBA QA · NO PREPARAR", quantity: 1, unitPriceCents: 0, selectedOptions: [] }]);
  assert.equal(order.deliveryAddress, "SIMULACIÓN QA · No preparar ni entregar"); assert.equal(order.deliveryNote, "Pedido de prueba QA sin cobro ni entrega real. No preparar comida. Eliminar tras confirmar recepción.");
  assert.deepEqual(order.pickupLocation, f.restaurants[0].location); assert.deepEqual(order.deliveryLocation, f.restaurants[0].location);
  assert.equal(order.tenantId, ids.tenant); assert.equal(order.restaurantId, ids.restaurant); assert.match(order.publicCode, /^\d{8}$/); assert.equal(order.displayCode, order.publicCode.slice(-3));
  for (const [key, value] of Object.entries(order)) if (key.endsWith("Cents")) assert.equal(value, 0, key);
  assert.equal(order.statusHistory[0].actorRole, "admin"); assert.match(order.statusHistory[0].reason, /QA/); assert(!order.statusHistory[0].reason.includes(order.qaReceptionRequestId)); assert(!order.deliveryNote.includes(order.qaReceptionRequestId));
  assert.deepEqual(res.body.qa, { mode: "reception", notification: { published: true } }); assert.equal(res.body.qa.expiresAt, undefined);
  assert.equal(f.calls.events, 1); assert.equal(f.calls.indexes, 1); assert.equal(f.calls.creates, 1); assert.deepEqual(f.calls.forbidden, []); assert.deepEqual(f.restaurants, before);
});
test("publication is awaited before the successful response", async () => {
  const f = fixture(); let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; }); let entered!: () => void; const eventEntered = new Promise<void>((resolve) => { entered = resolve; });
  f.options.beforeEvent = async () => { entered(); await pending; }; let done = false;
  const result = f.invoke().then((res) => { done = true; return res; }); await eventEntered; assert.equal(done, false); release(); assert.equal((await result).body.qa.notification.published, true);
});
test("repeat returns 200 same order; no extra code, writes/events; publication outcome remains unknown", async () => {
  const f = fixture(); const first = await f.invoke(); const repeat = await f.invoke(); assert.equal(repeat.code, 200); assert.deepEqual(repeat.body.order, first.body.order); assert.equal(repeat.body.qa.mode, "reception"); assert.equal(repeat.body.qa.notification.published, null); assert.equal(repeat.body.qa.notification.skipped, "IDEMPOTENT_REPLAY"); assert.equal(repeat.body.qa.expiresAt, undefined);
  assert.equal(f.calls.codes, 1); assert.equal(f.calls.creates, 1); assert.equal(f.calls.events, 1); assert.equal(f.calls.indexes, 1);
  for (const filter of f.calls.orderReads) assert.deepEqual(filter, { tenantId: ids.tenant, restaurantId: ids.restaurant, isTestOrder: true, qaReceptionRequestId: "offline-reception-1" });
});
test("replay cannot match another tenant, restaurant or a commercial order", async () => {
  const f = fixture(); const base = { _id: id(90), tenantId: ids.tenant, restaurantId: ids.restaurant, isTestOrder: true, qaReceptionRequestId: "offline-reception-1" };
  for (const override of [{ tenantId: ids.otherTenant }, { restaurantId: ids.otherRestaurant }, { isTestOrder: false }]) f.orders.push({ ...base, ...override });
  const res = await f.invoke(); assert.equal(res.code, 201); assert.notEqual(res.body.order._id, base._id); assert.equal(f.calls.creates, 1); assert.equal(f.calls.events, 1);
});
test("concurrent requests share one index guard; own E11000 returns winner with only one publication", async () => {
  const f = fixture(); let arrivals = 0; let release!: () => void; const barrier = new Promise<void>((resolve) => { release = resolve; });
  f.options.beforeCreate = async () => { arrivals++; if (arrivals === 2) release(); await barrier; };
  const results = await Promise.all([f.invoke(), f.invoke()]); assert.deepEqual(results.map((res) => res.code).sort(), [200, 201]); assert.equal(results[0].body.order._id, results[1].body.order._id); assert.equal(f.calls.createAttempts, 2); assert.equal(f.calls.creates, 1); assert.equal(f.calls.events, 1); assert.equal(f.calls.indexes, 1); assert.equal(f.orders.length, 1);
});
test("other unique E11000 is never mistaken for reception replay", async () => {
  const f = fixture(); f.options.createError = duplicate("publicCode_1"); await assert.rejects(f.invoke(), /publicCode_1/); assert.equal(f.calls.events, 0); assert.equal(f.calls.creates, 0); assert.equal(f.calls.orderReads.length, 1);
});
test("own index E11000 without scoped winner propagates, no insertion retry/publication", async () => {
  const f = fixture(); f.options.createError = duplicate(); await assert.rejects(f.invoke(), /qa_reception_request_unique/); assert.equal(f.calls.createAttempts, 1); assert.equal(f.calls.events, 0); assert.equal(f.calls.creates, 0); assert.equal(f.calls.orderReads.length, 2);
});
test("index failure returns 503 with no writes/events/codes and failed promise resets for retry", async () => {
  const f = fixture(); f.options.indexError = new Error("Offline index failure"); const fail = await f.invoke(); assert.equal(fail.code, 503); assert.equal(fail.body.error, "QA_RECEPTION_IDEMPOTENCY_UNAVAILABLE"); noWrites(f); assert.equal(f.calls.indexes, 1);
  f.options.indexError = null; const retry = await f.invoke(); assert.equal(retry.code, 201); assert.equal(f.calls.indexes, 2); assert.equal(f.calls.creates, 1); assert.equal(f.calls.events, 1);
});
test("post-create publication failure keeps order and returns clear failure; replay never re-emits or claims success", async () => {
  const f = fixture(); f.options.eventError = new Error("Offline publication failed"); const first = await f.invoke(); assert.equal(first.code, 201); assert.deepEqual(first.body.qa.notification, { published: false, error: "QA_RECEPTION_NOTIFICATION_FAILED" }); assert.equal(f.orders.length, 1); assert.deepEqual(f.calls.deletes, []);
  f.options.eventError = null; const replay = await f.invoke(); assert.equal(replay.code, 200); assert.equal(replay.body.order._id, first.body.order._id); assert.equal(replay.body.qa.notification.published, null); assert.equal(f.calls.creates, 1); assert.equal(f.calls.codes, 1); assert.equal(f.calls.events, 1);
});
test("existing QA cleanup safely removes a reception order with null rider/qaRider, no Rider/slot deletion", async () => {
  const f = fixture(); const created = await f.invoke(); const req = f.request(); req.params.id = created.body.order._id;
  const cleanup = await f.invoke(req, "delete"); assert.equal(cleanup.code, 204); assert.equal(cleanup.ended, true); assert.equal(f.orders.length, 0); assert.deepEqual(f.calls.forbidden, []); assert(!f.calls.deletes.includes("Rider")); assert(!f.calls.deletes.includes("RiderSlot")); assert(f.calls.deletes.includes("Order"));
});

test("no mode still executes unchanged legacy QA Rider/slot/dispatch/support flow", async () => {
  const f = fixture(); const req = f.request(); req.body = {}; delete req.auth.employeeId;
  const qaRider = { _id: id(70), name: "PIKI Rider QA automático" }; const ticket = { _id: id(71), ticketNumber: "OFFLINE-TICKET" };
  const legacy: string[] = [];
  f.ctx.employeeScope = async () => null;
  f.ctx.madridNow = () => ({ date: "2026-01-01", time: "12:00" });
  f.ctx.Rider.create = async (input: any) => { assert.equal(input.isTestRider, true); assert.equal(input.tenantId, ids.tenant); legacy.push("Rider"); return qaRider; };
  f.ctx.RiderSlot.create = async (input: any) => { assert.equal(input.riderId, qaRider._id); legacy.push("RiderSlot"); };
  f.ctx.notifyOrderPlaced = async () => { legacy.push("notifyOrderPlaced"); };
  f.ctx.enqueueOrderForDispatch = async (orderId: string, riderId: string) => { assert.equal(riderId, qaRider._id); legacy.push("dispatch"); return { state: "offered" }; };
  f.ctx.SupportTicket.create = async (input: any) => { assert.equal(input.orderId, f.orders[0]._id); legacy.push("SupportTicket"); return ticket; };
  f.ctx.Order.findById = () => query(() => f.orders[0]);
  const res = await f.invoke(req);
  assert.equal(res.code, 201); assert.equal(res.body.order.qaRiderId, qaRider._id); assert.equal(res.body.order.status, "ready_for_pickup"); assert.equal(res.body.order.totalCents, 1450); assert.equal(res.body.order.customerName, "Cliente QA"); assert.equal(res.body.order.qaReceptionRequestId, undefined);
  assert.deepEqual(legacy, ["Rider", "RiderSlot", "notifyOrderPlaced", "dispatch", "SupportTicket"]); assert.equal(res.body.qa.riderId, qaRider._id); assert.equal(res.body.qa.ticketId, ticket._id); assert(res.body.qa.expiresAt); assert.deepEqual(res.body.qa.dispatch, { state: "offered" }); assert.equal(res.body.qa.mode, undefined);
  assert.equal(f.calls.persistedOwnerReads, 0); assert.equal(f.calls.indexes, 0); assert.equal(f.calls.events, 0);
});
