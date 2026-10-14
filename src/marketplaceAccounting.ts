export type MarketplaceOrderAmounts = {
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  commissionRateBps: number;
  riderEarningsCents: number;
};

export type MarketplaceBreakdown = MarketplaceOrderAmounts & {
  customerFeesCents: number;
  customerTotalCents: number;
  platformCommissionCents: number;
  partnerPayoutCents: number;
  riderEarningsCents: number;
  platformNetBeforeProcessingCents: number;
};

const cents = (value: number) => {
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_MARKETPLACE_AMOUNT");
  return Math.round(value);
};

const bps = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) throw new Error("INVALID_COMMISSION_RATE");
  return value;
};

/**
 * Calculates the immutable money split for a single-marketplace order.
 * The partner commission applies to the product subtotal, not delivery or
 * customer service fees. Payment processor fees are deliberately recorded
 * separately by the payment adapter and never hidden in this calculation.
 */
export function calculateMarketplaceBreakdown(input: MarketplaceOrderAmounts): MarketplaceBreakdown {
  const subtotalCents = cents(input.subtotalCents);
  const deliveryFeeCents = cents(input.deliveryFeeCents);
  const serviceFeeCents = cents(input.serviceFeeCents);
  const commissionRateBps = bps(input.commissionRateBps);
  const riderEarningsCents = cents(input.riderEarningsCents);
  const platformCommissionCents = Math.floor((subtotalCents * commissionRateBps) / 10_000);
  const partnerPayoutCents = subtotalCents - platformCommissionCents;
  const customerFeesCents = deliveryFeeCents + serviceFeeCents;
  const customerTotalCents = subtotalCents + customerFeesCents;
  const platformNetBeforeProcessingCents = platformCommissionCents + customerFeesCents - riderEarningsCents;
  return {
    subtotalCents,
    deliveryFeeCents,
    serviceFeeCents,
    commissionRateBps,
    riderEarningsCents,
    customerFeesCents,
    customerTotalCents,
    platformCommissionCents,
    partnerPayoutCents,
    platformNetBeforeProcessingCents,
  };
}

export const DEFAULT_PARTNER_COMMISSION_BPS = 1_800;
