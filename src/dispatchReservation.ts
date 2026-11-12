import mongoose from "mongoose";
import { Order, Rider, RiderAssignmentReservation } from "./models.js";
import { confirmDispatchOnlineGuard, dispatchOrderIsOperational, dispatchRiderCas, loadDispatchOnlineGuard, type DispatchOnlineGuard } from "./dispatchOnlinePolicy.js";

/**
 * The unique order/slot indexes arbitrate reservations. Session/contract reads
 * and Rider CAS narrow races, but are not a multi-document atomic guarantee.
 */
export async function reserveRiderOrderSlot(
  riderId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId,
  tenantFilter: Record<string, unknown>,
  maxOrders = 1,
  riderFilter = tenantFilter,
  selectedGuard?: DispatchOnlineGuard,
) {
  const capacity = Math.min(2, Math.max(1, maxOrders));
  const order = await Order.findOne({ ...tenantFilter, _id: orderId, riderId: null,
    assignmentState: { $in: ["unassigned", "expired", "rejected"] } }).lean().exec() as any;
  if (!dispatchOrderIsOperational(order) || order.riderId
    || !["unassigned", "expired", "rejected"].includes(order.assignmentState)) return null;
  const guard = await loadDispatchOnlineGuard(riderId, order.tenantId, capacity,
    { sessionId: selectedGuard?.session._id });
  if (!guard) return null;
  const scoped = await Rider.exists({ ...riderFilter, ...dispatchRiderCas(guard) });
  if (!scoped) return null;
  const confirmed = await confirmDispatchOnlineGuard(guard);
  if (!confirmed) return null;
  guard.rider = confirmed;
  const existing = await RiderAssignmentReservation.find({ riderId, status: "reserved" }).lean().exec() as any[];
  if (existing.length >= capacity) return null;
  const occupied = new Set(existing.map((item) => item.slot));
  for (let slot = 1; slot <= capacity; slot += 1) {
    if (occupied.has(slot)) continue;
    try {
      const reservation = await RiderAssignmentReservation.findOneAndUpdate(
        { tenantId: order.tenantId, orderId, status: { $in: ["released", "completed", "cancelled"] } },
        { $set: { riderId, slot, mode: existing.length ? "saturated" : "normal", status: "reserved", expiresAt: null }, $setOnInsert: { orderId } },
        { upsert: true, new: true, runValidators: true },
      ).lean().exec() as any;
      if (!reservation) continue;
      const rider = await Rider.findOneAndUpdate(
        { ...riderFilter, ...dispatchRiderCas(guard) },
        { $set: { status: "busy", ...(guard.rider.activeOrderId == null ? { activeOrderId: orderId } : {}) } },
        { new: true },
      ).lean().exec() as any;
      if (!rider) {
        await RiderAssignmentReservation.updateOne({ _id: reservation._id, orderId, riderId, slot, status: "reserved" }, { $set: { status: "released" } }).exec();
        return null;
      }
      return { rider, reservation, onlineGuard: { ...guard, rider } };
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      if (await RiderAssignmentReservation.exists({ orderId, status: "reserved" })) return null;
    }
  }
  return null;
}

/** Confirm reservation ownership and the same frozen session before Order CAS. */
export async function confirmReservedDispatch(order: any, reserved: { reservation: any; onlineGuard: DispatchOnlineGuard }) {
  const guard = await loadDispatchOnlineGuard(reserved.onlineGuard.rider._id, order.tenantId, reserved.onlineGuard.capacity,
    { phase: "reserved", orderId: order._id, sessionId: reserved.onlineGuard.session._id });
  if (!guard || !(await confirmDispatchOnlineGuard(guard))) return false;
  return Boolean(await RiderAssignmentReservation.exists({ _id: reserved.reservation._id, tenantId: order.tenantId,
    orderId: order._id, riderId: guard.rider._id, slot: reserved.reservation.slot, status: "reserved" }));
}

/** Unlock only this link with snapshot CAS; never resurrect offline/paused/revoked Riders. */
export async function unlockReleasedRiderOrder(orderId: unknown, riderId: unknown) {
  const rider = await Rider.findOne({ _id: riderId }).lean().exec() as any;
  if (!rider) return;
  const [reservations, orders] = await Promise.all([
    RiderAssignmentReservation.find({ riderId, status: "reserved" }).lean().exec() as Promise<any[]>,
    Order.find({ riderId, assignmentState: { $in: ["offered", "assigned"] }, status: { $nin: ["delivered", "cancelled"] } })
      .select("_id").lean().exec() as Promise<any[]>,
  ]);
  const remaining = [...reservations.map((row) => row.orderId), ...orders.map((row) => row._id)]
    .filter((id) => String(id) !== String(orderId));
  const link = String(rider.activeOrderId) === String(orderId) ? remaining[0] ?? null : rider.activeOrderId ?? null;
  const online = ["available", "busy"].includes(rider.status) && rider.lifecycleStatus === "active"
    ? await loadDispatchOnlineGuard(riderId, rider.tenantId, 2, { phase: "release" }) : null;
  const status = online ? (remaining.length ? "busy" : "available") : rider.status;
  await Rider.updateOne({ _id: riderId, tenantId: rider.tenantId, status: rider.status,
    lifecycleStatus: rider.lifecycleStatus, email: rider.email, updatedAt: rider.updatedAt ?? null,
    activeOrderId: rider.activeOrderId ?? null }, { $set: { activeOrderId: link, status } }).exec();
}

export async function releaseRiderOrderSlot(orderId: mongoose.Types.ObjectId, riderId: mongoose.Types.ObjectId) {
  await RiderAssignmentReservation.updateOne({ orderId, riderId, status: "reserved" }, { $set: { status: "released" } }).exec();
  await unlockReleasedRiderOrder(orderId, riderId);
}
