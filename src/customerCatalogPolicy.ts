import { isCashPaymentEnabledForRestaurant } from "./paymentPolicy.js";
import { evaluateOpeningHours } from "./openingHours.js";
import { customerAvailability } from "./customerAvailability.js";

export const COMING_SOON_SLUGS = ["eleven-burgers-xativa", "nakama-sushi-xativa"] as const;
export const CUSTOMER_HIDDEN_TEST_SLUGS = ["kfc-xativa-test", "partner-test", "kings-tacos-xativa"] as const;
export const CUSTOMER_ORDERABLE_RESTAURANT_FILTER = {
  slug: { $nin: [...CUSTOMER_HIDDEN_TEST_SLUGS] }, internalDemo: { $ne: true }, isActive: true, onboardingStatus: "approved", availabilityStatus: "available", "menu.0": { $exists: true },
};
export const CUSTOMER_DIRECTORY_RESTAURANT_FILTER = {
  slug: { $nin: [...CUSTOMER_HIDDEN_TEST_SLUGS] }, internalDemo: { $ne: true }, listingType: "local_directory", isActive: true, onboardingStatus: "approved",
};
export const CUSTOMER_CATALOG_RESTAURANT_FILTER = {
  $or: [CUSTOMER_ORDERABLE_RESTAURANT_FILTER, { slug: { $in: [...COMING_SOON_SLUGS] }, availabilityStatus: "coming_soon", onboardingStatus: { $ne: "rejected" } }, CUSTOMER_DIRECTORY_RESTAURANT_FILTER],
};
export function restaurantIsWithinOpeningHours(openingHours: unknown, now = new Date()): boolean {
  return evaluateOpeningHours(openingHours, now).open;
}
export function customerCatalogRestaurantName(restaurant: { name: string; slug?: string }) { return restaurant.name; }
export function presentCustomerCatalogRestaurant<T extends { name: string; slug?: string; listingType?: string; goldFounder?: boolean; menu?: any[]; availabilityStatus?: string; upcomingMessage?: string; isActive?: boolean; onboardingStatus?: string; cashPaymentsEnabled?: boolean; partnerProfile?: { openingHours?: unknown } }>(restaurant: T) {
  const comingSoon = restaurant.availabilityStatus === "coming_soon";
  const withinHours = restaurantIsWithinOpeningHours(restaurant.partnerProfile?.openingHours);
  const listingType = restaurant.listingType === "local_directory" ? "local_directory" : "official_partner";
  const goldFounder = Boolean(restaurant.goldFounder) || GOLDEN_FOUNDER_SLUGS.includes(restaurant.slug as typeof GOLDEN_FOUNDER_SLUGS[number]);
  const hasMenu = !Object.prototype.hasOwnProperty.call(restaurant, "menu") || (Array.isArray(restaurant.menu) && restaurant.menu.length > 0);
  const availability = customerAvailability({ ...restaurant, comingSoon, listingType, hasMenu });
  const orderable = availability.canOrder && listingType === "official_partner";
  // Do not leak a stale persisted announcement after a restaurant becomes live.
  // The public catalog must derive this label from the operational status.
  return {
    ...restaurant,
    listingType,
    goldFounder,
    upcomingMessage: comingSoon ? (restaurant.upcomingMessage || "Disponible muy pronto") : "",
    cashPaymentsEnabled: isCashPaymentEnabledForRestaurant(restaurant),
    menu: customerMenuForRestaurant(restaurant),
    name: customerCatalogRestaurantName(restaurant),
    comingSoon,
    withinHours,
    canOrder: orderable,
    isOpen: availability.isOpen,
    reason: availability.reason,
    orderable,
    availabilityLabel: comingSoon ? "Disponible muy pronto" : withinHours ? "" : "Cerrado ahora",
    goldenFounder: GOLDEN_FOUNDER_SLUGS.includes(restaurant.slug as typeof GOLDEN_FOUNDER_SLUGS[number]),
    goldenFounderLabel: GOLDEN_FOUNDER_SLUGS.includes(restaurant.slug as typeof GOLDEN_FOUNDER_SLUGS[number]) ? "Partner Golden Fundador" : "",
    commissionRateBps: Math.round(customerCommissionRate(restaurant as T & { partnerProfile?: { commissionRateBps?: number } }) * 10_000),
  };
}
export const ALIBABA_KEBAB_SLUG = "alibaba-kebab-xativa";
export const GOLDEN_FOUNDER_SLUGS = [ALIBABA_KEBAB_SLUG, "rooster-kebab-xativa"] as const;
export const PARTNER_COMMISSION_RATES: Record<string, number> = {
  [ALIBABA_KEBAB_SLUG]: 0.15,
  "rooster-kebab-xativa": 0.25,
};
export const DEFAULT_CUSTOMER_COMMISSION_RATE = 0.20;
const ALIBABA_OPTIONS = {
  drinks: [
    ["coca-cola", "Coca-Cola Original", 0], ["coca-cola-zero", "Coca-Cola Zero", 0],
    ["fanta-naranja", "Fanta Naranja", 0], ["nestea-limon", "Nestea Limón", 0], ["aquarius-limon", "Aquarius Limón", 0],
  ],
  sauces: [["salsa-yogur", "Salsa de yogur", 0], ["salsa-picante", "Salsa picante", 0], ["salsa-barbacoa", "Salsa barbacoa", 0.5]],
  extras: [["extra-queso", "Queso", 1], ["extra-carne", "Carne extra", 2], ["extra-gratinado", "Gratinado", 1.9]],
} as const;
function alibabaOptions(prefix: string, values: readonly (readonly [string, string, number])[]) {
  return values.map(([id, name, price]) => ({ id: `alibaba-${prefix}-${id}`, name, price }));
}
function alibabaModifierGroups(item: Record<string, any>) {
  const name = String(item.name || "").toLocaleLowerCase("es-ES");
  const groups: any[] = [];
  if (name.includes("menú") || name.includes("menu")) groups.push({ id: `${item.id}-bebida`, name: "Elige tu bebida", description: "Incluida en el menú", minSelections: 1, maxSelections: 1, options: alibabaOptions("bebida", ALIBABA_OPTIONS.drinks) });
  if (name.includes("doner") || name.includes("kebab") || name.includes("carne")) groups.push({ id: `${item.id}-salsa`, name: "Elige tu salsa", description: "Puedes escoger una salsa", minSelections: 0, maxSelections: 1, options: alibabaOptions("salsa", ALIBABA_OPTIONS.sauces) });
  if (name.includes("doner") || name.includes("kebab") || name.includes("carne") || name.includes("plato")) groups.push({ id: `${item.id}-extras`, name: "¿Quieres añadir extras?", description: "Extras opcionales para tu pedido", minSelections: 0, maxSelections: 3, options: alibabaOptions("extra", ALIBABA_OPTIONS.extras) });
  return groups;
}
export function customerCommissionRate(restaurant: { slug?: string; partnerProfile?: { commissionRateBps?: number } }): number {
  return PARTNER_COMMISSION_RATES[restaurant.slug || ""] ?? DEFAULT_CUSTOMER_COMMISSION_RATE;
}
function applyPartnerMenuPricing<T extends Record<string, any>>(item: T, rate: number, restaurantSlug = ""): T {
  const apply = (value: unknown) => Number((Math.ceil(Math.max(0, Number(value || 0) * 100) * (1 + rate)) / 100).toFixed(2));
  const priced = { ...item, price: apply(item.price) };
  const sourceModifiers = Array.isArray(item.modifiers) && item.modifiers.length
    ? item.modifiers
    : Array.isArray(item.modifierGroups) && item.modifierGroups.length
      ? item.modifierGroups
      : restaurantSlug === ALIBABA_KEBAB_SLUG || String(item.id || "").startsWith("alibaba-")
        ? alibabaModifierGroups(item)
        : null;
  if (!sourceModifiers) return priced;
  const modifiers = sourceModifiers.map((modifier: any, groupIndex: number) => ({
    ...modifier,
    id: String(modifier.id || `${String(item.id || "item")}-group-${groupIndex + 1}`),
    name: String(modifier.name || modifier.title || modifier.label || `Opciones ${groupIndex + 1}`),
    price: apply(modifier.price),
    options: (Array.isArray(modifier.optionItems) && modifier.optionItems.length
      ? modifier.optionItems
      : Array.isArray(modifier.options) ? modifier.options : Array.isArray(modifier.items) ? modifier.items : [])
      .filter((option: any) => option?.available !== false)
      .map((option: any, optionIndex: number) => ({
        ...option,
        id: String(option.id || `${String(modifier.id || groupIndex)}-option-${optionIndex + 1}`),
        name: String(option.name || option.title || option.label || `Opción ${optionIndex + 1}`),
        price: apply(option.price),
      }))
      .filter((option: any) => option.name),
  }));
  // Alibaba's imported menu used `modifiers`; Customer and checkout use the
  // canonical `modifierGroups` contract. Publish both during migration so the
  // + button opens the real option selector and the server can quote it.
  return { ...priced, modifiers, modifierGroups: modifiers };
}
export function menuItemIsAvailable(item: { available?: boolean } | null | undefined): boolean {
  return Boolean(item) && item?.available !== false;
}
export function customerMenuForRestaurant<T extends { slug?: string; menu?: any[] }>(restaurant: T): any[] {
  const menu = Array.isArray(restaurant.menu) ? restaurant.menu.filter(menuItemIsAvailable) : [];
  const rate = customerCommissionRate(restaurant as T & { partnerProfile?: { commissionRateBps?: number } });
  return rate > 0 ? menu.map((item) => applyPartnerMenuPricing(item, rate, restaurant.slug || "")) : menu;
}
