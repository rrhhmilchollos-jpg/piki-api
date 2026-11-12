import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CustomerAccount, Order, Restaurant } from "./models.js";
import { CustomerQuoteConflict, customerQuoteExpectationSchema } from "./customerOrderQuote.js";

const customerId = "64b000000000000000000010";
const restaurantId = "64b000000000000000000011";
const expiry = new Date("2099-01-01T00:00:00Z");
const location = { latitude: 38.990276, longitude: -0.521111 };
const fixture = () => ({ _id: restaurantId, slug: "offline-credit-partner", tenantId: "64b000000000000000000012", name: "Sintético", isActive: true, onboardingStatus: "approved", availabilityStatus: "available", listingType: "official_partner", fulfillmentMode: "partner_delivery", priceIncludesCommission: true, menuRevision: 4, location: { coordinates: [-0.522, 38.99] }, menu: [{ id: "dish", name: "Plato", price: 10, available: true, modifiers: [] }] });
const account = (balance: number, expiresAt: Date | null = expiry) => ({ _id: customerId, email: "offline@example.invalid", pikiCreditsCents: balance, pikiCreditsExpiresAt: expiresAt });
function same(a: any, b: any) { return JSON.stringify(a) === JSON.stringify(b); }
function matches(row: any, filter: any, dbNow = Date.now()): boolean {
  return Object.entries(filter).every(([key, value]: [string, any]) => {
    if (key === "$or") return value.some((part: any) => matches(row, part));
    if (key === "$expr") {
      const [operator, [field]] = Object.entries(value)[0] as [string, any];
      const actual = new Date(row[field.slice(1)]).getTime();
      return operator === "$gt" ? actual > dbNow : actual <= dbNow;
    }
    const actual = key.split(".").reduce((v, part) => v?.[part], row);
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$exists" in value) return (actual !== undefined) === value.$exists;
      if ("$ne" in value) return !same(actual, value.$ne);
      if ("$in" in value) return value.$in.includes(actual);
      if ("$nin" in value) return !value.$nin.includes(actual);
    }
    return same(actual, value) || String(actual) === String(value);
  });
}
function query(read: () => any): any {
  return { selected: "", inSession: null, select(value: string) { this.selected = value; return this; }, session(value: any) { this.inSession = value; return this; }, lean() { return this; }, exec() { return Promise.resolve(read.call(this)); } };
}
function response(): any { return { statusCode: 200, body: null, headers: {}, status(value: number) { this.statusCode = value; return this; }, json(value: unknown) { this.body = value; return this; }, setHeader(key: string, value: string) { this.headers[key] = value; } }; }

// The callback comparison is deliberately EXACT, including the credit component.
// This is a contract regression, not a mount/browser/E2E of the Customer app.
function callbackAllowsCheckout(quote: any, checkout: any): boolean {
  return typeof checkout.checkoutUrl === "string" && checkout.totalCents === quote.totalCents && checkout.creditAppliedCents === quote.creditAppliedCents &&
    checkout.totalCents === quote.subtotalCents + quote.deliveryFeeCents + quote.serviceFeeCents - quote.creditAppliedCents;
}

