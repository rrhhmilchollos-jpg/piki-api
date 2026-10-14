import mongoose from "mongoose";
import { MarketplaceLedgerEntry, Order, PartnerPayoutBatch } from "./models.js";

export type LedgerOrder = {
  _id: mongoose.Types.ObjectId | string;
  tenantId?: mongoose.Types.ObjectId | string | null;
  restaurantId: mongoose.Types.ObjectId | string;
  publicCode: string;
  totalCents: number;
  partnerPayoutCents: number;
  riderEarningsCents: number;
  marketplaceCommissionCents: number;
  deliveryFeeCents: number;
  serviceFeeCents: number;
  paymentState: string;
};

const positive = (value: unknown, name: string) => {
  const result = Math.round(Number(value || 0));
  if (!Number.isFinite(result) || result < 0) throw new Error(`INVALID_LEDGER_AMOUNT:${name}`);
  return result;
};

/** Posts the delivery settlement once. Replays are safe through unique keys. */
export async function postMarketplaceOrderLedger(order: LedgerOrder) {
  if (order.paymentState !== "paid") return { posted: false, reason: "PAYMENT_NOT_PAID" as const };
  const total = positive(order.totalCents, "total");
  const partner = positive(order.partnerPayoutCents, "partner");
  const rider = positive(order.riderEarningsCents, "rider");
  const commission = positive(order.marketplaceCommissionCents, "commission");
  const fees = positive(order.deliveryFeeCents, "delivery") + positive(order.serviceFeeCents, "service");
  const platformNet = commission + fees - rider;
  if (partner + rider + platformNet !== total || platformNet < 0) throw new Error("LEDGER_ORDER_DOES_NOT_BALANCE");
  const orderId = new mongoose.Types.ObjectId(String(order._id));
  const common = { tenantId: order.tenantId || null, orderId, restaurantId: order.restaurantId, currency: "eur", source: "order_delivery" };
  const entries = [
    { ...common, accountType: "customer_cash", direction: "debit", amountCents: total, reason: "order_collected", idempotencyKey: `order:${order.publicCode}:customer` },
    { ...common, accountType: "partner_payable", direction: "credit", amountCents: partner, reason: "partner_sale_payable", idempotencyKey: `order:${order.publicCode}:partner` },
    { ...common, accountType: "rider_payable", direction: "credit", amountCents: rider, reason: "rider_delivery_payable", idempotencyKey: `order:${order.publicCode}:rider` },
    { ...common, accountType: "platform_revenue", direction: "credit", amountCents: platformNet, reason: "platform_marketplace_revenue", idempotencyKey: `order:${order.publicCode}:platform` },
  ];
  for (const entry of entries) await MarketplaceLedgerEntry.updateOne({ idempotencyKey: entry.idempotencyKey }, { $setOnInsert: entry }, { upsert: true }).exec();
  await Order.updateOne({ _id: orderId }, { $set: { payoutStatus: "eligible" } }).exec();
  return { posted: true, orderId: String(orderId), entries: entries.length, partnerPayoutCents: partner, riderEarningsCents: rider };
}

export async function preparePartnerPayoutBatch(input: { restaurantId: mongoose.Types.ObjectId; startsAt: Date; endsAt: Date; tenantId?: mongoose.Types.ObjectId | null }) {
  const orders = await Order.find({ restaurantId: input.restaurantId, ...(input.tenantId ? { tenantId: input.tenantId } : {}), status: "delivered", paymentState: "paid", payoutStatus: "eligible", deliveredAt: { $gte: input.startsAt, $lt: input.endsAt } }).select("_id publicCode partnerPayoutCents").lean().exec() as any[];
  const amountCents = orders.reduce((sum, order) => sum + positive(order.partnerPayoutCents, "partner"), 0);
  const key = `partner:${String(input.restaurantId)}:${input.startsAt.toISOString()}:${input.endsAt.toISOString()}`;
  const batch = await PartnerPayoutBatch.findOneAndUpdate({ idempotencyKey: key }, { $setOnInsert: { ...input, orderIds: orders.map(order => order._id), amountCents, currency: "eur", status: "prepared", idempotencyKey: key } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
  return { batch, orderCount: orders.length, amountCents };
}
