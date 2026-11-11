import assert from "node:assert/strict";
import test from "node:test";
import { stripeDeliveryPaymentAction } from "./deliveryConfirmation.js";

test("Stripe paid (card/Bizum automatic capture) needs no second charge or intent lookup", () => {
  assert.equal(stripeDeliveryPaymentAction({ paymentMethod: "stripe", paymentState: "paid", stripePaymentIntentId: "pi_offline_paid" }), "already_paid");
  assert.equal(stripeDeliveryPaymentAction({ paymentMethod: "stripe", paymentState: "paid" }), "already_paid");
});

test("legacy manual Stripe authorization still requires capture; unpaid/refunded states cannot deliver", () => {
  assert.equal(stripeDeliveryPaymentAction({ paymentMethod: "stripe", paymentState: "authorized", stripePaymentIntentId: "pi_offline_hold" }), "capture_authorization");
  for (const paymentState of ["pending", "failed", "refunded", "expired", "authorized"]) {
    assert.equal(stripeDeliveryPaymentAction({ paymentMethod: "stripe", paymentState }), "reject");
  }
});

test("cash guarantee is never interpreted as an online charge to capture", () => {
  for (const paymentState of ["pending", "authorized", "paid"]) {
    assert.equal(stripeDeliveryPaymentAction({ paymentMethod: "cash", paymentState, stripePaymentIntentId: "pi_offline_cod" }), "reject");
  }
});
