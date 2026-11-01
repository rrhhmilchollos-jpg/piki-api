import { Order } from "./models.js";

/**
 * Zombie orders: orders that entered the operational flow and never reached a
 * terminal state. They keep showing in the Customer app as "active", block the
 * Partner kitchen board and inflate dispatch metrics, so they must be closed by
 * the system instead of waiting for a human.
 *
 * Closing is deliberately conservative:
 *  - only orders without a Rider assigned are auto-closed, because a rider in
 *    the street is an operational signal, not a bug;
 *  - the customer is compensated through the cancellation reason, never by
 *    marking the order as delivered (which would settle money that never moved);
 *  - QA orders are excluded.
 */

export const ZOMBIE_ORDER_MAX_AGE_MS = 2 * 60 * 60 * 1_000;

export const ZOMBIE_ORDER_STATUSES = ["pending", "accepted", "preparing", "ready_for_pickup"] as const;

export type ZombieCandidate = {
  status?: string | null;
  createdAt?: Date | string | null;
  riderId?: unknown;
  isTestOrder?: boolean | null;
  archivedAt?: Date | string | null;
  deliveredAt?: Date | string | null;
  cancelledAt?: Date | string | null;
  paymentState?: string | null;
};

/** Pure predicate, so the policy is testable without a database. */
export function isZombieOrder(order: ZombieCandidate, now: Date = new Date(), maxAgeMs: number = ZOMBIE_ORDER_MAX_AGE_MS): boolean {
  if (!order) return false;
  if (order.isTestOrder) return false;
  if (order.riderId) return false;
  if (order.archivedAt || order.deliveredAt || order.cancelledAt) return false;
  if (!ZOMBIE_ORDER_STATUSES.includes(String(order.status) as (typeof ZOMBIE_ORDER_STATUSES)[number])) return false;
  const createdAt = order.createdAt ? new Date(order.createdAt) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return false;
  return now.getTime() - createdAt.getTime() >= maxAgeMs;
}

export type ZombieCloseResult = { closed: number; dryRun: boolean; orderIds: string[] };

/**
 * Closes zombie orders. `dryRun` defaults to true: the maintenance sweep can
 * count candidates in production for a while before it is allowed to write.
 * The operator enables writes with PIKI_ZOMBIE_ORDERS_ENFORCE=true.
 */
export async function closeZombieOrders(input: { now?: Date; maxAgeMs?: number; dryRun?: boolean; limit?: number } = {}): Promise<ZombieCloseResult> {
  const now = input.now || new Date();
  const maxAgeMs = input.maxAgeMs ?? ZOMBIE_ORDER_MAX_AGE_MS;
  const dryRun = input.dryRun ?? String(process.env.PIKI_ZOMBIE_ORDERS_ENFORCE || "").toLowerCase() !== "true";
  const cutoff = new Date(now.getTime() - maxAgeMs);

  const candidates = await Order.find({
    status: { $in: [...ZOMBIE_ORDER_STATUSES] },
    createdAt: { $lt: cutoff },
    riderId: null,
    archivedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    isTestOrder: { $ne: true },
  }).select("_id status createdAt paymentState totalCents").sort({ createdAt: 1 }).limit(Math.max(1, Math.min(200, input.limit || 50))).lean().exec() as any[];

  const eligible = candidates.filter((order) => isZombieOrder(order, now, maxAgeMs));
  const orderIds = eligible.map((order) => String(order._id));

  if (!eligible.length) return { closed: 0, dryRun, orderIds };
  if (dryRun) {
    console.log(JSON.stringify({ event: "zombie_orders_detected", count: eligible.length, maxAgeMs, orderIds }));
    return { closed: 0, dryRun, orderIds };
  }

  let closed = 0;
  for (const order of eligible) {
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: order.status, riderId: null, archivedAt: null, deliveredAt: null, cancelledAt: null },
      {
        $set: {
          status: "cancelled",
          cancelledAt: now,
          archivedAt: now,
          cancellationReason: "automatic_zombie_timeout",
          cancellationSource: "system",
          customerVisibleNote: "Hemos cerrado este pedido automáticamente porque el establecimiento no pudo completarlo. No se ha realizado ningún cargo.",
        },
        $inc: { version: 1 },
      },
      { new: true },
    ).lean().exec() as any;
    if (!updated) continue;
    closed += 1;
    console.log(JSON.stringify({ event: "zombie_order_closed", orderId: String(order._id), publicCode: updated.publicCode || null, previousStatus: order.status, paymentState: order.paymentState || null }));
  }

  return { closed, dryRun, orderIds };
}

/** Stats shape merged into the automatic dispatch sweep log. */
export type ZombieCloseStats = { closedZombieOrders: number; zombieCandidates: number; zombieMode: "dry_run" | "enforce" };

export async function runZombieOrderMaintenance(now: Date = new Date()): Promise<ZombieCloseStats> {
  const result = await closeZombieOrders({ now });
  return {
    closedZombieOrders: result.closed,
    zombieCandidates: result.orderIds.length,
    zombieMode: result.dryRun ? "dry_run" : "enforce",
  };
}
