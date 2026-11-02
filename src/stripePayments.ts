/**
 * Cobro asegurado del contra­rreembolso con Stripe.
 *
 * El cliente paga en efectivo al recibir, pero antes se le retiene el importe
 * total del pedido en la tarjeta (captura manual). Al entregar y cobrar en
 * efectivo, la retención se cancela y no se cobra nada. Si el cliente no paga
 * o no aparece, se captura la retención.
 *
 * Reglas de negocio acordadas:
 *  - Se retiene el importe total del pedido (productos + envío + comisión).
 *  - Plazo estándar de 7 días; a las 12 h del vencimiento se libera.
 *  - Pago en efectivo => se cancela la retención, nunca se captura.
 */
import Stripe from "stripe";
import { Order } from "./models.js";

/** Vigencia estándar de una autorización de tarjeta en pagos online. */
export const COD_AUTHORIZATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Margen de seguridad: liberamos 12 h antes de que el banco la suelte sola. */
export const COD_RELEASE_MARGIN_MS = 12 * 60 * 60 * 1000;

export type CodAuthorizationState =
  | "pending"
  | "authorized"
  | "captured"
  | "released"
  | "failed"
  | "expired";

let cachedClient: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

export function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY no configurada");
  if (!cachedClient) {
    // STRIPE_API_BASE permite apuntar a un Stripe simulado en pruebas locales.
    const base = process.env.STRIPE_API_BASE;
    const options: Record<string, unknown> = { apiVersion: "2024-06-20" };
    if (base) {
      const parsed = new URL(base);
      options.host = parsed.hostname;
      options.port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);
      options.protocol = parsed.protocol.replace(":", "") as "http" | "https";
    }
    cachedClient = new Stripe(key, options as never);
  }
  return cachedClient;
}

/** Momento en que una autorización creada ahora deja de ser válida. */
export function authorizationExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + COD_AUTHORIZATION_TTL_MS);
}

/** ¿Toca liberar ya esta autorización para no perder el margen de seguridad? */
export function shouldReleaseAuthorization(
  expiresAt: Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!expiresAt) return false;
  return now.getTime() >= expiresAt.getTime() - COD_RELEASE_MARGIN_MS;
}

/** Importe a retener: siempre el total del pedido. */
export function authorizationAmountCents(order: {
  totalCents?: number | null;
  subtotalCents?: number | null;
  deliveryFeeCents?: number | null;
  serviceFeeCents?: number | null;
}): number {
  if (typeof order.totalCents === "number" && order.totalCents > 0) {
    return Math.round(order.totalCents);
  }
  const sum =
    (order.subtotalCents ?? 0) +
    (order.deliveryFeeCents ?? 0) +
    (order.serviceFeeCents ?? 0);
  return Math.max(0, Math.round(sum));
}

export interface AuthorizeCodInput {
  orderId: string;
  amountCents: number;
  customerId?: string | null;
  paymentMethodId?: string | null;
  email?: string | null;
  description?: string;
}

export interface AuthorizeCodResult {
  paymentIntentId: string;
  clientSecret: string | null;
  status: string;
  requiresAction: boolean;
  expiresAt: Date;
}

/**
 * Crea la retención. Si el banco pide autenticación, devolvemos el clientSecret
 * para que el formulario de Stripe en la web del cliente la resuelva.
 */
export async function authorizeCodOrder(
  input: AuthorizeCodInput,
): Promise<AuthorizeCodResult> {
  const stripe = stripeClient();
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(input.amountCents),
    currency: "eur",
    capture_method: "manual",
    payment_method_types: ["card"],
    customer: input.customerId ?? undefined,
    payment_method: input.paymentMethodId ?? undefined,
    confirm: Boolean(input.paymentMethodId),
    description: input.description ?? `PIKI pedido ${input.orderId}`,
    receipt_email: input.email ?? undefined,
    metadata: { orderId: input.orderId, flow: "cod_guarantee" },
    // Guardamos la tarjeta para poder cobrar si el cliente no paga al recibir.
    setup_future_usage: "off_session",
  });

  return {
    paymentIntentId: intent.id,
    clientSecret: intent.client_secret ?? null,
    status: intent.status,
    requiresAction: intent.status === "requires_action",
    expiresAt: authorizationExpiry(),
  };
}

/** Captura la retención (total o parcial) porque el cliente no pagó en efectivo. */
export async function captureCodOrder(
  paymentIntentId: string,
  amountCents?: number,
): Promise<{ status: string; capturedCents: number }> {
  const stripe = stripeClient();
  const intent = await stripe.paymentIntents.capture(
    paymentIntentId,
    typeof amountCents === "number" ? { amount_to_capture: Math.round(amountCents) } : undefined,
  );
  return {
    status: intent.status,
    capturedCents: intent.amount_received ?? intent.amount ?? 0,
  };
}

export interface AuthorizationSnapshot {
  paymentIntentId: string;
  status: string;
  amountCents: number;
  capturedCents: number;
}

/**
 * Lee el estado real de la autorización en Stripe.
 *
 * Es la fuente de verdad del dinero: la base de datos puede decir «autorizada»
 * mientras el banco ya la soltó, o al contrario. El barrido siempre pregunta
 * antes de tocar nada.
 */
export async function retrieveAuthorization(paymentIntentId: string): Promise<AuthorizationSnapshot> {
  const intent = await stripeClient().paymentIntents.retrieve(paymentIntentId);
  return {
    paymentIntentId: intent.id,
    status: intent.status,
    amountCents: intent.amount ?? 0,
    capturedCents: intent.amount_received ?? 0,
  };
}

/**
 * ¿El error de Stripe significa «esto ya está resuelto»?
 *
 * Al liberar una autorización que el banco ya había soltado, Stripe responde
 * con un error de estado, no con éxito. Para el barrido no es un fallo: es
 * precisamente la conciliación que buscábamos.
 */
