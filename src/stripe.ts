import Stripe from "stripe";
import { Order, StripeEvent } from "./models.js";
import { publishPaidOrderEvents } from "./realtime.js";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
export const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;

export function stripeConfigured() {
  return Boolean(stripe && process.env.STRIPE_WEBHOOK_SECRET);
}

export async function createCheckoutSession(input: {
  orderId: string;
  publicCode: string;
  origin: string;
  customerEmail?: string;
  items: Array<{ name: string; quantity: number; unitPriceCents: number }>;
  deliveryFeeCents: number;
  serviceFeeCents: number;
}) {
  if (!stripe) throw new Error("STRIPE_SECRET_KEY no configurada");
  const metadata = { order_id: input.orderId, order_code: input.publicCode };
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
    payment_intent_data: { metadata },
    success_url: `${input.origin}/?checkout=success&order_id=${encodeURIComponent(input.publicCode)}`,
    cancel_url: `${input.origin}/?checkout=cancelled&order_id=${encodeURIComponent(input.publicCode)}`,
  }, { idempotencyKey: `piki-checkout-${input.publicCode}` });
}

async function reserveStripeEvent(event: Stripe.Event, orderCode: string | null): Promise<boolean> {
  try {
    await StripeEvent.create({ stripeEventId: event.id, type: event.type, orderCode });
    return true;
  } catch (error: any) {
    if (error?.code === 11000) return false;
    throw error;
  }
}

/**
 * Verifies Stripe's raw signature before touching application data. A paid event
 * is admitted once, moves the order to pending/paid atomically, and only then
 * writes durable realtime events. Re-delivered Stripe events are harmless.
 */
export async function processStripeWebhook(rawBody: Buffer, signature: string) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) throw new Error("Stripe webhook no configurado");
  const event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  const object = event.data.object as Stripe.Checkout.Session | Stripe.PaymentIntent | Stripe.Charge;
  const metadata = "metadata" in object ? object.metadata : undefined;
  const orderCode = metadata?.order_code || null;
  if (!(await reserveStripeEvent(event, orderCode))) return { duplicate: true, eventType: event.type, orderCode, activated: false };

  const paid = event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded" || event.type === "payment_intent.succeeded";
  const failed = event.type === "checkout.session.async_payment_failed" || event.type === "payment_intent.payment_failed";
  const refunded = event.type === "charge.refunded";
  const expired = event.type === "checkout.session.expired";
  const paymentState = paid ? "paid" : failed ? "failed" : refunded ? "refunded" : expired ? "expired" : null;
  let activated = false;

  if (orderCode && paymentState) {
    const session = object as Stripe.Checkout.Session;
    const paymentIntent = "payment_intent" in session && typeof session.payment_intent === "string" ? session.payment_intent : undefined;
    if (paid) {
      const order = await Order.findOneAndUpdate(
        { publicCode: orderCode, paymentState: { $ne: "paid" } },
        {
          $set: {
            paymentState: "paid",
            status: "pending",
            assignmentState: "unassigned",
            ...(event.type.startsWith("checkout.session") ? { stripeCheckoutSessionId: session.id } : {}),
            ...(paymentIntent ? { stripePaymentIntentId: paymentIntent } : {}),
          },
          $inc: { version: 1 },
          $push: { statusHistory: { status: "pending", actorRole: "system", reason: "Pago Stripe confirmado" } },
        },
        { new: true },
      ).lean().exec() as any;
      if (order) {
        await publishPaidOrderEvents(order);
        activated = true;
      }
    } else {
      await Order.updateOne(
        { publicCode: orderCode },
        { $set: { paymentState, ...(event.type.startsWith("checkout.session") ? { stripeCheckoutSessionId: session.id } : {}), ...(paymentIntent ? { stripePaymentIntentId: paymentIntent } : {}) } },
      ).exec();
    }
  }
  return { duplicate: false, eventType: event.type, orderCode, activated };
}
