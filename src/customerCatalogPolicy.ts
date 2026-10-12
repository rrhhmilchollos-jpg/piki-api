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

export function presentCustomerCatalogRestaurant<T extends { name: string; slug?: string; availabilityStatus?: string; isActive?: boolean; onboardingStatus?: string }>(restaurant: T) {
  const comingSoon = restaurant.availabilityStatus === "coming_soon";
  const orderable = restaurant.isActive === true && restaurant.onboardingStatus === "approved" && !comingSoon;
  return { ...restaurant, name: customerCatalogRestaurantName(restaurant), comingSoon, orderable, availabilityLabel: comingSoon ? "Disponible muy pronto" : "" };
}
