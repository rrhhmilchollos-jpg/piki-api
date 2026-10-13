import { randomUUID } from "node:crypto";
import mongoose, { type ClientSession } from "mongoose";
import { DispatchOutbox } from "./models.js";

export const DISPATCH_OUTBOX_TYPE = "dispatch.order.ready" as const;
export const DISPATCH_OUTBOX_PAYLOAD_VERSION = 1;
export const DEFAULT_DISPATCH_LEASE_MS = 30_000;
export const DEFAULT_DISPATCH_MAX_ATTEMPTS = 8;

export type DispatchOutboxStatus = "pending" | "processing" | "retry" | "processed" | "dead_letter";
export type DispatchOutboxEvent = {
  _id: unknown;
  eventId: string;
  orderId: unknown;
  tenantId?: unknown;
  type: typeof DISPATCH_OUTBOX_TYPE;
  payloadVersion: number;
  payload: { preferredRiderId?: string; reason?: string };
  idempotencyKey: string;
  availableAt: Date;
  attempts: number;
  status: DispatchOutboxStatus;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
  lastError?: string | null;
};

export type DispatchOutboxEnqueueInput = {
  orderId: string | mongoose.Types.ObjectId;
  tenantId?: string | mongoose.Types.ObjectId | null;
  /** Stable per transition. Duplicated delivery of the same transition is a no-op. */
  idempotencyKey: string;
  preferredRiderId?: string | mongoose.Types.ObjectId | null;
  reason?: string;
  availableAt?: Date;
  session?: ClientSession;
};

export function dispatchInitialIdempotencyKey(orderId: string | mongoose.Types.ObjectId) {
  return `dispatch:${String(orderId)}:initial`;
}

export function dispatchRequeueIdempotencyKey(orderId: string | mongoose.Types.ObjectId, version: number) {
  return `dispatch:${String(orderId)}:requeue:${version}`;
}

function objectIdOrNull(value: string | mongoose.Types.ObjectId | null | undefined) {
  if (!value) return null;
  return value instanceof mongoose.Types.ObjectId ? value : mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;
}

/**
 * Persists the dispatch intent before a worker is allowed to offer a rider.
 * Callers that change an Order must pass their Mongo session so both writes are
 * committed or aborted together.
 */
export async function enqueueDispatchOutbox(input: DispatchOutboxEnqueueInput) {
  const orderId = objectIdOrNull(input.orderId);
  if (!orderId) throw new Error("DISPATCH_OUTBOX_INVALID_ORDER_ID");
  const tenantId = objectIdOrNull(input.tenantId);
  const now = new Date();
  const insert = {
    eventId: randomUUID(),
    orderId,
    tenantId,
    type: DISPATCH_OUTBOX_TYPE,
    payloadVersion: DISPATCH_OUTBOX_PAYLOAD_VERSION,
    payload: {
      ...(input.preferredRiderId ? { preferredRiderId: String(input.preferredRiderId) } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 120) } : {}),
    },
    idempotencyKey: input.idempotencyKey,
    availableAt: input.availableAt || now,
    attempts: 0,
    status: "pending" as const,
    leaseOwner: null,
    leaseUntil: null,
    lastError: null,
  };
  await DispatchOutbox.updateOne(
    { idempotencyKey: input.idempotencyKey },
    { $setOnInsert: insert },
    { upsert: true, ...(input.session ? { session: input.session } : {}) },
  ).exec();
  return DispatchOutbox.findOne({ idempotencyKey: input.idempotencyKey }, null, input.session ? { session: input.session } : undefined).lean().exec() as Promise<DispatchOutboxEvent | null>;
}

export function dispatchOutboxClaimFilter(now: Date) {
  return {
    status: { $in: ["pending", "retry", "processing"] },
    availableAt: { $lte: now },
    $or: [
      { leaseUntil: null },
      { leaseUntil: { $exists: false } },
      { leaseUntil: { $lte: now } },
    ],
  };
}

/** Atomically claims one available event; an expired lease is intentionally reclaimable. */
export async function claimDispatchOutboxEvent(workerId: string, options: { now?: Date; leaseMs?: number } = {}) {
  const now = options.now || new Date();
  const leaseMs = options.leaseMs || DEFAULT_DISPATCH_LEASE_MS;
  return DispatchOutbox.findOneAndUpdate(
    dispatchOutboxClaimFilter(now),
    {
      $set: {
        status: "processing",
        leaseOwner: workerId,
        leaseUntil: new Date(now.getTime() + leaseMs),
        lastError: null,
      },
      $inc: { attempts: 1 },
    },
    { sort: { availableAt: 1, createdAt: 1 }, new: true },
  ).lean().exec() as Promise<DispatchOutboxEvent | null>;
}

