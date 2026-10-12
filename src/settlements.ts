export type SettlementOrder = {
  publicCode: string;
  subtotalCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  distanceKm: number;
  tipCents?: number;
  incentiveCents?: number;
};

export type SettlementLine = {
  publicCode: string;
  grossCents: number;
  partnerCommissionCents: number;
  partnerNetCents: number;
  riderBaseCents: number;
  riderDistanceCents: number;
  riderIncentiveCents: number;
  riderTipCents: number;
  riderTotalCents: number;
  platformNetCents: number;
};

export type SettlementSummary = {
  lines: SettlementLine[];
  totals: Omit<SettlementLine, "publicCode">;
  commissionRate: number;
  formulaVersion: string;
};

function cents(value: number) { return Math.max(0, Math.round(value)); }

export const PARTNER_COMMISSION_RATE = 0.23;

/**
 * Phase 1 settlement baseline. Percentages and rates are explicit and versioned;
 * finance can replace them with contract-specific rules without changing orders.
 */
export function calculateSettlement(orders: SettlementOrder[], options?: { partnerCommissionRate?: number; riderBaseCents?: number; riderPerKmCents?: number }) {
  const partnerCommissionRate = options?.partnerCommissionRate ?? PARTNER_COMMISSION_RATE;
  const riderBaseCents = options?.riderBaseCents ?? 250;
  const riderPerKmCents = options?.riderPerKmCents ?? 60;
  const lines = orders.map((order): SettlementLine => {
    const partnerCommissionCents = cents(order.subtotalCents * partnerCommissionRate);
    const partnerNetCents = Math.max(0, order.subtotalCents - partnerCommissionCents);
    const riderDistanceCents = cents(order.distanceKm * riderPerKmCents);
    const riderIncentiveCents = cents(order.incentiveCents || 0);
    const riderTipCents = cents(order.tipCents || 0);
    const riderTotalCents = riderBaseCents + riderDistanceCents + riderIncentiveCents + riderTipCents;
    const grossCents = order.subtotalCents + order.deliveryFeeCents + order.serviceFeeCents + riderTipCents;
    const platformNetCents = grossCents - partnerNetCents - riderTotalCents;
    return { publicCode: order.publicCode, grossCents, partnerCommissionCents, partnerNetCents, riderBaseCents, riderDistanceCents, riderIncentiveCents, riderTipCents, riderTotalCents, platformNetCents };
  });
  const totals = lines.reduce((sum, line) => {
    for (const key of Object.keys(sum) as Array<keyof Omit<SettlementLine, "publicCode">>) sum[key] += line[key];
    return sum;
  }, { grossCents: 0, partnerCommissionCents: 0, partnerNetCents: 0, riderBaseCents: 0, riderDistanceCents: 0, riderIncentiveCents: 0, riderTipCents: 0, riderTotalCents: 0, platformNetCents: 0 });
  return { lines, totals, commissionRate: partnerCommissionRate, formulaVersion: "piki-partner-23-customer-fee-299-2026-10" } satisfies SettlementSummary;
}


export const RIDER_INCENTIVE_POLICY = {
  hourlyRateCents: 700,
  requiredShiftHours: 4,
  minimumAcceptanceRate: 0.95,
  centralZoneSlug: "xativa-centro",
  acquisitionDeliveries: 5,
  acquisitionBonusCents: 2000,
  referralDeliveries: 20,
  referralBonusCents: 1500,
} as const;

function nonNegativeCents(value: number) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Returns only the incremental top-up; base delivery earnings remain in calculateSettlement. */
export function calculateHourlyGuaranteeTopUp(input: {
  eligible: boolean;
  scheduledHours: number;
  completedHours: number;
  deliveryEarningsCents: number;
  hourlyRateCents?: number;
}) {
  if (!input.eligible || !Number.isFinite(input.scheduledHours) || input.scheduledHours <= 0) return 0;
  if (!Number.isFinite(input.completedHours) || input.completedHours < input.scheduledHours) return 0;
  const hourlyRateCents = nonNegativeCents(input.hourlyRateCents ?? RIDER_INCENTIVE_POLICY.hourlyRateCents);
  const floorCents = Math.round(hourlyRateCents * input.scheduledHours);
  return Math.max(0, floorCents - nonNegativeCents(input.deliveryEarningsCents));
}

/** Zero offers is treated as eligible: the 95% rule applies only when an offer actually arrives. */
export function isAcceptanceRateEligible(acceptedOffers: number, totalOffers: number, minimumRate = RIDER_INCENTIVE_POLICY.minimumAcceptanceRate) {
  if (!Number.isInteger(acceptedOffers) || !Number.isInteger(totalOffers) || acceptedOffers < 0 || totalOffers < 0 || acceptedOffers > totalOffers) return false;
  if (totalOffers === 0) return true;
  return acceptedOffers / totalOffers >= minimumRate;
}

export function getRecruitmentAwards(completedDeliveries: number, isReferred: boolean) {
  const completed = Number.isFinite(completedDeliveries) ? Math.max(0, Math.floor(completedDeliveries)) : 0;
  const acquisitionBonusCents = completed >= RIDER_INCENTIVE_POLICY.acquisitionDeliveries ? RIDER_INCENTIVE_POLICY.acquisitionBonusCents : 0;
  const referralActive = isReferred && completed >= RIDER_INCENTIVE_POLICY.referralDeliveries;
  return {
    acquisitionBonusCents,
    referredRiderBonusCents: referralActive ? RIDER_INCENTIVE_POLICY.referralBonusCents : 0,
    inviterBonusCents: referralActive ? RIDER_INCENTIVE_POLICY.referralBonusCents : 0,
  };
}
