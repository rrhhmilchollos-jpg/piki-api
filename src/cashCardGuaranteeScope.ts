// Explicit Operations rollout. A false flag elsewhere must never opt another
// merchant or tenant into unsecured COD.
export const CASH_WITHOUT_CARD_TENANT_ID = "6ab891dbc9ebf588e74114f2";
export const CASH_WITHOUT_CARD_RESTAURANT_IDS = [
  "6af3dac6508226eb18543af6", // Kazoku Xàtiva
  "6af5b418579fe6af2a8bb834", // Kazoku Algemesí
] as const;
export type CashCardGuaranteeRestaurant = {
  _id?: unknown; tenantId?: unknown; name?: string | null; slug?: string | null;
  cashPaymentsEnabled?: boolean | null; cashOrderMaxCents?: number | null; cashOrderMinCents?: number | null;
  partnerProfile?: { cashCardGuaranteeRequired?: unknown; commissionRateBps?: unknown; openingHours?: unknown } | null;
};
export function isCashWithoutCardRolloutRestaurant(restaurant: CashCardGuaranteeRestaurant | null | undefined): boolean {
  return String(restaurant?.tenantId || "") === CASH_WITHOUT_CARD_TENANT_ID
    && (CASH_WITHOUT_CARD_RESTAURANT_IDS as readonly string[]).includes(String(restaurant?._id || ""));
}
/** Missing/null/string flags and merchants outside the approved scope fail closed. */
export function cashCardGuaranteeRequiredForRestaurant(restaurant: CashCardGuaranteeRestaurant | null | undefined): boolean {
  return !isCashWithoutCardRolloutRestaurant(restaurant) || restaurant?.cashPaymentsEnabled !== true
    || restaurant?.partnerProfile?.cashCardGuaranteeRequired !== false;
}
