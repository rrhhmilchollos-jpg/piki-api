export const MAX_CASH_ORDER_CENTS = 4_899;

export type CashPaymentMethod = "cash" | "stripe" | string | undefined | null;

/** The cash cap applies to one final customer order, never to a rider handover. */
export function isCashOrderWithinLimit(paymentMethod: CashPaymentMethod, totalCents: number): boolean {
  return paymentMethod !== "cash" || (Number.isInteger(totalCents) && totalCents >= 0 && totalCents <= MAX_CASH_ORDER_CENTS);
}

export function cashOrderLimitError(totalCents: number) {
  return {
    error: "CASH_ORDER_TOTAL_EXCEEDS_LIMIT",
    message: `Los pedidos en efectivo no pueden superar ${MAX_CASH_ORDER_CENTS} céntimos (€48,99) sobre el total final. Selecciona pago online.`,
    maxCashOrderCents: MAX_CASH_ORDER_CENTS,
    totalCents,
  } as const;
}

/** Mongo predicate for cash orders that may enter operational dispatch. */
export const cashOrderWithinLimitFilter = {
  paymentMethod: "cash",
  paymentState: "pending",
  // $gte also excludes legacy documents with null/missing totals instead of
  // treating an unknown amount as safe to dispatch.
  totalCents: { $gte: 0, $lte: MAX_CASH_ORDER_CENTS },
} as const;

export function isDispatchableCashOrder(paymentMethod: CashPaymentMethod, paymentState: string, totalCents: number): boolean {
  return paymentMethod === "cash" && paymentState === "pending" && isCashOrderWithinLimit(paymentMethod, totalCents);
}
