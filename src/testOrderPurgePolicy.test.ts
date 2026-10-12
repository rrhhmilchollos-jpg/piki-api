import assert from "node:assert/strict";
import test from "node:test";
import { buildPurgeConfirmationPhrase, getStaticPurgeBlockReasons, getTestOrderMarkers, isExactQaRestaurantName, isKnownQaSupportTicket, isPartnerTestOrderCandidate } from "./testOrderPurgePolicy.js";

test("KFC XATIVA QA matches only the exact normalized restaurant name", () => {
  assert.equal(isExactQaRestaurantName(" KFC   Xativa QA "), true);
  assert.equal(isExactQaRestaurantName("KFC XATIVA"), false);
  assert.equal(isExactQaRestaurantName("KFC XATIVA QA REAL"), false);
  assert.equal(isExactQaRestaurantName("QA KFC XATIVA"), false);
});

test("Partner test cleanup eligibility requires a test marker or exact KFC QA restaurant", () => {
  assert.equal(isPartnerTestOrderCandidate({ isTestOrder: true }, "KFC XATIVA"), true);
  assert.equal(isPartnerTestOrderCandidate({ qaRiderId: "rider-qa" }, "KFC XATIVA"), true);
  assert.equal(isPartnerTestOrderCandidate({}, " KFC  Xativa QA "), true);
  assert.equal(isPartnerTestOrderCandidate({}, "KFC XATIVA QA REAL"), false);
});

test("only explicit test markers and the exact QA restaurant classify an order as test data", () => {
  const qaIds = new Set(["qa-restaurant"]);
  assert.deepEqual(getTestOrderMarkers({ isTestOrder: true }, qaIds), ["isTestOrder:true"]);
  assert.deepEqual(getTestOrderMarkers({ qaRiderId: "rider-qa" }, qaIds), ["qaRiderId"]);
  assert.deepEqual(getTestOrderMarkers({ restaurantId: "qa-restaurant" }, qaIds), ["restaurant:KFC XATIVA QA exact"]);
  assert.deepEqual(getTestOrderMarkers({ restaurantId: "real-restaurant" }, qaIds), []);
});

test("cancelled unpaid orders are purgeable but active, delivered, paid or referenced orders fail closed", () => {
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "cancelled", paymentState: "pending" }, false), []);
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "ready_for_pickup", paymentState: "pending" }, false), ["ORDER_ACTIVE"]);
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "delivered", paymentState: "paid" }, false), ["PAYMENT_STATE_NOT_SAFE", "ORDER_NOT_CANCELLED"]);
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "cancelled", paymentState: "pending", stripePaymentIntentId: "pi_test" }, false), ["STRIPE_PAYMENT_REFERENCE"]);
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "cancelled", paymentState: "pending", cashCollectedAt: new Date() }, false), ["CASH_COLLECTION_REFERENCE"]);
});

test("only isolated QA simulator orders may be removed before pickup", () => {
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "ready_for_pickup", paymentState: "pending" }, true), []);
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "on_the_way", paymentState: "pending" }, true), ["ORDER_ACTIVE"]);
  assert.deepEqual(getStaticPurgeBlockReasons({ status: "ready_for_pickup", paymentState: "paid" }, true), ["PAYMENT_STATE_NOT_SAFE"]);
});

test("QA ticket identification requires both the QA role and a generated QA ticket number", () => {
  assert.equal(isKnownQaSupportTicket({ sourceRole: "qa", ticketNumber: "SUP-QA-ABC123" }), true);
  assert.equal(isKnownQaSupportTicket({ sourceRole: "support", ticketNumber: "SUP-QA-ABC123" }), false);
  assert.equal(isKnownQaSupportTicket({ sourceRole: "qa", ticketNumber: "SUP-2026-123" }), false);
});

test("confirmation phrase includes the exact preview count", () => {
  assert.equal(buildPurgeConfirmationPhrase(3), "ELIMINAR 3 PEDIDOS DE PRUEBA");
});