export function dispatchRetryDelayMs(attempt: number) {
  // Bounded exponential backoff: 1s, 2s, 4s … 5 min. No jitter is used here
  // so recovery remains deterministic and observable from the persisted event.
  return Math.min(5 * 60_000, 1_000 * (2 ** Math.max(0, attempt - 1)));
}

export async function markDispatchOutboxProcessed(event: DispatchOutboxEvent, workerId: string) {
  const result = await DispatchOutbox.updateOne(
    { _id: event._id, status: "processing", leaseOwner: workerId },
    { $set: { status: "processed", processedAt: new Date(), leaseOwner: null, leaseUntil: null, lastError: null } },
  ).exec();
  return result.modifiedCount === 1;
}

export async function rescheduleDispatchOutboxEvent(event: DispatchOutboxEvent, workerId: string, error: unknown, maxAttempts = DEFAULT_DISPATCH_MAX_ATTEMPTS) {
  const message = (error instanceof Error ? error.message : String(error || "DISPATCH_FAILED")).slice(0, 1000);
  const deadLetter = event.attempts >= maxAttempts;
  const result = await DispatchOutbox.updateOne(
    { _id: event._id, status: "processing", leaseOwner: workerId },
    {
      $set: deadLetter
        ? { status: "dead_letter", deadLetteredAt: new Date(), leaseOwner: null, leaseUntil: null, lastError: message }
        : { status: "retry", availableAt: new Date(Date.now() + dispatchRetryDelayMs(event.attempts)), leaseOwner: null, leaseUntil: null, lastError: message },
    },
  ).exec();
  return { updated: result.modifiedCount === 1, deadLetter };
}

export async function processDispatchOutboxBatch(
  workerId: string,
  handler: (event: DispatchOutboxEvent) => Promise<void>,
  options: { batchSize?: number; leaseMs?: number; maxAttempts?: number } = {},
) {
  let processed = 0;
  let deadLettered = 0;
  const batchSize = options.batchSize || 25;
  for (let index = 0; index < batchSize; index += 1) {
    const event = await claimDispatchOutboxEvent(workerId, { leaseMs: options.leaseMs });
    if (!event) break;
    try {
      await handler(event);
      await markDispatchOutboxProcessed(event, workerId);
      processed += 1;
    } catch (error) {
      const outcome = await rescheduleDispatchOutboxEvent(event, workerId, error, options.maxAttempts);
      if (outcome.deadLetter) deadLettered += 1;
    }
  }
  return { processed, deadLettered };
}

/**
 * Small deterministic model used only by unit tests. It mirrors the unique
 * idempotency key and lease rules enforced by MongoDB above without requiring
 * a running database in the TypeScript test suite.
 */
export class InMemoryDispatchOutbox {
  private readonly events = new Map<string, DispatchOutboxEvent>();

  enqueue(input: Omit<DispatchOutboxEnqueueInput, "session">) {
    const existing = this.events.get(input.idempotencyKey);
    if (existing) return existing;
    const event: DispatchOutboxEvent = {
      _id: input.idempotencyKey,
      eventId: `memory:${this.events.size + 1}`,
      orderId: String(input.orderId),
      tenantId: input.tenantId || null,
      type: DISPATCH_OUTBOX_TYPE,
      payloadVersion: DISPATCH_OUTBOX_PAYLOAD_VERSION,
      payload: { ...(input.preferredRiderId ? { preferredRiderId: String(input.preferredRiderId) } : {}), ...(input.reason ? { reason: input.reason } : {}) },
      idempotencyKey: input.idempotencyKey,
      availableAt: input.availableAt || new Date(),
      attempts: 0,
      status: "pending",
      leaseOwner: null,
      leaseUntil: null,
      lastError: null,
    };
    this.events.set(input.idempotencyKey, event);
    return event;
  }

  claim(workerId: string, now: Date, leaseMs = DEFAULT_DISPATCH_LEASE_MS) {
    const event = [...this.events.values()]
      .filter((candidate) => ["pending", "retry", "processing"].includes(candidate.status) && candidate.availableAt <= now && (!candidate.leaseUntil || candidate.leaseUntil <= now))
      .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())[0];
    if (!event) return null;
    event.status = "processing";
    event.leaseOwner = workerId;
    event.leaseUntil = new Date(now.getTime() + leaseMs);
    event.attempts += 1;
    return event;
  }

  size() { return this.events.size; }
}
