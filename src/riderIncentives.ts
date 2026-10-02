import { randomBytes } from "node:crypto";
import mongoose from "mongoose";
import { DispatchDecision, Order, Rider, RiderSlot, Zone } from "./models.js";
import { calculateHourlyGuaranteeTopUp, calculateSettlement, getRecruitmentAwards, isAcceptanceRateEligible, RIDER_INCENTIVE_POLICY } from "./settlements.js";
import { RiderIncentiveBudget, RiderIncentiveEntry, RiderReferralProfile, RiderShiftIncentiveMetric } from "./riderIncentivesModels.js";

const enabled = (key: string) => String(process.env[key] || "").trim().toLowerCase() === "true";
const monthlyCapCents = () => {
  const value = Number(process.env.PIKI_RIDER_INCENTIVES_MONTHLY_CAP_CENTS || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
};
const guaranteeZoneSlug = () => String(process.env.PIKI_HOURLY_GUARANTEE_ZONE_SLUG || RIDER_INCENTIVE_POLICY.centralZoneSlug).trim().toLowerCase();
const campaignStartAt = () => {
  const value = new Date(String(process.env.PIKI_RIDER_INCENTIVES_START_AT || ""));
  return Number.isFinite(value.getTime()) && value.getTime() <= Date.now() ? value : null;
};
const referralEnabled = () => enabled("PIKI_RIDER_REFERRALS_ENABLED") && monthlyCapCents() > 0 && campaignStartAt() !== null;
const guaranteeEnabled = () => enabled("PIKI_HOURLY_GUARANTEE_ENABLED") && monthlyCapCents() > 0;
const tenantFilter = (tenantId: mongoose.Types.ObjectId | null) => ({ tenantId: tenantId || null });
const monthKey = (date = new Date()) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
const asObjectId = (value: unknown) => value && mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(String(value)) : null;

export function incentiveProgramStatus() {
  const capCents = monthlyCapCents();
  return {
    referralsEnabled: referralEnabled(),
    hourlyGuaranteeEnabled: guaranteeEnabled(),
    monthlyCapCents: capCents,
    policy: {
      hourlyRateCents: RIDER_INCENTIVE_POLICY.hourlyRateCents,
      requiredShiftHours: RIDER_INCENTIVE_POLICY.requiredShiftHours,
      minimumAcceptanceRate: RIDER_INCENTIVE_POLICY.minimumAcceptanceRate,
      centralZoneSlug: guaranteeZoneSlug(),
      acquisitionDeliveries: RIDER_INCENTIVE_POLICY.acquisitionDeliveries,
      acquisitionBonusCents: RIDER_INCENTIVE_POLICY.acquisitionBonusCents,
      referralDeliveries: RIDER_INCENTIVE_POLICY.referralDeliveries,
      referralBonusCents: RIDER_INCENTIVE_POLICY.referralBonusCents,
      campaignStartAt: campaignStartAt()?.toISOString() || null,
    },
  };
}

async function awardIncentive(input: {
  tenantId: mongoose.Types.ObjectId | null;
  riderId: mongoose.Types.ObjectId;
  entryType: "acquisition_bonus" | "referral_bonus" | "referred_rider_bonus" | "hourly_guarantee";
  amountCents: number;
  sourceKey: string;
  relatedRiderId?: mongoose.Types.ObjectId | null;
  metadata?: Record<string, unknown>;
  earnedAt?: Date;
}, retry = 0) {
  if (input.amountCents < 1) return false;
  const earnedAt = input.earnedAt || new Date();
  const keyMonth = monthKey(earnedAt);
  const capCents = monthlyCapCents();
  if (capCents < 1 || input.amountCents > capCents) return false;
  const session = await mongoose.startSession();
  let awarded = false;
  let retryAfterDuplicate = false;
  try {
    await session.withTransaction(async () => {
      if (await RiderIncentiveEntry.findOne({ sourceKey: input.sourceKey }).session(session).lean().exec()) return;
      const scope = tenantFilter(null);
      await RiderIncentiveBudget.updateOne({ ...scope, monthKey: keyMonth }, { $setOnInsert: { ...scope, monthKey: keyMonth, capCents, committedCents: 0 } }, { upsert: true, session }).exec();
      const budget = await RiderIncentiveBudget.findOneAndUpdate(
        { ...scope, monthKey: keyMonth, committedCents: { $lte: capCents - input.amountCents } },
        { $inc: { committedCents: input.amountCents } },
        { new: true, session },
      ).lean().exec();
      if (!budget) return;
      await RiderIncentiveEntry.create([{
        tenantId: input.tenantId,
        riderId: input.riderId,
        entryType: input.entryType,
        amountCents: input.amountCents,
        sourceKey: input.sourceKey,
        relatedRiderId: input.relatedRiderId || null,
        monthKey: keyMonth,
        status: "earned",
        metadata: input.metadata || {},
        createdAt: earnedAt,
      }], { session });
      awarded = true;
    });
    return awarded;
  } catch (error: any) {
    if (error?.code === 11000) {
      if (retry < 3) retryAfterDuplicate = true;
      else return false;
    } else throw error;
  } finally {
    await session.endSession();
  }
  if (retryAfterDuplicate) {
    await new Promise((resolve) => setTimeout(resolve, 10 * (retry + 1)));
    return awardIncentive(input, retry + 1);
  }
  return awarded;
}

async function awardReferralPair(input: { tenantId: mongoose.Types.ObjectId | null; referredRiderId: mongoose.Types.ObjectId; inviterId: mongoose.Types.ObjectId; completedDeliveries: number }, retry = 0) {
  const session = await mongoose.startSession();
  let awarded = false;
  let retryAfterDuplicate = false;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const keyMonth = monthKey(now);
      const referredSourceKey = `referral-milestone:${input.referredRiderId}:20:referred`;
      const inviterSourceKey = `referral-milestone:${input.referredRiderId}:20:inviter`;
      const existing = await RiderIncentiveEntry.find({ sourceKey: { $in: [referredSourceKey, inviterSourceKey] } }).select("sourceKey").session(session).lean().exec() as any[];
      const existingKeys = new Set(existing.map((entry) => entry.sourceKey));
      const entries = [
        !existingKeys.has(referredSourceKey) ? { tenantId: input.tenantId, riderId: input.referredRiderId, entryType: "referred_rider_bonus", amountCents: RIDER_INCENTIVE_POLICY.referralBonusCents, sourceKey: referredSourceKey, relatedRiderId: input.inviterId, monthKey: keyMonth, status: "earned", metadata: { completedDeliveries: input.completedDeliveries, threshold: RIDER_INCENTIVE_POLICY.referralDeliveries }, createdAt: now } : null,
        !existingKeys.has(inviterSourceKey) ? { tenantId: input.tenantId, riderId: input.inviterId, entryType: "referral_bonus", amountCents: RIDER_INCENTIVE_POLICY.referralBonusCents, sourceKey: inviterSourceKey, relatedRiderId: input.referredRiderId, monthKey: keyMonth, status: "earned", metadata: { completedDeliveries: input.completedDeliveries, threshold: RIDER_INCENTIVE_POLICY.referralDeliveries }, createdAt: now } : null,
      ].filter(Boolean) as any[];
      if (!entries.length) return;
      const amountCents = entries.reduce((sum, entry) => sum + entry.amountCents, 0);
      const capCents = monthlyCapCents();
      if (capCents < amountCents) return;
      await RiderIncentiveBudget.updateOne({ ...tenantFilter(null), monthKey: keyMonth }, { $setOnInsert: { ...tenantFilter(null), monthKey: keyMonth, capCents, committedCents: 0 } }, { upsert: true, session }).exec();
      const budget = await RiderIncentiveBudget.findOneAndUpdate({ ...tenantFilter(null), monthKey: keyMonth, committedCents: { $lte: capCents - amountCents } }, { $inc: { committedCents: amountCents } }, { new: true, session }).lean().exec();
      if (!budget) return;
      await RiderIncentiveEntry.create(entries, { session });
      awarded = true;
    });
    return awarded;
  } catch (error: any) {
    if (error?.code === 11000) {
      if (retry < 3) retryAfterDuplicate = true;
      else return false;
    } else throw error;
  } finally {
    await session.endSession();
  }
  if (retryAfterDuplicate) {
    await new Promise((resolve) => setTimeout(resolve, 10 * (retry + 1)));
    return awardReferralPair(input, retry + 1);
  }
  return awarded;
}

