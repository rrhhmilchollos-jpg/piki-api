import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CustomerAccount, Order, Restaurant } from "./models.js";
import { evaluateXativaCoverage, requiredVehiclesForRoute, XATIVA_COVERAGE_POLICY } from "./coverage/xativaPolicy.js";
import { sourceOrderFee, MAX_SOURCE_ORDER_FEE_CENTS } from "./sourceOrderFee.js";
import { customerOrderQuote, customerQuotedItems } from "./customerOrderQuote.js";

const restaurantId = "64b000000000000000000021";
const customerId = "64b000000000000000000022";
const point: [number, number] = [-0.521111, 38.990276];
const fixture = (): any => ({ _id: restaurantId, slug: "offline-fee-partner", name: "Offline fee fixture", isActive: true, onboardingStatus: "approved", availabilityStatus: "available", listingType: "official_partner", fulfillmentMode: "partner_delivery", priceIncludesCommission: true, partnerProfile: { commissionRateBps: 1800 }, deliveryFeeCents: 399, location: { coordinates: [-0.522, 38.99] }, menu: [{ id: "dish", name: "Offline dish", price: 7.02, available: true, allergens: [], modifiers: [] }] });
const requestInput = (extra: any = {}) => ({ restaurantId, items: [{ id: "dish", quantity: 1 }], address: "Offline address 12", deliveryLocation: { latitude: point[1], longitude: point[0] }, paymentMethod: "stripe", ...extra });
function response(): any { return { statusCode: 200, body: null, headers: {}, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; }, setHeader(key: string, value: string) { this.headers[key] = value; } }; }
function query(read: (session: any) => any): any { return { inSession: null, session(s: any) { this.inSession = s; return this; }, select() { return this; }, lean() { return this; }, exec() { return Promise.resolve(read(this.inSession)); } }; }

test("sourceOrderFee: configuración por identidad, fallback vigente y fail closed", () => {
  for (const fee of [0, 399, 999, MAX_SOURCE_ORDER_FEE_CENTS]) assert.equal(sourceOrderFee({ _id: restaurantId, deliveryFeeCents: fee }, 299), fee);
  assert.equal(sourceOrderFee({ _id: restaurantId }, XATIVA_COVERAGE_POLICY.deliveryBaseFeeCents), 299);
  for (const fee of [null, -1, NaN, Infinity, -Infinity, 3.99, "399", true, MAX_SOURCE_ORDER_FEE_CENTS + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => sourceOrderFee({ _id: restaurantId, deliveryFeeCents: fee }, 299), /INVALID_DELIVERY_FEE/);
  }
  assert.throws(() => sourceOrderFee({ _id: "", deliveryFeeCents: 399 }, 299), /INVALID_DELIVERY_FEE_CONTEXT/);
  assert.throws(() => sourceOrderFee({ _id: restaurantId }, NaN), /INVALID_DELIVERY_FEE/);
  const configured = evaluateXativaCoverage(point, fixture());
  const policy = evaluateXativaCoverage(point);
  assert.equal(configured.deliveryFeeCents, 399);
  assert.equal(configured.deliveryBaseFeeCents, 399);
  assert.deepEqual({ ...configured, deliveryFeeCents: 299, deliveryBaseFeeCents: 299 }, policy, "solo cambia la tarifa, no geografía ni contrato de cobertura");
  const outside = evaluateXativaCoverage([0, 0], fixture());
  assert.equal(outside.covered, false); assert.equal(outside.deliveryFeeCents, null);
  assert.deepEqual(requiredVehiclesForRoute(null), ["motorcycle", "scooter", "car"]);
  assert.deepEqual(requiredVehiclesForRoute(1.5), ["motorcycle", "scooter", "car"]);
});

test("precio final 7.02 no recibe markup de nuevo; base de otros locales conserva redondeo legacy", () => {
  const restaurant = fixture();
  const requested = [{ id: "dish", quantity: 2 }];
  const items = customerQuotedItems(restaurant, requested);
  assert.equal(items[0].unitPriceCents, 702);
  const quote = customerOrderQuote({ restaurant, customerId: null, wallet: null, items, deliveryPoint: point, deliveryFeeCents: 399, serviceFeeCents: 0, paymentMethod: "stripe" });
  assert.equal(quote.subtotalCents, 1404); assert.equal(quote.totalCents, 1803); assert.equal(quote.expectation.deliveryFeeCents, 399, "envío una vez por pedido, no por SKU");
  const base = { ...restaurant, priceIncludesCommission: false, menu: [{ ...restaurant.menu[0], price: 5.95 }] };
  assert.equal(customerQuotedItems(base, [{ id: "dish", quantity: 1 }])[0].unitPriceCents, 703, "no alterar ceil global: almacenar HALF_UP final + flag explícito");
  for (const fee of [-1, NaN, 0.5]) assert.throws(() => customerOrderQuote({ restaurant, customerId: null, wallet: null, items, deliveryPoint: point, deliveryFeeCents: fee, serviceFeeCents: 0, paymentMethod: "stripe" }), /INVALID_TOTAL/);
});

