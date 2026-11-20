import { Types } from "mongoose";
import { cashOrderWithinLimitFilter } from "./paymentPolicy.js";
import { CASH_WITHOUT_CARD_RESTAURANT_IDS, CASH_WITHOUT_CARD_TENANT_ID, isApprovedCashWithoutCardOrder, type CashWithoutCardOrder } from "./cashCardGuaranteePolicy.js";

export const dispatchableOrderStatuses = [
  "pending",
  "accepted",
  "preparing",
  "ready_for_pickup",
] as const;

export const activeOperationalOrderStatuses = [
  ...dispatchableOrderStatuses,
  "picked_up",
  "on_the_way",
] as const;

export function isDispatchableOrderStatus(status: string): boolean {
  return (dispatchableOrderStatuses as readonly string[]).includes(status);
}

export const approvedCashWithoutCardPaymentFilter = {
  ...cashOrderWithinLimitFilter,
  totalCents: { ...cashOrderWithinLimitFilter.totalCents, $mod: [1, 0] },
  cashWithoutCardApproved: true,
  tenantId: new Types.ObjectId(CASH_WITHOUT_CARD_TENANT_ID),
  restaurantId: { $in: CASH_WITHOUT_CARD_RESTAURANT_IDS.map((id) => new Types.ObjectId(id)) },
  customerId: { $regex: /^[a-f\d]{24}$/i },
  stripeCheckoutSessionId: null,
  stripePaymentIntentId: null,
};
export const dispatchablePaymentFilter = {
  $or: [{ paymentState: { $in: ["authorized", "paid"] } }, approvedCashWithoutCardPaymentFilter],
};

// Kitchen intake of pending cash stays unchanged. Rider dispatch additionally
// requires a live guarantee OR the narrowly scoped server approval snapshot.
export const partnerKitchenPaymentFilter = {
  $or: [{ paymentState: { $in: ["authorized", "paid"] } }, cashOrderWithinLimitFilter],
};

export function isDispatchablePayment(paymentState: string, paymentMethod?: string, totalCents?: number, order?: CashWithoutCardOrder): boolean {
  return ["authorized", "paid"].includes(paymentState)
    || Boolean(order && isApprovedCashWithoutCardOrder({ ...order, paymentState, paymentMethod, totalCents }));
}