async function ensureReferralProfile(rider: any) {
  const existing = await RiderReferralProfile.findOne({ riderId: rider._id }).lean().exec() as any;
  if (existing) return existing;
  if (!referralEnabled() || rider.isTestRider) return null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `PIKI-${randomBytes(4).toString("hex").toUpperCase()}`;
    try {
      return await RiderReferralProfile.create({ tenantId: rider.tenantId || null, riderId: rider._id, code });
    } catch (error: any) {
      const raced = await RiderReferralProfile.findOne({ riderId: rider._id }).lean().exec();
      if (raced) return raced;
      if (error?.code !== 11000) throw error;
    }
  }
  throw new Error("RIDER_REFERRAL_CODE_GENERATION_FAILED");
}

export async function claimRiderReferralCode(rider: any, rawCode: string) {
  if (!referralEnabled()) return { ok: false as const, error: "REFERRAL_PROGRAM_NOT_ACTIVE" };
  if (!rider || rider.isTestRider) return { ok: false as const, error: "RIDER_NOT_ELIGIBLE" };
  const startAt = campaignStartAt();
  if (!startAt || !rider.createdAt || new Date(rider.createdAt).getTime() < startAt.getTime()) return { ok: false as const, error: "RIDER_NOT_ELIGIBLE" };
  const code = rawCode.trim().toUpperCase();
  if (!/^PIKI-[A-F0-9]{8}$/.test(code)) return { ok: false as const, error: "INVALID_REFERRAL_CODE" };
  const completed = await Order.countDocuments({ riderId: rider._id, status: "delivered", isTestOrder: { $ne: true } });
  if (completed > 0) return { ok: false as const, error: "REFERRAL_CODE_CLAIM_CLOSED" };
  const inviter = await RiderReferralProfile.findOne({ code, ...tenantFilter(rider.tenantId || null) }).lean().exec() as any;
  if (!inviter) return { ok: false as const, error: "REFERRAL_CODE_NOT_FOUND" };
  if (String(inviter.riderId) === String(rider._id)) return { ok: false as const, error: "SELF_REFERRAL_NOT_ALLOWED" };
  const profile = await ensureReferralProfile(rider);
  if (!profile) return { ok: false as const, error: "REFERRAL_PROGRAM_NOT_ACTIVE" };
  const claimed = await RiderReferralProfile.findOneAndUpdate(
    { riderId: rider._id, referredByRiderId: null, claimedAt: null },
    { $set: { referredByRiderId: inviter.riderId, claimedAt: new Date() } },
    { new: true },
  ).lean().exec();
  if (!claimed) return { ok: false as const, error: "REFERRAL_ALREADY_CLAIMED" };
  return { ok: true as const };
}

