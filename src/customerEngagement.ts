import { createHash, randomBytes } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import { CustomerAccount, Order } from "./models.js";

const userStreakSchema = new Schema({
  customerId: { type: String, required: true, unique: true, index: true },
  currentStreak: { type: Number, default: 0, min: 0 },
  longestStreak: { type: Number, default: 0, min: 0 },
  weekendStreak: { type: Number, default: 0, min: 0 },
  completedOrders: { type: Number, default: 0, min: 0 },
  uniqueRestaurants: { type: Number, default: 0, min: 0 },
  nightOrders: { type: Number, default: 0, min: 0 },
  lastRewardStreak: { type: Number, default: 0, min: 0 },
  lastRewardAt: { type: Date, default: null },
  freeDeliveryUntil: { type: Date, default: null },
  lastCompletedAt: { type: Date, default: null },
  lastCompletedOrderId: { type: Schema.Types.ObjectId, ref: "Order", default: null },
}, { timestamps: true, collection: "user_streaks" });

const badgeSchema = new Schema({
  slug: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  description: { type: String, required: true },
  criterion: { type: String, enum: ["completed_orders", "streak_days", "weekend_streak", "unique_restaurants", "night_orders"], required: true },
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

const customerDeliverySavingSchema = new Schema({
  customerId: { type: String, required: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true, index: true },
  savedOnDeliveryCents: { type: Number, required: true, min: 0 },
  source: { type: String, enum: ["piki_pass", "delivery_promotion", "credit"] , required: true },
  recordedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: "customer_delivery_savings" });
customerDeliverySavingSchema.index({ customerId: 1, recordedAt: -1 });
const customerCouponSchema = new Schema({
  customerId: { type: String, required: true, index: true },
  percentBps: { type: Number, required: true, min: 1, max: 500 },
  maxDiscountCents: { type: Number, required: true, min: 0 },
  minSubtotalCents: { type: Number, default: 0, min: 0 },
  label: { type: String, default: "Cupón PIKI" },
  source: { type: String, default: "wheel" },
  expiresAt: { type: Date, required: true, index: true },
  usedAt: { type: Date, default: null },
  usedOrderId: { type: String, default: null },
}, { timestamps: true });
customerCouponSchema.index({ customerId: 1, usedAt: 1, expiresAt: 1 });
const customerShareChallengeSchema = new Schema({
  customerId: { type: String, required: true, index: true },
  token: { type: String, required: true, unique: true, index: true },
  prizeLabel: { type: String, required: true },
  rewardCents: { type: Number, required: true, min: 0 },
  invitesRequired: { type: Number, required: true, min: 1 },
  invitesDone: { type: Number, default: 0, min: 0 },
  visitors: { type: [String], default: [] },
  sourceOrderId: { type: String, default: null },
  expiresAt: { type: Date, required: true, index: true },
  completedAt: { type: Date, default: null },
  claimedAt: { type: Date, default: null },
}, { timestamps: true });
customerShareChallengeSchema.index({ customerId: 1, claimedAt: 1 });
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
export const CustomerDeliverySaving = mongoose.models.CustomerDeliverySaving || mongoose.model("CustomerDeliverySaving", customerDeliverySavingSchema);

export const DEFAULT_BADGES = [
  { slug: "first-order", name: "Primer pedido", description: "Has completado tu primer pedido en PIKI.", criterion: "completed_orders", threshold: 1 },
  { slug: "five-orders", name: "Cliente habitual", description: "Has completado cinco pedidos.", criterion: "completed_orders", threshold: 5 },
  { slug: "streak-3", name: "Racha de 3", description: "Has pedido tres días consecutivos.", criterion: "streak_days", threshold: 3 },
  { slug: "streak-7", name: "Racha de 7", description: "Has pedido siete días consecutivos.", criterion: "streak_days", threshold: 7 },
  { slug: "explorador-local", name: "Explorador Local", description: "Has pedido en cinco restaurantes diferentes de PIKI.", criterion: "unique_restaurants", threshold: 5 },
  { slug: "noctambulo", name: "Noctámbulo", description: "Has pedido tres veces después de las 22:00.", criterion: "night_orders", threshold: 3 },
  { slug: "piki-lover", name: "PIKI Lover", description: "Has pedido en cuatro fines de semana seguidos.", criterion: "weekend_streak", threshold: 4 },
] as const;

export const COMMON_WHEEL_REWARD_CENTS = 100;
export const FREE_DELIVERY_WHEEL_CENTS = 299;
/** A free order is never paid in full: it is capped so a single spin cannot cost more than 5 €. */
export const FREE_ORDER_WHEEL_CAP_CENTS = 500;
/** Coupons are hard-capped at 5 %, both by percentage and by an absolute ceiling. */
export const WHEEL_COUPON_PERCENT_BPS = 500;
export const WHEEL_COUPON_HIGH_CAP_CENTS = 200;
export const WHEEL_COUPON_LOW_CAP_CENTS = 100;
export const WHEEL_COUPON_MIN_SUBTOTAL_CENTS = 800;
export const WHEEL_COUPON_TTL_MS = 7 * 86_400_000;

export type WheelRewardKind = "free_order" | "credit" | "free_delivery" | "coupon" | "challenge" | "none";
export type WheelCouponSpec = {
  percentBps: number;
  maxDiscountCents: number;
  minSubtotalCents: number;
  label: string;
  ttlMs: number;
};
export type WheelChallengeSpec = { prizeLabel: string; rewardCents: number; invitesRequired: number; ttlMs: number };
export type WheelSpinResult = { kind: WheelRewardKind; cents: number; label: string; message: string; coupon?: WheelCouponSpec | null; challenge?: WheelChallengeSpec | null };

export type WheelPrizeKey = "credit" | "coupon_low" | "free_delivery" | "coupon_high" | "challenge" | "free_order";

export type WheelHistory = {
  /** Orders delivered and spun since the last free-order prize. */
  spinsSinceJackpot?: number;
  /** When the customer last won the free-order prize. */
  jackpotLastAt?: Date | null;
  /** Delivered orders of this customer, used to unlock the top prize. */
  completedOrders?: number;
  /** Prize key of the previous spin, used to avoid repeats. */
  lastPrize?: string | null;
  /** Reward money already given to this customer in the last 30 days. */
  rewardCentsLast30Days?: number;
};

/** The top prize is deliberately hard: it unlocks late and only once every two months. */
export const JACKPOT_MIN_COMPLETED_ORDERS = 5;
export const JACKPOT_MIN_SPINS_WITHOUT = 25;
export const JACKPOT_COOLDOWN_DAYS = 60;
/** Hard budget per customer and rolling month, so the wheel can never cost real money. */
export const REWARD_BUDGET_30D_CENTS = 1_000;

/**
 * Base odds, in weights. The cheap credit is by far the most common; the 5 €
 * free order is a rare event that only becomes possible after a long streak of
 * spins without it. Every weight is re-balanced at spin time by `wheelWeights`.
 */
const BASE_WHEEL_WEIGHTS: Record<WheelPrizeKey, number> = {
  credit: 46,
  coupon_low: 24,
  free_delivery: 19,
  coupon_high: 9,
  challenge: 3,
  free_order: 1,
};

export function wheelWeights(history: WheelHistory = {}): Record<WheelPrizeKey, number> {
  const weights: Record<WheelPrizeKey, number> = { ...BASE_WHEEL_WEIGHTS };
  const spins = Math.max(0, Number(history.spinsSinceJackpot || 0));
  const orders = Math.max(0, Number(history.completedOrders || 0));
  const spent = Math.max(0, Number(history.rewardCentsLast30Days || 0));
  const lastJackpot = history.jackpotLastAt ? new Date(history.jackpotLastAt).getTime() : 0;
  const cooldownPassed = !lastJackpot || Date.now() - lastJackpot > JACKPOT_COOLDOWN_DAYS * 86_400_000;
  const jackpotUnlocked = orders >= JACKPOT_MIN_COMPLETED_ORDERS && spins >= JACKPOT_MIN_SPINS_WITHOUT && cooldownPassed;
  if (!jackpotUnlocked) {
    // Redistribute the jackpot weight into the everyday credit: the wheel still
    // feels alive, but a newcomer cannot take 5 € on their first spins.
    weights.credit += weights.free_order;
    weights.free_order = 0;
  }
  // Anti-repeat: two free deliveries in a row would feel rigged the wrong way.
  if (String(history.lastPrize || "").toUpperCase() === "FREE_DELIVERY") {
    const moved = weights.free_delivery * 0.5;
    weights.free_delivery -= moved;
    weights.credit += moved;
  }
  // Monthly budget guard: once the customer has taken 10 €, only small prizes remain.
  if (spent >= REWARD_BUDGET_30D_CENTS) {
    weights.credit += weights.free_delivery + weights.coupon_high;
    weights.free_delivery = 0;
    weights.coupon_high = 0;
    weights.free_order = 0;
    weights.challenge = 0;
  }
  return weights;
}

/** Temu-style sealed envelope: the big prize is real but it is paid with invites, never for free. */
export const SHARE_CHALLENGE_TTL_MS = 7 * 86_400_000;
export const SHARE_CHALLENGE_POOL = [
  { prizeLabel: "10 € en tu monedero PIKI", rewardCents: 1_000, invitesRequired: 4, weight: 70 },
  { prizeLabel: "15 € en tu monedero PIKI", rewardCents: 1_500, invitesRequired: 6, weight: 25 },
  { prizeLabel: "25 € en tu monedero PIKI", rewardCents: 2_500, invitesRequired: 10, weight: 5 },
] as const;

export function pickShareChallengePrize(randomValue = Math.random()): WheelChallengeSpec {
  const total = SHARE_CHALLENGE_POOL.reduce((sum, tier) => sum + tier.weight, 0);
  const value = Math.min(0.999999, Math.max(0, Number.isFinite(Number(randomValue)) ? Number(randomValue) : 0)) * total;
  let cursor = value;
  for (const tier of SHARE_CHALLENGE_POOL) {
    cursor -= tier.weight;
    if (cursor < 0) return { prizeLabel: tier.prizeLabel, rewardCents: tier.rewardCents, invitesRequired: tier.invitesRequired, ttlMs: SHARE_CHALLENGE_TTL_MS };
  }
  const fallback = SHARE_CHALLENGE_POOL[0];
  return { prizeLabel: fallback.prizeLabel, rewardCents: fallback.rewardCents, invitesRequired: fallback.invitesRequired, ttlMs: SHARE_CHALLENGE_TTL_MS };
}

function prizeForKey(key: WheelPrizeKey, subtotalCents: number): WheelSpinResult {
  if (key === "free_order") {
    const subtotal = Math.max(0, Math.round(Number(subtotalCents || 0)));
    const cents = Math.min(FREE_ORDER_WHEEL_CAP_CENTS, Math.max(COMMON_WHEEL_REWARD_CENTS, subtotal));
    return { kind: "free_order", cents, label: `Pedido gratis hasta ${(cents / 100).toFixed(2).replace(".", ",")} €`, message: `¡Has ganado tu pedido gratis hasta ${(cents / 100).toFixed(2).replace(".", ",")} €! Se abona como crédito PIKI válido 48 horas.` };
  }
  if (key === "coupon_high") {
    return { kind: "coupon", cents: 0, label: "Cupón 5 %", message: "¡Has ganado un cupón del 5 % para tu próximo pedido (máximo 2 €). Válido 7 días.", coupon: { percentBps: WHEEL_COUPON_PERCENT_BPS, maxDiscountCents: WHEEL_COUPON_HIGH_CAP_CENTS, minSubtotalCents: WHEEL_COUPON_MIN_SUBTOTAL_CENTS, label: "Cupón 5 % (máx. 2 €)", ttlMs: WHEEL_COUPON_TTL_MS } };
  }
  if (key === "coupon_low") {
    return { kind: "coupon", cents: 0, label: "Cupón 5 %", message: "¡Has ganado un cupón del 5 % para tu próximo pedido (máximo 1 €). Válido 7 días.", coupon: { percentBps: WHEEL_COUPON_PERCENT_BPS, maxDiscountCents: WHEEL_COUPON_LOW_CAP_CENTS, minSubtotalCents: WHEEL_COUPON_MIN_SUBTOTAL_CENTS, label: "Cupón 5 % (máx. 1 €)", ttlMs: WHEEL_COUPON_TTL_MS } };
  }
  if (key === "challenge") {
    const challenge = pickShareChallengePrize(Math.random());
    return { kind: "challenge", cents: 0, label: "Sobre sorpresa", message: `Has desbloqueado un sobre con ${challenge.prizeLabel}: comparte PIKI con ${challenge.invitesRequired} amigos y se abonará en tu monedero.`, challenge };
  }
  if (key === "free_delivery") {
    return { kind: "free_delivery", cents: FREE_DELIVERY_WHEEL_CENTS, label: "Envío gratis", message: "¡Enhorabuena! Te abonamos el importe del envío como crédito válido 48 horas." };
  }
  return { kind: "credit", cents: COMMON_WHEEL_REWARD_CENTS, label: "1,00 € de crédito", message: "¡Enhorabuena! Has ganado 1,00 € para tu próximo pedido. Válido durante 48 horas." };
}

/**
 * Weighted draw. Deterministic for a given random value and history, which keeps
 * the distribution auditable and testable: the cheap credit lands roughly four
 * out of five times and the free order is a rare, late-game event.
 */
export function resolveWheelSpin(randomValue = Math.random(), options: { subtotalCents?: number; history?: WheelHistory } = {}): WheelSpinResult {
  const normalized = Number(randomValue);
  if (!Number.isFinite(normalized)) return { kind: "none", cents: 0, label: "Sin premio", message: "Esta vez no ha habido premio." };
  const weights = wheelWeights(options.history || {});
  const order: WheelPrizeKey[] = ["free_order", "challenge", "coupon_high", "free_delivery", "coupon_low", "credit"];
  const total = order.reduce((sum, key) => sum + Math.max(0, weights[key]), 0);
  if (total <= 0) return prizeForKey("credit", Number(options.subtotalCents || 0));
  let cursor = Math.min(0.999999, Math.max(0, normalized)) * total;
  for (const key of order) {
    cursor -= Math.max(0, weights[key]);
    if (cursor < 0) return prizeForKey(key, Number(options.subtotalCents || 0));
  }
  return prizeForKey("credit", Number(options.subtotalCents || 0));
}

/** Backwards-compatible helper: the wallet amount a spin is worth. */
export function resolveWheelReward(randomValue = Math.random(), options: { subtotalCents?: number; history?: WheelHistory } = {}) {
  return resolveWheelSpin(randomValue, options).cents;
}

export const WHEEL_CREDIT_TTL_MS = 48 * 60 * 60 * 1_000;
export const STREAK_REWARD_CENTS = 300;
export const STREAK_REWARD_TTL_MS = 7 * 86_400_000;
export const STREAK_REWARD_EVERY = 3;

function isWeekendInstant(value: Date): boolean {
  const day = value.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * A reward lands every three consecutive days. Weekend streaks count too, so a
 * customer who only orders at the weekend is not punished by the daily rule.
 */
export function streakRewardFor(input: { currentStreak: number; lastRewardStreak?: number; completedAt?: Date }) {
  const streak = Math.max(0, Number(input.currentStreak || 0));
  const alreadyPaid = Math.max(0, Number(input.lastRewardStreak || 0));
  if (streak < STREAK_REWARD_EVERY) return { due: false as const, cents: 0 };
  if (streak <= alreadyPaid) return { due: false as const, cents: 0 };
  const at = input.completedAt || new Date();
  const weekendBonus = isWeekendInstant(at) ? 1 : 0;
  return { due: true as const, cents: STREAK_REWARD_CENTS + weekendBonus * 0, streak };
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
  const order = await Order.findOne({ _id: input.orderId, customerId, status: "delivered" }).select("_id restaurantId").lean().exec() as any;
  if (!order) return { updated: false, reason: "ORDER_NOT_DELIVERED" as const };
  const madridHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", hour12: false }).format(completedAt));
  const isNightOrder = madridHour >= 22 || madridHour < 5;
  const isWeekendOrder = isWeekendInstant(completedAt);
  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(async () => {
      await CustomerOrderCompletion.create([{ customerId, orderId: input.orderId, completedAt }], { session });
      const existing = await UserStreak.findOne({ customerId }).session(session).lean().exec() as any;
      const current = Number(existing?.currentStreak || 0);
      const nextStreak = nextCustomerStreak(current, existing?.lastCompletedAt, completedAt);
      const previousWeekendStreak = Number(existing?.weekendStreak || 0);
      const lastCompletedAt = existing?.lastCompletedAt ? new Date(existing.lastCompletedAt) : null;
      const sameWeekend = Boolean(lastCompletedAt && isWeekendInstant(lastCompletedAt) && isWeekendOrder && Math.abs(dayDistance(lastCompletedAt, completedAt)) < 7);
      const nextWeekendStreak = isWeekendOrder ? (sameWeekend ? Math.max(1, previousWeekendStreak) : previousWeekendStreak + 1) : previousWeekendStreak;
      const distinctRestaurants = await Order.distinct("restaurantId", { customerId, status: "delivered" }).session(session);
      const nextUniqueRestaurants = distinctRestaurants.filter(Boolean).length;
      const streak = await UserStreak.findOneAndUpdate({ customerId }, {
        $set: {
          currentStreak: nextStreak,
          longestStreak: Math.max(Number(existing?.longestStreak || 0), nextStreak),
          weekendStreak: nextWeekendStreak,
          uniqueRestaurants: nextUniqueRestaurants,
          lastCompletedAt: completedAt,
          lastCompletedOrderId: input.orderId,
        },
        $inc: { completedOrders: 1, ...(isNightOrder ? { nightOrders: 1 } : {}) },
      }, { upsert: true, new: true, setDefaultsOnInsert: true, session }).lean().exec() as any;

      const metrics: Record<string, number> = {
        completed_orders: Number(streak.completedOrders || 0),
        streak_days: Number(streak.currentStreak || 0),
        weekend_streak: Number(streak.weekendStreak || 0),
        unique_restaurants: Number(streak.uniqueRestaurants || 0),
        night_orders: Number(streak.nightOrders || 0),
      };
      const badges = await Badge.find({ active: true }).session(session).lean().exec() as any[];
      const earned = badges.filter((badge) => Number(badge.threshold || 0) <= Number(metrics[String(badge.criterion)] || 0));
      if (earned.length) await CustomerBadge.bulkWrite(earned.map((badge) => ({ updateOne: { filter: { customerId, badgeSlug: badge.slug }, update: { $setOnInsert: { customerId, badgeSlug: badge.slug, sourceOrderId: input.orderId, awardedAt: completedAt } }, upsert: true } })), { ordered: false, session });

      const reward = streakRewardFor({ currentStreak: nextStreak, lastRewardStreak: Number(existing?.lastRewardStreak || 0), completedAt });
      if (reward.due && reward.cents > 0) {
        await CustomerAccount.updateOne({ _id: customerId }, { $inc: { pikiCreditsCents: reward.cents }, $set: { pikiCreditsExpiresAt: new Date(completedAt.getTime() + STREAK_REWARD_TTL_MS) } }, { session }).exec();
        await UserStreak.updateOne({ customerId }, { $set: { lastRewardStreak: nextStreak, lastRewardAt: completedAt } }, { session }).exec();
      }

      return { updated: true, streak, badgesAwarded: earned.map((badge) => badge.slug), streakRewardCents: reward.due ? reward.cents : 0 };
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
  await Promise.all([UserStreak.init(), Badge.init(), CustomerBadge.init(), PikiPassSubscription.init(), ReferralReward.init(), RecommendationProfile.init(), CustomerOrderCompletion.init(), CustomerDeliverySaving.init(), CustomerCoupon.init(), CustomerShareChallenge.init()]);
  await Badge.bulkWrite(DEFAULT_BADGES.map((badge) => ({ updateOne: { filter: { slug: badge.slug }, update: { $setOnInsert: badge }, upsert: true } })), { ordered: false });
}

/** Issues a wheel coupon. Percentage and ceiling are clamped so no coupon can ever beat 5 % or its cap. */
export async function issueCustomerCoupon(customerId: string, spec: WheelCouponSpec, options: { source?: string; now?: Date } = {}) {
  const id = String(customerId || "").trim();
  if (!id) return null;
  const now = options.now || new Date();
  const percentBps = Math.max(1, Math.min(WHEEL_COUPON_PERCENT_BPS, Math.round(Number(spec.percentBps || 0))));
  const maxDiscountCents = Math.max(0, Math.min(WHEEL_COUPON_HIGH_CAP_CENTS, Math.round(Number(spec.maxDiscountCents || 0))));
  const minSubtotalCents = Math.max(0, Math.round(Number(spec.minSubtotalCents || 0)));
  const coupon = await CustomerCoupon.create({ customerId: id, percentBps, maxDiscountCents, minSubtotalCents, label: spec.label || "Cupón PIKI", source: options.source || "wheel", expiresAt: new Date(now.getTime() + (spec.ttlMs || WHEEL_COUPON_TTL_MS)) });
  return coupon.toObject();
}

export async function activeCustomerCoupons(customerId: string, now = new Date()) {
  const id = String(customerId || "").trim();
  if (!id) return [] as any[];
  return CustomerCoupon.find({ customerId: id, usedAt: null, expiresAt: { $gt: now } }).sort({ maxDiscountCents: -1, expiresAt: 1 }).lean().exec() as any;
}

/** Discount a coupon would produce on a given subtotal, never above its own ceiling. */
export function couponDiscountCents(coupon: any, subtotalCents: number) {
  const subtotal = Math.max(0, Math.round(Number(subtotalCents || 0)));
  if (!coupon) return 0;
  if (coupon.usedAt) return 0;
  if (coupon.expiresAt && new Date(coupon.expiresAt).getTime() <= Date.now()) return 0;
  if (subtotal < Number(coupon.minSubtotalCents || 0)) return 0;
  const percent = Math.max(0, Math.min(WHEEL_COUPON_PERCENT_BPS, Number(coupon.percentBps || 0)));
  const raw = Math.floor((subtotal * percent) / 10_000);
  return Math.max(0, Math.min(Math.round(Number(coupon.maxDiscountCents || 0)), raw));
}

/** Picks the coupon that saves the most for this order and marks it as used atomically. */
export async function redeemBestCoupon(customerId: string, subtotalCents: number, orderId?: string | null) {
  const coupons = await activeCustomerCoupons(customerId);
  const scored = (coupons as any[])
    .map((coupon: any) => ({ coupon, discountCents: couponDiscountCents(coupon, subtotalCents) }))
    .filter((row: { discountCents: number }) => row.discountCents > 0)
    .sort((a: { discountCents: number }, b: { discountCents: number }) => b.discountCents - a.discountCents);
  const best = scored[0];
  if (!best) return { coupon: null as any, discountCents: 0 };
  const updated = await CustomerCoupon.findOneAndUpdate({ _id: best.coupon._id, usedAt: null }, { $set: { usedAt: new Date(), usedOrderId: orderId ? String(orderId) : null } }, { new: true }).lean().exec();
  if (!updated) return { coupon: null as any, discountCents: 0 };
  return { coupon: updated as any, discountCents: best.discountCents };
}

function shareToken() {
  return randomBytes(9).toString("base64url");
}

/** Stable-ish fingerprint so the same friend cannot be counted twice from the same device. */
export function shareFingerprint(ip?: string | null, userAgent?: string | null) {
  return createHash("sha256").update(`${String(ip || "")}|${String(userAgent || "")}`).digest("hex").slice(0, 32);
}

export async function createShareChallenge(customerId: string, spec: WheelChallengeSpec, options: { orderId?: string | null; now?: Date } = {}) {
  const id = String(customerId || "").trim();
  if (!id) return null;
  const now = options.now || new Date();
  const challenge = await CustomerShareChallenge.create({
    customerId: id,
    token: shareToken(),
    prizeLabel: spec.prizeLabel,
    rewardCents: Math.max(0, Math.round(Number(spec.rewardCents || 0))),
    invitesRequired: Math.max(1, Math.round(Number(spec.invitesRequired || 1))),
    invitesDone: 0,
    visitors: [],
    sourceOrderId: options.orderId ? String(options.orderId) : null,
    expiresAt: new Date(now.getTime() + (spec.ttlMs || SHARE_CHALLENGE_TTL_MS)),
  });
  return challenge.toObject();
}

export async function activeShareChallenges(customerId: string, now = new Date()) {
  const id = String(customerId || "").trim();
  if (!id) return [] as any[];
  return CustomerShareChallenge.find({ customerId: id, claimedAt: null, expiresAt: { $gt: now } }).sort({ createdAt: -1 }).lean().exec() as any;
}

/** Counts one share visit. When the goal is reached the prize is paid automatically. */
export async function registerShareVisit(token: string, fingerprint: string, now = new Date()) {
  const cleanToken = String(token || "").trim();
  if (!cleanToken) return { found: false as const };
  const challenge = await CustomerShareChallenge.findOne({ token: cleanToken, claimedAt: null, expiresAt: { $gt: now } }).lean().exec() as any;
  if (!challenge) return { found: false as const };
  if ((challenge.visitors || []).includes(fingerprint)) {
    return { found: true as const, counted: false, invitesDone: Number(challenge.invitesDone || 0), invitesRequired: Number(challenge.invitesRequired || 0), completed: Boolean(challenge.completedAt) };
  }
  const updated = await CustomerShareChallenge.findOneAndUpdate(
    { _id: challenge._id, claimedAt: null, expiresAt: { $gt: now } },
    { $push: { visitors: fingerprint }, $inc: { invitesDone: 1 } },
    { new: true },
  ).lean().exec() as any;
  if (!updated) return { found: false as const };
  const goalReached = Number(updated.invitesDone || 0) >= Number(updated.invitesRequired || 0);
  if (!goalReached) {
    return { found: true as const, counted: true, invitesDone: Number(updated.invitesDone || 0), invitesRequired: Number(updated.invitesRequired || 0), completed: false };
  }
  const paid = await claimShareChallenge(String(updated._id), now);
  return { found: true as const, counted: true, invitesDone: Number(updated.invitesDone || 0), invitesRequired: Number(updated.invitesRequired || 0), completed: true, rewardCents: paid.rewardCents };
}

/** Pays a completed envelope once. Safe to call twice: the second call returns nothing. */
export async function claimShareChallenge(challengeId: string, now = new Date()) {
  if (!mongoose.Types.ObjectId.isValid(String(challengeId))) return { claimed: false as const, rewardCents: 0 };
  const challenge = await CustomerShareChallenge.findOne({ _id: challengeId, claimedAt: null }).lean().exec() as any;
  if (!challenge) return { claimed: false as const, rewardCents: 0 };
  if (Number(challenge.invitesDone || 0) < Number(challenge.invitesRequired || 0)) return { claimed: false as const, rewardCents: 0 };
  const locked = await CustomerShareChallenge.findOneAndUpdate({ _id: challengeId, claimedAt: null }, { $set: { claimedAt: now, completedAt: challenge.completedAt || now } }, { new: true }).lean().exec() as any;
  if (!locked) return { claimed: false as const, rewardCents: 0 };
  const cents = Math.max(0, Number(locked.rewardCents || 0));
  if (cents > 0) await restoreCustomerCredits(String(locked.customerId), cents, new Date(now.getTime() + SHARE_CHALLENGE_TTL_MS));
  return { claimed: true as const, rewardCents: cents };
}

export async function restoreCustomerCoupon(couponId?: string | null) {
  const id = String(couponId || "").trim();
  if (!id || !mongoose.Types.ObjectId.isValid(id)) return;
  await CustomerCoupon.updateOne({ _id: id }, { $set: { usedAt: null, usedOrderId: null } }).exec();
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

export async function syncCustomerDeliverySavings(customerId: string) {
  if (!customerId) return { savedOnDeliveryCents: 0, orders: 0 };
  const orders = await Order.find({ customerId, status: "delivered", $or: [{ creditAppliedCents: { $gt: 0 } }, { deliveryFeeCents: 0 }] }).select("_id deliveryFeeCents creditAppliedCents").lean().exec() as any[];
  const records = orders.map((order) => {
    const credit = Math.max(0, Number(order.creditAppliedCents || 0));
    const delivery = Math.max(0, Number(order.deliveryFeeCents || 0));
    const saved = Math.min(delivery || credit, credit || delivery);
    return { updateOne: { filter: { orderId: order._id }, update: { $set: { customerId, savedOnDeliveryCents: saved, source: delivery && saved === delivery ? "piki_pass" : "credit", recordedAt: new Date() } }, upsert: true } };
  }).filter((row) => row.updateOne.update.$set.savedOnDeliveryCents > 0);
  if (records.length) await CustomerDeliverySaving.bulkWrite(records, { ordered: false });
  const [summary] = await CustomerDeliverySaving.aggregate([{ $match: { customerId } }, { $group: { _id: null, savedOnDeliveryCents: { $sum: "$savedOnDeliveryCents" }, orders: { $sum: 1 } } }]);
  return { savedOnDeliveryCents: Number(summary?.savedOnDeliveryCents || 0), orders: Number(summary?.orders || 0) };
}
export const CustomerCoupon = mongoose.models.CustomerCoupon || mongoose.model("CustomerCoupon", customerCouponSchema);
export const CustomerShareChallenge = mongoose.models.CustomerShareChallenge || mongoose.model("CustomerShareChallenge", customerShareChallengeSchema);
