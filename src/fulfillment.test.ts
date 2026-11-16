import assert from "node:assert/strict";
import test from "node:test";
import { CASH_PAYMENTS_ENABLED, isCashPaymentEnabledForRestaurant, isCashOrderWithinLimit, setCashPaymentsEnabled } from "./paymentPolicy.js";
import { allowedPaymentMethods, paymentDecision, bizumReferenceFor, canChargeCard, remainingCardCents } from "./fulfillment.js";

test("un local bizumOnly acepta bizum y contra reembolso cuando el interruptor lo habilita", () => {
  const previous = CASH_PAYMENTS_ENABLED;
  setCashPaymentsEnabled(true);
  try {
  const restaurant = { name: "Kings Tacos Xàtiva", bizumOnly: true };
  assert.deepEqual(allowedPaymentMethods(restaurant), ["bizum", "cash"]);
  const blocked = paymentDecision(restaurant, "stripe");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.ok === false && blocked.error, "PAYMENT_METHOD_NOT_ALLOWED");
  const ok = paymentDecision(restaurant, "bizum");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true && ok.paymentState, "pending_bizum_confirmation");
  } finally { setCashPaymentsEnabled(previous); }
});

test("la compra por encargo exige prepago y emite tarjeta", () => {
  const restaurant = { name: "Nakama Sushi", fulfillmentModel: "rider_purchase", paymentMethods: ["stripe", "bizum"] };
  const decision = paymentDecision(restaurant, "stripe");
  assert.equal(decision.ok, true);
  assert.equal(decision.ok === true && decision.riderPurchase, true);
  assert.equal(decision.ok === true && decision.requiresPrepayment, true);
});

test("el interruptor global de efectivo prevalece sobre la configuración guardada del comercio", () => {
  const previous = CASH_PAYMENTS_ENABLED;
  const sinBandera = { name: "Local", slug: "local-x", cashPaymentsEnabled: false };
  try {
    setCashPaymentsEnabled(false);
    assert.equal(isCashPaymentEnabledForRestaurant(sinBandera), false);
    setCashPaymentsEnabled(true);
    assert.equal(isCashPaymentEnabledForRestaurant(sinBandera), true);
  } finally { setCashPaymentsEnabled(previous); }
});

test("el catálogo cambia los métodos permitidos al activar o desactivar el interruptor sin reiniciar", () => {
  const previous = CASH_PAYMENTS_ENABLED;
  try {
    setCashPaymentsEnabled(false);
    assert.deepEqual(allowedPaymentMethods({ name: "Local sin métodos legacy" }), ["stripe", "bizum"]);
    setCashPaymentsEnabled(true);
    assert.deepEqual(allowedPaymentMethods({ name: "Local sin métodos legacy" }), ["stripe", "bizum", "cash"]);
    setCashPaymentsEnabled(false);
    assert.deepEqual(allowedPaymentMethods({ name: "Local sin métodos legacy" }), ["stripe", "bizum"]);
  } finally { setCashPaymentsEnabled(previous); }
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


test("Bizum está disponible para cualquier partner e importe y no se trata como efectivo", () => {
  const previous = CASH_PAYMENTS_ENABLED;
  try {
    setCashPaymentsEnabled(false);
    assert.equal(paymentDecision({ name: "Partner con configuración legacy", paymentMethods: ["cash"] }, "bizum").ok, true);
    assert.equal(isCashOrderWithinLimit("bizum", 999_999_999), true);
  } finally { setCashPaymentsEnabled(previous); }
});
