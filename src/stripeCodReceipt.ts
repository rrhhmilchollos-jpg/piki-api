import { StripeEvent } from "./models.js";

const PROCESSING_LEASE_MS = 5 * 60_000;

/** Uses the same event-id namespace as Checkout; never resets acknowledged receipts. */
export async function claimCodStripeEvent(event: { id: string; type: string }): Promise<Date | "processed"> {
  const startedAt = new Date();
  try {
    await StripeEvent.create({
      stripeEventId: event.id, type: event.type, orderCode: null,
      processingStatus: "processing", processingStartedAt: startedAt,
    });
    return startedAt;
  } catch (error: any) {
    if (error?.code !== 11000) throw error;
  }
  const reclaimed = await StripeEvent.findOneAndUpdate(
    {
      stripeEventId: event.id,
      type: event.type,
      $or: [
        { processingStatus: "failed" },
        { processingStatus: "processing", processingStartedAt: { $lte: new Date(Date.now() - PROCESSING_LEASE_MS) } },
      ],
    },
    { $set: { processingStatus: "processing", processingStartedAt: startedAt, processedAt: null, failedAt: null, lastError: null } },
    { new: true },
  ).lean().exec();
  if (reclaimed) return startedAt;
  const existing = await StripeEvent.findOne({ stripeEventId: event.id }).select("type processingStatus").lean().exec() as any;
  if (!existing || existing.type !== event.type) throw new Error("COD_STRIPE_RECEIPT_CONFLICT");
  if (existing.processingStatus === "processing" || existing.processingStatus === "failed") throw new Error("COD_STRIPE_EVENT_IN_PROGRESS");
  // Historical receipts with no processingStatus were already acknowledged.
  return "processed";
}

/** Fence completion/failure: an expired attempt cannot mark a newer lease. */
export async function finishCodStripeEvent(id: string, startedAt: Date, error?: unknown): Promise<void> {
  const result = await StripeEvent.updateOne(
    { stripeEventId: id, processingStatus: "processing", processingStartedAt: startedAt },
    { $set: error === undefined
      ? { processingStatus: "processed", processedAt: new Date(), failedAt: null, lastError: null }
      : { processingStatus: "failed", failedAt: new Date(), lastError: (error instanceof Error ? error.name : "UnknownError").slice(0, 120) } },
  ).exec();
  if (result.matchedCount !== 1) throw new Error("COD_STRIPE_LEASE_LOST");
}
