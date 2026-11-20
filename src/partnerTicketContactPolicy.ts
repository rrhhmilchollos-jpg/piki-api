const PARTNER_TICKET_CONTACT_RESTAURANTS = new Set([
  "kazoku-xativa",
  "kazoku-algemesi",
  "alibaba-kebab-xativa",
]);

function restaurantKey(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Feature scope only; the caller must still enforce authenticated tenant and restaurant access. */
export function partnerTicketContactEnabled(restaurant: { slug?: unknown; name?: unknown } | null | undefined): boolean {
  return PARTNER_TICKET_CONTACT_RESTAURANTS.has(restaurantKey(restaurant?.slug))
    || PARTNER_TICKET_CONTACT_RESTAURANTS.has(restaurantKey(restaurant?.name));
}
