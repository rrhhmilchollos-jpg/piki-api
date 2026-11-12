import type { Express } from "express";
import { customerMenuForRestaurant, customerMenuPrice, isPublishedCustomerPartner } from "./customerCatalogPolicy.js";
import { canonicalRestaurantMenu } from "./menuContract.js";
import { normalizeOpeningHours } from "./openingHours.js";

export const KAZOKU_INFORMATION_IDS = ["6af3dac6508226eb18543af6", "6af5b418579fe6af2a8bb834"] as const;
export const KAZOKU_INFORMATION_TENANT = "6ab891dbc9ebf588e74114f2";
export const PARTNER_INFORMATION_PATH = "/api/v1/catalog/partner-information";
// Inclusion only: no whole partnerProfile, compliance, accounts or legal data.
export const PARTNER_INFORMATION_PROJECTION = "_id tenantId slug name cuisine category locality phone address menu menuRevision priceIncludesCommission listingType onboardingStatus isActive availabilityStatus internalDemo fulfillmentMode deliveryFeeCents partnerProfile.commissionRateBps partnerProfile.openingHours partnerProfile.postalCode partnerProfile.city partnerProfile.province";
export function partnerInformationFilter(objectId: (id: string) => unknown) {
  return {
    _id: { $in: KAZOKU_INFORMATION_IDS.map(objectId) }, tenantId: objectId(KAZOKU_INFORMATION_TENANT),
    listingType: "official_partner", onboardingStatus: { $in: ["pending_review", "approved"] }, internalDemo: { $ne: true },
  };
}
const text = (value: unknown): string | null => typeof value === "string" && value.trim() ? value : null;
const nonNegativeInteger = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Separate read-only DTO; never pass this to cart, quote, Partner or order code. */
export function presentPublicPartnerInformation(row: any) {
  if (!row || !(KAZOKU_INFORMATION_IDS as readonly string[]).includes(String(row._id))
    || String(row.tenantId) !== KAZOKU_INFORMATION_TENANT || row.listingType !== "official_partner"
    || !["pending_review", "approved"].includes(row.onboardingStatus) || row.internalDemo === true
    || row.fulfillmentMode === "assisted_purchase" || !text(row.name) || !text(row.slug)) return null;
  // Approved/public partners belong to the existing canonical catalogue. No duplicate lane.
  if (isPublishedCustomerPartner(row) && customerMenuForRestaurant(row).length > 0) return null;
  const commission = nonNegativeInteger(row.partnerProfile?.commissionRateBps);
  const commissionRateBps = commission !== null && commission <= 10_000 ? commission : null;
  const rate = row.priceIncludesCommission === true ? 0 : row.priceIncludesCommission === false && commissionRateBps !== null ? commissionRateBps / 10_000 : null;
  const sourceMenu = canonicalRestaurantMenu(row);
  const omittedItemIds = sourceMenu.filter(item => item?.id === "kazoku-43").map(item => item.id as string);
  const menu = sourceMenu.filter(item => item && item.id !== "kazoku-43" && text(item.id) && text(item.name)).map(item => ({
    id: item.id as string, name: item.name as string, description: text(item.description), category: text(item.category),
    // Same canonical rounding and final-price flag; no fallback commission or made-up prices.
    price: rate !== null && typeof item.price === "number" && Number.isFinite(item.price) && item.price >= 0 ? customerMenuPrice(item.price, rate) as number : null,
    allergens: Array.isArray(item.allergens) && item.allergens.every((value: unknown) => typeof value === "string") ? [...item.allergens] as string[] : null,
    informationPending: ["kazoku-18", "kazoku-42"].includes(item.id), available: false as const, orderable: false as const,
  }));
  const hours = normalizeOpeningHours(row.partnerProfile?.openingHours);
  return {
    id: String(row._id), slug: row.slug as string, name: row.name as string,
    locality: text(row.locality) || text(row.partnerProfile?.city), province: text(row.partnerProfile?.province),
    postalCode: text(row.partnerProfile?.postalCode), address: text(row.address), phone: text(row.phone),
    cuisine: text(row.cuisine), category: text(row.category), listingType: "official_partner" as const,
    informational: true as const, canOrder: false as const, orderable: false as const, menuStatus: "pending_validation" as const,
    message: "Pedidos todavía no habilitados. Carta informativa pendiente de validación alimentaria y comercial.",
    deliveryFeeCents: nonNegativeInteger(row.deliveryFeeCents),
    openingHours: hours ? { timeZone: hours.timeZone, regular: hours.regular, overrides: hours.overrides } : null,
    menuRevision: nonNegativeInteger(row.menuRevision), sourceItemCount: sourceMenu.length, omittedItemIds, menu,
  };
}

export function registerPublicPartnerInformationRoute(app: Pick<Express, "get">, deps: {
  objectId: (id: string) => unknown;
  findRows: (filter: Record<string, unknown>, projection: string) => Promise<any[]>;
}) {
  app.get(PARTNER_INFORMATION_PATH, async (_req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    try {
      const rows = await deps.findRows(partnerInformationFilter(deps.objectId), PARTNER_INFORMATION_PROJECTION);
      return res.json({ partners: rows.map(presentPublicPartnerInformation).filter(Boolean) });
    } catch {
      return res.status(503).json({ error: "PARTNER_INFORMATION_UNAVAILABLE" });
    }
  });
}
