import test from "node:test";
import assert from "node:assert/strict";
import { PIKI_PASS_MONTHLY_CENTS, PIKI_PASS_PLANS, PIKI_PASS_TRIAL_DAYS, mapStripeSubscriptionStatus } from "./pikiPassBilling.js";

test("los planes del Pass declaran 4,99 €/mes y 30 días de prueba", () => {
  assert.equal(PIKI_PASS_MONTHLY_CENTS, 499);
  assert.equal(PIKI_PASS_TRIAL_DAYS, 30);
  const monthly = PIKI_PASS_PLANS.find((plan) => plan.plan === "monthly");
  assert.equal(monthly?.amountCents, 499);
  assert.equal(monthly?.interval, "month");
  assert.equal(monthly?.trialDays, 30);
});

test("el estado de Stripe se proyecta al dominio del Pass", () => {
  assert.equal(mapStripeSubscriptionStatus("active"), "active");
  assert.equal(mapStripeSubscriptionStatus("trialing"), "active");
  assert.equal(mapStripeSubscriptionStatus("past_due"), "paused");
  assert.equal(mapStripeSubscriptionStatus("unpaid"), "paused");
  assert.equal(mapStripeSubscriptionStatus("canceled"), "cancelled");
  assert.equal(mapStripeSubscriptionStatus("incomplete_expired"), "expired");
});

test("un estado desconocido nunca concede acceso activo", () => {
  assert.notEqual(mapStripeSubscriptionStatus("something_new"), "active");
  assert.notEqual(mapStripeSubscriptionStatus(null), "active");
});
