import assert from "node:assert/strict";
import test from "node:test";
import { processStripeEvent } from "./stripe.js";
import { shouldPublishOperationalIntake, stripePaymentTransition } from "./stripeWebhookPolicy.js";

const event = (id: string, type: string, orderCode = "PIKI-TEST") => ({
  id,
  type,
  data: { object: { id: "pi_test_1", object: "payment_intent", metadata: { order_code: orderCode } } },
});

test("un webhook sólo queda procesado después de transición y outbox; un fallo se puede reintentar", async () => {
  const calls: string[] = [];
  const failedDependencies = {
    reserve: async () => "acquired" as const,
    applyPaymentTransition: async () => ({ order: { paymentMethod: "stripe", paymentState: "authorized", status: "pending", assignmentState: "unassigned" }, transitioned: true }),
    publishIntake: async () => { calls.push("outbox"); throw new Error("outbox unavailable"); },
    markProcessed: async () => { calls.push("processed"); },
    markFailed: async () => { calls.push("failed"); },
  };
  await assert.rejects(processStripeEvent(event("evt_retry", "payment_intent.amount_capturable_updated"), failedDependencies), /STRIPE_EVENT_PROCESSING_FAILED/);
  assert.deepEqual(calls, ["outbox", "failed"]);

  const retryCalls: string[] = [];
  const retryDependencies = {
    reserve: async () => "acquired" as const,
    applyPaymentTransition: async () => ({ order: { paymentMethod: "stripe", paymentState: "authorized", status: "pending", assignmentState: "unassigned" }, transitioned: false }),
    publishIntake: async () => { retryCalls.push("outbox"); },
    markProcessed: async () => { retryCalls.push("processed"); },
    markFailed: async () => { retryCalls.push("failed"); },
  };
  const result = await processStripeEvent(event("evt_retry", "payment_intent.amount_capturable_updated"), retryDependencies);
  assert.equal(result.activated, true);
  assert.deepEqual(retryCalls, ["outbox", "processed"]);
});

test("un duplicado procesado no repite transición ni outbox", async () => {
  const result = await processStripeEvent(event("evt_duplicate", "payment_intent.succeeded"), {
    reserve: async () => "processed" as const,
    applyPaymentTransition: async () => { throw new Error("must not apply"); },
    publishIntake: async () => { throw new Error("must not publish"); },
    markProcessed: async () => { throw new Error("must not mark"); },
    markFailed: async () => { throw new Error("must not mark"); },
  });
  assert.deepEqual(result, { duplicate: true, eventType: "payment_intent.succeeded", orderCode: "PIKI-TEST", activated: false });
});

test("eventos fuera de orden no reinician operación ni reabren un pedido entregado", () => {
  assert.equal(stripePaymentTransition("payment_intent.payment_failed")?.paymentState, "failed");
  assert.equal(stripePaymentTransition("payment_intent.succeeded")?.paymentState, "paid");
  const paid = stripePaymentTransition("payment_intent.succeeded");
  assert.ok(paid);
  assert.equal(shouldPublishOperationalIntake({ paymentMethod: "stripe", paymentState: "paid", status: "on_the_way", assignmentState: "assigned", riderId: "rider-1" }, paid), false);
  assert.equal(shouldPublishOperationalIntake({ paymentMethod: "stripe", paymentState: "paid", status: "pending", assignmentState: "unassigned" }, paid), true);
});
