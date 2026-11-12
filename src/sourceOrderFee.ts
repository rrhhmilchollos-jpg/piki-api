// Same upper bound as the existing persisted restaurant fee write contract.
export const MAX_SOURCE_ORDER_FEE_CENTS = 100_000;
export type SourceOrderFeeRestaurant = { _id: unknown; deliveryFeeCents?: unknown };
export class SourceOrderFeeError extends Error {
  constructor(code = "INVALID_DELIVERY_FEE") { super(code); }
}
function validFee(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SOURCE_ORDER_FEE_CENTS;
}

/** Read ONLY the authorized persisted restaurant snapshot, never request fees,
 * names/slugs, global overrides or environment variables. An absent field uses
 * the existing coverage tariff; an explicit zero is a valid configured fee.
 * Null, strings, fractional/negative/non-finite and out-of-bound values block.
 */
export function sourceOrderFee(restaurant: SourceOrderFeeRestaurant, policyFeeCents: number): number {
  if (!restaurant || restaurant._id === undefined || restaurant._id === null || !String(restaurant._id).trim()) throw new SourceOrderFeeError("INVALID_DELIVERY_FEE_CONTEXT");
  const fee = restaurant.deliveryFeeCents === undefined ? policyFeeCents : restaurant.deliveryFeeCents;
  if (!validFee(fee)) throw new SourceOrderFeeError();
  return fee;
}
