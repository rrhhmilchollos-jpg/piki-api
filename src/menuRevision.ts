import { z } from "zod";
import { partnerMenuItemsSchema } from "./menuContract.js";

export const menuWriteSchema = z.object({
  items: partnerMenuItemsSchema.refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Los ID de producto deben ser únicos"),
  expectedMenuRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
export const menuAvailabilitySchema = z.object({ available: z.boolean() }).strict();

export function currentMenuRevision(restaurant: { menuRevision?: number } | null | undefined): number {
  return restaurant?.menuRevision ?? 0;
}

/** Missing persisted revision is version zero; omission by legacy clients is LWW. */
export function menuRevisionFilter(expected?: number): Record<string, unknown> {
  if (expected === undefined) return {};
  return expected === 0
    ? { $or: [{ menuRevision: 0 }, { menuRevision: { $exists: false } }] }
    : { menuRevision: expected };
}
