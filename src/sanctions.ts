export type SanctionSeverity = "warning" | "temporary_restriction" | "review";
export type SanctionReason =
  | "late_acceptance"
  | "late_delivery"
  | "no_show"
  | "unsafe_driving"
  | "fraud_signal"
  | "customer_complaint"
  | "document_expired"
  | "other";

export type RiderIncident = {
  id: string;
  riderId: string;
  reason: SanctionReason;
  occurredAt: Date;
  evidence?: string[];
  acknowledged?: boolean;
  resolved?: boolean;
};

export type SanctionPolicy = {
  version: string;
  warningThreshold: number;
  restrictionThreshold: number;
  reviewThreshold: number;
  windowDays: number;
  restrictionHours: number;
};

export type SanctionDecision = {
  severity: SanctionSeverity;
  score: number;
  policyVersion: string;
  restrictionUntil: Date | null;
  requiresHumanReview: boolean;
  reasons: string[];
};

export const defaultSanctionPolicy: SanctionPolicy = {
  version: "2026-09-baseline",
  warningThreshold: 3,
  restrictionThreshold: 6,
  reviewThreshold: 9,
  windowDays: 30,
  restrictionHours: 24,
};

const reasonWeights: Record<SanctionReason, number> = {
  late_acceptance: 1,
  late_delivery: 1,
  no_show: 3,
  unsafe_driving: 5,
  fraud_signal: 6,
  customer_complaint: 1,
  document_expired: 2,
  other: 1,
};

export function calculateSanctionDecision(
  incidents: RiderIncident[],
  now = new Date(),
  policy = defaultSanctionPolicy,
): SanctionDecision {
  const cutoff = now.getTime() - policy.windowDays * 24 * 60 * 60 * 1000;
  const active = incidents.filter((incident) => incident.occurredAt.getTime() >= cutoff && !incident.resolved);
  const score = active.reduce((total, incident) => total + reasonWeights[incident.reason], 0);
  const reasons = active.map((incident) => `${incident.reason}:${reasonWeights[incident.reason]}`);

  if (score >= policy.reviewThreshold) {
    return { severity: "review", score, policyVersion: policy.version, restrictionUntil: null, requiresHumanReview: true, reasons };
  }
  if (score >= policy.restrictionThreshold) {
    const restrictionUntil = new Date(now.getTime() + policy.restrictionHours * 60 * 60 * 1000);
    return { severity: "temporary_restriction", score, policyVersion: policy.version, restrictionUntil, requiresHumanReview: true, reasons };
  }
  if (score >= policy.warningThreshold) {
    return { severity: "warning", score, policyVersion: policy.version, restrictionUntil: null, requiresHumanReview: false, reasons };
  }
  return { severity: "warning", score, policyVersion: policy.version, restrictionUntil: null, requiresHumanReview: false, reasons: reasons.length ? reasons : ["no_active_incidents"] };
}

export function canRiderReceiveOffers(decision: SanctionDecision, now = new Date()): boolean {
  return decision.severity !== "review" && !(decision.restrictionUntil && decision.restrictionUntil.getTime() > now.getTime());
}

export function resolveIncident(incident: RiderIncident): RiderIncident {
  return { ...incident, resolved: true };
}
