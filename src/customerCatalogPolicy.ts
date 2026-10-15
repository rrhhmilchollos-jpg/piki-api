export const COMING_SOON_SLUGS = ["eleven-burgers-xativa", "nakama-sushi-xativa", "rooster-kebab-xativa", "alibaba-kebab-xativa"] as const;
export const CUSTOMER_HIDDEN_TEST_SLUGS = ["kfc-xativa-qa", "kfc-xativa-test", "partner-test", "kings-tacos-xativa"] as const;
export const CUSTOMER_ORDERABLE_RESTAURANT_FILTER = {
  slug: { $nin: [...CUSTOMER_HIDDEN_TEST_SLUGS] }, internalDemo: { $ne: true }, isActive: true, onboardingStatus: "approved", availabilityStatus: "available", "menu.0": { $exists: true },
};
export const CUSTOMER_CATALOG_RESTAURANT_FILTER = {
  $or: [CUSTOMER_ORDERABLE_RESTAURANT_FILTER, { slug: { $in: [...COMING_SOON_SLUGS] }, availabilityStatus: "coming_soon", onboardingStatus: { $ne: "rejected" } }],
};
export function restaurantIsWithinOpeningHours(openingHours: unknown, now = new Date()): boolean {
  if (!openingHours || typeof openingHours !== "object") return true;
  const day = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "Europe/Madrid" }).format(now).toLocaleLowerCase("es-ES");
  const value = (openingHours as Record<string, unknown>)[day] as { open?: string; close?: string; closed?: boolean } | undefined;
  if (!value || value.closed === true) return false;
  const open = String(value.open || ""); const close = String(value.close || "");
  if (!/^\d{2}:\d{2}$/.test(open) || !/^\d{2}:\d{2}$/.test(close)) return true;
  const current = Number(new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Madrid" }).format(now).replace(":", ""));
  const start = Number(open.replace(":", "")); const end = Number(close.replace(":", ""));
  return end >= start ? current >= start && current <= end : current >= start || current <= end;
}
export function customerCatalogRestaurantName(restaurant: { name: string; slug?: string }) { return restaurant.name; }
export function presentCustomerCatalogRestaurant<T extends { name: string; slug?: string; menu?: any[]; availabilityStatus?: string; isActive?: boolean; onboardingStatus?: string; partnerProfile?: { openingHours?: unknown } }>(restaurant: T) {
  const comingSoon = restaurant.availabilityStatus === "coming_soon";
  const withinHours = restaurantIsWithinOpeningHours(restaurant.partnerProfile?.openingHours);
  const orderable = restaurant.isActive === true && restaurant.onboardingStatus === "approved" && !comingSoon && withinHours;
  return { ...restaurant, menu: customerMenuForRestaurant(restaurant), name: customerCatalogRestaurantName(restaurant), comingSoon, withinHours, orderable, availabilityLabel: comingSoon ? "Disponible muy pronto" : withinHours ? "" : "Cerrado ahora" };
}
export const ALIBABA_KEBAB_SLUG = "alibaba-kebab-xativa";
export const PARTNER_COMMISSION_RATES: Record<string, number> = {
  [ALIBABA_KEBAB_SLUG]: 0.15,
  "rooster-kebab-xativa": 0.23,
  "nakama-sushi-xativa": 0.23,
};
export const DEFAULT_CUSTOMER_COMMISSION_RATE = 0.18;
export function customerCommissionRate(restaurant: { slug?: string; partnerProfile?: { commissionRateBps?: number } }): number {
  if (Number.isInteger(restaurant.partnerProfile?.commissionRateBps)) return Math.max(0, Math.min(1, Number(restaurant.partnerProfile!.commissionRateBps) / 10_000));
  return PARTNER_COMMISSION_RATES[restaurant.slug || ""] ?? DEFAULT_CUSTOMER_COMMISSION_RATE;
}
function applyPartnerMenuPricing<T extends Record<string, any>>(item: T, rate: number): T {
  const apply = (value: unknown) => Number((Math.ceil(Math.max(0, Number(value || 0) * 100) * (1 + rate)) / 100).toFixed(2));
  const priced = { ...item, price: apply(item.price) };
  if (!Array.isArray(item.modifiers)) return priced;
  const modifiers = item.modifiers.map((modifier: any) => ({
    ...modifier,
    price: apply(modifier.price),
    options: Array.isArray(modifier.options)
      ? modifier.options.map((option: any) => ({ ...option, price: apply(option.price) }))
      : modifier.options,
  }));
  // Alibaba's imported menu used `modifiers`; Customer and checkout use the
  // canonical `modifierGroups` contract. Publish both during migration so the
  // + button opens the real option selector and the server can quote it.
  return { ...priced, modifiers, modifierGroups: modifiers };
}
export function customerMenuForRestaurant<T extends { slug?: string; menu?: any[] }>(restaurant: T): any[] {
  const menu = Array.isArray(restaurant.menu) ? restaurant.menu : [];
  const rate = customerCommissionRate(restaurant as T & { partnerProfile?: { commissionRateBps?: number } });
  return rate > 0 ? menu.map((item) => applyPartnerMenuPricing(item, rate)) : menu;
}
