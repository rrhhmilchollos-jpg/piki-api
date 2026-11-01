import Stripe from "stripe";
import { PikiPassSubscription, CustomerDeliverySaving, UserStreak } from "./customerEngagement.js";

/**
 * PIKI Pass billing.
 *
 * The module owns everything that talks to Stripe Billing for the Customer
 * subscription product: checkout creation, the billing portal, and the
 * projection of Stripe subscription state into MongoDB.
 *
 * It deliberately creates its own Stripe client instead of importing the one
 * in `stripe.ts`, because `stripe.ts` calls back into this module from the
 * webhook saga. A one-way dependency keeps the event pipeline acyclic.
 */

const secretKey = process.env.STRIPE_SECRET_KEY;
const billingClient = secretKey ? new Stripe(secretKey) : null;

export const PIKI_PASS_MONTHLY_CENTS = 499;
export const PIKI_PASS_ANNUAL_CENTS = 4_990;
export const PIKI_PASS_TRIAL_DAYS = 30;
export const PIKI_PASS_FREE_DELIVERY_MIN_SUBTOTAL_CENTS = 1_000;

export type PikiPassPlan = "monthly" | "annual";

export const PIKI_PASS_PLANS: Array<{ plan: PikiPassPlan; label: string; amountCents: number; interval: "month" | "year"; trialDays: number }> = [
  { plan: "monthly", label: "PIKI Pass mensual", amountCents: PIKI_PASS_MONTHLY_CENTS, interval: "month", trialDays: PIKI_PASS_TRIAL_DAYS },
  { plan: "annual", label: "PIKI Pass anual", amountCents: PIKI_PASS_ANNUAL_CENTS, interval: "year", trialDays: PIKI_PASS_TRIAL_DAYS },
];

export function pikiPassConfigured(): boolean {
  return Boolean(billingClient);
}

function priceIdFor(plan: PikiPassPlan): string | null {
  const configured = plan === "annual" ? process.env.STRIPE_PASS_ANNUAL_PRICE_ID : process.env.STRIPE_PASS_MONTHLY_PRICE_ID;
  const value = String(configured || "").trim();
  return value.startsWith("price_") ? value : null;
}

function planConfig(plan: PikiPassPlan) {
  return PIKI_PASS_PLANS.find((entry) => entry.plan === plan) || PIKI_PASS_PLANS[0];
}

function lineItemFor(plan: PikiPassPlan): Stripe.Checkout.SessionCreateParams.LineItem {
  const priceId = priceIdFor(plan);
  if (priceId) return { quantity: 1, price: priceId };
  const config = planConfig(plan);
  return {
    quantity: 1,
    price_data: {
      currency: "eur",
      unit_amount: config.amountCents,
      recurring: { interval: config.interval, interval_count: 1 },
      product_data: { name: config.label, description: "Envíos gratis en pedidos desde 10 € y ventajas exclusivas PIKI." },
    },
  };
}

/** Hosted Stripe Checkout in subscription mode, with the 30-day trial applied. */
export async function createPassCheckoutSession(input: {
  customerId: string;
  customerEmail?: string | null;
  plan: PikiPassPlan;
  origin: string;
}) {
  if (!billingClient) throw new Error("STRIPE_SECRET_KEY no configurada");
  const plan = input.plan === "annual" ? "annual" : "monthly";
  const metadata = { purpose: "piki_pass", customer_id: input.customerId, plan };
  return billingClient.checkout.sessions.create({
    mode: "subscription",
    locale: "es",
    customer_email: input.customerEmail || undefined,
    line_items: [lineItemFor(plan)],
    subscription_data: { trial_period_days: PIKI_PASS_TRIAL_DAYS, metadata },
    metadata,
    client_reference_id: input.customerId,
    success_url: `${input.origin}/piki-pass?pass=success`,
    cancel_url: `${input.origin}/piki-pass?pass=cancelled`,
  }, { idempotencyKey: `piki-pass-${input.customerId}-${plan}` });
}

/** Stripe-hosted portal so the Customer can update the card or cancel without support. */
export async function createPassPortalSession(input: { stripeCustomerId: string; origin: string }) {
  if (!billingClient) throw new Error("STRIPE_SECRET_KEY no configurada");
  return billingClient.billingPortal.sessions.create({ customer: input.stripeCustomerId, return_url: `${input.origin}/piki-pass` });
}

/**
 * Fallback checkout session when the hosted subscription flow is disabled by
 * an operator. It keeps the Customer on a one-off payment for 30 days of Pass,
 * so the product is not blocked by a missing Dashboard price.
 */
