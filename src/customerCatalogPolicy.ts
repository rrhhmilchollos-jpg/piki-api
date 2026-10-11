/** Public-facing temporary catalog cutover; records and order history remain intact. */
export const CUSTOMER_CATALOG_RESTAURANT_SLUG = "piki-prueba" as const;
export const CUSTOMER_CATALOG_RESTAURANT_NAME = "PIKI-PRUEBA" as const;

export const COMING_SOON_SLUGS = ["kings-tacos-xativa", "eleven-burgers-xativa", "nakama-sushi-xativa", "rooster-kebab-xativa", "alibaba-kebab-xativa"] as const;
export const CUSTOMER_ORDERABLE_RESTAURANT_FILTER = {
  slug: { $in: [CUSTOMER_CATALOG_RESTAURANT_SLUG, "kfc-xativa"] },
  isActive: true,
  onboardingStatus: "approved",
  availabilityStatus: { $ne: "coming_soon" },
};
export const CUSTOMER_CATALOG_RESTAURANT_FILTER = {
  $or: [CUSTOMER_ORDERABLE_RESTAURANT_FILTER, { slug: { $in: [...COMING_SOON_SLUGS] }, availabilityStatus: "coming_soon", onboardingStatus: { $ne: "rejected" } }],
};

export function customerCatalogRestaurantName(restaurant: { name: string; slug?: string }) {
  return restaurant.slug === CUSTOMER_CATALOG_RESTAURANT_SLUG || restaurant.slug === "kfc-xativa"
    ? CUSTOMER_CATALOG_RESTAURANT_NAME
    : restaurant.name;
}

export function presentCustomerCatalogRestaurant<T extends { name: string; slug?: string; availabilityStatus?: string }>(restaurant: T) {
  const comingSoon = restaurant.availabilityStatus === "coming_soon";
  return { ...restaurant, name: customerCatalogRestaurantName(restaurant), comingSoon, orderable: !comingSoon, availabilityLabel: comingSoon ? "Disponible muy pronto" : "" };
}
