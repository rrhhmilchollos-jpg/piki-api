import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Readable } from "node:stream";
import mongoose from "mongoose";
import express from "express";
import { readFileSync } from "node:fs";
import ts from "typescript";

const secret = "whsec_offline_webhook_fixture_only";
const orderId = "64b000000000000000000091";
const tenantId = "64b000000000000000000092";
const restaurantId = "64b000000000000000000093";
const orderCode = "PIKI-OFFLINE-WEBHOOK";
function query(value: any): any {
  const q: any = { select: () => q, lean: () => q, session: () => q, limit: () => q, exec: async () => typeof value === "function" ? value() : value };
  q.then = (resolve: any, reject: any) => q.exec().then(resolve, reject);
  return q;
}
function response(): any {
  return { statusCode: 200, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } };
}
function event(id: string, type = "payment_intent.succeeded", metadata: Record<string, string> = { order_code: orderCode }): any {
  const status = type === "payment_intent.canceled" ? "canceled" : type === "payment_intent.amount_capturable_updated" ? "requires_capture" : type === "payment_intent.payment_failed" ? "requires_payment_method" : "succeeded";
  return { id, type, data: { object: { id: "pi_offline_webhook", object: "payment_intent", metadata, status, amount_received: 1800, amount_capturable: 1800, capture_method: "manual", currency: "eur", created: 1794477600 } } };
}

