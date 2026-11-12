import { z } from "zod";
import { DOCUMENT_UPLOAD_MIME_TYPES } from "./fileSecurity.js";
import { openingHoursSchema } from "./openingHours.js";

// Only new applications use this price. Persisted/signed 300 EUR profiles remain valid.
export const NEW_PARTNER_PDA_UNIT_COST_CENTS = 20000;
export const PARTNER_ONBOARDING_DOCUMENT_TYPES = ["tax_id", "bank_certificate", "insurance", "activity_license", "food_sanitary_authorization"] as const;
const partnerDocumentSchema = z.object({
  type: z.enum(PARTNER_ONBOARDING_DOCUMENT_TYPES),
  fileName: z.string().min(1).max(180),
  mimeType: z.enum(DOCUMENT_UPLOAD_MIME_TYPES),
  sizeBytes: z.number().int().positive().max(2_500_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentBase64: z.string().min(20).max(3_500_000),
});
const partnerDocumentsSchema = z.array(partnerDocumentSchema).max(5).default([]).superRefine((documents, context) => {
  const seen = new Set<string>();
  documents.forEach((document, index) => {
    if (seen.has(document.type)) context.addIssue({ code: "custom", path: [index, "type"], message: "DUPLICATE_PARTNER_DOCUMENT_TYPE" });
    seen.add(document.type);
  });
});

export const partnerSchema = z.object({
  name: z.string().min(2).max(160), email: z.string().email(),
  password: z.string().min(12).max(200).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/),
  phone: z.string().min(6).max(40), address: z.string().min(5).max(280),
  legalName: z.string().trim().min(2).max(180), taxId: z.string().trim().regex(/^[A-Za-z0-9-]{5,20}$/),
  legalForm: z.enum(["autonomo", "sl", "sa", "cooperativa", "otra"]),
  representativeName: z.string().trim().min(2).max(160), representativeRole: z.string().trim().min(2).max(100), representativeDocument: z.string().trim().min(5).max(30),
  fiscalAddress: z.string().trim().min(5).max(280), operatingAddress: z.string().trim().min(5).max(280), postalCode: z.string().trim().regex(/^\d{5}$/), city: z.string().trim().min(2).max(100), province: z.string().trim().min(2).max(100),
  iban: z.string().trim().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/), bankAccountHolder: z.string().trim().min(2).max(180), cuisine: z.string().trim().min(2).max(100), vatRate: z.union([z.literal(4), z.literal(10), z.literal(21)]),
  commissionAccepted: z.literal(true), termsAcceptedAt: z.coerce.date(), contractAccepted: z.literal(true), privacyAccepted: z.literal(true), dataProcessingAccepted: z.literal(true),
  pdaUnits: z.number().int().min(1).max(50), pdaUnitCostCents: z.literal(NEW_PARTNER_PDA_UNIT_COST_CENTS), pdaCostAccepted: z.literal(true), pdaCostAcceptedAt: z.coerce.date(), privacyAcceptedAt: z.coerce.date(), dataProcessingAcceptedAt: z.coerce.date(),
  openingHours: openingHoursSchema, documents: partnerDocumentsSchema,
});
export const manualPartnerSchema = partnerSchema.omit({ password: true });

// Review of a saved profile uses its actual historical price, never a new consent
// or the new-intake literal. Optional files do not replace mandatory legal data.
const partnerLegalReviewSchema = manualPartnerSchema.pick({
  legalName: true, taxId: true, legalForm: true, representativeName: true,
  representativeRole: true, representativeDocument: true, fiscalAddress: true,
  operatingAddress: true, postalCode: true, city: true, province: true, iban: true,
  bankAccountHolder: true, cuisine: true, vatRate: true, commissionAccepted: true,
  termsAcceptedAt: true, privacyAcceptedAt: true, dataProcessingAcceptedAt: true,
  pdaUnits: true, pdaCostAcceptedAt: true,
}).extend({ contractAcceptedAt: z.coerce.date(), pdaUnitCostCents: z.union([z.literal(20000), z.literal(30000)]) });

export function partnerLegalProfileReadyForReview(profile: unknown): boolean {
  if (!profile || typeof profile !== "object") return false;
  const value = profile as Record<string, unknown>;
  const timestamps = ["termsAcceptedAt", "contractAcceptedAt", "privacyAcceptedAt", "dataProcessingAcceptedAt", "pdaCostAcceptedAt"];
  if (timestamps.some((key) => value[key] == null)) return false;
  return partnerLegalReviewSchema.safeParse(profile).success;
}

// Receipt telemetry only: optional attachments never gate intake or approval.
export function allPartnerOnboardingDocumentsReceived(documents: readonly { type: string }[]): boolean {
  return PARTNER_ONBOARDING_DOCUMENT_TYPES.every((type) => documents.some((document) => document.type === type));
}