export async function trackRiderShiftStart(slot: any, rider: any, startedAt = new Date()) {
  if (!guaranteeEnabled() || !slot?._id || !rider?._id || rider.isTestRider) return;
  await RiderShiftIncentiveMetric.updateOne(
    { slotId: slot._id },
    { $setOnInsert: { tenantId: rider.tenantId || null, riderId: rider._id, slotId: slot._id, startedAt, completedAt: null, lastSampleAt: null, trackedSeconds: 0, sampleCount: 0, centralZoneViolation: false, maxGapSeconds: 0 } },
    { upsert: true },
  ).exec();
}

export async function trackRiderLocationForIncentive(riderId: mongoose.Types.ObjectId, coordinates: [number, number]) {
  if (!guaranteeEnabled()) return;
  const slot = await RiderSlot.findOne({ riderId, status: "active" }).sort({ updatedAt: -1 }).lean().exec() as any;
  if (!slot) return;
  const metric = await RiderShiftIncentiveMetric.findOne({ slotId: slot._id }).lean().exec() as any;
  if (!metric || metric.completedAt) return;
  const now = new Date();
  const previous = metric.lastSampleAt ? new Date(metric.lastSampleAt) : null;
  const gapSeconds = previous ? Math.max(0, (now.getTime() - previous.getTime()) / 1000) : 0;
  const coveredSeconds = previous && gapSeconds <= 90 ? Math.floor(gapSeconds) : 0;
  const zone = await Zone.findOne({ ...tenantFilter(slot.tenantId || null), slug: guaranteeZoneSlug(), isActive: true, polygon: { $geoIntersects: { $geometry: { type: "Point", coordinates } } } }).select("_id").lean().exec();
  const onDelivery = Boolean(await Order.exists({ riderId, isTestOrder: { $ne: true }, assignmentState: { $in: ["offered", "assigned"] }, status: { $nin: ["delivered", "cancelled"] } }));
  const update: Record<string, unknown> = {
    $set: { lastSampleAt: now, ...(!zone && !onDelivery ? { centralZoneViolation: true } : {}) },
    $inc: { sampleCount: 1, trackedSeconds: coveredSeconds },
    ...(gapSeconds > 0 ? { $max: { maxGapSeconds: Math.floor(gapSeconds) } } : {}),
  };
  await RiderShiftIncentiveMetric.updateOne({ _id: metric._id }, update).exec();
}

