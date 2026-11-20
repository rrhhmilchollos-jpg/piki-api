import { isCashOrderWithinLimit, isCashPaymentEnabledForRestaurant, cashOrderLimitCents, cashOrderMinimumCents } from "./paymentPolicy.js";
import { cashCardGuaranteeRequiredForRestaurant, isCashWithoutCardRolloutRestaurant, type CashCardGuaranteeRestaurant } from "./cashCardGuaranteeScope.js";
export { CASH_WITHOUT_CARD_TENANT_ID, CASH_WITHOUT_CARD_RESTAURANT_IDS, cashCardGuaranteeRequiredForRestaurant, isCashWithoutCardRolloutRestaurant, type CashCardGuaranteeRestaurant } from "./cashCardGuaranteeScope.js";

/** Only pass an account obtained from currentCustomer's authenticated session.
 * Never accept an input/body customerId or cashWithoutCardApproved as authority.
 */
export function approveCashWithoutCardForOrder(restaurant: CashCardGuaranteeRestaurant, paymentMethod: string, totalCents: number, authenticatedCustomer: { _id?: unknown } | null | undefined): boolean {
  return paymentMethod === "cash" && !cashCardGuaranteeRequiredForRestaurant(restaurant)
    && restaurant.cashPaymentsEnabled === true && isCashPaymentEnabledForRestaurant(restaurant)
    && /^[a-f\d]{24}$/i.test(String(authenticatedCustomer?._id || ""))
    && isCashOrderWithinLimit(paymentMethod, totalCents, cashOrderLimitCents(restaurant))
    && totalCents >= cashOrderMinimumCents(restaurant);
}
export type CashWithoutCardOrder = {
  restaurantId?: unknown; tenantId?: unknown; customerId?: unknown;
  cashWithoutCardApproved?: unknown; paymentMethod?: unknown; paymentState?: unknown; totalCents?: unknown;
  stripeCheckoutSessionId?: unknown; stripePaymentIntentId?: unknown;
};
/** Customer display state only. Mongo pending remains pending until QR cash collection. */
export function customerCashPaymentState(order: CashWithoutCardOrder): unknown {
  return order.cashWithoutCardApproved === true && order.paymentMethod === "cash" && order.paymentState === "pending"
    ? "pending_cash_collection" : order.paymentState;
}
/** Persisted server snapshot, not a payment authorization; funds remain due. */
export function isApprovedCashWithoutCardOrder(order: CashWithoutCardOrder | null | undefined): boolean {
  return order?.cashWithoutCardApproved === true
    && isCashWithoutCardRolloutRestaurant({ _id: order.restaurantId, tenantId: order.tenantId })
    && typeof order.customerId === "string" && /^[a-f\d]{24}$/i.test(order.customerId)
    && order.paymentMethod === "cash" && order.paymentState === "pending"
    && typeof order.totalCents === "number" && isCashOrderWithinLimit("cash", order.totalCents)
    && order.stripeCheckoutSessionId == null && order.stripePaymentIntentId == null;
}
