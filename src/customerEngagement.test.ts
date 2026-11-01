import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BADGES, STREAK_REWARD_CENTS, wheelWeights, calculatePriceBreakdown, nextCustomerStreak, resolveWheelReward, resolveWheelSpin, streakRewardFor } from "./customerEngagement.js";

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

test("un cliente nuevo nunca gana el pedido gratis", () => {
  const fresh = { spinsSinceJackpot: 0, completedOrders: 0 };
  for (const value of [0, 0.001, 0.5, 0.999999]) {
    assert.notEqual(resolveWheelSpin(value, { history: fresh }).kind, "free_order");
  }
  assert.equal(wheelWeights(fresh).free_order, 0);
});
test("el pedido gratis solo aparece tras 25 giros y 5 pedidos, y nunca pasa de 5 €", () => {
  const veteran = { spinsSinceJackpot: 30, completedOrders: 12, jackpotLastAt: null };
  const spin = resolveWheelSpin(0, { subtotalCents: 9_900, history: veteran });
  assert.equal(spin.kind, "free_order");
  assert.equal(spin.cents, 500);
  const lowTicket = resolveWheelSpin(0, { subtotalCents: 0, history: veteran });
  assert.equal(lowTicket.cents, 100);
  const blocked = resolveWheelSpin(0, { subtotalCents: 9_900, history: { ...veteran, jackpotLastAt: new Date() } });
  assert.notEqual(blocked.kind, "free_order");
});
test("la ruleta evita repetir el envío gratis y nunca supera el tope del 5 %", () => {
  const weights = wheelWeights({ lastPrize: "FREE_DELIVERY" });
  assert.ok(weights.free_delivery < 19, "el envío gratis baja tras ganarlo");
  for (const value of [0.05, 0.35, 0.6, 0.9]) {
    const spin = resolveWheelSpin(value);
    if (!spin.coupon) continue;
    assert.ok(spin.coupon.percentBps <= 500);
    assert.ok(spin.coupon.maxDiscountCents <= 200);
  }
});
test("cuando el cliente ya ha recibido 10 € al mes solo quedan premios pequeños", () => {
  const capped = wheelWeights({ rewardCentsLast30Days: 1_000, lastPrize: "CREDIT" });
  assert.equal(capped.free_order, 0);
  assert.equal(capped.free_delivery, 0);
  assert.equal(capped.coupon_high, 0);
  assert.ok(capped.credit > 0);
  assert.equal(resolveWheelSpin(0.99, { history: { rewardCentsLast30Days: 1_000 } }).kind, "credit");
});
test("la distribución real es aburrida a propósito: el crédito domina", () => {
  let credit = 0;
  const total = 4_000;
  for (let index = 0; index < total; index += 1) {
    if (resolveWheelSpin((index + 0.5) / total).kind === "credit") credit += 1;
  }
  assert.ok(credit / total > 0.3, `el crédito debería dominar y salió ${(credit / total * 100).toFixed(1)}%`);
  let jackpots = 0;
  for (let index = 0; index < total; index += 1) {
    if (resolveWheelSpin((index + 0.5) / total).kind === "free_order") jackpots += 1;
  }
  assert.equal(jackpots, 0, "sin historial suficiente no puede salir el pedido gratis");
  assert.equal(resolveWheelSpin(Number.NaN).kind, "none");
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
