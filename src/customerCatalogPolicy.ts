/** Public-facing temporary catalog cutover; records and order history remain intact. */
export const CUSTOMER_CATALOG_RESTAURANT_SLUG = "piki-prueba" as const;
export const CUSTOMER_CATALOG_RESTAURANT_NAME = "PIKI-PRUEBA" as const;

export const CUSTOMER_CATALOG_RESTAURANT_FILTER = {
  $or: [{ slug: CUSTOMER_CATALOG_RESTAURANT_SLUG }, { slug: "kfc-xativa" }],
  isActive: true,
  onboardingStatus: "approved",
} as const;

export function customerCatalogRestaurantName(restaurant: { name: string; slug?: string }) {
  return restaurant.slug === CUSTOMER_CATALOG_RESTAURANT_SLUG || restaurant.slug === "kfc-xativa"
    ? CUSTOMER_CATALOG_RESTAURANT_NAME
    : restaurant.name;
}

export function presentCustomerCatalogRestaurant<T extends { name: string; slug?: string }>(restaurant: T): Omit<T, "name"> & { name: string } {
  return { ...restaurant, name: customerCatalogRestaurantName(restaurant) };
}
