import mongoose from "mongoose";
import { AccessAuthorization, GovernanceAuditEvent, Order, PartnerPayoutBatch, Restaurant, Rider, RiderPayoutBatch } from "./models.js";

export type GovernanceActor = {
  employeeId?: mongoose.Types.ObjectId | string | null;
  role?: string | null;
  tenantId?: mongoose.Types.ObjectId | string | null;
};

export async function recordGovernanceEvent(input: {
  actor: GovernanceActor;
  action: string;
  targetType: "restaurant" | "rider" | "employee" | "payout_batch" | "rider_payout_batch" | "system";
  targetId?: mongoose.Types.ObjectId | string | null;
  before?: unknown;
  after?: unknown;
  reason?: string;
}) {
  const actorId = input.actor.employeeId && mongoose.isValidObjectId(input.actor.employeeId) ? new mongoose.Types.ObjectId(String(input.actor.employeeId)) : null;
  const targetId = input.targetId && mongoose.isValidObjectId(input.targetId) ? new mongoose.Types.ObjectId(String(input.targetId)) : null;
  return GovernanceAuditEvent.create({
    tenantId: input.actor.tenantId && mongoose.isValidObjectId(input.actor.tenantId) ? new mongoose.Types.ObjectId(String(input.actor.tenantId)) : null,
    actorEmployeeId: actorId,
    actorRole: input.actor.role || "system",
    action: input.action,
    targetType: input.targetType,
    targetId,
    before: input.before ?? null,
    after: input.after ?? null,
    reason: input.reason || "",
  });
}

export function publicPartnerCode(id: unknown) {
  return `PIKI-P-${String(id).slice(-6).toUpperCase()}`;
}

export function publicRiderCode(id: unknown) {
  return `PIKI-R-${String(id).slice(-6).toUpperCase()}`;
}

export const payoutTransitions: Record<string, string[]> = {
  prepared: ["approved", "cancelled"],
  approved: ["paid", "failed", "cancelled"],
  failed: ["approved", "cancelled"],
  paid: [],
  cancelled: [],
};

export function canTransitionPayout(from: string, to: string) {
  return (payoutTransitions[from] || []).includes(to);
}

export async function markPartnerBatchPaid(input: { batchId: mongoose.Types.ObjectId; externalTransferId: string; actor: GovernanceActor; note?: string }) {
  const batch = await PartnerPayoutBatch.findOneAndUpdate(
    { _id: input.batchId, status: "approved", externalTransferId: null },
    { $set: { status: "paid", externalTransferId: input.externalTransferId.trim() } },
    { new: true },
  ).lean().exec() as any;
  if (!batch) throw new Error("PAYOUT_BATCH_NOT_APPROVED_OR_ALREADY_PAID");
  await Order.updateMany({ _id: { $in: batch.orderIds }, payoutBatchId: String(batch._id), payoutStatus: "eligible" }, { $set: { payoutStatus: "paid" } }).exec();
  await recordGovernanceEvent({ actor: input.actor, action: "partner_payout_paid", targetType: "payout_batch", targetId: batch._id, after: { status: "paid", externalTransferId: input.externalTransferId.trim(), amountCents: batch.amountCents }, reason: input.note || "Liquidación partner registrada por Finanzas." });
  return batch;
}

export async function markRiderBatchPaid(input: { batchId: mongoose.Types.ObjectId; externalTransferId: string; actor: GovernanceActor; note?: string }) {
  const batch = await RiderPayoutBatch.findOneAndUpdate(
    { _id: input.batchId, status: "approved", externalTransferId: null },
    { $set: { status: "paid", externalTransferId: input.externalTransferId.trim() } },
    { new: true },
  ).lean().exec() as any;
  if (!batch) throw new Error("RIDER_PAYOUT_BATCH_NOT_APPROVED_OR_ALREADY_PAID");
  await Order.updateMany({ _id: { $in: batch.orderIds }, riderPayoutBatchId: String(batch._id) }, { $set: { riderPayoutStatus: "paid" } }).exec();
  await recordGovernanceEvent({ actor: input.actor, action: "rider_payout_paid", targetType: "rider_payout_batch", targetId: batch._id, after: { status: "paid", externalTransferId: input.externalTransferId.trim(), amountCents: batch.amountCents }, reason: input.note || "Liquidación rider registrada por Finanzas." });
  return batch;
}

export async function syncPublicIds() {
  const restaurants = await Restaurant.find({ $or: [{ partnerCode: { $exists: false } }, { partnerCode: null }, { partnerCode: "" }] }).select("_id").lean().exec();
  for (const restaurant of restaurants) await Restaurant.updateOne({ _id: restaurant._id, $or: [{ partnerCode: { $exists: false } }, { partnerCode: null }, { partnerCode: "" }] }, { $set: { partnerCode: publicPartnerCode(restaurant._id) } }).exec();
  const riders = await Rider.find({ $or: [{ riderCode: { $exists: false } }, { riderCode: null }, { riderCode: "" }] }).select("_id").lean().exec();
  for (const rider of riders) await Rider.updateOne({ _id: rider._id, $or: [{ riderCode: { $exists: false } }, { riderCode: null }, { riderCode: "" }] }, { $set: { riderCode: publicRiderCode(rider._id) } }).exec();
  return { partners: restaurants.length, riders: riders.length };
}
