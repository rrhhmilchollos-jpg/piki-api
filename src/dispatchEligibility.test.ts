import assert from "node:assert/strict";
import { test } from "node:test";
import { activeOperationalOrderStatuses, dispatchableOrderStatuses, dispatchablePaymentFilter, isDispatchableOrderStatus, isDispatchablePayment } from "./dispatchEligibility.js";
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

test("a Rider can confirm pickup while the Partner is still processing the order", () => {
  for (const status of ["pending", "accepted", "preparing", "ready_for_pickup"] as const) {
    assert.equal(canTransition(status, "picked_up", "rider"), true);
  }
  assert.equal(canTransition("pending", "picked_up", "partner"), false);
});

test("the active operations list keeps orders visible through pickup and transit", () => {
  assert.deepEqual(activeOperationalOrderStatuses, [...dispatchableOrderStatuses, "picked_up", "on_the_way"]);
  assert.equal((activeOperationalOrderStatuses as readonly string[]).includes("delivered"), false);
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
