import assert from "node:assert/strict";
import test from "node:test";
import { allowedPaymentMethods, paymentDecision, bizumReferenceFor, canChargeCard, remainingCardCents } from "./fulfillment.js";

test("un local bizumOnly solo acepta bizum", () => {
  const restaurant = { name: "Kings Tacos Xàtiva", bizumOnly: true };
  assert.deepEqual(allowedPaymentMethods(restaurant), ["bizum"]);
  const blocked = paymentDecision(restaurant, "stripe");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.error, "PAYMENT_METHOD_NOT_ALLOWED");
  const ok = paymentDecision(restaurant, "bizum");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.paymentState, "pending_bizum_confirmation");
});

test("la compra por encargo exige prepago y emite tarjeta", () => {
  const restaurant = { name: "Nakama Sushi", fulfillmentModel: "rider_purchase", paymentMethods: ["stripe", "bizum"] };
  const decision = paymentDecision(restaurant, "stripe");
  assert.equal(decision.ok, true);
  assert.equal(decision.ok === true && decision.riderPurchase, true);
  assert.equal(decision.ok === true && decision.requiresPrepayment, true);
});

test("el efectivo sigue bloqueado sin habilitación explícita", () => {
  const restaurant = { name: "Forno Rossi", cashPaymentsEnabled: false };
  const decision = paymentDecision(restaurant, "cash");
  assert.equal(decision.ok, false);
});

test("la referencia de bizum es corta y única por pedido", () => {
  assert.equal(bizumReferenceFor("PIKI-ABC123"), "PIKIABC123");
  assert.match(bizumReferenceFor("PIKI-MZ1K9QW2"), /^PIKI[A-Z0-9]{1,8}$/);
});

test("la tarjeta virtual nunca permite gastar más del presupuesto", () => {
  const card = { status: "issued", budgetCents: 500, spentCents: 200 };
  assert.equal(remainingCardCents(card), 300);
  assert.equal(canChargeCard(card, 300), true);
  assert.equal(canChargeCard(card, 301), false);
  assert.equal(canChargeCard({ ...card, status: "settled" }, 100), false);
  assert.equal(canChargeCard(card, 0), false);
});
