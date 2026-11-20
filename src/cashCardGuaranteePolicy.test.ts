import assert from "node:assert/strict";
import test from "node:test";
import { Types } from "mongoose";
import { CASH_PAYMENTS_ENABLED, setCashPaymentsEnabled, isCashPaymentEnabledForRestaurant } from "./paymentPolicy.js";
import { approveCashWithoutCardForOrder, cashCardGuaranteeRequiredForRestaurant, CASH_WITHOUT_CARD_RESTAURANT_IDS, CASH_WITHOUT_CARD_TENANT_ID } from "./cashCardGuaranteePolicy.js";
import { dispatchablePaymentFilter, isDispatchablePayment } from "./dispatchEligibility.js";
import { publicRestaurantPaymentCapabilities } from "./publicRestaurantPaymentCapabilities.js";
import { Order, Restaurant } from "./models.js";

const customer = { _id: "640000000000000000000001" };
const restaurant = (id: string = CASH_WITHOUT_CARD_RESTAURANT_IDS[0]) => ({ _id: new Types.ObjectId(id), tenantId: new Types.ObjectId(CASH_WITHOUT_CARD_TENANT_ID), cashPaymentsEnabled: true, partnerProfile: { cashCardGuaranteeRequired: false } });
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (key === "$or") return expected.some((part: any) => matches(row, part));
    const actual = row[key];
    if (expected === null) return actual == null;
    if (expected instanceof Types.ObjectId) return actual instanceof Types.ObjectId && String(actual) === String(expected);
    if (expected && typeof expected === "object") return Object.entries(expected).every(([op, value]: [string, any]) => {
      if (op === "$in") return value.some((item: any) => item instanceof Types.ObjectId ? actual instanceof Types.ObjectId && String(item) === String(actual) : item === actual);
      if (op === "$regex") return typeof actual === "string" && value.test(actual);
      if (op === "$gte") return typeof actual === "number" && actual >= value;
      if (op === "$lte") return typeof actual === "number" && actual <= value;
      if (op === "$mod") return typeof actual === "number" && actual % value[0] === value[1];
      assert.fail(`unsupported ${op}`);
    });
    return actual === expected;
  });
}
test("cash sin tarjeta: solo flags persistidos exactos de los dos Kazoku, autenticación y cap", () => {
  const previous = CASH_PAYMENTS_ENABLED;
  try {
    for (const globalEnabled of [false, true]) {
      setCashPaymentsEnabled(globalEnabled);
      for (const id of CASH_WITHOUT_CARD_RESTAURANT_IDS) {
        const row = restaurant(id);
        assert.equal(cashCardGuaranteeRequiredForRestaurant(row), false);
        assert.equal(isCashPaymentEnabledForRestaurant(row), true);
        const dto = publicRestaurantPaymentCapabilities(row);
        assert.equal(dto.cashPaymentsEnabled, true); assert.equal(dto.cashCardGuaranteeRequired, false);
        assert.ok(dto.allowedPaymentMethods.includes("cash"));
        assert.equal(approveCashWithoutCardForOrder(row, "cash", 4_899, customer), true);
        for (const total of [4_900, -1, 1.5, NaN, Infinity]) assert.equal(approveCashWithoutCardForOrder(row, "cash", total, customer), false);
        for (const user of [null, undefined, {}, { _id: "client-claim" }]) assert.equal(approveCashWithoutCardForOrder(row, "cash", 1_225, user), false);
        for (const method of ["stripe", "bizum"]) assert.equal(approveCashWithoutCardForOrder(row, method, 1_225, customer), false);
        for (const flag of [undefined, null, true, "false", 0]) assert.equal(approveCashWithoutCardForOrder({ ...row, partnerProfile: { cashCardGuaranteeRequired: flag } }, "cash", 1_225, customer), false);
        assert.equal(approveCashWithoutCardForOrder({ ...row, cashPaymentsEnabled: false }, "cash", 1_225, customer), false);
        assert.equal(approveCashWithoutCardForOrder({ ...row, tenantId: new Types.ObjectId() }, "cash", 1_225, customer), false);
        assert.equal(approveCashWithoutCardForOrder({ ...row, _id: new Types.ObjectId() }, "cash", 1_225, customer), false);
        assert.equal(approveCashWithoutCardForOrder({ ...row, cashOrderMaxCents: 1_000 }, "cash", 1_225, customer), false);
        assert.equal(approveCashWithoutCardForOrder({ ...row, cashOrderMinCents: 1_300 }, "cash", 1_225, customer), false);
      }
    }
  } finally { setCashPaymentsEnabled(previous); }
});
test("Mongo y runtime admiten snapshot cash pending aprobado, nunca Stripe/Bizum ni claims inválidos", () => {
  const row = restaurant();
  const base: any = { restaurantId: row._id, tenantId: row.tenantId, customerId: String(customer._id), cashWithoutCardApproved: true, paymentMethod: "cash", paymentState: "pending", totalCents: 1_225 };
  const cases = [{}, { cashWithoutCardApproved: false }, { cashWithoutCardApproved: undefined }, { cashWithoutCardApproved: "true" }, { paymentMethod: "stripe" }, { paymentMethod: "bizum" }, { paymentState: "failed" }, { paymentState: "refunded" }, { paymentState: "expired" }, { customerId: null }, { customerId: "client-claim" }, { tenantId: new Types.ObjectId() }, { restaurantId: new Types.ObjectId() }, { totalCents: null }, { totalCents: 4_899 }, { totalCents: 4_900 }, { totalCents: 1.5 }, { stripePaymentIntentId: "pi_existing_online" }, { stripeCheckoutSessionId: "cs_existing_online" }];
  for (const [index, override] of cases.entries()) {
    const order = { ...base, ...override };
    const expected = index === 0 || override.totalCents === 4_899;
    assert.equal(isDispatchablePayment(order.paymentState, order.paymentMethod, order.totalCents, order), expected, JSON.stringify(override));
    assert.equal(matches(order, dispatchablePaymentFilter), expected, JSON.stringify(override));
  }
  assert.equal(isDispatchablePayment("pending", "cash", 1_225), false, "missing full server snapshot remains blocked");
  for (const state of ["authorized", "paid"]) assert.equal(isDispatchablePayment(state, "stripe", 50_000), true);
});
test("Mongoose persiste defaults seguros y snapshot sin falsificar paymentState", () => {
  const schema: any = Restaurant.schema.path("partnerProfile");
  assert.equal(schema.schema.path("cashCardGuaranteeRequired").defaultValue, true);
  const base = { publicCode: "OFFLINE-CASH", restaurantId: restaurant()._id, tenantId: restaurant().tenantId, customerId: customer._id, totalCents: 1_225, paymentMethod: "cash" };
  assert.equal(new Order(base).cashWithoutCardApproved, false);
  const persisted = new Order({ ...base, cashWithoutCardApproved: true }).toObject();
  assert.equal(persisted.cashWithoutCardApproved, true); assert.equal(persisted.paymentState, "pending");
});
