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

// Intake schema: unchanged. New applications are still validated strictly.
export const partnerSchema = z.object({
  name: z.string().min(2).max(160), email: z.string().email(),
  password: z.string().min(12).max(200).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/),
  phone: z.string().min(6).max(40), address: z.string().min(5).max(280),
  legalName: z.string().trim().min(2).max(180), taxId: z.string().trim().regex(/^[A-Za-z0-9-]{5,20}$/),
  legalForm: z.enum(["autonomo", "sl", "sa", "cooperativa", "otra"]),
  representativeName: z.string().trim().min(2).max(160), representativeRole: z.string().trim().min(2).max(100), representativeDocument: z.string().trim().min(5).max(30).optional(),
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

// ---------------------------------------------------------------------------
// Tolerant normalisation of SAVED profiles. It only fixes the representation of
// data that is already there (spaces, case, text vs number, accents). It never
// invents values: anything genuinely missing still fails the review.
// ---------------------------------------------------------------------------

type LegalForm = "autonomo" | "sl" | "sa" | "cooperativa" | "otra";
const LEGAL_FORM_ALIASES: Record<string, LegalForm> = {
  autonomo: "autonomo", empresarioindividual: "autonomo", trabajadorautonomo: "autonomo",
  sl: "sl", slu: "sl", sociedadlimitada: "sl",
  sa: "sa", sociedadanonima: "sa",
  cooperativa: "cooperativa", scoop: "cooperativa",
  otra: "otra", otro: "otra",
};

function text(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined; // "" is treated as not provided
}

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = Number(raw.replace("%", "").replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function acceptedFlag(value: unknown): unknown {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  return value;
}

function dateValue(value: unknown): unknown {
  if (value == null) return undefined;
  if (typeof value === "string" && !value.trim()) return undefined;
  return value;
}

function normaliseLegalProfile(profile: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...profile };
  const taxId = text(profile.taxId);
  if (taxId) next.taxId = taxId.replace(/[\s.]/g, "").toUpperCase();
  const iban = text(profile.iban);
  if (iban) next.iban = iban.replace(/\s/g, "").toUpperCase();
  const postalCode = text(profile.postalCode);
  // A postal code saved as a number loses its leading zero (e.g. 3001 -> 03001).
  if (postalCode) next.postalCode = /^\d{1,5}$/.test(postalCode) ? postalCode.padStart(5, "0") : postalCode;
  for (const key of ["legalName", "representativeName", "representativeRole", "fiscalAddress", "operatingAddress", "city", "province", "bankAccountHolder", "cuisine"]) {
    next[key] = text(profile[key]);
  }
  next.representativeDocument = text(profile.representativeDocument); // empty string => not provided
  const legalForm = text(profile.legalForm);
  if (legalForm) {
    const key = legalForm.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
    next.legalForm = LEGAL_FORM_ALIASES[key] ?? legalForm;
  }
  const vat = numberOf(profile.vatRate);
  if (vat !== undefined) next.vatRate = vat > 0 && vat < 1 ? Math.round(vat * 100) : vat; // 0.21 => 21
  const units = numberOf(profile.pdaUnits);
  if (units !== undefined) next.pdaUnits = units;
  const unitCost = numberOf(profile.pdaUnitCostCents);
  // Some legacy records store euros (200/300) instead of cents (20000/30000).
  if (unitCost !== undefined) next.pdaUnitCostCents = unitCost === 200 || unitCost === 300 ? unitCost * 100 : unitCost;
  next.commissionAccepted = acceptedFlag(profile.commissionAccepted);
  for (const key of ["termsAcceptedAt", "contractAcceptedAt", "privacyAcceptedAt", "dataProcessingAcceptedAt", "pdaCostAcceptedAt"]) {
    next[key] = dateValue(profile[key]);
  }
  return next;
}

const FIELD_LABELS: Record<string, string> = {
  profile: "Perfil legal", legalName: "Razón social", taxId: "NIF/CIF", legalForm: "Forma jurídica",
  representativeName: "Nombre del representante", representativeRole: "Cargo del representante",
  representativeDocument: "Documento del representante", fiscalAddress: "Dirección fiscal",
  operatingAddress: "Dirección operativa", postalCode: "Código postal", city: "Ciudad", province: "Provincia",
  iban: "IBAN", bankAccountHolder: "Titular de la cuenta", cuisine: "Tipo de cocina", vatRate: "IVA",
  commissionAccepted: "Aceptación de comisión", termsAcceptedAt: "Fecha de aceptación de términos",
  contractAcceptedAt: "Fecha de aceptación del contrato", privacyAcceptedAt: "Fecha de aceptación de privacidad",
  dataProcessingAcceptedAt: "Fecha de aceptación del tratamiento de datos", pdaCostAcceptedAt: "Fecha de aceptación del coste de PDA",
  pdaUnits: "Número de PDAs", pdaUnitCostCents: "Coste por PDA",
};

export type PartnerLegalProfileIssue = { field: string; label: string; reason: "missing" | "invalid" };

/** Exact list of what blocks review. Never includes the values (IBAN, tax id...). */
export function partnerLegalProfileReviewIssues(profile: unknown): PartnerLegalProfileIssue[] {
  if (!profile || typeof profile !== "object") return [{ field: "profile", label: FIELD_LABELS.profile, reason: "missing" }];
  const normalised = normaliseLegalProfile(profile as Record<string, unknown>);
  const issues = new Map<string, PartnerLegalProfileIssue>();
  const add = (field: string, reason: "missing" | "invalid") => {
    if (!issues.has(field)) issues.set(field, { field, label: FIELD_LABELS[field] ?? field, reason });
  };
  const parsed = partnerLegalReviewSchema.safeParse(normalised);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = typeof issue.path[0] === "string" ? issue.path[0] : "profile";
      add(field, normalised[field] === undefined || normalised[field] === null ? "missing" : "invalid");
    }
  }
  return [...issues.values()];
}

export function partnerLegalProfileReadyForReview(profile: unknown): boolean {
  return partnerLegalProfileReviewIssues(profile).length === 0;
}

// Receipt telemetry only: optional attachments never gate intake or approval.
export function allPartnerOnboardingDocumentsReceived(documents: readonly { type: string }[]): boolean {
  return PARTNER_ONBOARDING_DOCUMENT_TYPES.every((type) => documents.some((document) => document.type === type));
}
