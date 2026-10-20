import assert from "node:assert/strict";
import test from "node:test";
import { calculateMarketplaceBreakdown } from "./marketplaceAccounting.js";

test("separa venta del partner, comision, tarifas y rider", () => {
  const result = calculateMarketplaceBreakdown({
    subtotalCents: 2_000,
    deliveryFeeCents: 299,
    serviceFeeCents: 99,
    commissionRateBps: 1_800,
    riderEarningsCents: 350,
  });
  assert.equal(result.platformCommissionCents, 360);
  assert.equal(result.partnerPayoutCents, 1_640);
  assert.equal(result.customerFeesCents, 398);
  assert.equal(result.customerTotalCents, 2_398);
  assert.equal(result.platformNetBeforeProcessingCents, 408);
});

test("la comision nunca se aplica a las tarifas de entrega", () => {
  const result = calculateMarketplaceBreakdown({ subtotalCents: 1_000, deliveryFeeCents: 500, serviceFeeCents: 0, commissionRateBps: 2_000, riderEarningsCents: 500 });
  assert.equal(result.platformCommissionCents, 200);
  assert.equal(result.partnerPayoutCents, 800);
  assert.equal(result.platformNetBeforeProcessingCents, 200);
});

test("la fase de acumulacion conserva 2,99 de entrega y cero payout de rider", () => {
  const result = calculateMarketplaceBreakdown({ subtotalCents: 1_000, deliveryFeeCents: 299, serviceFeeCents: 79, commissionRateBps: 2_000, riderEarningsCents: 0 });
  assert.equal(result.deliveryFeeCents, 299);
  assert.equal(result.riderEarningsCents, 0);
  assert.equal(result.platformNetBeforeProcessingCents, 578);
});

test("rechaza importes y comisiones imposibles", () => {
  assert.throws(() => calculateMarketplaceBreakdown({ subtotalCents: -1, deliveryFeeCents: 0, serviceFeeCents: 0, commissionRateBps: 1_800, riderEarningsCents: 0 }), /INVALID_MARKETPLACE_AMOUNT/);
  assert.throws(() => calculateMarketplaceBreakdown({ subtotalCents: 1, deliveryFeeCents: 0, serviceFeeCents: 0, commissionRateBps: 10_001, riderEarningsCents: 0 }), /INVALID_COMMISSION_RATE/);
});