export async function createPassOneOffSession(input: { customerId: string; customerEmail?: string | null; plan: PikiPassPlan; origin: string }) {
  if (!billingClient) throw new Error("STRIPE_SECRET_KEY no configurada");
  const config = planConfig(input.plan);
  const metadata = { purpose: "piki_pass_once", customer_id: input.customerId, plan: config.plan, duration_days: "30" };
  return billingClient.checkout.sessions.create({
    mode: "payment",
    locale: "es",
    customer_email: input.customerEmail || undefined,
    line_items: [{ quantity: 1, price_data: { currency: "eur", product_data: { name: "PIKI Pass · 30 días" }, unit_amount: config.amountCents } }],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${input.origin}/piki-pass?pass=success`,
    cancel_url: `${input.origin}/piki-pass?pass=cancelled`,
  }, { idempotencyKey: `piki-pass-once-${input.customerId}` });
}

export type PassStatus = "active" | "paused" | "cancelled" | "expired";

export function mapStripeSubscriptionStatus(status: string | null | undefined): PassStatus {
  switch (String(status || "")) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "paused";
    case "canceled":
      return "cancelled";
    case "incomplete_expired":
      return "expired";
    default:
      return "paused";
  }
}

function secondsToDate(value: unknown): Date | null {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1_000);
}

function subscriptionPeriodEnd(subscription: any): Date | null {
  return secondsToDate(subscription?.current_period_end)
    || secondsToDate(subscription?.items?.data?.[0]?.current_period_end)
    || secondsToDate(subscription?.trial_end);
}

/**
 * Projects a Stripe subscription into `piki_pass_subscriptions`. The write is
 * idempotent: Stripe retries delivery, so every field is derived from the
 * event payload rather than incremented.
 */
export async function syncPassSubscriptionFromStripe(subscription: any) {
  const metadata = subscription?.metadata || {};
  const customerId = String(metadata.customer_id || "").trim();
  const stripeCustomerId = typeof subscription?.customer === "string" ? subscription.customer : String(subscription?.customer?.id || "");
  const stripeSubscriptionId = String(subscription?.id || "").trim();

  let resolvedCustomerId = customerId;
  if (!resolvedCustomerId && stripeSubscriptionId) {
    const existing = await PikiPassSubscription.findOne({ stripeSubscriptionId }).select("customerId").lean().exec() as any;
    resolvedCustomerId = String(existing?.customerId || "");
  }
  if (!resolvedCustomerId) return { synced: false, reason: "CUSTOMER_NOT_RESOLVED" as const };

  const status = mapStripeSubscriptionStatus(subscription?.status);
  const startedAt = secondsToDate(subscription?.start_date) || new Date();
  const expiresAt = subscriptionPeriodEnd(subscription) || new Date(Date.now() + 30 * 86_400_000);
  const plan: PikiPassPlan = metadata.plan === "annual" ? "annual" : "monthly";
  const trialEndsAt = secondsToDate(subscription?.trial_end);

  const subscriptionRow = await PikiPassSubscription.findOneAndUpdate(
    { customerId: resolvedCustomerId },
    {
      $set: {
        customerId: resolvedCustomerId,
        plan,
        status,
        startedAt,
        expiresAt,
        stripeSubscriptionId: stripeSubscriptionId || null,
        stripeCustomerId: stripeCustomerId || null,
        cancelAtPeriodEnd: Boolean(subscription?.cancel_at_period_end),
        trialEndsAt: trialEndsAt || null,
        lastStripeStatus: String(subscription?.status || ""),
        lastSyncedAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean().exec();

  return { synced: true as const, customerId: resolvedCustomerId, status, plan, expiresAt, subscription: subscriptionRow };
}

/** Handles a one-off 30-day Pass purchase (fallback flow). */
export async function activatePassFromOneOffPayment(session: any) {
  const metadata = session?.metadata || {};
  const customerId = String(metadata.customer_id || "").trim();
  if (!customerId) return { synced: false, reason: "CUSTOMER_NOT_RESOLVED" as const };
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000);
  const subscriptionRow = await PikiPassSubscription.findOneAndUpdate(
    { customerId },
    {
      $set: { customerId, plan: metadata.plan === "annual" ? "annual" : "monthly", status: "active", startedAt: now, expiresAt, lastStripeStatus: "paid_once", lastSyncedAt: now },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean().exec();
  return { synced: true as const, customerId, status: "active" as PassStatus, expiresAt, subscription: subscriptionRow };
}

/**
 * Entry point used by the Stripe webhook saga. Returns `handled: false` for
 * every event that does not belong to PIKI Pass, so the payment pipeline keeps
 * owning order events exactly as before.
 */
export async function applyPikiPassEvent(event: { id: string; type: string; data: { object: any } }) {
  const object = event.data?.object || {};
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
    case "customer.subscription.deleted": {
      const result = await syncPassSubscriptionFromStripe(object);
      return { handled: true, kind: "subscription" as const, ...result };
    }
    case "invoice.paid":
    case "invoice.payment_failed":
    case "invoice.payment_action_required": {
      const subscriptionId = typeof object?.subscription === "string" ? object.subscription : String(object?.subscription?.id || "");
      if (!subscriptionId || !billingClient) return { handled: false, reason: "NO_SUBSCRIPTION" as const };
      const subscription = await billingClient.subscriptions.retrieve(subscriptionId);
      const result = await syncPassSubscriptionFromStripe(subscription);
      return { handled: true, kind: "invoice" as const, invoiceStatus: object?.status || null, ...result };
    }
    case "checkout.session.completed": {
      if (object?.metadata?.purpose !== "piki_pass_once") return { handled: false, reason: "NOT_PIKI_PASS" as const };
      const result = await activatePassFromOneOffPayment(object);
      return { handled: true, kind: "one_off" as const, ...result };
    }
    default:
      return { handled: false, reason: "IGNORED_EVENT" as const };
  }
}

export type PassSnapshot = {
  active: boolean;
  status: PassStatus | "none";
  plan: PikiPassPlan | null;
  expiresAt: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  priceCents: number;
  freeDeliveryMinSubtotalCents: number;
  savings: { grossSavedCents: number; subscriptionPaidCents: number; netSavedCents: number; orders: number };
};

/**
 * Reads the Pass state plus the savings ledger. Net savings subtracts what the
 * Customer actually paid in subscription months, so the panel never advertises
 * a gross figure as if it were profit.
 */
export async function pikiPassSnapshot(customerId: string, now = new Date()): Promise<PassSnapshot> {
  const row = await PikiPassSubscription.findOne({ customerId }).lean().exec() as any;
  const savingsRows = await CustomerDeliverySaving.find({ customerId, source: "piki_pass" }).select("savedOnDeliveryCents recordedAt").lean().exec() as any[];
  const active = Boolean(row && ["active", "paused"].includes(String(row.status)) && new Date(row.expiresAt).getTime() > now.getTime());
  const grossSavedCents = savingsRows.reduce((total, saving) => total + Math.max(0, Number(saving.savedOnDeliveryCents || 0)), 0);
  let subscriptionPaidCents = 0;
  if (row?.startedAt) {
    const months = Math.max(0, Math.floor((now.getTime() - new Date(row.startedAt).getTime()) / (30 * 86_400_000)));
    const paidMonths = Number(row.trialEndsAt) ? Math.max(0, months - 1) : months;
    subscriptionPaidCents = paidMonths * (row.plan === "annual" ? Math.round(PIKI_PASS_ANNUAL_CENTS / 12) : PIKI_PASS_MONTHLY_CENTS);
  }
  const hasTrial = Boolean(row?.trialEndsAt && new Date(row.trialEndsAt).getTime() > now.getTime());
  return {
    active,
    status: (row?.status as PassStatus) || "none",
    plan: (row?.plan as PikiPassPlan) || null,
    expiresAt: row?.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    trialEndsAt: row?.trialEndsAt ? new Date(row.trialEndsAt).toISOString() : null,
    cancelAtPeriodEnd: Boolean(row?.cancelAtPeriodEnd),
    priceCents: row?.plan === "annual" ? PIKI_PASS_ANNUAL_CENTS : PIKI_PASS_MONTHLY_CENTS,
    freeDeliveryMinSubtotalCents: PIKI_PASS_FREE_DELIVERY_MIN_SUBTOTAL_CENTS,
    savings: { grossSavedCents, subscriptionPaidCents: hasTrial ? 0 : subscriptionPaidCents, netSavedCents: grossSavedCents - (hasTrial ? 0 : subscriptionPaidCents), orders: savingsRows.length },
  };
}

/**
 * Delivery benefit for a checkout: an active Pass removes the delivery fee on
 * orders above the minimum subtotal. Returns the fee to apply and the reason,
 * so the checkout breakdown can explain it instead of hiding it.
 */
export async function passDeliveryBenefit(input: { customerId?: string | null; subtotalCents: number; deliveryFeeCents: number; now?: Date }) {
  const fee = Math.max(0, Math.round(input.deliveryFeeCents));
  if (!input.customerId) return { applied: false, deliveryFeeCents: fee, reason: "NO_CUSTOMER" as const };
  const snapshot = await pikiPassSnapshot(input.customerId, input.now || new Date());
  if (!snapshot.active) return { applied: false, deliveryFeeCents: fee, reason: "NO_ACTIVE_PASS" as const };
  if (input.subtotalCents < PIKI_PASS_FREE_DELIVERY_MIN_SUBTOTAL_CENTS) return { applied: false, deliveryFeeCents: fee, reason: "BELOW_MIN_SUBTOTAL" as const };
  return { applied: true, deliveryFeeCents: 0, savedCents: fee, reason: "PIKI_PASS" as const };
}

/** Express-friendly payload for the Customer app. */
export async function pikiPassPayload(customerId: string) {
  const snapshot = await pikiPassSnapshot(customerId);
  const streak = await UserStreak.findOne({ customerId }).select("currentStreak longestStreak completedOrders").lean().exec() as any;
  return {
    ...snapshot,
    plans: PIKI_PASS_PLANS.map((plan) => ({ plan: plan.plan, label: plan.label, amountCents: plan.amountCents, interval: plan.interval, trialDays: plan.trialDays })),
    streak: { currentStreak: Number(streak?.currentStreak || 0), longestStreak: Number(streak?.longestStreak || 0), completedOrders: Number(streak?.completedOrders || 0) },
  };
}
