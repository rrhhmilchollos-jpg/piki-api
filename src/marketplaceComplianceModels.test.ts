import assert from "node:assert/strict";
import test from "node:test";
import { assertComplianceTransition, isOperational, openPayoutHoldReason } from "./marketplaceComplianceModels.js";

test("permite el flujo normal de revisión KYB", () => {
  assert.doesNotThrow(() => assertComplianceTransition({ from: "pending", to: "in_review", actor: "admin" }));
  assert.doesNotThrow(() => assertComplianceTransition({ from: "in_review", to: "verified", actor: "admin" }));
});

test("impide saltar desde pending a verified", () => {
  assert.throws(() => assertComplianceTransition({ from: "pending", to: "verified", actor: "admin" }), /INVALID_COMPLIANCE_TRANSITION/);
});

test("solo marca operativo cuando PIKI y Stripe están listos", () => {
  const base = {
    legalEntityId: "legal-1",
    restaurantId: "restaurant-1",
    pikiStatus: "verified" as const,
    stripeAccountId: "acct_123",
    stripeStatus: "verified" as const,
    chargesEnabled: true,
    payoutsEnabled: true,
    stripeRequirementsClear: true,
    payoutHoldsClear: true,
  };
  assert.equal(isOperational(base), true);
  assert.equal(isOperational({ ...base, payoutsEnabled: false }), false);
  assert.equal(openPayoutHoldReason({ ...base, stripeRequirementsClear: false }), "STRIPE_REQUIREMENTS_OPEN");
});
