export const MAX_CASH_ORDER_CENTS = 4_899;

export type CashPaymentMethod = "cash" | "stripe" | string | undefined | null;
export type CashPaymentPartner = { slug?: string | null; name?: string | null; cashPaymentsEnabled?: boolean | null };

/**
 * Cash must be explicitly enabled by a PIKI superadmin per partner. It is not
 * inferred from a legacy order or from a client-provided payment method.
 * Alibaba Kebab Xàtiva is permanently online-only by the partner's request.
 */
export function isCashPaymentEnabledForRestaurant(restaurant: CashPaymentPartner): boolean {
  return restaurant.cashPaymentsEnabled === true && String(restaurant.slug || "") !== "alibaba-kebab-xativa";
}

export function cashPaymentDisabledError(restaurant: CashPaymentPartner) {
  return {
    error: "CASH_PAYMENT_NOT_ENABLED_FOR_PARTNER",
    message: `${restaurant.name || "Este establecimiento"} solo acepta pago online en PIKI. Selecciona tarjeta, Apple Pay o Google Pay.`,
  } as const;
}

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
