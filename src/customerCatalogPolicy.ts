export const COMING_SOON_SLUGS = ["kings-tacos-xativa", "eleven-burgers-xativa", "nakama-sushi-xativa", "rooster-kebab-xativa", "alibaba-kebab-xativa"] as const;
export const CUSTOMER_ORDERABLE_RESTAURANT_FILTER = {
  internalDemo: { $ne: true },
  isActive: true,
  onboardingStatus: "approved",
  availabilityStatus: "available",
  "menu.0": { $exists: true },
};
export const CUSTOMER_CATALOG_RESTAURANT_FILTER = {
  $or: [CUSTOMER_ORDERABLE_RESTAURANT_FILTER, { slug: { $in: [...COMING_SOON_SLUGS] }, availabilityStatus: "coming_soon", onboardingStatus: { $ne: "rejected" } }],
};

export function customerCatalogRestaurantName(restaurant: { name: string; slug?: string }) {
  return restaurant.name;
}

export function presentCustomerCatalogRestaurant<T extends { name: string; slug?: string; menu?: any[]; availabilityStatus?: string; isActive?: boolean; onboardingStatus?: string }>(restaurant: T) {
  const comingSoon = restaurant.availabilityStatus === "coming_soon";
  const orderable = restaurant.isActive === true && restaurant.onboardingStatus === "approved" && !comingSoon;
  return { ...restaurant, menu: customerMenuForRestaurant(restaurant), name: customerCatalogRestaurantName(restaurant), comingSoon, orderable, availabilityLabel: comingSoon ? "Disponible muy pronto" : "" };
}

export const ALIBABA_KEBAB_SLUG = "alibaba-kebab-xativa";
export const ALIBABA_PARTNER_COMMISSION_RATE = 0.18;

/** Precio visible al cliente: coste del producto + 18% de comisión PIKI. */
export function applyAlibabaCommissionCents(cents: number): number {
  return Math.ceil(Math.max(0, Number(cents) || 0) * (1 + ALIBABA_PARTNER_COMMISSION_RATE));
}

function applyAlibabaMenuPricing<T extends Record<string, any>>(item: T): T {
  const priced = { ...item, price: Number((applyAlibabaCommissionCents(Number(item.price || 0) * 100) / 100).toFixed(2)) };
  if (!Array.isArray(item.modifiers)) return priced;
  return {
    ...priced,
    modifiers: item.modifiers.map((modifier: any) => ({
      ...modifier,
      price: Number((applyAlibabaCommissionCents(Number(modifier.price || 0) * 100) / 100).toFixed(2)),
      options: Array.isArray(modifier.options) ? modifier.options.map((option: any) => ({
        ...option,
        price: Number((applyAlibabaCommissionCents(Number(option.price || 0) * 100) / 100).toFixed(2)),
      })) : modifier.options,
    })),
  };
}

export function customerMenuForRestaurant<T extends { slug?: string; menu?: any[] }>(restaurant: T): any[] {
  const menu = Array.isArray(restaurant.menu) ? restaurant.menu : [];
  return restaurant.slug === ALIBABA_KEBAB_SLUG ? menu.map(applyAlibabaMenuPricing) : menu;
}
