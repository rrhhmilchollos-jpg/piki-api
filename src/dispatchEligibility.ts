// El filtro de efectivo sin garantía sigue existiendo para auditoría, pero ya
// no habilita el reparto.
import { cashOrderWithinLimitFilter, isDispatchableCashOrder } from "./paymentPolicy.js";
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

// Todo pedido, también los de efectivo, necesita una garantía viva antes de
// salir a reparto: la tarjeta se retiene (paymentState "authorized") y el rider
// cobra en la puerta. Sin tarjeta no hay oferta, así el cliente no se queda con
// un pedido que nadie va a cubrir.
export const dispatchablePaymentFilter = {
  paymentState: { $in: ["authorized", "paid"] },
};

export function isDispatchablePayment(paymentState: string, _paymentMethod?: string, _totalCents?: number): boolean {
  return ["authorized", "paid"].includes(paymentState);
}
