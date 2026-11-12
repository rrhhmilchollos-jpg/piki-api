import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { Order, Restaurant } from "./models.js";

function query(value: any): any { return { select() { return this; }, lean() { return this; }, exec: async () => value, then: (resolve: any, reject: any) => Promise.resolve(value).then(resolve, reject) }; }
function response(): any { return { statusCode: 200, body: null, status(value: number) { this.statusCode = value; return this; }, json(value: unknown) { this.body = value; return this; } }; }
const restaurantId = "64b000000000000000000031";
const tenantId = "64b000000000000000000032";
const fixture = (): any => ({ _id: restaurantId, tenantId, slug: "offline-rest-fee", name: "Offline REST fixture", listingType: "official_partner", fulfillmentMode: "partner_delivery", isActive: true, availabilityStatus: "available", onboardingStatus: "approved", location: { coordinates: [-0.522, 38.99] }, priceIncludesCommission: true, partnerProfile: { commissionRateBps: 1800 }, deliveryFeeCents: 399, menu: [{ id: "dish", name: "Offline dish", price: 7.02, available: true, modifiers: [], allergens: [] }] });

test("Root REST diff: handlers Express reales con fee persistida y stale guard antes de efectos", async (t) => {
  assert.equal(process.env.PIKI_NO_LISTEN, "true", "Solo scripts/offline-validation.mjs test en copia aislada con diff de Root");
  const { app } = await import("./server.js");
  const handler = (path: string) => { const route = (app as any)._router.stack.find((layer: any) => layer.route?.path === path).route; return route.stack[route.stack.length - 1].handle; };
  let restaurant = fixture(); let created: any[] = []; let routes = 0;
  t.mock.method(Restaurant as any, "findOne", () => query(restaurant));
  t.mock.method(Order as any, "exists", () => query(false));
  t.mock.method(Order as any, "create", async (payload: any) => { const order = { _id: "64b000000000000000000033", id: "64b000000000000000000033", ...payload }; created.push(order); return order; });
  t.mock.method(globalThis, "fetch", async (url: any) => { assert.ok(String(url).startsWith("https://router.project-osrm.org/route/")); routes++; return { ok: true, json: async () => ({ code: "Ok", routes: [{ distance: 1600, duration: 120 }] }) } as any; });
  const create = async (extra: any = {}) => { const res = response(); await handler("/api/v1/orders")({ body: { restaurantId, deliveryAddress: "Offline address 12", deliveryLocation: { latitude: 38.990276, longitude: -0.521111 }, items: [{ itemId: "dish", quantity: 2 }], paymentMethod: "stripe", ...extra }, header: () => undefined }, res, () => { throw new Error("UNEXPECTED_NEXT"); }); return res; };
  for (const fee of [399, 0, undefined]) await t.test(`REST guarda tarifa ${String(fee)} una vez y no aplica markup de nuevo`, async () => {
    restaurant = fixture(); if (fee === undefined) delete restaurant.deliveryFeeCents; else restaurant.deliveryFeeCents = fee; created = [];
    const res = await create({ deliveryFeeCents: 999, totalCents: 1 });
    assert.equal(res.statusCode, 201); const expected = fee ?? 299;
    assert.equal(created[0].subtotalCents, 1404); assert.equal(created[0].deliveryFeeCents, expected); assert.equal(created[0].deliveryBaseFeeCents, expected); assert.equal(created[0].totalCents, 1404 + expected);
    assert.deepEqual(created[0].requiredVehicleClasses, ["motorcycle", "scooter", "car"]);
    assert.equal(res.body.order.deliveryFeeCents, expected);
  });
  await t.test("REST invalidez y cobertura bloquean antes de Order", async () => {
    created = []; const beforeRoutes = routes; restaurant = fixture(); restaurant.deliveryFeeCents = -1;
    const invalid = await create(); assert.equal(invalid.statusCode, 409); assert.equal(invalid.body.error, "INVALID_DELIVERY_FEE");
    restaurant = fixture(); const outside = await create({ deliveryLocation: { latitude: 0, longitude: 0 } }); assert.equal(outside.statusCode, 422);
    assert.deepEqual(created, []); assert.equal(routes, beforeRoutes);
  });
  const order: any = { _id: "64b000000000000000000033", tenantId, restaurantId, publicCode: "OFFLINE-REST-FEE", paymentMethod: "stripe", paymentState: "pending", deliveryFeeCents: 399, deliveryBaseFeeCents: 399, subtotalCents: 702, serviceFeeCents: 0, totalCents: 1101 };
  t.mock.method(Order as any, "findById", () => query(order));
  const checkout = async () => { const res = response(); const token = createHmac("sha256", "development-only-checkout-secret").update(`checkout:${order.publicCode}`).digest("base64url"); await handler("/api/v1/payments/checkout")({ body: { orderId: order._id, checkoutToken: token, origin: "https://pikidelivery.com" } }, res, () => { throw new Error("UNEXPECTED_NEXT"); }); return res; };
  for (const fee of [499, undefined, null, -1, NaN, 399.1]) await t.test(`REST stale/invalid ${String(fee)} no llega a mutaciones ni Stripe`, async () => {
    restaurant = fixture(); if (fee === undefined) delete restaurant.deliveryFeeCents; else restaurant.deliveryFeeCents = fee;
    const res = await checkout(); assert.equal(res.statusCode, 409); assert.ok(["QUOTE_CHANGED", "INVALID_DELIVERY_FEE"].includes(res.body.error));
  });
  await t.test("REST identidad tenant diferente falla cerrado", async () => {
    restaurant = fixture(); restaurant.tenantId = "64b000000000000000000099";
    const res = await checkout(); assert.equal(res.statusCode, 409); assert.equal(res.body.error, "QUOTE_CHANGED");
  });
});