test("Stripe: handlers reales sin DB, puertos, Stripe API, SMTP ni workers", async (t) => {
  assert.equal(process.env.PIKI_NO_LISTEN, "true", "Usar scripts/offline-validation.mjs test");
  assert.equal(process.env.DOTENV_CONFIG_PATH, "/dev/null");
  // Only synthetic keys: the SDK verifies HMAC locally; no Stripe request occurs.
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_webhook_fixture_only";
  process.env.STRIPE_WEBHOOK_SECRET = secret;
  const models = await import("./models.js");
  const payments = await import("./stripePayments.js");
  const modern = await import("./stripe.js");
  const { mountStripeWebhook } = await import("./stripeRoutes.js");
  const app = express();
  // Compile only the exact production route block; never import server/boot.
  const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const routeStart = serverSource.indexOf("const stripeWebhookHandler =");
  const routeEnd = serverSource.indexOf("\nconst vercelWebhookSecret", routeStart);
  assert.ok(routeStart > 0 && routeEnd > routeStart);
  const routeCode = ts.transpile(serverSource.slice(routeStart, routeEnd), { target: ts.ScriptTarget.ES2022 });
  new Function("express", "app", "stripeConfigured", "processStripeWebhook", "isStripeSignatureError", routeCode)(express, app, modern.stripeConfigured, modern.processStripeWebhook, modern.isStripeSignatureError);
  mountStripeWebhook(app);
  app.use(express.json({ limit: "20mb" }));
  const stack = (app as any)._router.stack;
  const routeLayer = (path: string) => {
    const layer = stack.find((entry: any) => entry.route?.methods.post && (Array.isArray(entry.route.path) ? entry.route.path.includes(path) : entry.route.path === path));
    assert.ok(layer, path);
    return layer;
  };
  const handler = (path: string) => routeLayer(path).route.stack.at(-1).handle;
  const call = async (path: string, payload: any, options: { signature?: string; raw?: any } = {}) => {
    const raw = options.raw ?? Buffer.from(JSON.stringify(payload));
    const signature = options.signature ?? payments.stripeClient().webhooks.generateTestHeaderString({ payload: raw.toString(), secret });
    const res = response();
    await handler(path)({ body: raw, header: (name: string) => name === "stripe-signature" ? signature : undefined }, res);
    return res;
  };
  function fixture(s: TestContext, overrides: any = {}) {
    let stored: any = { _id: orderId, tenantId, restaurantId, publicCode: orderCode, paymentMethod: "stripe", paymentState: "pending", status: "pending", assignmentState: "unassigned", version: 0, totalCents: 1800, stripePaymentIntentId: "pi_offline_webhook", ...overrides };
    let present = true;
    let failOrderSave = false;
    let failDispatch = false;
    let failRealtime = false;
    let failMarker = false;
    let beforeCodWrite: (() => void) | null = null;
    let saveCount = 0;
    let transitionCount = 0;
    const events = new Map<string, any>();
    const dispatch = new Map<string, any>();
    const realtime = new Map<string, any>();
    const clone = (row: any) => JSON.parse(JSON.stringify(row));
    const equal = (a: any, b: any) => a instanceof Date || b instanceof Date ? new Date(a).getTime() === new Date(b).getTime() : a == null && b == null ? true : a === b;
    const matches = (row: any, filter: any) => row && Object.entries(filter).every(([key, value]) => equal(row[key], value));
    const document = () => { const doc = clone(stored); return Object.assign(doc, { set(update: any) { Object.assign(doc, update); }, async save() { if (failOrderSave) throw new Error("OFFLINE_ORDER_SAVE_FAILED"); Object.assign(stored, doc); saveCount++; } }); };
    s.mock.method(mongoose, "startSession", async () => ({
      async withTransaction(fn: any) {
        const before = clone(stored);
        const beforeDispatch = new Map(dispatch);
        try { await fn(); } catch (error) { stored = before; dispatch.clear(); for (const [key, value] of beforeDispatch) dispatch.set(key, value); throw error; }
      },
      async endSession() {},
    }) as any);
    s.mock.method(models.Order as any, "findOne", (filter: any) => query(() => present && matches(stored, filter) ? document() : null));
    s.mock.method(models.Order as any, "find", (filter: any) => query(() => present && matches(stored, filter) ? [clone(stored)] : []));
    s.mock.method(models.Order as any, "updateOne", (filter: any, update: any) => query(() => {
      assert.ok([...events.values()].some((row) => row.processingStatus === "processing"), "claim COD antes de la escritura");
      if (beforeCodWrite) { const hook = beforeCodWrite; beforeCodWrite = null; hook(); }
      if (failOrderSave) throw new Error("OFFLINE_ORDER_SAVE_FAILED");
      if (!present || !matches(stored, filter)) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(stored, update.$set); saveCount++;
      return { matchedCount: 1, modifiedCount: 1 };
    }));
    s.mock.method(models.Order as any, "findOneAndUpdate", (filter: any, update: any) => {
      if (!present || filter.publicCode !== stored.publicCode || filter.paymentMethod !== stored.paymentMethod || !filter.paymentState.$in.includes(stored.paymentState)) return query(null);
      if (filter.stripePaymentIntentId && filter.stripePaymentIntentId !== stored.stripePaymentIntentId) return query(null);
      if ("cashCollectedAt" in filter && !equal(filter.cashCollectedAt, stored.cashCollectedAt)) return query(null);
      Object.assign(stored, update.$set);
      stored.version += update.$inc.version;
      transitionCount++;
      return query(clone(stored));
    });
    s.mock.method(models.StripeEvent as any, "create", async (row: any) => {
      if (events.has(row.stripeEventId)) throw Object.assign(new Error("duplicate"), { code: 11000 });
      events.set(row.stripeEventId, { ...row });
    });
    s.mock.method(models.StripeEvent as any, "findOneAndUpdate", (filter: any, update: any) => {
      const row = events.get(filter.stripeEventId);
      if (!row || (filter.type && row.type !== filter.type) || !(row.processingStatus === "failed" || (row.processingStatus === "processing" && row.processingStartedAt <= filter.$or[1].processingStartedAt.$lte))) return query(null);
      Object.assign(row, update.$set);
      return query({ ...row });
    });
    s.mock.method(models.StripeEvent as any, "findOne", (filter: any) => query(() => { const row = events.get(filter.stripeEventId); return matches(row, filter) ? row : null; }));
    s.mock.method(models.StripeEvent as any, "updateOne", (filter: any, update: any) => query(() => {
      if (failMarker && update.$set.processingStatus === "processed") throw new Error("OFFLINE_RECEIPT_MARKER_FAILED");
      const row = events.get(filter.stripeEventId);
      if (!matches(row, filter)) return { matchedCount: 0, modifiedCount: 0 };
      Object.assign(row, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }));
    s.mock.method(models.DispatchOutbox as any, "updateOne", (filter: any, update: any) => {
      if (failDispatch) throw new Error("OFFLINE_DISPATCH_OUTBOX_FAILED");
      if (!dispatch.has(filter.idempotencyKey)) dispatch.set(filter.idempotencyKey, update.$setOnInsert);
      return query({ modifiedCount: 1 });
    });
    s.mock.method(models.DispatchOutbox as any, "findOne", (filter: any) => query(dispatch.get(filter.idempotencyKey) || null));
    s.mock.method(models.RealtimeEvent as any, "findOneAndUpdate", (filter: any, update: any) => {
      if (failRealtime) throw new Error("OFFLINE_REALTIME_OUTBOX_FAILED");
      if (!realtime.has(filter.dedupeKey)) realtime.set(filter.dedupeKey, { _id: new mongoose.Types.ObjectId(), createdAt: new Date(), ...update.$setOnInsert });
      return query({ toObject: () => realtime.get(filter.dedupeKey) });
    });
    s.mock.method(models.EmployeeAccount as any, "find", () => query([]));
    s.mock.method(models.Restaurant as any, "findById", () => query(null));
    // Partner publication now verifies the persisted restaurant/order tenant.
    s.mock.method(models.Restaurant as any, "findOne", (filter: any) => query(String(filter._id) === restaurantId && String(filter.tenantId) === tenantId ? { _id: restaurantId, tenantId } : null));
    return { events, dispatch, realtime, get order() { return stored; }, get saves() { return saveCount; }, get transitions() { return transitionCount; }, set present(value: boolean) { present = value; }, set failSave(value: boolean) { failOrderSave = value; }, set failDispatch(value: boolean) { failDispatch = value; }, set failRealtime(value: boolean) { failRealtime = value; }, set failMarker(value: boolean) { failMarker = value; }, set beforeCodWrite(value: () => void) { beforeCodWrite = value; } };
  }
  await t.test("las tres rutas conservan bytes raw y se montan antes de JSON", async () => {
    const jsonIndex = stack.findIndex((entry: any) => entry.name === "jsonParser");
    assert.ok(jsonIndex >= 0);
    const productionJsonIndex = serverSource.indexOf('app.use(express.json({ limit: "20mb" }))');
    assert.ok(routeEnd < productionJsonIndex);
    assert.ok(serverSource.indexOf("mountStripeWebhook(app);") < productionJsonIndex);
    for (const path of ["/webhooks/stripe", "/api/v1/payments/webhook", "/api/webhooks/stripe"]) {
      const layer = routeLayer(path);
      assert.ok(stack.indexOf(layer) < jsonIndex, path);
      assert.equal(layer.route.stack[0].name, "rawParser");
      const raw = Buffer.from('{ "spacing": "preserved", "unicode": "á" }');
      const req: any = Readable.from([raw]);
      req.headers = { "content-type": "application/json", "content-length": String(raw.length) };
      await new Promise<void>((resolve, reject) => layer.route.stack[0].handle(req, response(), (error: any) => error ? reject(error) : resolve()));
      assert.ok(Buffer.isBuffer(req.body));
      assert.deepEqual(req.body, raw);
      await new Promise<void>((resolve, reject) => stack[jsonIndex].handle(req, response(), (error: any) => error ? reject(error) : resolve()));
      assert.deepEqual(req.body, raw);
    }
    assert.equal(handler("/api/v1/payments/webhook"), handler("/api/webhooks/stripe"));
  });
  await t.test("firma inválida devuelve 400 sin persistir en ninguna ruta", async (s) => {
    const f = fixture(s);
    for (const path of ["/webhooks/stripe", "/api/v1/payments/webhook", "/api/webhooks/stripe"]) {
      const res = await call(path, event("evt_bad_signature"), { signature: "t=1,v1=bad" });
      assert.equal(res.statusCode, 400);
    }
    assert.equal(f.events.size, 0);
    assert.equal(f.saves, 0);
  });
  await t.test("bytes alterados tras firmar se rechazan antes de persistir", async (s) => {
    const f = fixture(s);
    const payload = event("evt_tampered");
    const signature = payments.stripeClient().webhooks.generateTestHeaderString({ payload: JSON.stringify(payload), secret });
    const raw = Buffer.from(JSON.stringify({ ...payload, id: "evt_changed" }));
    for (const path of ["/webhooks/stripe", "/api/v1/payments/webhook", "/api/webhooks/stripe"]) {
      assert.equal((await call(path, payload, { signature, raw })).statusCode, 400);
    }
    assert.equal(f.events.size, 0);
    assert.equal(f.transitions, 0);
  });
  await t.test("COD: configuración ausente es 503, no 400", async (s) => {
    fixture(s);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try { assert.equal((await call("/webhooks/stripe", event("evt_unconfigured"))).statusCode, 503); }
    finally { process.env.STRIPE_WEBHOOK_SECRET = secret; }
  });
  await t.test("COD: fallo de persistencia es 500 y no revela mensajes internos", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    f.failSave = true;
    const res = await call("/webhooks/stripe", event("evt_cod_failure", "payment_intent.amount_capturable_updated", { orderId, flow: "cod_guarantee" }));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "STRIPE_WEBHOOK_PROCESSING_FAILED" });
  });
  await t.test("COD: contrato orderId funciona y cancelación conserva efectivo cobrado y tenant", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "paid", cashCollectedAt: "2026-11-12T10:00:00Z", status: "delivered", assignmentState: "assigned", riderId: "offline-rider" });
    const res = await call("/webhooks/stripe", event("evt_cod_cancel", "payment_intent.canceled", { orderId, flow: "cod_guarantee" }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.handled, true);
    assert.equal(f.order.paymentState, "paid");
    assert.equal(f.order.status, "delivered");
    assert.equal(f.order.riderId, "offline-rider");
    assert.equal(f.order.tenantId, tenantId);
  });
  await t.test("cancelación COD sin order_code: activo procesa COD, no consume el id como no-op moderno", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const payload = event("evt_cod_cancel_on_active", "payment_intent.canceled", { orderId, flow: "cod_guarantee" });
    const res = await call("/api/v1/payments/webhook", payload);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.orderCode, null);
    assert.equal(res.body.handled, true);
    assert.equal(f.events.get(payload.id).processingStatus, "processed");
    assert.equal(f.order.paymentState, "expired");
    assert.equal(f.transitions, 0);
    assert.equal(f.saves, 1);
    assert.equal(f.order.tenantId, tenantId);
  });
  await t.test("COD: cancelación de garantía no cobrada marca expired, no paid ni refund", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const res = await call("/webhooks/stripe", event("evt_cod_cancel_unpaid", "payment_intent.canceled", { orderId, flow: "cod_guarantee" }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.handled, true);
    assert.equal(f.order.paymentState, "expired");
    assert.ok(f.order.paymentReleasedAt);
    assert.equal(f.order.tenantId, tenantId);
  });
  await t.test("caracterización COD: metadata order_code sin PI vinculado recibe 200 no manejado", async (s) => {
    const f = fixture(s, { stripePaymentIntentId: null });
    const res = await call("/webhooks/stripe", event("evt_cod_wrong_contract"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.handled, false);
    assert.equal(f.order.paymentState, "pending");
    assert.equal(f.events.size, 0);
  });
  await t.test("COD corregido: deduplica y conserva paid ante failure tardío", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "paid", status: "delivered", assignmentState: "assigned" });
    const payload = event("evt_cod_old_failure", "payment_intent.payment_failed", { orderId, flow: "cod_guarantee" });
    await call("/webhooks/stripe", payload);
    assert.equal((await call("/webhooks/stripe", payload)).body.duplicate, true);
    assert.equal(f.order.paymentState, "paid");
    assert.equal(f.saves, 0);
    assert.equal(f.events.get(payload.id).processingStatus, "processed");
    assert.equal(f.order.status, "delivered");
  });
  await t.test("saga: order_code actualiza pago sin reabrir pedido ni rider ni tenant", async (s) => {
    const f = fixture(s, { status: "delivered", assignmentState: "assigned", riderId: "offline-rider" });
    const payload = event("evt_success");
    const res = await call("/api/v1/payments/webhook", payload);
    assert.equal(res.statusCode, 200);
    assert.equal(f.order.paymentState, "paid");
    assert.equal(f.order.status, "delivered");
    assert.equal(f.order.riderId, "offline-rider");
    assert.equal(f.order.tenantId, tenantId);
    assert.equal(f.dispatch.size, 0);
    assert.equal(f.events.get(payload.id).processingStatus, "processed");
    const duplicate = await call("/api/webhooks/stripe", payload);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(f.transitions, 1);
  });
  await t.test("saga: fallo de dispatch devuelve 500, rollback y retry deduplicado", async (s) => {
    const f = fixture(s);
    const payload = event("evt_dispatch_retry");
    f.failDispatch = true;
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 500);
    assert.equal(f.order.paymentState, "pending");
    assert.equal(f.events.get(payload.id).processingStatus, "failed");
    f.failDispatch = false;
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "paid");
    assert.equal(f.dispatch.size, 1);
    assert.equal(String([...f.dispatch.values()][0].tenantId), tenantId);
    assert.equal(f.realtime.size, 3);
    assert.ok([...f.realtime.values()].every((row) => String(row.tenantId) === tenantId));
    assert.equal((await call("/api/v1/payments/webhook", payload)).body.duplicate, true);
    assert.equal(f.dispatch.size, 1);
    assert.equal(f.realtime.size, 3);
  });
  await t.test("saga: fallo realtime tras pago devuelve 500 y retry repara sin transición adicional", async (s) => {
    const f = fixture(s);
    const payload = event("evt_realtime_retry");
    f.failRealtime = true;
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.order.paymentState, "paid");
    assert.equal(f.events.get(payload.id).processingStatus, "failed");
    f.failRealtime = false;
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.transitions, 1);
    assert.equal(f.dispatch.size, 1);
    assert.equal(f.realtime.size, 3);
  });
  await t.test("saga: pedido order_code no encontrado es 500 reclaimable, nunca 200 procesado", async (s) => {
    const f = fixture(s, { status: "delivered", assignmentState: "assigned" });
    const payload = event("evt_missing_order_retry");
    f.present = false;
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed");
    f.present = true;
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "paid");
    assert.equal(f.events.get(payload.id).processingStatus, "processed");
  });
  await t.test("saga: lease activo es 500; lease obsoleto se recupera", async (s) => {
    const f = fixture(s, { status: "delivered", assignmentState: "assigned" });
    const payload = event("evt_lease");
    f.events.set(payload.id, { stripeEventId: payload.id, type: payload.type, processingStatus: "processing", processingStartedAt: new Date() });
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.order.paymentState, "pending");
    f.events.get(payload.id).processingStartedAt = new Date(Date.now() - 6 * 60_000);
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "paid");
  });
  await t.test("saga: fuera de orden no degrada paid o refunded", async (s) => {
    const f = fixture(s, { paymentState: "paid", status: "delivered", assignmentState: "assigned" });
    await call("/api/webhooks/stripe", event("evt_old_failure", "payment_intent.payment_failed"));
    assert.equal(f.order.paymentState, "paid");
    const refund = event("evt_refund", "charge.refunded");
    refund.data.object.object = "charge";
    await call("/api/webhooks/stripe", refund);
    assert.equal(f.order.paymentState, "refunded");
    await call("/api/webhooks/stripe", event("evt_old_success"));
    assert.equal(f.order.paymentState, "refunded");
    assert.equal(f.order.status, "delivered");
    assert.equal(f.order.tenantId, tenantId);
  });
  for (const [type, state] of [
    ["checkout.session.async_payment_succeeded", "paid"],
    ["checkout.session.async_payment_failed", "failed"],
    ["checkout.session.expired", "expired"],
    ["payment_intent.amount_capturable_updated", "authorized"],
  ]) await t.test(`saga: contrato ${type} -> ${state} sin alterar operación`, async (s) => {
    const f = fixture(s, { status: "delivered", assignmentState: "assigned", riderId: "offline-rider" });
    const payload: any = event(`evt_${state}`, type);
    if (type.startsWith("checkout.session")) Object.assign(payload.data.object, { id: "cs_offline", object: "checkout.session", payment_intent: "pi_offline_webhook" });
    const res = await call("/api/v1/payments/webhook", payload);
    assert.equal(res.statusCode, 200);
    assert.equal(f.order.paymentState, state);
    assert.equal(f.order.stripePaymentIntentId, "pi_offline_webhook");
    if (type.startsWith("checkout.session")) assert.equal(f.order.stripeCheckoutSessionId, "cs_offline");
    assert.equal(f.order.status, "delivered");
    assert.equal(f.order.riderId, "offline-rider");
    assert.equal(f.order.tenantId, tenantId);
  });
  for (const type of ["checkout.session.completed", "payment_intent.canceled"]) await t.test(`saga: ${type} no confirma pago; cancelación sólo expira pendiente`, async (s) => {
    const f = fixture(s);
    const payload: any = event(`evt_ignored_${type}`, type);
    if (type.startsWith("checkout.session")) Object.assign(payload.data.object, { id: "cs_offline", object: "checkout.session", payment_status: "unpaid" });
    const res = await call("/api/v1/payments/webhook", payload);
    assert.equal(res.statusCode, 200);
    assert.equal(f.order.paymentState, type === "payment_intent.canceled" ? "expired" : "pending");
    assert.equal(f.transitions, type === "payment_intent.canceled" ? 1 : 0);
    assert.equal(f.dispatch.size, 0);
    assert.equal(f.events.get(payload.id).processingStatus, "processed");
  });
  await t.test("caracterización saga: metadata.orderCode camelCase no es order_code", async (s) => {
    const f = fixture(s);
    const res = await call("/api/webhooks/stripe", event("evt_camelcase", "payment_intent.succeeded", { orderCode }));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.orderCode, null);
    assert.equal(f.order.paymentState, "pending");
    assert.equal(f.events.get("evt_camelcase").processingStatus, "processed");
  });
  await t.test("eventos ignorados siguen 200 sin tocar pedidos", async (s) => {
    const f = fixture(s);
    const payload = event("evt_ignored", "payment_method.attached", {});
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "pending");
    assert.equal(f.transitions, 0);
    assert.equal(f.events.get(payload.id).processingStatus, "processed");
  });
  const codEvent = (id: string, type = "payment_intent.amount_capturable_updated", extra: Record<string, string> = {}) => event(id, type, { orderId, flow: "cod_guarantee", ...extra });
  function mockRefund(s: TestContext, f: ReturnType<typeof fixture>, options: { timeoutOnce?: boolean; status?: string; existing?: any[] } = {}) {
    const calls: any[] = [];
    const accepted = new Map<string, any>();
    let timeout = options.timeoutOnce === true;
    s.mock.method(payments.stripeClient().refunds, "list", async () => ({ data: options.existing ?? [] }) as any);
    s.mock.method(payments.stripeClient().refunds, "create", async (input: any, request: any) => {
      assert.ok([...f.events.values()].some((row) => row.processingStatus === "processing"), "claim antes de Stripe");
      calls.push({ input, request });
      if (!accepted.has(request.idempotencyKey)) accepted.set(request.idempotencyKey, { id: "re_offline", status: options.status ?? "succeeded", amount: 1800 });
      if (timeout) { timeout = false; throw new Error("OFFLINE_TIMEOUT_AFTER_STRIPE_ACCEPTED"); }
      return accepted.get(request.idempotencyKey);
    });
    return { calls, accepted };
  }
  await t.test("COD: duplicado procesado escribe una vez y no extiende caducidad", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    const payload = codEvent("evt_cod_duplicate");
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    const expiry = f.order.paymentAuthorizationExpiresAt;
    assert.equal((await call("/webhooks/stripe", payload)).body.duplicate, true);
    assert.equal(f.saves, 1);
    assert.equal(f.order.paymentAuthorizationExpiresAt, expiry);
    assert.equal(new Date(expiry).getTime(), payload.data.object.created * 1000 + payments.COD_AUTHORIZATION_TTL_MS);
    assert.equal(f.dispatch.size, 0);
    assert.equal(f.realtime.size, 0);
  });
  await t.test("COD: persistencia fallida queda failed y retry reclama antes de transición", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    const payload = codEvent("evt_cod_write_retry");
    f.failSave = true;
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.order.paymentState, "pending");
    assert.equal(f.events.get(payload.id).processingStatus, "failed");
    f.failSave = false;
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "authorized");
    assert.equal(f.saves, 1);
  });
  await t.test("COD: lease activo devuelve 500; lease obsoleto se reclama", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    const payload = codEvent("evt_cod_lease");
    f.events.set(payload.id, { stripeEventId: payload.id, type: payload.type, processingStatus: "processing", processingStartedAt: new Date() });
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.saves, 0);
    f.events.get(payload.id).processingStartedAt = new Date(Date.now() - 6 * 60_000);
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.saves, 1);
  });
  await t.test("COD: fallo del marker tras efecto se recupera sin otra escritura", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    const payload = codEvent("evt_cod_marker_retry");
    f.failMarker = true;
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.order.paymentState, "authorized");
    assert.equal(f.events.get(payload.id).processingStatus, "failed");
    f.failMarker = false;
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.saves, 1);
  });
  await t.test("COD: pedido aún ausente no recibe falso 200; asociación PI debe existir para retry", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", stripePaymentIntentId: null });
    const payload = codEvent("evt_cod_missing_order");
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed");
    assert.equal(f.order.stripePaymentIntentId, null);
    f.order.stripePaymentIntentId = payload.data.object.id;
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "authorized");
  });
  for (const state of ["paid", "refunded", "cash"]) await t.test(`COD: failure/canceled/authorization tardíos conservan ${state}`, async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: state === "cash" ? "paid" : state, cashCollectedAt: state === "cash" ? "2026-11-12T10:00:00Z" : null, status: "delivered", assignmentState: "assigned", riderId: "offline-rider" });
    for (const type of ["payment_intent.payment_failed", "payment_intent.canceled", "payment_intent.amount_capturable_updated"]) {
      assert.equal((await call("/webhooks/stripe", codEvent(`evt_cod_late_${state}_${type}`, type))).statusCode, 200);
      assert.equal(f.order.paymentState, state === "cash" ? "paid" : state);
    }
    assert.equal(f.order.status, "delivered"); assert.equal(f.order.riderId, "offline-rider"); assert.equal(f.order.tenantId, tenantId);
  });
  await t.test("COD: CAS detecta cobro efectivo concurrente y retry no lo degrada", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const payload = codEvent("evt_cod_cash_race", "payment_intent.payment_failed");
    f.beforeCodWrite = () => { f.order.cashCollectedAt = "2026-11-12T10:00:00Z"; f.order.paymentState = "paid"; };
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.order.paymentState, "paid");
    assert.equal(f.events.get(payload.id).processingStatus, "failed");
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "paid"); assert.equal(f.saves, 0);
  });
  await t.test("COD: payload sin event ID/PI/object válido se rechaza sin sobrescribir vínculo", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    for (const mutate of [(p: any) => delete p.id, (p: any) => { p.id = ""; }, (p: any) => delete p.data.object.id, (p: any) => { p.data = {}; }, (p: any) => { p.data.object.object = "charge"; }]) {
      const payload = codEvent("evt_cod_bad_payload"); mutate(payload);
      assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    }
    assert.equal(f.events.size, 0); assert.equal(f.saves, 0); assert.equal(f.order.stripePaymentIntentId, "pi_offline_webhook");
  });
  await t.test("COD: metadata ajena, checkout y contrato mixto no consumen receipt de Checkout", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    for (const metadata of [{ order_code: orderCode }, { orderId, flow: "other_flow" }, { orderId, flow: "cod_guarantee", order_code: orderCode }] as Record<string, string>[]) {
      const res = await call("/webhooks/stripe", event("evt_cod_ambiguous", "payment_intent.succeeded", metadata));
      assert.equal(res.statusCode, 200); assert.equal(res.body.handled, false);
    }
    assert.equal(f.events.size, 0); assert.equal(f.saves, 0);
  });
  await t.test("COD: orderId conflictivo y falso capturable nunca autorizan por metadata", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    for (const [id, change] of [
      ["evt_wrong_order", (p: any) => { p.data.object.metadata.orderId = "other-order"; }],
      ["evt_wrong_pi", (p: any) => { p.data.object.id = "pi_other"; }],
      ["evt_wrong_amount", (p: any) => { p.data.object.amount_capturable = 1; }],
      ["evt_wrong_capture", (p: any) => { p.data.object.capture_method = "automatic"; }],
    ] as const) {
      const payload = codEvent(id); change(payload);
      assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
      assert.equal(f.events.get(id).processingStatus, "failed");
    }
    assert.equal(f.order.paymentState, "pending"); assert.equal(f.saves, 0); assert.equal(f.order.stripePaymentIntentId, "pi_offline_webhook");
  });
  await t.test("COD: refund timeout accepted -> retry misma key; duplicados no repiten", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const refund = mockRefund(s, f, { timeoutOnce: true });
    s.mock.method(console, "error", () => undefined);
    const payload = codEvent("evt_cod_refund_timeout", "payment_intent.succeeded");
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.order.paymentState, "authorized"); assert.equal(f.events.get(payload.id).processingStatus, "failed");
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "pending");
    assert.equal((await call("/webhooks/stripe", payload)).body.duplicate, true);
    assert.equal((await call("/webhooks/stripe", codEvent("evt_cod_same_pi_new_event", "payment_intent.succeeded"))).statusCode, 200);
    assert.equal(refund.accepted.size, 1);
    assert.ok(refund.calls.every((row) => row.request.idempotencyKey === "piki-cod-guarantee-refund-pi_offline_webhook"));
    assert.equal(f.saves, 1);
  });
  await t.test("COD: refund aceptado y fallo DB se reintenta sin segunda devolución lógica", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const refund = mockRefund(s, f);
    const payload = codEvent("evt_cod_refund_save", "payment_intent.succeeded");
    f.failSave = true;
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    f.failSave = false;
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(refund.accepted.size, 1); assert.equal(refund.calls.length, 2); assert.equal(f.order.paymentState, "pending");
  });
  await t.test("COD: refund fallido no confirma ni borra captura; pending previo parcial no se confunde con full", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized", paymentCapturedCents: 1800 });
    const refund = mockRefund(s, f, { status: "failed", existing: [{ status: "succeeded", amount: 100 }] });
    const payload = codEvent("evt_cod_refund_failed", "payment_intent.succeeded");
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed"); assert.equal(f.order.paymentState, "authorized"); assert.equal(f.order.paymentCapturedCents, 1800);
    assert.equal(refund.calls.length, 1); assert.equal(f.saves, 0);
  });
  await t.test("COD: refund garantía realmente cobrada conserva cash/paid y todos sus datos", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "paid", cashCollectedAt: "2026-11-12T10:00:00Z", paymentCapturedCents: 1800, paymentCapturedAt: "2026-11-12T09:59:00Z" });
    const before = structuredClone(f.order);
    const refund = mockRefund(s, f);
    assert.equal((await call("/webhooks/stripe", codEvent("evt_cod_refund_cash", "payment_intent.succeeded"))).statusCode, 200);
    assert.equal(refund.calls.length, 1); assert.deepEqual(f.order, before); assert.equal(f.saves, 0);
  });
  await t.test("COD: captura marcada rider y tarjeta automática no generan refund; marcador falso no autoriza", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const refund = mockRefund(s, f);
    assert.equal((await call("/webhooks/stripe", codEvent("evt_cod_false_marker", "payment_intent.succeeded", { capturedBy: "anything" }))).statusCode, 500);
    assert.equal(f.order.paymentState, "authorized");
    assert.equal((await call("/webhooks/stripe", codEvent("evt_cod_deliberate", "payment_intent.succeeded", { capturedBy: "rider" }))).statusCode, 200);
    assert.equal(f.order.paymentState, "paid");
    f.order.paymentMethod = "card"; f.order.paymentState = "pending";
    const card = codEvent("evt_cod_card", "payment_intent.succeeded"); card.data.object.capture_method = "automatic";
    assert.equal((await call("/webhooks/stripe", card)).statusCode, 200);
    assert.equal(f.order.paymentState, "paid"); assert.equal(refund.calls.length, 0);
  });
  await t.test("COD: duplicado concurrente durante refund no toma claim ni marca processed prematuro", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let creates = 0;
    s.mock.method(payments.stripeClient().refunds, "list", async () => { entered(); await gate; return { data: [] } as any; });
    s.mock.method(payments.stripeClient().refunds, "create", async () => { creates++; return { status: "succeeded" } as any; });
    const payload = codEvent("evt_cod_concurrent", "payment_intent.succeeded");
    const first = call("/webhooks/stripe", payload);
    await started;
    try {
      assert.equal((await call("/webhooks/stripe", payload)).statusCode, 500);
      assert.equal(f.events.get(payload.id).processingStatus, "processing"); assert.equal(creates, 0);
    } finally { release(); }
    assert.equal((await first).statusCode, 200); assert.equal(creates, 1);
    assert.equal((await call("/webhooks/stripe", payload)).body.duplicate, true);
  });
  await t.test("COD: intento obsoleto no puede marcar ni degradar un lease reclamado", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const receipts = await import("./stripeCodReceipt.js");
    const payload = codEvent("evt_cod_fenced");
    const old = new Date(Date.now() - 6 * 60_000);
    f.events.set(payload.id, { stripeEventId: payload.id, type: payload.type, processingStatus: "processing", processingStartedAt: old });
    const lease = await receipts.claimCodStripeEvent(payload);
    assert.ok(lease instanceof Date);
    await assert.rejects(receipts.finishCodStripeEvent(payload.id, old), /LEASE_LOST/);
    await assert.rejects(receipts.finishCodStripeEvent(payload.id, old, new Error("old failure")), /LEASE_LOST/);
    assert.equal(f.events.get(payload.id).processingStatus, "processing");
    await receipts.finishCodStripeEvent(payload.id, lease as Date);
    assert.equal(f.events.get(payload.id).processingStatus, "processed");
  });
  await t.test("canonical preserva no-ops históricos processed, rechaza mezcla y conserva Checkout sin refund", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const refund = mockRefund(s, f);
    const previous = codEvent("evt_canonical_cod_historical", "payment_intent.succeeded");
    const receipt = { stripeEventId: previous.id, type: previous.type, orderCode: null, processingStatus: "processed", processedAt: new Date() };
    f.events.set(previous.id, receipt);
    for (const path of ["/api/v1/payments/webhook", "/webhooks/stripe"]) {
      const res = await call(path, previous);
      assert.equal(res.statusCode, 200); assert.equal(res.body.duplicate, true);
      assert.equal(f.events.get(previous.id), receipt);
    }
    const metadataLess = event("evt_canonical_no_flow", "payment_intent.succeeded", { orderId });
    assert.equal((await call("/api/v1/payments/webhook", metadataLess)).statusCode, 200);
    assert.equal((await call("/webhooks/stripe", metadataLess)).body.duplicate, true);
    const mixed = codEvent("evt_canonical_mixed", "payment_intent.succeeded", { order_code: orderCode });
    assert.equal((await call("/api/v1/payments/webhook", mixed)).statusCode, 500);
    assert.equal(f.events.get(mixed.id).processingStatus, "failed");
    assert.equal((await call("/webhooks/stripe", mixed)).body.handled, false);
    assert.equal(f.order.paymentState, "authorized"); assert.equal(f.saves, 0);
    assert.equal(refund.calls.length, 0);
    f.order.paymentMethod = "stripe"; f.order.paymentState = "pending";
    assert.equal((await call("/api/v1/payments/webhook", event("evt_checkout_still_works"))).statusCode, 200);
    assert.equal(f.order.paymentState, "paid"); assert.equal(f.transitions, 1); assert.equal(refund.calls.length, 0);
  });
  await t.test("COD: referencia real de ocho caracteres debe coincidir y tener PI único preexistente", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", publicCode: "PIKI-MVZH7BM8" });
    const payload = codEvent("evt_cod_real_reference"); payload.data.object.metadata.orderId = "MVZH7BM8";
    assert.equal((await call("/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "authorized");
    const canceled = codEvent("evt_cod_real_reference_canceled", "payment_intent.canceled"); canceled.data.object.metadata.orderId = "MVZH7BM8";
    assert.equal((await call("/webhooks/stripe", canceled)).statusCode, 200);
    assert.equal(f.order.paymentState, "expired");
    const conflict = codEvent("evt_cod_reference_conflict"); conflict.data.object.metadata.orderId = "OTHER123";
    assert.equal((await call("/webhooks/stripe", conflict)).statusCode, 500);
    assert.equal(f.events.get(conflict.id).processingStatus, "failed"); assert.equal(f.order.paymentState, "expired");
    s.mock.method(models.Order as any, "find", () => query([f.order, { ...f.order, _id: tenantId }]));
    assert.equal((await call("/webhooks/stripe", codEvent("evt_cod_duplicate_link"))).statusCode, 500);
    assert.equal(f.events.get("evt_cod_duplicate_link").processingStatus, "failed");
  });
  for (const state of ["paid", "refunded", "authorized", "cash-collected"]) await t.test(`Checkout: canceled conserva ${state} o expira sólo authorized sin cobro`, async (s) => {
    const f = fixture(s, { paymentState: state === "cash-collected" ? "pending" : state, cashCollectedAt: state === "cash-collected" ? "2026-11-12T10:00:00Z" : null, status: "delivered", assignmentState: "assigned", riderId: "offline-rider" });
    const payload = event(`evt_checkout_cancel_${state}`, "payment_intent.canceled");
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, state === "authorized" ? "expired" : state === "cash-collected" ? "pending" : state);
    assert.equal(f.order.status, "delivered"); assert.equal(f.order.riderId, "offline-rider"); assert.equal(f.order.tenantId, tenantId); assert.equal(f.dispatch.size, 0);
    assert.equal((await call("/api/webhooks/stripe", payload)).body.duplicate, true);
  });
  await t.test("Checkout: canceled ajeno al PI vinculado o inválido queda failed sin sobreescribir PI", async (s) => {
    const f = fixture(s, { paymentState: "authorized" });
    const wrong = event("evt_checkout_cancel_wrong_pi", "payment_intent.canceled"); wrong.data.object.id = "pi_other";
    assert.equal((await call("/api/v1/payments/webhook", wrong)).statusCode, 500);
    assert.equal(f.order.paymentState, "authorized"); assert.equal(f.order.stripePaymentIntentId, "pi_offline_webhook"); assert.equal(f.events.get(wrong.id).processingStatus, "failed");
    const invalid = event("evt_checkout_cancel_invalid", "payment_intent.canceled"); invalid.data.object.status = "succeeded";
    assert.equal((await call("/api/v1/payments/webhook", invalid)).statusCode, 500);
    assert.equal(f.order.paymentState, "authorized"); assert.equal(f.transitions, 0);
  });
  await t.test("Checkout: canceled con pedido ausente devuelve 500; retry y duplicate seguros", async (s) => {
    const f = fixture(s);
    const payload = event("evt_checkout_cancel_missing", "payment_intent.canceled"); f.present = false;
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed"); f.present = true;
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 200); assert.equal(f.order.paymentState, "expired");
    assert.equal((await call("/api/v1/payments/webhook", payload)).body.duplicate, true); assert.equal(f.transitions, 1);
  });
  await t.test("origen plural retirado: hunk exacto, Rider singular y resto conservados", () => {
    const origins = serverSource.match(/^const defaultOrigins = (\[.*\]);$/m);
    assert.ok(origins);
    const values = JSON.parse(origins[1]);
    assert.ok(values.includes("https://rider.pikidelivery.com"));
    assert.ok(!values.includes("https://riders.pikidelivery.com"));
    assert.ok(values.includes("https://partners.pikidelivery.com"));
    assert.ok(values.includes("https://piki-riders.onrender.com"));
  });
  await t.test("activo COD: verifica sólo whsec ACTIVE y procesa referencia/PI una vez antes de claim moderno", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", publicCode: "PIKI-MVZH7BM8" });
    const payload = codEvent("evt_active_cod_signed", "payment_intent.amount_capturable_updated", { orderId: "MVZH7BM8" });
    const constructEvent = modern.stripe!.webhooks.constructEvent;
    const verification = s.mock.method(modern.stripe!.webhooks, "constructEvent", (...args: any[]) => {
      assert.equal(args[2], secret); assert.ok(Buffer.isBuffer(args[0]));
      return Reflect.apply(constructEvent, modern.stripe!.webhooks, args);
    });
    // The SDK shares its Webhooks object across clients: exactly one call also
    // proves the COD processor did not run the legacy raw verification wrapper.
    const res = await call("/api/v1/payments/webhook", payload);
    assert.equal(res.statusCode, 200); assert.equal(res.body.handled, true); assert.equal(res.body.duplicate, false);
    assert.equal(f.order.paymentState, "authorized"); assert.equal(f.saves, 1); assert.equal(f.transitions, 0);
    assert.equal(f.events.size, 1); assert.equal(f.events.get(payload.id).processingStatus, "processed");
    assert.equal(verification.mock.callCount(), 1);
    const expiry = f.order.paymentAuthorizationExpiresAt;
    const duplicate = await call("/api/webhooks/stripe", payload);
    assert.equal(duplicate.statusCode, 200); assert.equal(duplicate.body.duplicate, true);
    assert.equal(f.saves, 1); assert.equal(f.order.paymentAuthorizationExpiresAt, expiry);
    assert.equal(verification.mock.callCount(), 2);
    assert.equal(f.dispatch.size, 0); assert.equal(f.realtime.size, 0);
  });
  await t.test("activo COD: firma de destino legacy distinto se rechaza antes de claim/lookup/efectos", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    const payload = codEvent("evt_active_wrong_destination");
    const signature = payments.stripeClient().webhooks.generateTestHeaderString({ payload: JSON.stringify(payload), secret: "whsec_offline_disabled_legacy_destination" });
    const find = s.mock.method(models.Order as any, "find", () => { throw new Error("LOOKUP_BEFORE_SIGNATURE_FORBIDDEN"); });
    for (const path of ["/api/v1/payments/webhook", "/api/webhooks/stripe"]) {
      assert.equal((await call(path, payload, { signature })).statusCode, 400);
    }
    assert.equal(find.mock.callCount(), 0); assert.equal(f.events.size, 0); assert.equal(f.saves, 0);
  });
  await t.test("activo COD: contratos mixtos fallan 500 reclaimable antes de lookup, pago, refund o saga", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const before = structuredClone(f.order);
    const refund = mockRefund(s, f);
    const find = s.mock.method(models.Order as any, "find", () => { throw new Error("MIXED_CONTRACT_LOOKUP_FORBIDDEN"); });
    for (const [key, value] of [["order_code", orderCode], ["orderCode", orderCode], ["order_id", orderId], ["purpose", "rider_tip"]]) {
      const payload = codEvent(`evt_active_mixed_${key}`, "payment_intent.succeeded", { [key]: value });
      for (const path of ["/api/v1/payments/webhook", "/api/webhooks/stripe"]) {
        const res = await call(path, payload);
        assert.equal(res.statusCode, 500); assert.deepEqual(res.body, { error: "STRIPE_WEBHOOK_PROCESSING_FAILED" });
        assert.equal(f.events.get(payload.id).processingStatus, "failed");
      }
    }
    assert.equal(find.mock.callCount(), 0); assert.deepEqual(f.order, before); assert.equal(f.saves, 0);
    assert.equal(f.transitions, 0); assert.equal(refund.calls.length, 0); assert.equal(f.dispatch.size, 0);
  });
  await t.test("activo COD: CodHold-only no se reconcilia ni se fabrica paid; 500/failed retryable", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized", publicCode: "PIKI-MVZH7BM8" });
    const before = structuredClone(f.order); f.present = false;
    const { CodHold } = await import("./codHolds.js");
    const holdRead = s.mock.method(CodHold as any, "findOne", () => { throw new Error("COD_HOLD_RECONCILIATION_FORBIDDEN"); });
    const holdWrite = s.mock.method(CodHold as any, "updateOne", () => { throw new Error("COD_HOLD_MUTATION_FORBIDDEN"); });
    const refund = mockRefund(s, f);
    const payload = codEvent("evt_active_cod_hold_only", "payment_intent.canceled", { orderId: "MVZH7BM8" });
    for (const path of ["/api/v1/payments/webhook", "/api/webhooks/stripe"]) {
      assert.equal((await call(path, payload)).statusCode, 500);
      assert.equal(f.events.get(payload.id).processingStatus, "failed");
    }
    assert.deepEqual(f.order, before); assert.equal(f.saves, 0); assert.equal(refund.calls.length, 0);
    assert.equal(holdRead.mock.callCount(), 0); assert.equal(holdWrite.mock.callCount(), 0);
  });
  await t.test("activo COD: falta metadata.orderId, identidad contradictoria o PI no único nunca mutan", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", publicCode: "PIKI-MVZH7BM8" });
    const before = structuredClone(f.order);
    for (const [id, metadata, pi] of [
      ["evt_active_no_order_identity", { flow: "cod_guarantee" }, "pi_offline_webhook"],
      ["evt_active_wrong_order", { flow: "cod_guarantee", orderId: "OTHER123" }, "pi_offline_webhook"],
      ["evt_active_wrong_pi", { flow: "cod_guarantee", orderId: "MVZH7BM8" }, "pi_other"],
    ] as const) {
      const payload = event(id, "payment_intent.amount_capturable_updated", metadata); payload.data.object.id = pi;
      assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 500);
      assert.equal(f.events.get(id).processingStatus, "failed");
    }
    const lookup = s.mock.method(models.Order as any, "find", (filter: any) => {
      assert.deepEqual(filter, { stripePaymentIntentId: "pi_offline_webhook" });
      const q = query([f.order, { ...f.order, _id: tenantId }]);
      q.limit = (n: number) => { assert.equal(n, 2); return q; }; return q;
    });
    assert.equal((await call("/api/v1/payments/webhook", codEvent("evt_active_ambiguous_pi"))).statusCode, 500);
    assert.equal(lookup.mock.callCount(), 1); assert.equal(f.events.get("evt_active_ambiguous_pi").processingStatus, "failed");
    assert.deepEqual(f.order, before); assert.equal(f.saves, 0); assert.equal(f.transitions, 0);
  });
  await t.test("activo COD: failed y lease obsoleto se reclaman; processing activo no se consume", async (s) => {
    const f = fixture(s, { paymentMethod: "cash" });
    const payload = codEvent("evt_active_cod_failed_retry");
    f.failSave = true;
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed"); assert.equal(f.order.paymentState, "pending");
    f.failSave = false;
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 200);
    assert.equal(f.saves, 1); assert.equal(f.order.paymentState, "authorized");
    const leased = codEvent("evt_active_cod_lease", "payment_intent.canceled");
    f.events.set(leased.id, { stripeEventId: leased.id, type: leased.type, processingStatus: "processing", processingStartedAt: new Date() });
    assert.equal((await call("/api/v1/payments/webhook", leased)).statusCode, 500);
    assert.equal(f.order.paymentState, "authorized"); assert.equal(f.events.get(leased.id).processingStatus, "processing");
    f.events.get(leased.id).processingStartedAt = new Date(Date.now() - 6 * 60_000);
    assert.equal((await call("/api/v1/payments/webhook", leased)).statusCode, 200);
    assert.equal(f.order.paymentState, "expired"); assert.equal(f.events.get(leased.id).processingStatus, "processed");
  });
  await t.test("activo COD: CAS protege paid/efectivo concurrente y mismo id se recupera sin degradar", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized", status: "delivered", riderId: "offline-rider" });
    const payload = codEvent("evt_active_cod_cas", "payment_intent.payment_failed");
    f.beforeCodWrite = () => { f.order.cashCollectedAt = "2026-11-12T10:00:00Z"; f.order.paymentState = "paid"; };
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed"); assert.equal(f.order.paymentState, "paid");
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "paid"); assert.equal(f.saves, 0); assert.equal(f.transitions, 0);
    assert.equal(f.order.status, "delivered"); assert.equal(f.order.riderId, "offline-rider"); assert.equal(f.order.tenantId, tenantId);
  });
  for (const state of ["paid", "refunded", "cash-collected"]) await t.test(`activo COD: canceled/failed/capturable conservan ${state}`, async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: state === "cash-collected" ? "authorized" : state, cashCollectedAt: state === "cash-collected" ? "2026-11-12T10:00:00Z" : null });
    const expected = f.order.paymentState;
    for (const type of ["payment_intent.canceled", "payment_intent.payment_failed", "payment_intent.amount_capturable_updated"]) {
      assert.equal((await call("/api/v1/payments/webhook", codEvent(`evt_active_late_${state}_${type}`, type))).statusCode, 200);
      assert.equal(f.order.paymentState, expected);
    }
    assert.equal(f.transitions, 0); assert.equal(f.dispatch.size, 0); assert.equal(f.realtime.size, 0);
  });
  await t.test("activo COD: refund timeout y fallo DB reusan key estable del PI; duplicate no repite", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const refund = mockRefund(s, f, { timeoutOnce: true });
    s.mock.method(console, "error", () => undefined);
    const payload = codEvent("evt_active_refund_retry", "payment_intent.succeeded");
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed"); assert.equal(f.order.paymentState, "authorized");
    f.failSave = true;
    assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 500);
    assert.equal(f.events.get(payload.id).processingStatus, "failed"); assert.equal(f.order.paymentState, "authorized");
    f.failSave = false;
    assert.equal((await call("/api/v1/payments/webhook", payload)).statusCode, 200);
    assert.equal(f.order.paymentState, "pending"); assert.equal(f.saves, 1);
    const creates = refund.calls.length;
    assert.equal((await call("/api/v1/payments/webhook", payload)).body.duplicate, true);
    assert.equal(refund.calls.length, creates);
    assert.equal((await call("/api/v1/payments/webhook", codEvent("evt_active_refund_second_id", "payment_intent.succeeded"))).statusCode, 200);
    assert.equal(refund.accepted.size, 1);
    assert.ok(refund.calls.every((row) => row.request.idempotencyKey === "piki-cod-guarantee-refund-pi_offline_webhook"));
    assert.equal(f.saves, 1); assert.equal(f.dispatch.size, 0);
  });
  await t.test("activo COD: refund concurrente mantiene processing y duplicado no ejecuta otra devolución", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let creates = 0;
    s.mock.method(payments.stripeClient().refunds, "list", async () => { entered(); await gate; return { data: [] } as any; });
    s.mock.method(payments.stripeClient().refunds, "create", async (_input: any, request: any) => {
      assert.equal(request.idempotencyKey, "piki-cod-guarantee-refund-pi_offline_webhook"); creates++; return { status: "pending" } as any;
    });
    const payload = codEvent("evt_active_cod_concurrent_refund", "payment_intent.succeeded");
    const first = call("/api/v1/payments/webhook", payload); await started;
    try {
      assert.equal((await call("/api/webhooks/stripe", payload)).statusCode, 500);
      assert.equal(f.events.get(payload.id).processingStatus, "processing"); assert.equal(creates, 0);
    } finally { release(); }
    assert.equal((await first).statusCode, 200); assert.equal(creates, 1);
    assert.equal((await call("/api/v1/payments/webhook", payload)).body.duplicate, true); assert.equal(creates, 1);
  });
  await t.test("activo COD: recibo histórico acknowledged sin estado no se resetea ni ejecuta efectos", async (s) => {
    const f = fixture(s, { paymentMethod: "cash", paymentState: "authorized" });
    const payload = codEvent("evt_active_legacy_ack", "payment_intent.succeeded");
    const receipt = { stripeEventId: payload.id, type: payload.type, orderCode: null, processedAt: new Date() };
    f.events.set(payload.id, receipt);
    const refund = mockRefund(s, f);
    const before = structuredClone(f.order);
    const res = await call("/api/v1/payments/webhook", payload);
    assert.equal(res.statusCode, 200); assert.equal(res.body.duplicate, true);
    assert.equal(f.events.get(payload.id), receipt); assert.equal(receipt.processedAt instanceof Date, true);
    assert.deepEqual(f.order, before); assert.equal(f.saves, 0); assert.equal(refund.calls.length, 0);
  });
  await t.test("activo: card_charge_test canceled sin pedido queda ignored/processed con id real, sin fabricar Order", async (s) => {
    const f = fixture(s);
    const before = structuredClone(f.order);
    const payload = event("evt_active_card_charge_test", "payment_intent.canceled", { flow: "card_charge_test", surface: "admin" });
    const create = s.mock.method(models.Order as any, "create", () => { throw new Error("FAKE_ORDER_FORBIDDEN"); });
    const find = s.mock.method(models.Order as any, "findOne", () => { throw new Error("UNSUPPORTED_ORDER_LOOKUP_FORBIDDEN"); });
    const refund = mockRefund(s, f);
    const res = await call("/api/v1/payments/webhook", payload);
    assert.equal(res.statusCode, 200); assert.equal(res.body.orderCode, null); assert.equal(res.body.activated, false);
    assert.equal(f.events.size, 1); assert.equal(f.events.get(payload.id).stripeEventId, payload.id);
    assert.equal(f.events.get(payload.id).type, "payment_intent.canceled"); assert.equal(f.events.get(payload.id).processingStatus, "processed");
    assert.equal((await call("/api/webhooks/stripe", payload)).body.duplicate, true);
    assert.deepEqual(f.order, before); assert.equal(f.saves, 0); assert.equal(f.transitions, 0);
    assert.equal(create.mock.callCount(), 0); assert.equal(find.mock.callCount(), 0); assert.equal(refund.calls.length, 0);
    assert.equal(f.dispatch.size, 0); assert.equal(f.realtime.size, 0);
  });
  assert.ok(modern.stripe, "Cliente SDK local creado únicamente con clave sintética");
});
