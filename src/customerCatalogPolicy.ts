/** Public-facing temporary catalog cutover; records and order history remain intact. */
export const CUSTOMER_CATALOG_RESTAURANT_SLUG = "kfc-xativa" as const;
export const CUSTOMER_CATALOG_RESTAURANT_NAME = "KFC XATIVA QA" as const;

export const CUSTOMER_CATALOG_RESTAURANT_FILTER = {
  slug: CUSTOMER_CATALOG_RESTAURANT_SLUG,
  isActive: true,
  onboardingStatus: "approved",
} as const;

export function customerCatalogRestaurantName(restaurant: { name: string; slug?: string }) {
  return restaurant.slug === CUSTOMER_CATALOG_RESTAURANT_SLUG
    ? CUSTOMER_CATALOG_RESTAURANT_NAME
    : restaurant.name;
}

export function presentCustomerCatalogRestaurant<T extends { name: string; slug?: string }>(restaurant: T): Omit<T, "name"> & { name: string } {
  return { ...restaurant, name: customerCatalogRestaurantName(restaurant) };
}