export function isAlreadyResolvedStripeError(error: unknown): boolean {
  const candidate = error as { code?: string; message?: string; raw?: { code?: string; message?: string } };
  const code = String(candidate?.code ?? candidate?.raw?.code ?? "");
  const message = String(candidate?.message ?? candidate?.raw?.message ?? "").toLowerCase();
  if (code === "payment_intent_unexpected_state" || code === "resource_missing") return true;
  return /already (been )?(cancel|expired|succeeded|captured)|has been canceled|cannot cancel|canceled paymentintent|no such payment_intent/.test(
    message,
  );
}

/** Libera la retención. Es lo que se hace cuando el cliente paga en efectivo. */
export async function releaseCodOrder(
  paymentIntentId: string,
  reason = "paid_in_cash",
): Promise<{ status: string }> {
  const stripe = stripeClient();
  const intent = await stripe.paymentIntents.cancel(paymentIntentId, {
    cancellation_reason: "abandoned",
  });
  try {
    const order = await Order.findOne({ stripePaymentIntentId: paymentIntentId });
    if (order) {
      // `paymentState` es el campo del esquema. Si el cliente ya había pagado en
      // efectivo, el pedido está cobrado, no caducado: marcarlo al revés dejaría
      // la caja descuadrada.
      const paidInCash = Boolean((order as unknown as { cashCollectedAt?: Date | null }).cashCollectedAt);
      order.set({
        paymentState: paidInCash ? "paid" : "expired",
        paymentReleasedAt: new Date(),
        paymentReleaseReason: reason,
      });
      await order.save();
    }
  } catch {
    // Si el pedido no se puede actualizar, la retención ya está liberada en Stripe.
  }
  return { status: intent.status };
}

export interface SweepResult {
  inspected: number;
  released: number;
  failed: number;
  errors: string[];
}

/**
 * Libera las retenciones que van a caducar sin que nadie las haya resuelto.
 * Sin esto, el banco suelta el dinero solo y el pedido queda sin garantía.
 */
export async function sweepExpiringCodAuthorizations(
  now: Date = new Date(),
  options: { apply?: boolean } = {},
): Promise<SweepResult> {
  const apply = options.apply === true;
  const candidates = await Order.find({
    paymentMethod: "cash",
    paymentState: "authorized",
    stripePaymentIntentId: { $type: "string" },
    archivedAt: null,
  })
    .select("_id stripePaymentIntentId paymentAuthorizationExpiresAt totalCents")
    .limit(200)
    .lean();

  const result: SweepResult = { inspected: candidates.length, released: 0, failed: 0, errors: [] };
  for (const candidate of candidates) {
    const expiresAt = candidate.paymentAuthorizationExpiresAt as Date | null | undefined;
    if (!shouldReleaseAuthorization(expiresAt, now)) continue;
    if (!apply) {
      result.released += 1;
      continue;
    }
    try {
      await releaseCodOrder(String(candidate.stripePaymentIntentId), "authorization_expired");
      result.released += 1;
    } catch (error) {
      result.failed += 1;
      result.errors.push(`${String(candidate._id)}: ${(error as Error).message}`);
    }
  }
  return result;
}

export interface StripeEventSummary {
  type: string;
  orderId: string | null;
  paymentIntentId: string | null;
  handled: boolean;
}

/**
 * Aplica un evento de Stripe al pedido correspondiente.
 * Se apoya en metadata.orderId, que grabamos al crear la retención.
 */
export async function handleStripeEvent(event: {
  type: string;
  data: { object: Record<string, unknown> };
}): Promise<StripeEventSummary> {
  const object = event.data.object as {
    id?: string;
    metadata?: Record<string, string>;
    status?: string;
    amount_received?: number;
  };
  const paymentIntentId = typeof object.id === "string" ? object.id : null;
  const orderId = object.metadata?.orderId ?? null;
  const summary: StripeEventSummary = {
    type: event.type,
    orderId,
    paymentIntentId,
    handled: false,
  };
  if (!orderId && !paymentIntentId) return summary;

  const query = orderId
    ? { _id: orderId }
    : { stripePaymentIntentId: paymentIntentId as string };
  const order = await Order.findOne(query);
  if (!order) return summary;

  switch (event.type) {
    case "payment_intent.amount_capturable_updated":
      order.set({
        paymentState: "authorized",
        paymentAuthorizedAt: new Date(),
        paymentAuthorizationExpiresAt: authorizationExpiry(),
        stripePaymentIntentId: paymentIntentId,
      });
      summary.handled = true;
      break;
    case "payment_intent.succeeded":
      order.set({
        paymentState: "paid",
        paymentCapturedAt: new Date(),
        paymentCapturedCents: object.amount_received ?? order.totalCents,
      });
      summary.handled = true;
      break;
    case "payment_intent.canceled":
      order.set({ paymentState: "expired", paymentReleasedAt: new Date() });
      summary.handled = true;
      break;
    case "payment_intent.payment_failed":
      order.set({ paymentState: "failed" });
      summary.handled = true;
      break;
    default:
      return summary;
  }
  await order.save();
  return summary;
}

/** Verifica la firma del webhook. Sin esto, cualquiera podría marcarnos pedidos como pagados. */
export function verifyStripeWebhook(
  rawBody: Buffer | string,
  signature: string | undefined,
): { type: string; data: { object: Record<string, unknown> } } {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET no configurada");
  if (!signature) throw new Error("falta la cabecera stripe-signature");
  return stripeClient().webhooks.constructEvent(
    rawBody,
    signature,
    secret,
  ) as unknown as { type: string; data: { object: Record<string, unknown> } };
}
