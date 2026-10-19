import Stripe from "stripe";
import mongoose from "mongoose";
import { Order, StripeEvent } from "./models.js";
import { publishOrderIntakeEvents } from "./realtime.js";
import { dispatchCustomerOrderById } from "./customerCompat.js";
import { dispatchInitialIdempotencyKey, enqueueDispatchOutbox } from "./dispatchOutbox.js";
import {
  allowedPriorPaymentStates,
  shouldPublishOperationalIntake,
  stripePaymentIntentId,
  stripePaymentTransition,
  type StripePaymentState,
  type StripeWebhookObject,
} from "./stripeWebhookPolicy.js";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
export const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const PROCESSING_LEASE_MS = 5 * 60_000;

export function stripeConfigured() {
  return Boolean(stripe && process.env.STRIPE_WEBHOOK_SECRET);
}

/** Crea o reutiliza la cuenta Express del partner y devuelve el enlace hosted de Stripe. */
export async function createPartnerStripeOnboardingLink(input: {
  restaurantId: string;
  email: string;
  legalName: string;
  legalForm: "autonomo" | "sl" | "sa" | "cooperativa" | "otra";
  refreshUrl: string;
  returnUrl: string;
  existingAccountId?: string | null;
}) {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY no configurada");
  const account = input.existingAccountId
    ? await stripe.accounts.retrieve(input.existingAccountId)
    : await stripe.accounts.create({
        type: "express",
        country: "ES",
        email: input.email,
        business_type: input.legalForm === "autonomo" ? "individual" : "company",
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        business_profile: { name: input.legalName, product_description: "Restaurante partner de PIKI Delivery" },
        metadata: { piki_restaurant_id: input.restaurantId, piki_role: "marketplace_partner" },
      });
  const link = await stripe.accountLinks.create({
    account: account.id,
    type: "account_onboarding",
    refresh_url: input.refreshUrl,
    return_url: input.returnUrl,
    collection_options: { fields: "eventually_due" },
  });
  return { account, link };
}

export function isStripeSignatureError(error: unknown): boolean {
  return error instanceof Error && error.name === "StripeSignatureVerificationError";
}

export class StripeWebhookProcessingError extends Error {
  readonly code = "STRIPE_WEBHOOK_PROCESSING_FAILED";
  constructor(message: string, { cause }: { cause?: unknown } = {}) {
    super(message, { cause });
    this.name = "StripeWebhookProcessingError";
  }
}

export async function createCheckoutSession(input: {
  orderId: string;
  publicCode: string;
  origin: string;
  customerEmail?: string;
  items: Array<{ name: string; quantity: number; unitPriceCents: number }>;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  /** Stripe dynamic methods remain managed in Dashboard; this records Customer intent. */
  preferredPaymentMethod?: "stripe" | "bizum";
}) {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY no configurada");
  const metadata = { order_id: input.orderId, order_code: input.publicCode, customer_payment_choice: input.preferredPaymentMethod || "stripe" };
  const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = input.items.map((item) => ({
    quantity: item.quantity,
    price_data: { currency: "eur", product_data: { name: item.name }, unit_amount: item.unitPriceCents },
  }));
  if (input.deliveryFeeCents > 0) lineItems.push({ quantity: 1, price_data: { currency: "eur", product_data: { name: "Entrega PIKI" }, unit_amount: input.deliveryFeeCents } });
  if (input.serviceFeeCents > 0) lineItems.push({ quantity: 1, price_data: { currency: "eur", product_data: { name: "Tasa de servicio PIKI" }, unit_amount: input.serviceFeeCents } });
  return stripe.checkout.sessions.create({
    mode: "payment",
    line_items: lineItems,
    locale: "es",
    customer_email: input.customerEmail,
    client_reference_id: input.publicCode,
    metadata,
    // Keep the hosted checkout limited to the two methods approved for PIKI.
    // Bizum is handled by Stripe; no phone number is stored or displayed here.
    // The installed Stripe SDK predates Bizum's type declaration; the API
    // accepts it and Stripe's current Checkout docs list it explicitly.
    payment_method_types: ["card", "bizum" as unknown as Stripe.Checkout.SessionCreateParams.PaymentMethodType],
    payment_intent_data: { metadata, capture_method: "manual" },
    success_url: `${input.origin}/?checkout=success&order_id=${encodeURIComponent(input.publicCode)}`,
    cancel_url: `${input.origin}/?checkout=cancelled&order_id=${encodeURIComponent(input.publicCode)}`,
  }, { idempotencyKey: `piki-checkout-${input.publicCode}` });
}

type StripeEventLike = { id: string; type: string; data: { object: StripeWebhookObject } };
type Reservation = "acquired" | "processed" | "in_progress";
type PaymentApplyResult = { order: any | null; transitioned: boolean };

export type StripeWebhookDependencies = {
  reserve(event: StripeEventLike, orderCode: string | null): Promise<Reservation>;
  applyPaymentTransition(input: { orderCode: string; paymentState: StripePaymentState; eventType: string; object: StripeWebhookObject }): Promise<PaymentApplyResult>;
  publishIntake(order: any): Promise<void>;
  markProcessed(stripeEventId: string): Promise<void>;
  markFailed(stripeEventId: string, error: unknown): Promise<void>;
};

