export const COMPLIANCE_CASE_STATUSES = ["pending", "in_review", "verified", "rejected", "expired", "suspended"] as const;
export type ComplianceCaseStatus = typeof COMPLIANCE_CASE_STATUSES[number];

export const DOCUMENT_STATUSES = ["received", "in_review", "approved", "rejected", "expired"] as const;
export type ComplianceDocumentStatus = typeof DOCUMENT_STATUSES[number];

export const STRIPE_ACCOUNT_STATUSES = ["not_created", "onboarding", "pending_verification", "verified", "restricted", "disabled"] as const;
export type StripeAccountStatus = typeof STRIPE_ACCOUNT_STATUSES[number];

export const STRIPE_REQUIREMENT_STATES = ["currently_due", "eventually_due", "past_due", "pending_verification"] as const;
export type StripeRequirementState = typeof STRIPE_REQUIREMENT_STATES[number];

export const CAPABILITY_STATUSES = ["unrequested", "pending", "active", "inactive"] as const;
export type CapabilityStatus = typeof CAPABILITY_STATUSES[number];

export type MarketplaceCapability = "card_payments" | "transfers";
export type StripeBusinessType = "individual" | "company" | "non_profit" | "government_entity";

export interface PartnerLegalEntity {
  id: string;
  restaurantId: string;
  tenantId: string | null;
  countryCode: "ES";
  legalEntityType: "individual" | "company";
  businessStructure: string | null;
  legalName: string;
  tradingName: string;
  taxId: string;
  taxIdLast4: string | null;
  fiscalAddress: Record<string, string>;
  operatingAddress: Record<string, string>;
  pikiStatus: ComplianceCaseStatus;
  contractVersion: string | null;
  contractAcceptedAt: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PartnerRepresentative {
  id: string;
  legalEntityId: string;
  fullName: string;
  email: string;
  phone: string | null;
  roleTitle: string;
  taxIdLast4: string | null;
  dateOfBirth: string | null;
  isPrimary: boolean;
  identityStatus: ComplianceCaseStatus;
  identityDocumentId: string | null;
}

export interface BeneficialOwner {
  id: string;
  legalEntityId: string;
  fullName: string;
  email: string | null;
  taxIdLast4: string | null;
  dateOfBirth: string | null;
  ownershipPercent: number | null;
  controlBasis: string | null;
  identityStatus: ComplianceCaseStatus;
  verifiedAt: string | null;
}

export interface ComplianceDocument {
  id: string;
  legalEntityId: string;
  representativeId: string | null;
  beneficialOwnerId: string | null;
  documentType: string;
  source: "partner_upload" | "admin_upload" | "stripe" | "system";
  status: ComplianceDocumentStatus;
  fileName: string;
  mimeType: string;
  storageKey: string;
  sizeBytes: number;
  sha256: string;
  expiresAt: string | null;
  viewedAt: string | null;
  viewedBy: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNotes: string | null;
  rejectionCode: string | null;
  version: number;
}

export interface StripeRequirement {
  id: string;
  connectedAccountId: string;
  state: StripeRequirementState;
  requirementKey: string;
  capabilityName: MarketplaceCapability | null;
  errorCode: string | null;
  errorReason: string | null;
  pendingSince: string | null;
  deadlineAt: string | null;
  resolvedAt: string | null;
  sourceEventId: string | null;
}

export interface StripeCapability {
  capabilityName: MarketplaceCapability;
  requested: boolean;
  status: CapabilityStatus;
  disabledReason: string | null;
  currentDeadline: string | null;
  requirements: Record<string, unknown>;
  lastSyncedAt: string | null;
}

export interface StripeConnectedAccount {
  id: string;
  legalEntityId: string;
  stripeAccountId: string;
  accountType: "express" | "custom" | "standard";
  countryCode: "ES";
  businessType: StripeBusinessType;
  dashboardType: string | null;
  tosType: string | null;
  requirementCollection: "stripe" | "application" | null;
  status: StripeAccountStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  controllerSnapshot: Record<string, unknown>;
  capabilities: StripeCapability[];
  requirements: StripeRequirement[];
  lastEventId: string | null;
  lastSyncedAt: string | null;
}

export interface PartnerMarketplaceReadiness {
  legalEntityId: string;
  restaurantId: string;
  pikiStatus: ComplianceCaseStatus;
  stripeAccountId: string | null;
  stripeStatus: StripeAccountStatus | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  stripeRequirementsClear: boolean;
  payoutHoldsClear: boolean;
  operational: boolean;
}

export type ComplianceTransition = {
  from: ComplianceCaseStatus;
  to: ComplianceCaseStatus;
  actor: "partner" | "admin" | "finance" | "stripe_webhook" | "system";
};

const ALLOWED_TRANSITIONS: Record<ComplianceCaseStatus, readonly ComplianceCaseStatus[]> = {
  pending: ["in_review", "rejected", "expired", "suspended"],
  in_review: ["verified", "rejected", "expired", "suspended"],
  verified: ["in_review", "expired", "suspended"],
  rejected: ["in_review", "suspended"],
  expired: ["in_review", "suspended"],
  suspended: ["in_review", "verified", "rejected"],
};

export function assertComplianceTransition(input: ComplianceTransition): void {
  if (!ALLOWED_TRANSITIONS[input.from].includes(input.to)) {
    throw new Error(`INVALID_COMPLIANCE_TRANSITION:${input.from}->${input.to}`);
  }
}

export function isOperational(readiness: Omit<PartnerMarketplaceReadiness, "operational">): boolean {
  return readiness.pikiStatus === "verified"
    && Boolean(readiness.stripeAccountId)
    && readiness.stripeStatus === "verified"
    && readiness.chargesEnabled
    && readiness.payoutsEnabled
    && readiness.stripeRequirementsClear
    && readiness.payoutHoldsClear;
}

export function openPayoutHoldReason(readiness: Omit<PartnerMarketplaceReadiness, "operational">): string | null {
  if (readiness.pikiStatus !== "verified") return "PIKI_KYB_NOT_VERIFIED";
  if (!readiness.stripeAccountId) return "STRIPE_ACCOUNT_NOT_CREATED";
  if (!readiness.chargesEnabled) return "STRIPE_CHARGES_DISABLED";
  if (!readiness.payoutsEnabled) return "STRIPE_PAYOUTS_DISABLED";
  if (!readiness.stripeRequirementsClear) return "STRIPE_REQUIREMENTS_OPEN";
  if (!readiness.payoutHoldsClear) return "PIKI_PAYOUT_HOLD_ACTIVE";
  return null;
}
