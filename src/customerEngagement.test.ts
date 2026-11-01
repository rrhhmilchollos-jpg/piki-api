import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BADGES, calculatePriceBreakdown, nextCustomerStreak, resolveWheelReward } from "./customerEngagement.js";

test("priceBreakdown calcula subtotal, tarifas, descuento, propina y total en céntimos", () => {
  assert.deepEqual(calculatePriceBreakdown({ subtotalCents: 1200, deliveryFeeCents: 300, serviceFeeCents: 79, discountCents: 150, tipCents: 200 }), {
    subtotalCents: 1200, deliveryFeeCents: 300, serviceFeeCents: 79, discountCents: 150, tipCents: 200, totalCents: 1629,
  });
});

test("priceBreakdown no permite descuentos superiores al importe", () => {
  const result = calculatePriceBreakdown({ subtotalCents: 100, deliveryFeeCents: 0, serviceFeeCents: 0, discountCents: 999 });
  assert.equal(result.discountCents, 100);
  assert.equal(result.totalCents, 0);
});

test("los badges iniciales cubren primer pedido, recurrencia y rachas", () => {
  assert.deepEqual(DEFAULT_BADGES.map((badge) => badge.slug), ["first-order", "five-orders", "streak-3", "streak-7"]);
});

test("la ruleta aplica el límite de 60% sin zonas ambiguas", () => {
  assert.equal(resolveWheelReward(0), 150);
  assert.equal(resolveWheelReward(0.599999), 150);
  assert.equal(resolveWheelReward(0.6), 0);
  assert.equal(resolveWheelReward(1), 0);
  assert.equal(resolveWheelReward(Number.NaN), 0);
});

test("la racha sólo aumenta con el día UTC inmediatamente siguiente", () => {
  const previous = new Date("2026-11-01T23:59:00.000Z");
  assert.equal(nextCustomerStreak(2, previous, new Date("2026-11-02T00:01:00.000Z")), 3);
  assert.equal(nextCustomerStreak(2, previous, new Date("2026-11-03T00:01:00.000Z")), 1);
  assert.equal(nextCustomerStreak(2, previous, new Date("2026-10-31T00:01:00.000Z")), 1);
});
