export type StripePaymentState = "authorized" | "paid" | "failed" | "refunded" | "expired";

export type StripeWebhookObject = {
  id?: string;
  object?: string;
  payment_intent?: string | { id?: string } | null;
  metadata?: Record<string, string> | null;
};

export type StripePaymentTransition = {
  paymentState: StripePaymentState;
  activatesOperationalIntake: boolean;
};

export function stripePaymentTransition(eventType: string): StripePaymentTransition | null {
  switch (eventType) {
    case "payment_intent.amount_capturable_updated":
      return { paymentState: "authorized", activatesOperationalIntake: true };
    case "payment_intent.succeeded":
    case "checkout.session.async_payment_succeeded":
      return { paymentState: "paid", activatesOperationalIntake: true };
    case "checkout.session.async_payment_failed":
    case "payment_intent.payment_failed":
      return { paymentState: "failed", activatesOperationalIntake: false };
    case "charge.refunded":
      return { paymentState: "refunded", activatesOperationalIntake: false };
    case "checkout.session.expired":
      return { paymentState: "expired", activatesOperationalIntake: false };
    default:
      return null;
  }
}

/** Returns the prior states that may transition to the webhook payment state. */
export function allowedPriorPaymentStates(next: StripePaymentState): string[] {
  switch (next) {
    case "authorized":
      return ["pending"];
    case "paid":
      // A later succeeded event repairs a previous asynchronous failure but can
      // never overwrite a refund.
      return ["pending", "authorized", "failed"];
    case "failed":
    case "expired":
      return ["pending"];
    case "refunded":
      return ["paid"];
  }
}

export function stripePaymentIntentId(object: StripeWebhookObject): string | undefined {
  if (object.object === "payment_intent" && typeof object.id === "string") return object.id;
  if (typeof object.payment_intent === "string") return object.payment_intent;
  if (object.payment_intent && typeof object.payment_intent.id === "string") return object.payment_intent.id;
  return undefined;
}

/**
 * A webhook is payment-only: it must never reopen an active/delivered order or
 * discard an assigned rider. Intake is only emitted while the order is still
 * the untouched operational pending state.
 */
export function shouldPublishOperationalIntake(order: any, transition: StripePaymentTransition): boolean {
  return transition.activatesOperationalIntake
    && order?.paymentMethod === "stripe"
    && ["authorized", "paid"].includes(String(order?.paymentState))
    && order?.status === "pending"
    && order?.assignmentState === "unassigned";
}
