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
  $or: [
    { paymentState: { $in: ["authorized", "paid"] } },
    { paymentMethod: "cash", paymentState: "pending" },
  ],
};

export function isDispatchablePayment(paymentState: string, paymentMethod?: string): boolean {
  return ["authorized", "paid"].includes(paymentState) || (paymentState === "pending" && paymentMethod === "cash");
}