test("quote → checkout real: crédito confirmado, expectativa exacta y débito transaccional offline", async (t) => {
  assert.equal(process.env.PIKI_NO_LISTEN, "true", "Usar scripts/offline-validation.mjs test");
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_offline_mock_not_a_real_key";
  const { handleCustomerTrpc } = await import("./customerCompat.js");
  const { stripe } = await import("./stripe.js");
  if (previousKey === undefined) delete process.env.STRIPE_SECRET_KEY; else process.env.STRIPE_SECRET_KEY = previousKey;
  assert.ok(stripe);
  t.mock.method(mongoose.Query.prototype as any, "exec", () => { throw new Error("UNMOCKED_DB_FORBIDDEN"); });
  let restaurant: any = fixture();
  let wallet: any = account(0);
  let orders: any[] = [];
  let staged: { restaurant: any; wallet: any; orders: any[] } | null = null;
  let effects: string[] = [];
  let debitFilters: any[] = [];
  let stripeInputs: any[] = [];
  let onStart: (() => void) | null = null;
  let onDebit: (() => void) | null = null;
  let onRestaurantLock: (() => void) | null = null;
  let retryOnce = false;
  let orderFailure = false;
  let stripeFailure = false;
  let quoteSessionReads = 0;
  let debitDbNow: number | undefined;
  const reset = (balance = 0, expiration: Date | null = expiry) => {
    restaurant = fixture(); wallet = account(balance, expiration); orders = []; staged = null; effects = []; debitFilters = []; stripeInputs = [];
    onStart = null; onDebit = null; orderFailure = false; stripeFailure = false; quoteSessionReads = 0;
    debitDbNow = undefined;
    onRestaurantLock = null; retryOnce = false;
  };
  const session: any = {
    async withTransaction(fn: () => Promise<void>) {
      assert.equal(staged, null);
      for (;;) {
        staged = structuredClone({ restaurant, wallet, orders });
        try {
          await fn();
          restaurant = staged!.restaurant; wallet = staged!.wallet; orders = staged!.orders;
          effects.push("commit"); return;
        } catch (error: any) {
          effects.push("abort");
          if (retryOnce && error.code === 112) { retryOnce = false; effects.push("retry"); continue; }
          throw error;
        } finally { staged = null; }
      }
    },
    async endSession() { effects.push("end"); },
  };
  t.mock.method(mongoose, "startSession", async () => { effects.push("start"); onStart?.(); onStart = null; return session; });
  t.mock.method(CustomerAccount as any, "findOne", () => query(() => structuredClone(wallet)));
  t.mock.method(CustomerAccount as any, "findById", (id: any) => query(function(this: any) {
    assert.equal(String(id), customerId); assert.equal(this.inSession, session); quoteSessionReads++;
    return structuredClone(staged!.wallet);
  }));
  t.mock.method(CustomerAccount as any, "updateOne", (filter: any, update: any, options: any) => query(() => {
    assert.equal(options.session, session); assert.ok(staged);
    effects.push(update.$inc.pikiCreditsCents < 0 ? "debit" : update.$inc.pikiCreditsCents > 0 ? "refund" : "zero-credit-cas");
    debitFilters.push(structuredClone(filter));
    if (onDebit) { const hook = onDebit; onDebit = null; hook(); return { matchedCount: 0 }; }
    if (!matches(staged!.wallet, filter, debitDbNow)) return { matchedCount: 0 };
    staged!.wallet.pikiCreditsCents += update.$inc.pikiCreditsCents;
    if (update.$max) staged!.wallet.pikiCreditsExpiresAt = new Date(Math.max(new Date(staged!.wallet.pikiCreditsExpiresAt).getTime(), new Date(update.$max.pikiCreditsExpiresAt).getTime()));
    return { matchedCount: 1 };
  }));
  t.mock.method(Restaurant as any, "findOne", (filter: any) => query(function(this: any) {
    const row = this.inSession ? staged!.restaurant : restaurant;
    return matches(row, filter) ? structuredClone(row) : null;
  }));
  t.mock.method(Restaurant as any, "updateOne", (filter: any, update: any, options: any) => query(() => {
    assert.equal(options.session, session); assert.deepEqual(update.$inc, { __v: 1 }); assert.equal(options.timestamps, false);
    effects.push("restaurant-lock");
    if (onRestaurantLock) { const hook = onRestaurantLock; onRestaurantLock = null; hook(); }
    if (!matches(staged!.restaurant, filter)) return { matchedCount: 0 };
    staged!.restaurant.__v = (staged!.restaurant.__v ?? 0) + 1;
    return { matchedCount: 1 };
  }));
  t.mock.method(Order as any, "create", async (payload: any[], options: any) => {
    effects.push("order-create"); assert.equal(options.session, session); assert.ok(staged);
    if (orderFailure) throw new Error("MOCK_ORDER_FAILURE");
    const order = { _id: "64b000000000000000000013", ...payload[0], stripeCheckoutSessionId: null };
    staged!.orders.push(order); return [order];
  });
  t.mock.method(Order as any, "updateOne", (filter: any, update: any, options: any) => query(() => {
    const list = options?.session ? staged!.orders : orders;
    const order = list.find((row: any) => matches(row, filter));
    effects.push(update.$set.paymentState === "failed" ? "order-failed" : "attach-stripe");
    if (!order) return { matchedCount: 0 };
    Object.assign(order, update.$set); return { matchedCount: 1 };
  }));
  t.mock.method(globalThis, "fetch", async (url: any) => {
    assert.ok(String(url).startsWith("https://router.project-osrm.org/route/"));
    return { ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 1000, duration: 120 }] }) } as any;
  });
  t.mock.method(stripe.checkout.sessions, "create", async (input: any) => {
    effects.push("stripe"); stripeInputs.push(input);
    if (stripeFailure) throw new Error("MOCK_STRIPE_UNAVAILABLE");
    return { id: "cs_offline_mock", url: "https://checkout.stripe.com/c/pay/cs_offline_mock" } as any;
  });
  t.mock.method(console, "error", () => undefined);
  const input = (extra: any = {}) => ({ restaurantId, items: [{ id: "dish", quantity: 1 }], deliveryLocation: location, address: "Calle sintética 12", paymentMethod: "stripe", ...extra });
  const call = async (procedure: string, body = input()) => {
    const res = response();
    await handleCustomerTrpc({ originalUrl: `/api/trpc/${procedure}`, params: { procedure }, path: `/api/trpc/${procedure}`, query: {}, body: { json: body }, method: "POST", header: (name: string) => name === "x-piki-session" ? "offline-session" : undefined } as any, res);
    return res;
  };
  const getQuote = async () => {
    const before = structuredClone({ restaurant, wallet, orders });
    const result = await call("order.quote"); assert.equal(result.statusCode, 200);
    assert.equal(result.headers["Cache-Control"], "private, no-store, max-age=0");
    assert.deepEqual({ restaurant, wallet, orders }, before); assert.deepEqual(effects, []); assert.equal(quoteSessionReads, 0);
    return result.body.result.data.json;
  };

  for (const [label, balance, expiration, applied] of [["cero", 0, expiry, 0], ["positivo", 300, expiry, 300], ["caducado", 300, new Date("2000-01-01"), 0], ["sin vigencia", 300, null, 0]] as const) {
    await t.test(`quote y callback neto con crédito ${label}`, async () => {
      reset(balance, expiration);
      const quote = await getQuote();
      assert.equal(quote.creditAppliedCents, applied);
      assert.equal(quote.totalCents, quote.subtotalCents + quote.deliveryFeeCents + quote.serviceFeeCents - applied);
      assert.equal(customerQuoteExpectationSchema.safeParse(quote.expectation).success, true);
      const checkout = await call("order.checkout", input({ expectation: quote.expectation }));
      assert.equal(checkout.statusCode, 200);
      const result = checkout.body.result.data.json;
      assert.equal(callbackAllowsCheckout(quote, result), true);
      assert.equal(callbackAllowsCheckout(quote, { ...result, totalCents: result.totalCents - 1 }), false, "no permitir un importe menor");
      assert.equal(orders[0].totalCents, quote.totalCents); assert.equal(orders[0].creditAppliedCents, applied);
      assert.equal(wallet.pikiCreditsCents, balance - applied);
      assert.equal(stripeInputs[0].line_items.reduce((sum: number, line: any) => sum + line.quantity * line.price_data.unit_amount, 0), quote.totalCents);
      assert.equal(stripeInputs[0].metadata.piki_credit_cents, String(applied));
      assert.ok(effects.indexOf("order-create") > effects.indexOf(applied ? "debit" : "zero-credit-cas"));
      assert.ok(effects.indexOf("stripe") > effects.indexOf("commit"));
      assert.equal(debitFilters[0].pikiCreditsCents, balance);
      assert.deepEqual(debitFilters[0].pikiCreditsExpiresAt, expiration);
      if (applied) assert.deepEqual(debitFilters[0].$expr, { $gt: ["$pikiCreditsExpiresAt", "$$NOW"] });
    });
  }
  for (const change of ["saldo baja", "saldo sube", "caduca", "precio", "elegibilidad", "identidad", "saldo cambia pero descuento sigue limitado"] as const) await t.test(`cambio entre quote y checkout: ${change}`, async () => {
    reset(change === "saldo cambia pero descuento sigue limitado" ? 10000 : 300);
    const quote = await getQuote();
    if (change === "saldo baja") wallet.pikiCreditsCents = 100;
    if (change === "saldo sube") wallet.pikiCreditsCents = 400;
    if (change === "caduca") wallet.pikiCreditsExpiresAt = new Date("2000-01-01");
    if (change === "precio") restaurant.menu[0].price = 11;
    if (change === "elegibilidad") restaurant.fulfillmentMode = "assisted_purchase";
    if (change === "identidad") wallet._id = "64b000000000000000000099";
    if (change === "saldo cambia pero descuento sigue limitado") wallet.pikiCreditsCents = 9999;
    const before = structuredClone(wallet);
    const result = await call("order.checkout", input({ expectation: quote.expectation }));
    assert.ok(result.statusCode === 409 || (change === "elegibilidad" && result.statusCode === 404));
    assert.deepEqual(effects, [], "rechaza incluso antes de iniciar transacción"); assert.deepEqual(orders, []); assert.deepEqual(wallet, before); assert.deepEqual(stripeInputs, []);
  });
  for (const change of ["saldo", "precio", "elegibilidad"] as const) await t.test(`relectura transaccional detecta cambio tras precheck: ${change}`, async () => {
    reset(300); const quote = await getQuote();
    onStart = () => { if (change === "saldo") wallet.pikiCreditsCents = 100; if (change === "precio") restaurant.menu[0].price = 12; if (change === "elegibilidad") restaurant.fulfillmentMode = "assisted_purchase"; };
    const result = await call("order.checkout", input({ expectation: quote.expectation }));
    assert.equal(result.statusCode, 409); assert.deepEqual(orders, []); assert.equal(stripeInputs.length, 0);
    assert.equal(effects.includes("order-create"), false); assert.equal(effects.includes("debit"), false); assert.equal(effects.includes("abort"), true);
  });
  await t.test("retry por WriteConflict vuelve a validar expectativa original, nunca acepta saldo menor", async () => {
    reset(300); const quote = await getQuote(); retryOnce = true;
    onRestaurantLock = () => { wallet.pikiCreditsCents = 100; throw Object.assign(new Error("MOCK_WRITE_CONFLICT"), { code: 112 }); };
    const result = await call("order.checkout", input({ expectation: quote.expectation }));
    assert.equal(result.statusCode, 409); assert.equal(effects.includes("retry"), true);
    assert.equal(wallet.pikiCreditsCents, 100); assert.deepEqual(orders, []); assert.equal(stripeInputs.length, 0);
    assert.equal(effects.includes("debit"), false); assert.equal(effects.includes("order-create"), false);
  });
  for (const balance of [0, 300]) await t.test(`CAS fallido después de lectura con saldo ${balance}: no Order ni Stripe`, async () => {
    reset(balance); const quote = await getQuote();
    onDebit = () => { wallet.pikiCreditsCents = balance + 25; };
    const result = await call("order.checkout", input({ expectation: quote.expectation }));
    assert.equal(result.statusCode, 409); assert.equal(wallet.pikiCreditsCents, balance + 25);
    assert.deepEqual(orders, []); assert.equal(effects.includes("order-create"), false); assert.equal(effects.includes("stripe"), false);
    assert.equal(restaurant.__v, undefined, "también revierte lock de catálogo");
  });
  await t.test("caducidad en el instante del CAS usa reloj DB y aborta sin pedido", async () => {
    reset(300); const quote = await getQuote();
    // The API clock still considers the same snapshot unexpired; the simulated
    // database clock reaches its expiry exactly at the conditional write.
    debitDbNow = expiry.getTime();
    const result = await call("order.checkout", input({ expectation: quote.expectation }));
    assert.equal(result.statusCode, 409); assert.deepEqual(debitFilters[0].$expr, { $gt: ["$pikiCreditsExpiresAt", "$$NOW"] });
    assert.deepEqual(orders, []); assert.equal(wallet.pikiCreditsCents, 300); assert.equal(stripeInputs.length, 0);
  });
  await t.test("crédito que alcanza productos de varias unidades no pierde un céntimo en Stripe", async () => {
    reset(0);
    const quoteInput = input({ items: [{ id: "dish", quantity: 3 }] });
    const gross = (await call("order.quote", quoteInput)).body.result.data.json;
    wallet.pikiCreditsCents = gross.deliveryFeeCents + gross.serviceFeeCents + 1051;
    const quote = (await call("order.quote", quoteInput)).body.result.data.json;
    assert.deepEqual(effects, []);
    const checkout = await call("order.checkout", { ...quoteInput, expectation: quote.expectation });
    assert.equal(checkout.statusCode, 200);
    assert.equal(callbackAllowsCheckout(quote, checkout.body.result.data.json), true);
    const stripeTotal = stripeInputs[0].line_items.reduce((sum: number, line: any) => sum + line.quantity * line.price_data.unit_amount, 0);
    assert.equal(stripeTotal, quote.totalCents);
    assert.equal(stripeTotal, 1949);
  });
  await t.test("fallo Order.create revierte débito y lock por la misma transacción", async () => {
    reset(300); const quote = await getQuote(); orderFailure = true;
    const result = await call("order.checkout", input({ expectation: quote.expectation }));
    assert.notEqual(result.statusCode, 200); assert.equal(wallet.pikiCreditsCents, 300); assert.deepEqual(orders, []); assert.equal(stripeInputs.length, 0); assert.equal(restaurant.__v, undefined);
  });
  await t.test("Stripe falla: compensa saldo y marca failed atómicamente sin extender vigencia", async () => {
    reset(300); const quote = await getQuote(); stripeFailure = true;
    const result = await call("order.checkout", input({ expectation: quote.expectation }));
    assert.equal(result.statusCode, 503); assert.equal(wallet.pikiCreditsCents, 300); assert.deepEqual(wallet.pikiCreditsExpiresAt, expiry);
    assert.equal(orders[0].paymentState, "failed"); assert.equal(orders[0].creditAppliedCents, 0);
    assert.equal(orders[0].totalCents, quote.totalCents + 300);
  });
  await t.test("input legacy sin expectation conserva handler pero usa CAS transaccional", async () => {
    reset(300);
    const result = await call("order.checkout");
    assert.equal(result.statusCode, 200); assert.equal(result.body.result.data.json.creditAppliedCents, 300);
    assert.ok(effects.indexOf("debit") < effects.indexOf("order-create")); assert.equal(wallet.pikiCreditsCents, 0);
  });
  await t.test("expectation inválida o total menor se rechaza sin efectos", async () => {
    reset(300); const quote = await getQuote();
    for (const expectation of [null, {}, { ...quote.expectation, extra: true }, { ...quote.expectation, totalCents: quote.totalCents - 1 }]) {
      const result = await call("order.checkout", input({ expectation }));
      assert.ok([400, 409].includes(result.statusCode)); assert.deepEqual(effects, []); assert.deepEqual(orders, []);
    }
  });
  assert.equal(new CustomerQuoteConflict().message, "QUOTE_CHANGED");
});
