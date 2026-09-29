import assert from "node:assert/strict";
import { test } from "node:test";
import { dispatchableOrderStatuses, isDispatchableOrderStatus } from "./dispatchEligibility.js";
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
