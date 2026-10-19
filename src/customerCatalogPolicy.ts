export const COMING_SOON_SLUGS = ["eleven-burgers-xativa", "nakama-sushi-xativa", "rooster-kebab-xativa", "alibaba-kebab-xativa"] as const;
export const CUSTOMER_HIDDEN_TEST_SLUGS = ["kfc-xativa-test", "partner-test", "kings-tacos-xativa"] as const;
export const CUSTOMER_ORDERABLE_RESTAURANT_FILTER = {
  slug: { $nin: [...CUSTOMER_HIDDEN_TEST_SLUGS] }, internalDemo: { $ne: true }, isActive: true, onboardingStatus: "approved", availabilityStatus: "available", "menu.0": { $exists: true },
};
export const CUSTOMER_CATALOG_RESTAURANT_FILTER = {
  $or: [CUSTOMER_ORDERABLE_RESTAURANT_FILTER, { slug: { $in: [...COMING_SOON_SLUGS] }, availabilityStatus: "coming_soon", onboardingStatus: { $ne: "rejected" } }],
};
function withinOpeningSlot(current: number, slot: unknown): boolean {
  if (!slot || typeof slot !== "object") return false;
  const value = slot as { open?: string; close?: string };
  const open = String(value.open || ""); const close = String(value.close || "");
  if (!/^\d{2}:\d{2}$/.test(open) || !/^\d{2}:\d{2}$/.test(close)) return false;
  const start = Number(open.replace(":", "")); const end = Number(close.replace(":", ""));
  return end >= start ? current >= start && current <= end : current >= start || current <= end;
}
export function restaurantIsWithinOpeningHours(openingHours: unknown, now = new Date()): boolean {
  if (!openingHours || typeof openingHours !== "object") return true;
  const day = new Intl.DateTimeFormat("es-ES", { weekday: "long", timeZone: "Europe/Madrid" }).format(now).toLocaleLowerCase("es-ES");
  const value = (openingHours as Record<string, unknown>)[day] as { open?: string; close?: string; closed?: boolean; morning?: unknown; afternoon?: unknown; evening?: unknown } | undefined;
  if (!value || value.closed === true) return false;
  const current = Number(new Intl.DateTimeFormat("es-ES", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Europe/Madrid" }).format(now).replace(":", ""));
  if (value.morning || value.afternoon || value.evening) return withinOpeningSlot(current, value.morning) || withinOpeningSlot(current, value.afternoon || value.evening);
  if (!value.open || !value.close) return true;
  return withinOpeningSlot(current, value);
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
  [ALIBABA_KEBAB_SLUG]: 0.18,
  "rooster-kebab-xativa": 0.18,
  "nakama-sushi-xativa": 0.18,
};
export const DEFAULT_CUSTOMER_COMMISSION_RATE = 0.18;
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
  if (Number.isInteger(restaurant.partnerProfile?.commissionRateBps)) {
    return Math.max(0, Math.min(1, Number(restaurant.partnerProfile!.commissionRateBps) / 10_000));
  }
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
    options: (Array.isArray(modifier.options) ? modifier.options : Array.isArray(modifier.items) ? modifier.items : [])
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
