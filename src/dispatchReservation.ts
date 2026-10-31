import mongoose from "mongoose";
import { Rider, RiderAssignmentReservation } from "./models.js";

const MAX_RIDER_ACTIVE_ORDERS = 2;

/**
 * There is exactly one reservation document per order. Reuse it after release
 * rather than inserting another one, which would violate the unique orderId
 * index. The partial unique (riderId, status, slot) index arbitrates competing
 * workers; a losing worker may try another free slot but never steals an
 * already-reserved order.
 */
export async function reserveRiderOrderSlot(
  riderId: mongoose.Types.ObjectId,
  orderId: mongoose.Types.ObjectId,
  tenantFilter: Record<string, unknown>,
  maxOrders = 1,
  riderFilter = tenantFilter,
) {
  const capacity = Math.min(MAX_RIDER_ACTIVE_ORDERS, Math.max(1, maxOrders));
  const existing = await RiderAssignmentReservation.find({ riderId, status: "reserved" }).select("slot").lean().exec() as unknown as Array<{ slot: number }>;
  if (existing.length >= capacity) return null;
  const occupied = new Set(existing.map((item) => item.slot));

  for (let slot = 1; slot <= capacity; slot += 1) {
    if (occupied.has(slot)) continue;
    try {
      const reservation = await RiderAssignmentReservation.findOneAndUpdate(
        { ...tenantFilter, orderId, status: { $in: ["released", "completed", "cancelled"] } },
        { $set: { riderId, slot, mode: existing.length ? "saturated" : "normal", status: "reserved", expiresAt: null }, $setOnInsert: { orderId } },
        { upsert: true, new: true, runValidators: true },
      ).lean().exec() as any;
      if (!reservation) continue;
      const rider = await Rider.findOneAndUpdate(
        { ...riderFilter, _id: riderId, status: { $in: ["available", "busy"] }, ...(existing.length === 0 ? { activeOrderId: null } : {}) },
        { $set: { status: "busy", ...(existing.length === 0 ? { activeOrderId: orderId } : {}) } },
        { new: true },
      ).lean().exec() as any;
      if (!rider) {
        await RiderAssignmentReservation.updateOne({ _id: reservation._id, orderId, riderId, slot, status: "reserved" }, { $set: { status: "released" } }).exec();
        return null;
      }
      return { rider, reservation };
    } catch (error: any) {
      if (error?.code !== 11000) throw error;
      // A competing worker can already own this order. Do not disturb it.
      if (await RiderAssignmentReservation.exists({ orderId, status: "reserved" })) return null;
      // Otherwise the slot was taken concurrently. Try the remaining slot.
    }
  }
  return null;
}
