import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { Restaurant, CustomerAccount } from "./models.js";
import { handleCustomerTrpc } from "./customerCompat.js";
import { customerMenuForRestaurant, menuItemIsAvailable } from "./customerCatalogPolicy.js";

const menu = [
  { id: "active", name: "Disponible", price: 10, available: true },
  { id: "paused", name: "Pausado", price: 8, available: false },
  { id: "legacy", name: "Sin flag antiguo", price: 7 },
];
const restaurant = { _id: "6acad53e7f55ddba7e05c189", name: "Mr Rooster", slug: "rooster-kebab-xativa", isActive: true, availabilityStatus: "available", onboardingStatus: "approved", menu };
const query = (data: unknown) => ({ sort() { return this; }, lean() { return this; }, exec: async () => data });
function response() {
  return {
    headers: {} as Record<string, string>, statusCode: 200, body: null as any,
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}
function request(procedure: string, body: unknown = {}) {
  return { params: { procedure }, originalUrl: `/api/trpc/${procedure}`, path: `/api/trpc/${procedure}`, query: {}, body, header: () => "test-session" } as unknown as Request;
}

test("public menu hides paused items without removing legacy available products", () => {
  assert.deepEqual(customerMenuForRestaurant({ menu }).map(item => item.id), ["active", "legacy"]);
  assert.equal(menuItemIsAvailable(null), false);
  assert.equal(menuItemIsAvailable(menu[1]), false);
  assert.equal(menuItemIsAvailable(menu[2]), true);
});

test("the actual Customer tRPC catalog route is no-store and omits paused products", async () => {
  const originalFind = Restaurant.find;
  Restaurant.find = (() => query([restaurant])) as any;
  try {
    const res = response();
    await handleCustomerTrpc(request("catalog.list"), res as unknown as Response);
    assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
    assert.deepEqual(res.body.result.data.json[0].menu.map((item: any) => item.id), ["active", "legacy"]);
  } finally { Restaurant.find = originalFind; }
});

test("a basket retained before a stock pause cannot create a Customer order", async () => {
  const originalRestaurant = Restaurant.findOne;
  const originalCustomer = CustomerAccount.findOne;
  Restaurant.findOne = (() => query(restaurant)) as any;
  CustomerAccount.findOne = (() => query({ _id: "test-customer" })) as any;
  try {
    const res = response();
    await handleCustomerTrpc(request("order.checkout", { restaurantId: restaurant._id, items: [{ id: "paused", quantity: 1 }] }), res as unknown as Response);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.json.data.code, "PRODUCT_UNAVAILABLE");
  } finally {
    Restaurant.findOne = originalRestaurant;
    CustomerAccount.findOne = originalCustomer;
  }
});