function madridLocalToUtc(date: string, time: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, 0);
    const difference = target - observed;
    guess += difference;
    if (difference === 0) break;
  }
  return new Date(guess);
}

export async function settleHourlyGuarantee(slot: any, completedAt = new Date()) {
  if (!guaranteeEnabled() || !slot?._id) return { awardedCents: 0, status: "disabled" as const };
  const metric = await RiderShiftIncentiveMetric.findOne({ slotId: slot._id }).lean().exec() as any;
  if (!metric || !metric.startedAt) return { awardedCents: 0, status: "tracking_missing" as const };
  const startMinute = Number(slot.startTime?.slice(0, 2)) * 60 + Number(slot.startTime?.slice(3, 5));
  const endMinute = Number(slot.endTime?.slice(0, 2)) * 60 + Number(slot.endTime?.slice(3, 5));
  const scheduledMinutes = endMinute - startMinute;
  if (scheduledMinutes !== RIDER_INCENTIVE_POLICY.requiredShiftHours * 60) return { awardedCents: 0, status: "not_a_four_hour_shift" as const };
  const scheduledStart = madridLocalToUtc(slot.date, slot.startTime);
  const scheduledEnd = madridLocalToUtc(slot.date, slot.endTime);
  const durationSeconds = Math.floor((scheduledEnd.getTime() - scheduledStart.getTime()) / 1000);
  const actualStartMs = new Date(metric.startedAt).getTime();
  const completionMs = completedAt.getTime();
  const fullAttendance = actualStartMs >= scheduledStart.getTime() - 30_000
    && actualStartMs <= scheduledStart.getTime() + 30_000
    && completionMs >= scheduledEnd.getTime()
    && Number(metric.trackedSeconds || 0) >= durationSeconds - 90
    && Number(metric.maxGapSeconds || 0) <= 90
    && Number(metric.sampleCount || 0) >= 2
    && metric.lastSampleAt
    && new Date(metric.lastSampleAt).getTime() >= scheduledEnd.getTime() - 90_000;
  const decisions = await DispatchDecision.find({ riderId: slot.riderId, createdAt: { $gte: scheduledStart, $lte: completedAt }, outcome: { $in: ["accepted", "expired", "rejected"] } }).select("orderId outcome actorRole").lean().exec() as any[];
  const decisionOrderIds = [...new Set(decisions.map((decision) => decision.orderId).filter(Boolean))];
  const testOrderIds = new Set((await Order.find({ _id: { $in: decisionOrderIds }, isTestOrder: true }).select("_id").lean().exec()).map((order: any) => String(order._id)));
  const relevantDecisions = decisions.filter((decision) => !testOrderIds.has(String(decision.orderId)) && (decision.outcome === "expired" || (decision.outcome === "accepted" && decision.actorRole === "rider") || (decision.outcome === "rejected" && decision.actorRole === "rider")));
  const accepted = relevantDecisions.filter((decision) => decision.outcome === "accepted" && decision.actorRole === "rider").length;
  const totalOffers = relevantDecisions.length;
  const eligible = Boolean(fullAttendance && !metric.centralZoneViolation && isAcceptanceRateEligible(accepted, totalOffers));
  if (!eligible) return { awardedCents: 0, status: "requirements_not_met" as const, acceptedOffers: accepted, totalOffers, centralZoneOk: !metric.centralZoneViolation, fullAttendance: Boolean(fullAttendance) };
  const orders = await Order.find({ riderId: slot.riderId, ...tenantFilter(slot.tenantId || null), status: "delivered", isTestOrder: { $ne: true }, deliveredAt: { $gte: new Date(metric.startedAt), $lte: completedAt } }).select("publicCode subtotalCents deliveryFeeCents serviceFeeCents routeDistanceKm").lean().exec() as any[];
  const deliveryEarningsCents = calculateSettlement(orders.map((order) => ({
    publicCode: String(order.publicCode || order._id),
    subtotalCents: Number(order.subtotalCents || 0),
    deliveryFeeCents: Number(order.deliveryFeeCents || 0),
    serviceFeeCents: Number(order.serviceFeeCents || 0),
    distanceKm: Number(order.routeDistanceKm || 0),
  }))).totals.riderTotalCents;
  const topUpCents = calculateHourlyGuaranteeTopUp({ eligible: true, scheduledHours: RIDER_INCENTIVE_POLICY.requiredShiftHours, completedHours: RIDER_INCENTIVE_POLICY.requiredShiftHours, deliveryEarningsCents });
  if (!topUpCents) return { awardedCents: 0, status: "delivery_earnings_met_floor" as const, deliveryEarningsCents };
  const tenantId = asObjectId(slot.tenantId);
  const issued = await awardIncentive({ tenantId, riderId: new mongoose.Types.ObjectId(String(slot.riderId)), entryType: "hourly_guarantee", amountCents: topUpCents, sourceKey: `hourly-guarantee:${slot._id}:policy-1`, metadata: { slotId: String(slot._id), deliveryEarningsCents, guaranteedFloorCents: RIDER_INCENTIVE_POLICY.hourlyRateCents * RIDER_INCENTIVE_POLICY.requiredShiftHours, acceptedOffers: accepted, totalOffers, formulaVersion: "piki-phase1-2026-09" }, earnedAt: completedAt });
  return { awardedCents: issued ? topUpCents : 0, status: issued ? "earned" as const : "budget_limit_or_already_earned" as const, deliveryEarningsCents };
}

