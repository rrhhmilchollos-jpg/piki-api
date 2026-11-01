import mongoose, { Schema } from "mongoose";
import { CustomerAccount, Order } from "./models.js";

const userStreakSchema = new Schema({
  customerId: { type: String, required: true, unique: true, index: true },
  currentStreak: { type: Number, default: 0, min: 0 },
  longestStreak: { type: Number, default: 0, min: 0 },
  completedOrders: { type: Number, default: 0, min: 0 },
  lastCompletedAt: { type: Date, default: null },
  lastCompletedOrderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
}, { timestamps: true, collection: "user_streaks" });

const badgeSchema = new Schema({
  slug: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  description: { type: String, required: true },
  criterion: { type: String, enum: ["completed_orders", "streak_days"], required: true },
  threshold: { type: Number, required: true, min: 1 },
  active: { type: Boolean, default: true, index: true },
}, { timestamps: true, collection: "badges" });

const customerBadgeSchema = new Schema({
  customerId: { type: String, required: true, index: true },
  badgeSlug: { type: String, required: true, index: true },
  awardedAt: { type: Date, default: Date.now },
  sourceOrderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
}, { timestamps: true, collection: "customer_badges" });
customerBadgeSchema.index({ customerId: 1, badgeSlug: 1 }, { unique: true });

const pikiPassSubscriptionSchema = new Schema({
  customerId: { type: String, required: true, unique: true, index: true },
  plan: { type: String, enum: ["monthly", "annual"], required: true },
  status: { type: String, enum: ["active", "paused", "cancelled", "expired"], default: "active", index: true },
  startedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true, index: true },
  stripeSubscriptionId: { type: String, default: null, index: true },
}, { timestamps: true, collection: "piki_pass_subscriptions" });

const referralRewardSchema = new Schema({
  inviterCustomerId: { type: String, required: true, index: true },
  invitedCustomerId: { type: String, required: true, unique: true, index: true },
  referralCode: { type: String, required: true, index: true },
  status: { type: String, enum: ["pending", "earned", "paid", "cancelled"], default: "pending", index: true },
  qualifyingOrderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
  rewardCents: { type: Number, default: 150, min: 0 },
  earnedAt: { type: Date, default: null },
}, { timestamps: true, collection: "customer_referral_rewards" });

const recommendationProfileSchema = new Schema({
  customerId: { type: String, required: true, unique: true, index: true },
  preferredRestaurantIds: { type: [Schema.Types.ObjectId], default: [] },
  preferredCategories: { type: [String], default: [] },
  orderCount: { type: Number, default: 0, min: 0 },
  lastComputedAt: { type: Date, default: null },
  modelVersion: { type: String, default: "rules-v1" },
}, { timestamps: true, collection: "customer_recommendation_profiles" });

const customerOrderCompletionSchema = new Schema({
  customerId: { type: String, required: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true, index: true },
  completedAt: { type: Date, required: true },
}, { timestamps: true, collection: "customer_order_completions" });

export const UserStreak = mongoose.models.UserStreak || mongoose.model("UserStreak", userStreakSchema);
export const Badge = mongoose.models.Badge || mongoose.model("Badge", badgeSchema);
export const CustomerBadge = mongoose.models.CustomerBadge || mongoose.model("CustomerBadge", customerBadgeSchema);
export const PikiPassSubscription = mongoose.models.PikiPassSubscription || mongoose.model("PikiPassSubscription", pikiPassSubscriptionSchema);
export const ReferralReward = mongoose.models.ReferralReward || mongoose.model("ReferralReward", referralRewardSchema);
export const RecommendationProfile = mongoose.models.RecommendationProfile || mongoose.model("RecommendationProfile", recommendationProfileSchema);
export const CustomerOrderCompletion = mongoose.models.CustomerOrderCompletion || mongoose.model("CustomerOrderCompletion", customerOrderCompletionSchema);

