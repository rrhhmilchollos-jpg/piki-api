import { z } from "zod";

/**
 * Fields a Partner may change for its assigned establishment.
 * Commercial controls such as commission, delivery fee, promotion and status
 * intentionally do not belong to this schema.
 */
export const partnerBasicProfileSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  email: z.union([z.string().email().max(254), z.literal("")]).optional(),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(280).optional(),
  locality: z.string().trim().max(120).optional(),
  cuisine: z.string().trim().min(1).max(120).optional(),
  category: z.string().trim().min(1).max(120).optional(),
}).strict();
