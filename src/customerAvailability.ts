import { evaluateOpeningHours } from "./openingHours.js";

export type CustomerAvailabilityReason = "open" | "paused" | "closed" | "coming_soon" | "not_approved" | "unavailable" | "not_orderable";
// Customer orders must remain available around the clock. Partner schedules
// are still retained for partner/admin operational views, but they must not
// make a customer catalogue item or checkout appear closed.
export const CUSTOMER_OPERATING_24_7 = true;

export type CustomerAvailabilityInput = {
  isActive?: boolean;
  onboardingStatus?: string;
  availabilityStatus?: string;
  comingSoon?: boolean;
  listingType?: string;
  hasMenu?: boolean;
  openingHours?: unknown;
};

/** Canonical server-side adapter. Clients consume these fields and do not evaluate opening hours. */
export function customerAvailability(input: CustomerAvailabilityInput, now = new Date()) {
  const evaluation = evaluateOpeningHours(input.openingHours, now);
  const withinHours = CUSTOMER_OPERATING_24_7 || evaluation.open;
  const comingSoon = input.comingSoon === true || input.availabilityStatus === "coming_soon";
  let reason: CustomerAvailabilityReason;
  if (comingSoon) reason = "coming_soon";
  else if (input.isActive !== true) reason = "paused";
  else if (input.onboardingStatus !== "approved") reason = "not_approved";
  else if (input.availabilityStatus && input.availabilityStatus !== "available") reason = "unavailable";
  else if (!withinHours) reason = "closed";
  else if (input.listingType === "local_directory" || input.hasMenu === false) reason = "not_orderable";
  else reason = "open";

  const canOrder = reason === "open";
  return {
    canOrder,
    isOpen: input.isActive === true && withinHours,
    withinHours,
    reason,
    orderable: canOrder,
  };
}