test("handler POST real offline: quote → checkout tarifa exacta y rechazos antes de Order/Stripe", async (t) => {
  assert.equal(process.env.PIKI_NO_LISTEN, "true", "Usar scripts/offline-validation.mjs test");
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_mock_not_a_real_key";
  const { handleCustomerTrpc } = await import("./customerCompat.js");
  const { stripe } = await import("./stripe.js");
  if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
  assert.ok(stripe);
  let restaurant = fixture();
  const wallet = { _id: customerId, email: "offline@example.invalid", pikiCreditsCents: 0, pikiCreditsExpiresAt: null };
  let effects: string[] = []; let orders: any[] = []; let stripeInputs: any[] = [];
  let onStart: (() => void) | null = null;
  let retry = false; let onLock: (() => void) | null = null;
  const session: any = { async withTransaction(fn: () => Promise<void>) { for (;;) { try { await fn(); effects.push("commit"); return; } catch (error: any) { effects.push("abort"); if (retry && error.code === 112) { retry = false; effects.push("retry"); continue; } throw error; } } }, async endSession() {} };
  t.mock.method(mongoose.Query.prototype as any, "exec", () => { throw new Error("UNMOCKED_DB_FORBIDDEN"); });
  t.mock.method(CustomerAccount as any, "findOne", () => query(() => structuredClone(wallet)));
  t.mock.method(CustomerAccount as any, "findById", () => query((s) => { assert.equal(s, session); return structuredClone(wallet); }));
  t.mock.method(CustomerAccount as any, "updateOne", (_f: any, _u: any, options: any) => query(() => { assert.equal(options.session, session); effects.push("wallet-cas"); return { matchedCount: 1 }; }));
  t.mock.method(Restaurant as any, "findOne", (filter: any) => query(() => { assert.equal(String(filter._id), restaurantId); return structuredClone(restaurant); }));
  t.mock.method(Restaurant as any, "updateOne", (_f: any, _u: any, options: any) => query(() => { assert.equal(options.session, session); effects.push("lock"); onLock?.(); return { matchedCount: 1 }; }));
  t.mock.method(mongoose, "startSession", async () => { effects.push("start"); onStart?.(); onStart = null; return session; });
  t.mock.method(Order as any, "create", async (payload: any[], options: any) => { assert.equal(options.session, session); effects.push("order"); orders.push({ _id: "64b000000000000000000023", ...payload[0] }); return [orders[0]]; });
  t.mock.method(Order as any, "updateOne", () => query(() => { effects.push("attach"); return { matchedCount: 1 }; }));
  t.mock.method(globalThis, "fetch", async (url: any) => { assert.ok(String(url).startsWith("https://router.project-osrm.org/route/")); effects.push("routing-mock"); return { ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 1600, duration: 120 }] }) } as any; });
  t.mock.method(stripe.checkout.sessions, "create", async (input: any) => { effects.push("stripe-mock"); stripeInputs.push(input); return { id: "cs_offline_fee", url: "https://checkout.stripe.com/c/pay/cs_offline_fee" } as any; });
  const call = async (procedure: string, input = requestInput()) => {
    const res = response();
    await handleCustomerTrpc({ originalUrl: `/api/trpc/${procedure}`, params: { procedure }, path: `/api/trpc/${procedure}`, query: {}, body: { json: input }, method: "POST", header: (key: string) => key === "x-piki-session" ? "offline-session" : undefined } as any, res);
    return res;
  };
  const reset = () => { restaurant = fixture(); effects = []; orders = []; stripeInputs = []; onStart = null; onLock = null; retry = false; };
  const quote = async () => { const result = await call("order.quote"); assert.equal(result.statusCode, 200); assert.deepEqual(effects, []); return result.body.result.data.json; };
  const assertNoPayment = () => { assert.equal(effects.includes("order"), false); assert.equal(effects.includes("stripe-mock"), false); assert.equal(effects.includes("wallet-cas"), false); assert.deepEqual(orders, []); assert.deepEqual(stripeInputs, []); };

  for (const fee of [399, 0, undefined]) await t.test(`tarifa persistida ${String(fee)} en quote, Order y Stripe mock`, async () => {
    reset(); if (fee === undefined) delete restaurant.deliveryFeeCents; else restaurant.deliveryFeeCents = fee;
    const quoted = await quote(); const expectedFee = fee ?? 299;
    assert.equal(quoted.subtotalCents, 702); assert.equal(quoted.deliveryFeeCents, expectedFee); assert.equal(quoted.expectation.deliveryFeeCents, expectedFee);
    const result = await call("order.checkout", requestInput({ expectation: quoted.expectation, deliveryFeeCents: 1, totalCents: 1 }));
    assert.equal(result.statusCode, 200); const checkout = result.body.result.data.json;
    assert.equal(checkout.totalCents, 702 + expectedFee); assert.equal(checkout.priceBreakdown.deliveryFeeCents, expectedFee);
    assert.equal(orders[0].deliveryFeeCents, expectedFee); assert.equal(orders[0].deliveryBaseFeeCents, expectedFee);
    assert.deepEqual(orders[0].requiredVehicleClasses, ["motorcycle", "scooter", "car"]);
    assert.equal(stripeInputs[0].line_items.reduce((sum: number, line: any) => sum + line.quantity * line.price_data.unit_amount, 0), quoted.totalCents);
    assert.ok(effects.indexOf("stripe-mock") > effects.indexOf("commit"));
  });
  for (const fee of [299, 499, undefined]) await t.test(`stale fee ${String(fee)} rechazado antes de routing/transacción`, async () => {
    reset(); const quoted = await quote(); if (fee === undefined) delete restaurant.deliveryFeeCents; else restaurant.deliveryFeeCents = fee;
    const result = await call("order.checkout", requestInput({ expectation: quoted.expectation }));
    assert.equal(result.statusCode, 409); assert.deepEqual(effects, []); assertNoPayment();
  });
  await t.test("config explícita cambia aunque misma tarifa efectiva: token detecta snapshot", async () => {
    reset(); delete restaurant.deliveryFeeCents; const quoted = await quote(); restaurant.deliveryFeeCents = 299;
    const result = await call("order.checkout", requestInput({ expectation: quoted.expectation }));
    assert.equal(result.statusCode, 409); assert.deepEqual(effects, []); assertNoPayment();
  });
  for (const fee of [499, -1, null, NaN]) await t.test(`relectura de tarifa ${String(fee)} en transacción aborta`, async () => {
    reset(); const quoted = await quote(); onStart = () => { restaurant.deliveryFeeCents = fee; };
    const result = await call("order.checkout", requestInput({ expectation: quoted.expectation }));
    assert.equal(result.statusCode, 409); assert.ok(effects.includes("abort")); assertNoPayment();
  });
  await t.test("WriteConflict reintenta y vuelve a leer tarifa: nunca conserva fee anterior", async () => {
    reset(); const quoted = await quote(); retry = true;
    onLock = () => { onLock = null; restaurant.deliveryFeeCents = 499; throw Object.assign(new Error("MOCK_WRITE_CONFLICT"), { code: 112 }); };
    const result = await call("order.checkout", requestInput({ expectation: quoted.expectation }));
    assert.equal(result.statusCode, 409); assert.ok(effects.includes("retry")); assertNoPayment();
  });
  for (const fee of [null, -1, NaN, Infinity, 399.1, "399", 100001]) await t.test(`fee inválida ${String(fee)} bloquea quote y checkout`, async () => {
    reset(); restaurant.deliveryFeeCents = fee;
    for (const procedure of ["order.quote", "order.checkout"]) { const result = await call(procedure); assert.equal(result.statusCode, 400); assert.equal(result.body.error.json.data.code, "INVALID_DELIVERY_FEE"); }
    assert.deepEqual(effects, []); assertNoPayment();
  });
  await t.test("fuera de cobertura no acepta configuración 399 ni cargos del cliente", async () => {
    reset(); const result = await call("order.checkout", requestInput({ deliveryLocation: { latitude: 0, longitude: 0 }, deliveryFeeCents: 399 }));
    assert.equal(result.statusCode, 400); assert.equal(result.body.error.json.data.code, "DELIVERY_OUTSIDE_COVERAGE"); assert.deepEqual(effects, []); assertNoPayment();
  });
});
