import { z } from "zod";

const contactFields = {
  name: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().min(6).max(40),
  privacyNoticeAccepted: z.literal(true),
  website: z.string().max(200).optional(),
};

const recruitmentSelectionFields = {
  localityCode: z.string().trim().regex(/^\d{5}$/).optional(),
  provinceCode: z.string().trim().regex(/^\d{2}$/).optional(),
  requestedZoneSlug: z.string().trim().regex(/^[a-z0-9-]+$/).optional(),
};

export const partnerLeadSubmissionSchema = z.object({
  ...contactFields,
  ...recruitmentSelectionFields,
  address: z.string().trim().min(5).max(280),
  city: z.string().trim().min(2).max(100),
});

export const riderLeadSubmissionSchema = z.object({
  ...contactFields,
  ...recruitmentSelectionFields,
  city: z.string().trim().min(2).max(120),
  vehicle: z.enum(["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"]),
  availability: z.string().trim().min(2).max(160),
});

export const webLeadStatusSchema = z.enum(["new", "info_requested", "qualified", "rejected"]);
export const webLeadReviewSchema = z.object({
  status: webLeadStatusSchema,
  notes: z.string().trim().max(1000).default(""),
});

export function normalizeLeadEmail(email: string) {
  return email.trim().toLowerCase();
}
