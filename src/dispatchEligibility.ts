import { cashOrderWithinLimitFilter, isDispatchableCashOrder } from "./paymentPolicy.js";
// El filtro de efectivo sin garantía sigue existiendo para auditoría, pero no
// habilita por sí solo el reparto a un Rider.
void cashOrderWithinLimitFilter; void isDispatchableCashOrder;

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

export const dispatchablePaymentFilter = {
  paymentState: { $in: ["authorized", "paid"] },
};

// Partner Orders debe poder recibir y mostrar un contrarreembolso pendiente
// para que el establecimiento lo acepte, pero dispatch sigue exigiendo una
// garantía de pago viva hasta que Operaciones autorice ese flujo.
export const partnerKitchenPaymentFilter = {
  $or: [dispatchablePaymentFilter, cashOrderWithinLimitFilter],
};

export function isDispatchablePayment(paymentState: string, _paymentMethod?: string, _totalCents?: number): boolean {
  return ["authorized", "paid"].includes(paymentState);
}
