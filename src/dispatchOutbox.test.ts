import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_DISPATCH_LEASE_MS, InMemoryDispatchOutbox, dispatchInitialIdempotencyKey, dispatchRequeueIdempotencyKey, dispatchRetryDelayMs } from "./dispatchOutbox.js";

test("dispatch outbox is idempotent for the same order transition", () => {
  const outbox = new InMemoryDispatchOutbox();
  const key = dispatchInitialIdempotencyKey("507f1f77bcf86cd799439011");
  const first = outbox.enqueue({ orderId: "507f1f77bcf86cd799439011", idempotencyKey: key, reason: "cash_order_created" });
  const duplicate = outbox.enqueue({ orderId: "507f1f77bcf86cd799439011", idempotencyKey: key, reason: "cash_order_created" });
  assert.equal(first.eventId, duplicate.eventId);
  assert.equal(outbox.size(), 1);
});

test("Partner status transitions at the same order version have distinct but repeatable dispatch keys", () => {
  const orderId = "507f1f77bcf86cd799439011";
  const accepted = dispatchRequeueIdempotencyKey(orderId, 0, "partner_status_accepted");
  const preparing = dispatchRequeueIdempotencyKey(orderId, 0, "partner_status_preparing");
  assert.notEqual(accepted, preparing);
  assert.equal(accepted, dispatchRequeueIdempotencyKey(orderId, 0, "partner_status_accepted"));
  assert.equal(dispatchRequeueIdempotencyKey(orderId, 0), `dispatch:${orderId}:requeue:0`);
});

test("a live dispatch lease excludes a second worker from offering the same order", () => {
  const outbox = new InMemoryDispatchOutbox();
  const now = new Date("2026-10-12T00:00:00.000Z");
  outbox.enqueue({ orderId: "order-1", idempotencyKey: "dispatch:order-1:initial", availableAt: now });
  const workerA = outbox.claim("worker-a", now);
  const workerB = outbox.claim("worker-b", new Date(now.getTime() + 1));
  assert.equal(workerA?.leaseOwner, "worker-a");
  assert.equal(workerB, null);
});

test("an expired dispatch lease is reclaimable after worker loss", () => {
  const outbox = new InMemoryDispatchOutbox();
  const now = new Date("2026-10-12T00:00:00.000Z");
  outbox.enqueue({ orderId: "order-2", idempotencyKey: "dispatch:order-2:initial", availableAt: now });
  const first = outbox.claim("worker-a", now, DEFAULT_DISPATCH_LEASE_MS);
  assert.equal(first?.attempts, 1);
  const recovered = outbox.claim("worker-b", new Date(now.getTime() + DEFAULT_DISPATCH_LEASE_MS + 1), DEFAULT_DISPATCH_LEASE_MS);
  assert.equal(recovered?.leaseOwner, "worker-b");
  assert.equal(recovered?.attempts, 2);
});

test("dispatch retry backoff is bounded and exponential", () => {
  assert.equal(dispatchRetryDelayMs(1), 1_000);
  assert.equal(dispatchRetryDelayMs(4), 8_000);
  assert.equal(dispatchRetryDelayMs(99), 5 * 60_000);
});
