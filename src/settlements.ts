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

/**
 * Phase 1 settlement baseline. Percentages and rates are explicit and versioned;
 * finance can replace them with contract-specific rules without changing orders.
 */
export function calculateSettlement(orders: SettlementOrder[], options?: { partnerCommissionRate?: number; riderBaseCents?: number; riderPerKmCents?: number }) {
  const partnerCommissionRate = options?.partnerCommissionRate ?? 0.18;
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
  return { lines, totals, commissionRate: partnerCommissionRate, formulaVersion: "piki-phase1-2026-09" } satisfies SettlementSummary;
}
