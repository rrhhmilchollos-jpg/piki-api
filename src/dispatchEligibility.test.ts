import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchableOrderStatuses, dispatchablePaymentFilter, isDispatchableOrderStatus, isDispatchablePayment } from "./dispatchEligibility.js";
import { canTransition } from "./workflow.js";

test("pending orders are eligible for rider dispatch before Partner acceptance", () => {
  assert.equal(isDispatchableOrderStatus("pending"), true);
  assert.deepEqual(dispatchableOrderStatuses, [
    "pending",
    "accepted",
    "preparing",
    "ready_for_pickup",
  ]);
  assert.equal(isDispatchableOrderStatus("delivered"), false);
});

test("a Rider can confirm pickup from a pending order, but a Partner cannot", () => {
  assert.equal(canTransition("pending", "picked_up", "rider"), true);
  assert.equal(canTransition("pending", "picked_up", "partner"), false);
});


test("only paid online orders and cash-on-delivery orders are visible to operations", () => {
  assert.equal(isDispatchablePayment("paid", "stripe"), true);
  assert.equal(isDispatchablePayment("pending", "cash"), true);
  assert.equal(isDispatchablePayment("pending", "stripe"), false);
  assert.equal(isDispatchablePayment("failed", "cash"), false);
  assert.deepEqual(dispatchablePaymentFilter, {
    $or: [
      { paymentState: "paid" },
      { paymentMethod: "cash", paymentState: "pending" },
    ],
  });
});
