/**
 * Bloqueo de importe en tarjeta para pedidos contra reembolso.
 *
 * El problema que resuelve: si el rider compra con dinero de PIKI y al llegar
 * el cliente no está, no responde o rechaza el pedido, PIKI se come el coste.
 *
 * La solución es una autorización (hold) con captura manual: se bloquea el
 * importe en la tarjeta del cliente al crear el pedido, pero NO se cobra. Si el
 * cliente paga en efectivo al recibir, se libera el bloqueo y ese dinero vuelve
 * a estar disponible al instante. Si no paga, se captura el importe bloqueado.
 *
 * Se habla directamente con la API de Stripe por HTTP para no acoplar este
 * módulo al resto del SDK y poder probarlo sin claves reales.
 */

const STRIPE_API = "https://api.stripe.com/v1";

export type HoldState = "requires_capture" | "captured" | "canceled" | "failed";

export type HoldResult = {
  ok: boolean;
  holdId?: string;
  state?: HoldState;
  amountCents?: number;
  reason?: string;
};

function secretKey(): string {
  return String(process.env.STRIPE_SECRET_KEY || "").trim();
}

export function holdsEnabled(): boolean {
  return secretKey().length > 0;
}

async function callStripe(path: string, body: URLSearchParams): Promise<any> {
  const key = secretKey();
  if (!key) throw new Error("STRIPE_SECRET_KEY no configurada");
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `Stripe ${response.status}`;
    throw new Error(String(message).slice(0, 200));
  }
  return payload;
}

/**
 * Bloquea el importe en la tarjeta sin cobrarlo.
 * `paymentMethodId` es el método de pago guardado del cliente (pm_...).
 */
export async function createHold(input: {
  amountCents: number;
  customerId: string;
  orderId: string;
  paymentMethodId: string;
  currency?: string;
}): Promise<HoldResult> {
  const amount = Math.round(Number(input.amountCents));
  if (!Number.isFinite(amount) || amount < 50) return { ok: false, reason: "importe_no_valido" };
  if (!input.paymentMethodId) return { ok: false, reason: "sin_metodo_de_pago" };
  if (!holdsEnabled()) return { ok: false, reason: "stripe_no_configurado" };

  const body = new URLSearchParams({
    amount: String(amount),
    currency: (input.currency || "eur").toLowerCase(),
    capture_method: "manual",
    payment_method: input.paymentMethodId,
    confirm: "true",
    "automatic_payment_methods[enabled]": "true",
    "automatic_payment_methods[allow_redirects]": "never",
    "metadata[orderId]": input.orderId,
    "metadata[customerId]": input.customerId,
    "metadata[purpose]": "cash_order_hold",
  });

  try {
    const intent = await callStripe("/payment_intents", body);
    const state = String(intent?.status || "") as HoldState;
    if (state !== "requires_capture") {
      return { ok: false, holdId: intent?.id, state, reason: `estado_${state || "desconocido"}` };
    }
    return { ok: true, holdId: intent.id, state, amountCents: amount };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "error_stripe" };
  }
}

/** Cobra el importe bloqueado (el cliente no pagó al recibir). */
export async function captureHold(holdId: string, amountCents?: number): Promise<HoldResult> {
  if (!holdId) return { ok: false, reason: "sin_bloqueo" };
  try {
    const body = new URLSearchParams();
    if (typeof amountCents === "number") body.set("amount_to_capture", String(Math.round(amountCents)));
    const intent = await callStripe(`/payment_intents/${encodeURIComponent(holdId)}/capture`, body);
    return { ok: true, holdId, state: String(intent?.status || "captured") as HoldState };
  } catch (error) {
    return { ok: false, holdId, reason: error instanceof Error ? error.message : "error_stripe" };
  }
}

/** Libera el bloqueo: el cliente pagó en efectivo y el dinero vuelve a su tarjeta. */
export async function releaseHold(holdId: string): Promise<HoldResult> {
  if (!holdId) return { ok: false, reason: "sin_bloqueo" };
  try {
    const intent = await callStripe(`/payment_intents/${encodeURIComponent(holdId)}/cancel`, new URLSearchParams());
    return { ok: true, holdId, state: String(intent?.status || "canceled") as HoldState };
  } catch (error) {
    return { ok: false, holdId, reason: error instanceof Error ? error.message : "error_stripe" };
  }
}