export async function completeRiderShiftIncentiveTracking(slot: any, completedAt = new Date()) {
  if (!slot?._id) return { awardedCents: 0, status: "slot_missing" as const };
  await RiderShiftIncentiveMetric.updateOne({ slotId: slot._id }, { $set: { completedAt } }).exec();
  return settleHourlyGuarantee(slot, completedAt);
}

export async function awardRiderRecruitmentMilestones(riderId: mongoose.Types.ObjectId) {
  if (!referralEnabled()) return;
  const rider = await Rider.findById(riderId).lean().exec() as any;
  if (!rider || rider.isTestRider) return;
  const profile = await ensureReferralProfile(rider);
  if (!profile) return;
  const completedDeliveries = await Order.countDocuments({ riderId, ...tenantFilter(rider.tenantId || null), status: "delivered", isTestOrder: { $ne: true } });
  const referred = Boolean(profile.referredByRiderId);
  const awards = getRecruitmentAwards(completedDeliveries, referred);
  const startAt = campaignStartAt();
  const createdDuringCampaign = Boolean(startAt && rider.createdAt && new Date(rider.createdAt).getTime() >= startAt.getTime());
  if (awards.acquisitionBonusCents && createdDuringCampaign) {
    await awardIncentive({ tenantId: rider.tenantId || null, riderId, entryType: "acquisition_bonus", amountCents: awards.acquisitionBonusCents, sourceKey: `rider-acquisition:${riderId}:deliveries-${RIDER_INCENTIVE_POLICY.acquisitionDeliveries}`, metadata: { completedDeliveries, threshold: RIDER_INCENTIVE_POLICY.acquisitionDeliveries } });
  }
  if (awards.referredRiderBonusCents && profile.referredByRiderId && createdDuringCampaign) {
    const referredRiderId = new mongoose.Types.ObjectId(String(riderId));
    const inviterId = new mongoose.Types.ObjectId(String(profile.referredByRiderId));
    await awardReferralPair({ tenantId: rider.tenantId || null, referredRiderId, inviterId, completedDeliveries });
  }
}