async function reserveStripeEvent(event: StripeEventLike, orderCode: string | null): Promise<Reservation> {
  try {
    await StripeEvent.create({
      stripeEventId: event.id,
      type: event.type,
      orderCode,
      processingStatus: "processing",
      processingStartedAt: new Date(),
    });
    return "acquired";
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
  }

  // A failed attempt is deliberately reclaimable. A stale processing lease is
  // also reclaimable after process death; an active duplicate asks Stripe to
  // retry rather than incorrectly acknowledging an unfinished event.
  const reclaimableBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
  const reclaimed = await StripeEvent.findOneAndUpdate(
    {
      stripeEventId: event.id,
      $or: [
        { processingStatus: "failed" },
        { processingStatus: "processing", processingStartedAt: { $lte: reclaimableBefore } },
      ],
    },
    {
      $set: {
        type: event.type,
        orderCode,
        processingStatus: "processing",
        processingStartedAt: new Date(),
        processedAt: null,
        failedAt: null,
        lastError: null,
      },
    },
    { new: true },
  ).lean().exec();
  if (reclaimed) return "acquired";

  const existing = await StripeEvent.findOne({ stripeEventId: event.id }).select("processingStatus").lean().exec() as any;
  // Events persisted before this migration were already acknowledged by the
  // former handler; do not replay them blindly.
  return existing?.processingStatus === "processing" ? "in_progress" : "processed";
}

async function applyPaymentTransition(input: { orderCode: string; paymentState: StripePaymentState; eventType: string; object: StripeWebhookObject }): Promise<PaymentApplyResult> {
  const paymentIntentId = stripePaymentIntentId(input.object);
  const isCheckoutEvent = input.eventType.startsWith("checkout.session");
  const update = {
    $set: {
      paymentState: input.paymentState,
      ...(isCheckoutEvent && typeof input.object.id === "string" ? { stripeCheckoutSessionId: input.object.id } : {}),
      ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    },
    $inc: { version: 1 },
  };
  // Payment and dispatch intent share one Mongo transaction. A redelivery uses
  // the same idempotency key, so it repairs a missing intent without a second
  // rider offer.
  let result: PaymentApplyResult = { order: null, transitioned: false };
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const transitioned = await Order.findOneAndUpdate(
        {
          publicCode: input.orderCode,
          paymentMethod: "stripe",
          paymentState: { $in: allowedPriorPaymentStates(input.paymentState) },
        },
        update,
        { new: true, session },
      ).lean().exec() as any;
      const order = transitioned || await Order.findOne({ publicCode: input.orderCode }).session(session).lean().exec() as any;
      if (shouldPublishOperationalIntake(order, { paymentState: input.paymentState, activatesOperationalIntake: ["authorized", "paid"].includes(input.paymentState) })) {
        await enqueueDispatchOutbox({
          orderId: order._id,
          tenantId: order.tenantId || null,
          idempotencyKey: dispatchInitialIdempotencyKey(order._id),
          reason: "stripe_payment_confirmed",
          session,
        });
      }
      result = { order, transitioned: Boolean(transitioned) };
    });
  } finally {
    await session.endSession();
  }
  return result;
}

const defaultStripeWebhookDependencies: StripeWebhookDependencies = {
  reserve: reserveStripeEvent,
  applyPaymentTransition,
  publishIntake: async (order) => publishOrderIntakeEvents(order, { settlement: "paid", message: "Pago online confirmado por Stripe." }),
  markProcessed: async (stripeEventId) => {
    await StripeEvent.updateOne(
      { stripeEventId, processingStatus: "processing" },
      { $set: { processingStatus: "processed", processedAt: new Date(), failedAt: null, lastError: null } },
    ).exec();
  },
  markFailed: async (stripeEventId, error) => {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    await StripeEvent.updateOne(
      { stripeEventId },
      { $set: { processingStatus: "failed", failedAt: new Date(), lastError: errorName.slice(0, 120) } },
    ).exec();
  },
};

/**
 * Idempotent Stripe saga: reserve → order transition → durable realtime outbox
 * → processed marker. A failure before the marker returns non-2xx to Stripe,
 * and a redelivery reclaims the event to finish any missing outbox writes.
 */
export async function processStripeEvent(event: StripeEventLike, dependencies: StripeWebhookDependencies = defaultStripeWebhookDependencies) {
  const object = event.data.object;
  const orderCode = object.metadata?.order_code || null;
  const reservation = await dependencies.reserve(event, orderCode);
  if (reservation === "processed") return { duplicate: true, eventType: event.type, orderCode, activated: false };
  if (reservation === "in_progress") throw new StripeWebhookProcessingError("STRIPE_EVENT_IN_PROGRESS");

  try {
    const transition = stripePaymentTransition(event.type);
    let activated = false;
    if (orderCode && transition) {
      const { order } = await dependencies.applyPaymentTransition({ orderCode, paymentState: transition.paymentState, eventType: event.type, object });
      if (shouldPublishOperationalIntake(order, transition)) {
        await dependencies.publishIntake(order);
        activated = true;
      }
    }
    await dependencies.markProcessed(event.id);
    return { duplicate: false, eventType: event.type, orderCode, activated };
  } catch (error) {
    try {
      await dependencies.markFailed(event.id, error);
    } catch (markError) {
      console.error("Stripe event failure marker unavailable", markError instanceof Error ? markError.name : "UnknownError");
    }
    throw new StripeWebhookProcessingError("STRIPE_EVENT_PROCESSING_FAILED", { cause: error });
  }
}

/** Verifies Stripe's raw signature before starting the idempotent event saga. */
export async function processStripeWebhook(rawBody: Buffer, signature: string) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw new Error("Stripe webhook no configurado");
  const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  return processStripeEvent(event as unknown as StripeEventLike);
}

export async function captureStripePaymentIntent(paymentIntentId: string) {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY no configurada");
  const intent = await stripe.paymentIntents.capture(paymentIntentId, {}, { idempotencyKey: `piki-capture-${paymentIntentId}` });
  if (intent.status !== "succeeded") throw new Error(`STRIPE_CAPTURE_STATUS_${intent.status}`);
  return intent;
}
