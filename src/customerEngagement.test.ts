import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BADGES, STREAK_REWARD_CENTS, calculatePriceBreakdown, nextCustomerStreak, resolveWheelReward, resolveWheelSpin, streakRewardFor } from "./customerEngagement.js";

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

test("los badges cubren primer pedido, recurrencia, rachas, explorador y noctámbulo", () => {
  assert.deepEqual(DEFAULT_BADGES.map((badge) => badge.slug), [
    "first-order", "five-orders", "streak-3", "streak-7", "explorador-local", "noctambulo", "piki-lover",
  ]);
});

test("la ruleta respeta la tabla 1% / 60% / 39% sin zonas ambiguas", () => {
  assert.equal(resolveWheelSpin(0).kind, "free_order");
  assert.equal(resolveWheelSpin(0.009999).kind, "free_order");
  assert.equal(resolveWheelSpin(0.01).kind, "credit");
  assert.equal(resolveWheelSpin(0.01).cents, 150);
  assert.equal(resolveWheelSpin(0.609999).kind, "credit");
  assert.equal(resolveWheelSpin(0.61).kind, "free_delivery");
  assert.equal(resolveWheelSpin(0.61).cents, 299);
  assert.equal(resolveWheelSpin(0.999999).kind, "free_delivery");
  assert.equal(resolveWheelSpin(Number.NaN).kind, "none");
});

test("el pedido gratis se limita al subtotal y a un techo de 15 €", () => {
  assert.equal(resolveWheelSpin(0, { subtotalCents: 900 }).cents, 900);
  assert.equal(resolveWheelSpin(0, { subtotalCents: 9_900 }).cents, 1_500);
  assert.equal(resolveWheelSpin(0, { subtotalCents: 0 }).cents, 150);
});

test("resolveWheelReward mantiene el importe monetario del premio", () => {
  assert.equal(resolveWheelReward(0.3), 150);
  assert.equal(resolveWheelReward(0.9), 299);
  assert.equal(resolveWheelReward(Number.NaN), 0);
});

test("la recompensa de racha se paga una sola vez cada tres días consecutivos", () => {
  assert.deepEqual(streakRewardFor({ currentStreak: 2 }), { due: false, cents: 0 });
  assert.deepEqual(streakRewardFor({ currentStreak: 3, lastRewardStreak: 0 }), { due: true, cents: STREAK_REWARD_CENTS, streak: 3 });
  assert.deepEqual(streakRewardFor({ currentStreak: 3, lastRewardStreak: 3 }), { due: false, cents: 0 });
  assert.equal(streakRewardFor({ currentStreak: 6, lastRewardStreak: 3 }).due, true);
});

test("la racha sólo aumenta con el día UTC inmediatamente siguiente", () => {
  const previous = new Date("2026-11-01T23:59:00.000Z");
  assert.equal(nextCustomerStreak(2, previous, new Date("2026-11-02T00:01:00.000Z")), 3);
  assert.equal(nextCustomerStreak(2, previous, new Date("2026-11-03T00:01:00.000Z")), 1);
  assert.equal(nextCustomerStreak(2, previous, new Date("2026-10-31T00:01:00.000Z")), 1);
});
