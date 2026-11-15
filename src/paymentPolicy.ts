export const MAX_CASH_ORDER_CENTS = 4_899;
/** Production kill-switch: COD is closed unless explicitly enabled in Render or Admin. */
export let CASH_PAYMENTS_ENABLED = process.env.PIKI_CASH_PAYMENTS_ENABLED === "true";
export function setCashPaymentsEnabled(enabled: boolean) {
  CASH_PAYMENTS_ENABLED = Boolean(enabled);
}
export async function hydrateCashPaymentsEnabled() {
  try {
    const mongoose = (await import("mongoose")).default;
    const collection = mongoose.connection.collection("global_configs");
    const config = await collection.findOne({ configKey: "default" }, { projection: { "values.cashPaymentsEnabled": 1 } }) as any;
    if (typeof config?.values?.cashPaymentsEnabled === "boolean") setCashPaymentsEnabled(config.values.cashPaymentsEnabled);
  } catch (error) {
    console.warn("No se pudo cargar el estado persistido del contrareembolso; se mantiene el valor de Render.", error instanceof Error ? error.message : error);
  }
}

export type CashPaymentMethod = "cash" | "stripe" | "bizum" | string | undefined | null;

/** Métodos online que se confirman mediante Stripe y nunca requieren cobro al Rider. */
export const ONLINE_PAYMENT_METHODS = ["stripe", "bizum"] as const;
export function isOnlinePaymentMethod(value: unknown): value is (typeof ONLINE_PAYMENT_METHODS)[number] {
  return ONLINE_PAYMENT_METHODS.includes(value as (typeof ONLINE_PAYMENT_METHODS)[number]);
}
export type CashPaymentPartner = { slug?: string | null; name?: string | null; cashPaymentsEnabled?: boolean | null; cashOrderMaxCents?: number | null; cashOrderMinCents?: number | null };
export function cashOrderLimitCents(restaurant?: CashPaymentPartner | null): number {
  const configured = Number(restaurant?.cashOrderMaxCents);
  return Number.isFinite(configured) ? Math.max(0, Math.min(MAX_CASH_ORDER_CENTS, Math.round(configured))) : MAX_CASH_ORDER_CENTS;
}
export function cashOrderMinimumCents(restaurant?: CashPaymentPartner | null): number {
  const configured = Number(restaurant?.cashOrderMinCents);
  return Number.isFinite(configured) ? Math.max(0, Math.round(configured)) : 0;
}

/**
 * Cash is controlled by the global operations kill-switch. Legacy partner
 * fields and client-provided payment methods cannot bypass a closed switch.
 */
export function isCashPaymentEnabledForRestaurant(_restaurant: CashPaymentPartner): boolean {
  // La garantía de tarjeta, el barrido y la liquidación ya están implementados;
  // el interruptor global evita exponer COD hasta que Operaciones lo autorice.
  return CASH_PAYMENTS_ENABLED;
}

export function cashPaymentDisabledError(restaurant: CashPaymentPartner) {
  return {
    error: "CASH_PAYMENT_NOT_ENABLED_FOR_PARTNER",
    message: `${restaurant.name || "Este establecimiento"} solo acepta pago online en PIKI. Selecciona tarjeta, Apple Pay o Google Pay.`,
  } as const;
}

/** The cash cap applies to one final customer order, never to a rider handover. */
export function isCashOrderWithinLimit(paymentMethod: CashPaymentMethod, totalCents: number, maxCents = MAX_CASH_ORDER_CENTS): boolean {
  return paymentMethod !== "cash" || (Number.isInteger(totalCents) && totalCents >= 0 && totalCents <= maxCents);
}

export function cashOrderLimitError(totalCents: number, maxCents = MAX_CASH_ORDER_CENTS) {
  const limitMessage = maxCents === MAX_CASH_ORDER_CENTS
    ? `${MAX_CASH_ORDER_CENTS} céntimos (€48,99)`
    : `${(maxCents / 100).toFixed(2).replace(".", ",")} €`;
  return {
    error: "CASH_ORDER_TOTAL_EXCEEDS_LIMIT",
    message: `Los pedidos en efectivo no pueden superar ${limitMessage} sobre el total final. Selecciona pago online.`,
    maxCashOrderCents: maxCents,
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