export async function loadRiderIncentiveSnapshot(rider: any) {
  const program = incentiveProgramStatus();
  if (!rider || rider.isTestRider) return { program, referral: null, wallet: { earnedCents: 0, paidCents: 0, entries: [] }, guarantee: { active: program.hourlyGuaranteeEnabled, currentShift: null } };
  const referralProfile = program.referralsEnabled ? await ensureReferralProfile(rider) : await RiderReferralProfile.findOne({ riderId: rider._id }).lean().exec() as any;
  const completedDeliveries = await Order.countDocuments({ riderId: rider._id, ...tenantFilter(rider.tenantId || null), status: "delivered", isTestOrder: { $ne: true } });
  const referralCounts = referralProfile
    ? await RiderReferralProfile.countDocuments({ referredByRiderId: rider._id, ...tenantFilter(rider.tenantId || null) })
    : 0;
  const [entries, budget, activeSlot] = await Promise.all([
    RiderIncentiveEntry.find({ riderId: rider._id, ...tenantFilter(rider.tenantId || null) }).sort({ createdAt: -1 }).limit(50).lean().exec(),
    RiderIncentiveBudget.findOne({ ...tenantFilter(null), monthKey: monthKey() }).lean().exec(),
    RiderSlot.findOne({ riderId: rider._id, status: "active" }).sort({ updatedAt: -1 }).lean().exec(),
  ]);
  const currentSlot = activeSlot as any;
  const totals = await RiderIncentiveEntry.aggregate([{ $match: { riderId: rider._id, ...tenantFilter(rider.tenantId || null) } }, { $group: { _id: null, earnedCents: { $sum: { $cond: [{ $eq: ["$status", "earned"] }, "$amountCents", 0] } }, paidCents: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, "$amountCents", 0] } } } }]).exec() as any[];
  const earnedCents = Number(totals[0]?.earnedCents || 0);
  const paidCents = Number(totals[0]?.paidCents || 0);
  const progress = Math.min(completedDeliveries, RIDER_INCENTIVE_POLICY.acquisitionDeliveries);
  let currentShift: Record<string, unknown> | null = null;
  if (currentSlot) {
    const metric = await RiderShiftIncentiveMetric.findOne({ slotId: currentSlot._id }).lean().exec() as any;
    currentShift = { date: currentSlot.date, startTime: currentSlot.startTime, endTime: currentSlot.endTime, zoneSlug: currentSlot.zoneSlug, sampleCount: Number(metric?.sampleCount || 0), trackedSeconds: Number(metric?.trackedSeconds || 0), centralZoneOk: metric && Number(metric.sampleCount || 0) > 0 ? !metric.centralZoneViolation : null };
  }
  return {
    program: { ...program, budgetCommittedCents: Number((budget as any)?.committedCents || 0), budgetRemainingCents: Math.max(0, program.monthlyCapCents - Number((budget as any)?.committedCents || 0)) },
    referral: {
      code: referralProfile?.code || null,
      referredBy: referralProfile?.referredByRiderId ? "claimed" : null,
      completedDeliveries,
      eligibleToClaim: Boolean(campaignStartAt() && rider.createdAt && new Date(rider.createdAt).getTime() >= campaignStartAt()!.getTime() && !referralProfile?.referredByRiderId && completedDeliveries === 0),
      acquisitionProgress: progress,
      acquisitionTarget: RIDER_INCENTIVE_POLICY.acquisitionDeliveries,
      referralProgress: referralProfile?.referredByRiderId ? Math.min(completedDeliveries, RIDER_INCENTIVE_POLICY.referralDeliveries) : null,
      referralTarget: referralProfile?.referredByRiderId ? RIDER_INCENTIVE_POLICY.referralDeliveries : null,
      successfulInvitations: referralCounts,
    },
    wallet: { earnedCents, paidCents, entries },
    guarantee: { active: program.hourlyGuaranteeEnabled, currentShift },
  };
}