export const DEFAULT_BADGES = [
  { slug: "first-order", name: "Primer pedido", description: "Has completado tu primer pedido en PIKI.", criterion: "completed_orders", threshold: 1 },
  { slug: "five-orders", name: "Cliente habitual", description: "Has completado cinco pedidos.", criterion: "completed_orders", threshold: 5 },
  { slug: "streak-3", name: "Racha de 3", description: "Has pedido tres días consecutivos.", criterion: "streak_days", threshold: 3 },
  { slug: "streak-7", name: "Racha de 7", description: "Has pedido siete días consecutivos.", criterion: "streak_days", threshold: 7 },
] as const;

export const COMMON_WHEEL_REWARD_CENTS = 150;
export function resolveWheelReward(randomValue = Math.random()) {
  const normalized = Number(randomValue);
  if (!Number.isFinite(normalized)) return 0;
  return normalized >= 0 && normalized < 0.6 ? COMMON_WHEEL_REWARD_CENTS : 0;
}

export type PriceBreakdownInput = { subtotalCents: number; deliveryFeeCents: number; serviceFeeCents: number; discountCents?: number; tipCents?: number };
export function calculatePriceBreakdown(input: PriceBreakdownInput) {
  const subtotalCents = Math.max(0, Math.round(input.subtotalCents));
  const deliveryFeeCents = Math.max(0, Math.round(input.deliveryFeeCents));
  const serviceFeeCents = Math.max(0, Math.round(input.serviceFeeCents));
  const requestedDiscountCents = Math.max(0, Math.round(input.discountCents || 0));
  const discountCents = Math.min(requestedDiscountCents, subtotalCents + deliveryFeeCents + serviceFeeCents);
  const tipCents = Math.max(0, Math.round(input.tipCents || 0));
  return { subtotalCents, deliveryFeeCents, serviceFeeCents, discountCents, tipCents, totalCents: subtotalCents + deliveryFeeCents + serviceFeeCents - discountCents + tipCents };
}

function utcDay(value: Date) { return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()); }
function dayDistance(a: Date, b: Date) { return Math.round((utcDay(b) - utcDay(a)) / 86_400_000); }
export function nextCustomerStreak(currentStreak: number, lastCompletedAt: Date | null | undefined, completedAt: Date) {
  return lastCompletedAt && dayDistance(new Date(lastCompletedAt), completedAt) === 1 ? Math.max(0, Number(currentStreak || 0)) + 1 : 1;
}

