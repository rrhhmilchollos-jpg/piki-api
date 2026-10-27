import { z } from "zod";

export const DELIVERY_CREDENTIAL_FAILURE_LIMIT = 5;
export const DELIVERY_CREDENTIAL_FAILURE_WINDOW_MS = 15 * 60_000;

const confirmationSchema = z.object({
  // New clients may name the credential and method. Legacy clients keep using deliveryQr.
  method: z.enum(["pin", "qr"]).optional(),
  credential: z.string().trim().min(1).max(4096).optional(),
  deliveryQr: z.string().trim().min(1).max(4096).optional(),
  idempotencyKey: z.string().trim().min(8).max(160).optional(),
}).superRefine((value, ctx) => {
  if (!value.credential && !value.deliveryQr) ctx.addIssue({ code: "custom", message: "credential_required" });
  if (value.credential && value.deliveryQr) ctx.addIssue({ code: "custom", message: "single_credential_required" });
});

export type DeliveryCredential = { method: "pin" | "qr"; credential: string; idempotencyKey: string | null; legacy: boolean };

export function parseDeliveryCredential(body: unknown): DeliveryCredential | null {
  const parsed = confirmationSchema.safeParse(body);
  if (!parsed.success) return null;
  const credential = parsed.data.credential || parsed.data.deliveryQr || "";
  const inferred = /^https?:\/\//i.test(credential) ? "qr" : "pin";
  if (parsed.data.method && parsed.data.method !== inferred) return null;
  return {
    method: parsed.data.method || inferred,
    credential,
    idempotencyKey: parsed.data.idempotencyKey || null,
    legacy: Boolean(parsed.data.deliveryQr),
  };
}

export type DeliveryFailureState = { count?: number; windowStartedAt?: Date | string | null; lockedUntil?: Date | string | null } | null | undefined;

export function deliveryFailureLock(state: DeliveryFailureState, now = new Date()) {
  const lockedUntil = state?.lockedUntil ? new Date(state.lockedUntil) : null;
  return lockedUntil && lockedUntil.getTime() > now.getTime() ? lockedUntil : null;
}

export function nextDeliveryFailureState(state: DeliveryFailureState, now = new Date()) {
  const priorStart = state?.windowStartedAt ? new Date(state.windowStartedAt) : null;
  const inWindow = Boolean(priorStart && now.getTime() - priorStart.getTime() < DELIVERY_CREDENTIAL_FAILURE_WINDOW_MS);
  const count = (inWindow ? Number(state?.count || 0) : 0) + 1;
  const windowStartedAt = inWindow && priorStart ? priorStart : now;
  const lockedUntil = count >= DELIVERY_CREDENTIAL_FAILURE_LIMIT ? new Date(now.getTime() + DELIVERY_CREDENTIAL_FAILURE_WINDOW_MS) : null;
  return { count, windowStartedAt, lockedUntil };
}

/** Mongo predicate shared by failure increment and valid-credential reset. */
export function deliveryCredentialNotLockedFilter(now = new Date()) {
  return {
    $or: [
      { "deliveryCredentialFailures.lockedUntil": null },
      { "deliveryCredentialFailures.lockedUntil": { $exists: false } },
      { "deliveryCredentialFailures.lockedUntil": { $lte: now } },
    ],
  };
}

/**
 * Aggregation update pipeline: MongoDB evaluates the current document and
 * writes the next counter/lock in one operation, so concurrent failures never
 * overwrite each other's count or a newly-created lock.
 */
export function deliveryFailureAtomicUpdate(now = new Date()): Record<string, unknown>[] {
  const windowStart = new Date(now.getTime() - DELIVERY_CREDENTIAL_FAILURE_WINDOW_MS);
  const lockedUntil = new Date(now.getTime() + DELIVERY_CREDENTIAL_FAILURE_WINDOW_MS);
  return [{
    $set: {
      deliveryCredentialFailures: {
        $let: {
          vars: { prior: { $ifNull: ["$deliveryCredentialFailures", {}] } },
          in: {
            $let: {
              vars: {
                inWindow: {
                  $and: [
                    { $ne: [{ $ifNull: ["$$prior.windowStartedAt", null] }, null] },
                    { $gt: ["$$prior.windowStartedAt", windowStart] },
                  ],
                },
              },
              in: {
                $let: {
                  vars: {
                    nextCount: { $add: [{ $cond: ["$$inWindow", { $ifNull: ["$$prior.count", 0] }, 0] }, 1] },
                    nextWindowStartedAt: { $cond: ["$$inWindow", "$$prior.windowStartedAt", now] },
                  },
                  in: {
                    count: "$$nextCount",
                    windowStartedAt: "$$nextWindowStartedAt",
                    lockedUntil: { $cond: [{ $gte: ["$$nextCount", DELIVERY_CREDENTIAL_FAILURE_LIMIT] }, lockedUntil, null] },
                  },
                },
              },
            },
          },
        },
      },
    },
  }];
}

export function deliveredConfirmationResponse(order: any, idempotent: boolean, gpsDistanceMeters: number | null = null, gpsOutsideConfiguredRadius = false) {
  return {
    message: order.paymentMethod === "cash" ? "Entrega confirmada y efectivo registrado en cartera." : "Entrega confirmada.",
    idempotent,
    chatPurged: true,
    gpsDistanceMeters,
    gpsOutsideConfiguredRadius,
    order: {
      id: order._id,
      publicCode: order.publicCode,
      status: order.status,
      deliveredAt: order.deliveredAt,
      paymentMethod: order.paymentMethod,
      cashCollected: Boolean(order.cashCollectedAt),
    },
  };
}
