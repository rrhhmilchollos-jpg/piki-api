export const dispatchableOrderStatuses = [
  "pending",
  "accepted",
  "preparing",
  "ready_for_pickup",
] as const;

export function isDispatchableOrderStatus(status: string): boolean {
  return (dispatchableOrderStatuses as readonly string[]).includes(status);
}


export const dispatchablePaymentFilter = {
  $or: [
    { paymentState: "paid" },
    { paymentMethod: "cash", paymentState: "pending" },
  ],
};

export function isDispatchablePayment(paymentState: string, paymentMethod?: string): boolean {
  return paymentState === "paid" || (paymentState === "pending" && paymentMethod === "cash");
}
