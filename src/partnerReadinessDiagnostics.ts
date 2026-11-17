import { CUSTOMER_HIDDEN_TEST_SLUGS, isPublishedCustomerPartner } from "./customerCatalogPolicy.js";

/** Stable API reason codes for a partner location that cannot accept orders. */
export function partnerReadinessBlockers(restaurant: any): string[] {
  if (!restaurant) return ["restaurant_not_found"];

  const blockers: string[] = [];
  if (restaurant.onboardingStatus !== "approved") blockers.push("not_approved");
  if (restaurant.isActive !== true) blockers.push("paused");
  if (restaurant.availabilityStatus === "coming_soon") blockers.push("coming_soon");
  else if (restaurant.availabilityStatus !== "available") blockers.push("unavailable");

  const listingInvalid = restaurant.fulfillmentMode === "assisted_purchase"
    || restaurant.listingType === "local_directory"
    || (restaurant.listingType !== undefined && !["official_partner", "restaurant"].includes(restaurant.listingType))
    || restaurant.internalDemo === true
    || (typeof restaurant.slug === "string" && (CUSTOMER_HIDDEN_TEST_SLUGS as readonly string[]).includes(restaurant.slug));
  if (listingInvalid) blockers.push("not_orderable");
  if (restaurant.marketplaceCompliance?.pikiStatus !== "verified") blockers.push("piki_compliance_not_verified");

  const menu = restaurant.menu;
  if (!Array.isArray(menu) || menu.length === 0) {
    blockers.push("menu_empty");
  } else {
    const available = menu.filter((item: any) => item?.available !== false);
    if (available.length === 0) blockers.push("menu_no_available_items");
    else if (available.some((item: any) => !Array.isArray(item?.allergens))) blockers.push("menu_allergens_missing");
  }

  // Keep the catalog publication policy as the source of truth for less common
  // persisted-state combinations not represented above. No blocker is cleared here.
  if (!blockers.length && !isPublishedCustomerPartner(restaurant)) blockers.push("not_orderable");
  return [...new Set(blockers)];
}
