import mongoose, { Schema } from "mongoose";

const riderReferralProfileSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, unique: true, index: true },
  code: { type: String, required: true, uppercase: true, trim: true, unique: true, index: true },
  referredByRiderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true },
  claimedAt: { type: Date, default: null },
}, { timestamps: true, collection: "rider_referral_profiles" });
riderReferralProfileSchema.index({ tenantId: 1, referredByRiderId: 1, createdAt: -1 });

const riderShiftIncentiveMetricSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  slotId: { type: Schema.Types.ObjectId, ref: "RiderSlot", required: true, unique: true, index: true },
  startedAt: { type: Date, required: true },
  completedAt: { type: Date, default: null },
  lastSampleAt: { type: Date, default: null },
  trackedSeconds: { type: Number, default: 0, min: 0 },
  sampleCount: { type: Number, default: 0, min: 0 },
  centralZoneViolation: { type: Boolean, default: false },
  maxGapSeconds: { type: Number, default: 0, min: 0 },
}, { timestamps: true, collection: "rider_shift_incentive_metrics" });
riderShiftIncentiveMetricSchema.index({ tenantId: 1, riderId: 1, startedAt: -1 });

const riderIncentiveEntrySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  entryType: { type: String, enum: ["acquisition_bonus", "referral_bonus", "referred_rider_bonus", "hourly_guarantee"], required: true, index: true },
  amountCents: { type: Number, required: true, min: 0 },
  sourceKey: { type: String, required: true, unique: true, index: true },
  relatedRiderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true },
  monthKey: { type: String, required: true, index: true },
  status: { type: String, enum: ["earned", "paid", "reversed"], default: "earned", index: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: "rider_incentive_entries" });
riderIncentiveEntrySchema.index({ tenantId: 1, riderId: 1, createdAt: -1 });

const riderIncentiveBudgetSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null },
  monthKey: { type: String, required: true },
  capCents: { type: Number, required: true, min: 1 },
  committedCents: { type: Number, required: true, min: 0, default: 0 },
  reservedCents: { type: Number, required: true, min: 0, default: 0 },
}, { timestamps: true, collection: "rider_incentive_budgets" });
riderIncentiveBudgetSchema.index({ tenantId: 1, monthKey: 1 }, { unique: true });

const riderShiftGuaranteeReservationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  slotId: { type: Schema.Types.ObjectId, ref: "RiderSlot", required: true, unique: true, index: true },
  monthKey: { type: String, required: true, index: true },
  slotDate: { type: String, required: true },
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
  zoneSlug: { type: String, required: true },
  amountCents: { type: Number, required: true, min: 1 },
  guaranteedFloorCents: { type: Number, required: true, min: 1 },
  payoutCents: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ["reserved", "released", "settled"], required: true, default: "reserved", index: true },
  reservedAt: { type: Date, default: Date.now },
  releasedAt: { type: Date, default: null },
  settledAt: { type: Date, default: null },
}, { timestamps: true, collection: "rider_shift_guarantee_reservations" });
riderShiftGuaranteeReservationSchema.index({ monthKey: 1, status: 1, createdAt: -1 });

export const RiderReferralProfile = mongoose.models.RiderReferralProfile || mongoose.model("RiderReferralProfile", riderReferralProfileSchema);
export const RiderShiftIncentiveMetric = mongoose.models.RiderShiftIncentiveMetric || mongoose.model("RiderShiftIncentiveMetric", riderShiftIncentiveMetricSchema);
export const RiderIncentiveEntry = mongoose.models.RiderIncentiveEntry || mongoose.model("RiderIncentiveEntry", riderIncentiveEntrySchema);
export const RiderIncentiveBudget = mongoose.models.RiderIncentiveBudget || mongoose.model("RiderIncentiveBudget", riderIncentiveBudgetSchema);
export const RiderShiftGuaranteeReservation = mongoose.models.RiderShiftGuaranteeReservation || mongoose.model("RiderShiftGuaranteeReservation", riderShiftGuaranteeReservationSchema);