export async function recordCompletedCustomerOrder(input: { customerId?: string | null; orderId: mongoose.Types.ObjectId; completedAt?: Date }) {
  const customerId = String(input.customerId || "").trim();
  if (!customerId) return { updated: false, reason: "NO_CUSTOMER" as const };
  const completedAt = input.completedAt || new Date();
  const order = await Order.findOne({ _id: input.orderId, customerId, status: "delivered" }).select("_id").lean().exec();
  if (!order) return { updated: false, reason: "ORDER_NOT_DELIVERED" as const };
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      await CustomerOrderCompletion.create([{ customerId, orderId: input.orderId, completedAt }], { session });
      const existing = await UserStreak.findOne({ customerId }).session(session).lean().exec() as any;
      const current = Number(existing?.currentStreak || 0);
      const nextStreak = nextCustomerStreak(current, existing?.lastCompletedAt, completedAt);
      const streak = await UserStreak.findOneAndUpdate({ customerId }, { $set: { currentStreak: nextStreak, longestStreak: Math.max(Number(existing?.longestStreak || 0), nextStreak), lastCompletedAt: completedAt, lastCompletedOrderId: input.orderId }, $inc: { completedOrders: 1 } }, { upsert: true, new: true, setDefaultsOnInsert: true, session }).lean().exec() as any;
      const badges = await Badge.find({ active: true, $or: [{ criterion: "completed_orders", threshold: { $lte: Number(streak.completedOrders || 0) } }, { criterion: "streak_days", threshold: { $lte: Number(streak.currentStreak || 0) } }] }).session(session).lean().exec() as any[];
      if (badges.length) await CustomerBadge.bulkWrite(badges.map((badge) => ({ updateOne: { filter: { customerId, badgeSlug: badge.slug }, update: { $setOnInsert: { customerId, badgeSlug: badge.slug, sourceOrderId: input.orderId, awardedAt: completedAt } }, upsert: true } })), { ordered: false, session });
      return { updated: true, streak, badgesAwarded: badges.map((badge) => badge.slug) };
    });
    return result;
  } catch (error: any) {
    if (error?.code === 11000) {
      const existing = await UserStreak.findOne({ customerId }).lean().exec();
      return { updated: false, reason: "ALREADY_RECORDED" as const, streak: existing };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function recommendationProfileForCustomer(customerId: string) {
  const orders = await Order.find({ customerId, status: "delivered" }).sort({ deliveredAt: -1 }).limit(100).select("restaurantId items").lean().exec() as any[];
  const restaurants = new Map<string, number>(); const categories = new Map<string, number>();
  for (const order of orders) { const restaurantId = String(order.restaurantId); restaurants.set(restaurantId, (restaurants.get(restaurantId) || 0) + 1); for (const item of order.items || []) { const category = String(item.name || "").split(" ")[0].toLowerCase(); if (category) categories.set(category, (categories.get(category) || 0) + 1); } }
  const preferredRestaurantIds = [...restaurants.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).filter(([id]) => mongoose.isValidObjectId(id)).map(([id]) => new mongoose.Types.ObjectId(id));
  const preferredCategories = [...categories.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category]) => category);
  return RecommendationProfile.findOneAndUpdate({ customerId }, { $set: { preferredRestaurantIds, preferredCategories, orderCount: orders.length, lastComputedAt: new Date(), modelVersion: "rules-v1" } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
}

export async function ensureCustomerEngagementIndexes() {
  await Promise.all([UserStreak.init(), Badge.init(), CustomerBadge.init(), PikiPassSubscription.init(), ReferralReward.init(), RecommendationProfile.init(), CustomerOrderCompletion.init()]);
  await Badge.bulkWrite(DEFAULT_BADGES.map((badge) => ({ updateOne: { filter: { slug: badge.slug }, update: { $setOnInsert: badge }, upsert: true } })), { ordered: false });
}

export async function consumeCustomerCredits(customerId: string, maximumCents: number) {
  const max = Math.max(0, Math.floor(maximumCents));
  if (!customerId || max === 0) return 0;
  const now = new Date();
  await CustomerAccount.updateOne({ _id: customerId, pikiCreditsExpiresAt: { $lte: now }, pikiCreditsCents: { $gt: 0 } }, { $set: { pikiCreditsCents: 0, pikiCreditsExpiresAt: null } }).exec();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const wallet = await CustomerAccount.findById(customerId).select("pikiCreditsCents pikiCreditsExpiresAt").lean().exec() as any;
    if (!wallet?.pikiCreditsExpiresAt || new Date(wallet.pikiCreditsExpiresAt).getTime() <= now.getTime()) return 0;
    const available = Math.max(0, Number(wallet.pikiCreditsCents || 0));
    const applied = Math.min(available, max);
    if (!applied) return 0;
    const updated = await CustomerAccount.findOneAndUpdate({ _id: customerId, pikiCreditsCents: available, pikiCreditsExpiresAt: wallet.pikiCreditsExpiresAt }, { $inc: { pikiCreditsCents: -applied }, $set: { pikiCreditsExpiresAt: new Date(wallet.pikiCreditsExpiresAt) } }, { new: true }).select("pikiCreditsCents").lean().exec();
    if (updated) return applied;
  }
  return 0;
}

export async function restoreCustomerCredits(customerId: string, cents: number, expiresAt?: Date | null) {
  if (!customerId || cents <= 0) return;
  await CustomerAccount.updateOne({ _id: customerId }, { $inc: { pikiCreditsCents: Math.floor(cents) }, $set: { pikiCreditsExpiresAt: expiresAt || new Date(Date.now() + 48 * 60 * 60 * 1000) } }).exec();
}
