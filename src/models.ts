import mongoose, { InferSchemaType, Schema } from "mongoose";
import { RiderIncentiveBudget, RiderIncentiveEntry, RiderReferralProfile, RiderShiftIncentiveMetric } from "./riderIncentivesModels.js";

const tenantSchema = new Schema({
  slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
  name: { type: String, required: true, trim: true },
  status: { type: String, enum: ["active", "suspended", "archived"], default: "active", index: true },
  isPlatformTenant: { type: Boolean, default: false, index: true },
  settings: { type: Schema.Types.Mixed, default: { limits: { maxRiders: 100000, maxDailySlots: 100000, maxSlotsPerRiderPerDay: 3 } } },
}, { timestamps: true, collection: "tenants" });
tenantSchema.index({ status: 1, createdAt: -1 });
const tenantMembershipSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, index: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true, index: true },
  role: { type: String, enum: ["owner", "admin", "partner", "rider", "fleet", "zone_manager", "commercial"], required: true },
  status: { type: String, enum: ["active", "suspended", "revoked"], default: "active", index: true },
  scopes: { type: [String], default: [] },
}, { timestamps: true, collection: "tenant_memberships" });
tenantMembershipSchema.index({ tenantId: 1, employeeId: 1 }, { unique: true });
const geoPoint = new Schema({ type: { type: String, enum: ["Point"], default: "Point" }, coordinates: { type: [Number], default: [0, 0] } }, { _id: false });
const menuModifier = new Schema({ id: { type: String, required: true }, name: { type: String, required: true }, description: { type: String, default: "" }, price: { type: Number, required: true, min: 0, default: 0 }, required: { type: Boolean, default: false }, minSelections: { type: Number, min: 0, default: 0 }, maxSelections: { type: Number, min: 1, default: 1 }, options: { type: [Schema.Types.Mixed], default: [] } }, { _id: false });
const menuItem = new Schema({ id: { type: String, required: true }, name: { type: String, required: true }, description: { type: String, default: "" }, price: { type: Number, required: true, min: 0 }, category: { type: String, default: "General" }, image: { type: String, default: "" }, allergens: { type: [String], default: [] }, modifiers: { type: [menuModifier], default: [] }, available: { type: Boolean, default: true }, vegetarian: { type: Boolean, default: false }, popular: { type: Boolean, default: false } }, { _id: false });
const partnerAssetSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
  organizationKey: { type: String, required: true, index: true },
  folderKey: { type: String, required: true, index: true },
  locality: { type: String, required: true, index: true },
  kind: { type: String, enum: ["menu_image", "menu_file", "restaurant_image", "document"], required: true },
  fileName: { type: String, required: true, trim: true },
  mimeType: { type: String, enum: ["image/webp", "image/jpeg", "image/png", "image/gif", "application/pdf"], required: true },
  sizeBytes: { type: Number, required: true, min: 1, max: 4_194_304 },
  sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/i },
  contentBase64: { type: String, required: true, select: false },
  scanStatus: { type: String, enum: ["clean", "rejected"], default: "clean", index: true },
  scanEngine: { type: String, default: "ClamAV" },
  scannedAt: { type: Date, default: null },
}, { timestamps: true, collection: "partner_assets" });
partnerAssetSchema.index({ restaurantId: 1, kind: 1, createdAt: -1 });
const partnerLocalityGroupSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  localityKey: { type: String, required: true, index: true },
  localityName: { type: String, required: true },
  province: { type: String, default: "Valencia" },
  restaurantIds: { type: [Schema.Types.ObjectId], ref: "Restaurant", default: [] },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, collection: "partner_locality_groups" });
const menuImportDraftSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
  sourceAssetId: { type: Schema.Types.ObjectId, ref: "PartnerAsset", required: true, index: true },
  sourceFileName: { type: String, required: true, maxlength: 180 },
  extractionMethod: { type: String, enum: ["pdf-text", "ocr"], required: true },
  extractedLines: { type: Number, default: 0, min: 0 },
  warnings: { type: [String], default: [] },
  textPreview: { type: String, default: "", maxlength: 6000 },
  items: { type: [Schema.Types.Mixed], default: [] },
  status: { type: String, enum: ["draft", "published", "rejected"], default: "draft", index: true },
  createdBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null },
  publishedAt: { type: Date, default: null },
}, { timestamps: true, collection: "menu_import_drafts" });
menuImportDraftSchema.index({ restaurantId: 1, createdAt: -1 });

const partnerDocument = new Schema({ type: { type: String, enum: ["tax_id", "bank_certificate", "insurance", "activity_license", "food_sanitary_authorization", "identity", "other"], required: true }, fileName: { type: String, required: true }, mimeType: { type: String, required: true }, sizeBytes: { type: Number, required: true, max: 2_500_000 }, sha256: { type: String, required: true }, documentRequestId: { type: Schema.Types.ObjectId, ref: "DocumentRequest", default: null, index: true }, contentBase64: { type: String, required: true, select: false }, status: { type: String, enum: ["received", "approved", "rejected"], default: "received" }, reviewNotes: { type: String, default: "" }, reviewedAt: { type: Date, default: null }, reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, viewedAt: { type: Date, default: null }, viewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null } }, { _id: true });
const partnerProfile = new Schema({ legalName: { type: String, required: true, trim: true }, taxId: { type: String, required: true, uppercase: true, trim: true, index: true }, legalForm: { type: String, enum: ["autonomo", "sl", "sa", "cooperativa", "otra"], required: true }, representativeName: { type: String, required: true, trim: true }, representativeRole: { type: String, required: true, trim: true }, representativeDocument: { type: String, required: true, trim: true }, fiscalAddress: { type: String, required: true, trim: true }, operatingAddress: { type: String, required: true, trim: true }, postalCode: { type: String, required: true, trim: true }, city: { type: String, required: true, trim: true }, province: { type: String, required: true, trim: true }, iban: { type: String, required: true, uppercase: true, trim: true }, bankAccountHolder: { type: String, required: true, trim: true }, cuisine: { type: String, required: true, trim: true }, vatRate: { type: Number, enum: [4, 10, 21], required: true }, commissionAccepted: { type: Boolean, required: true }, commissionRateBps: { type: Number, default: 1800, min: 0, max: 10000 }, termsAcceptedAt: { type: Date, required: true }, contractAcceptedAt: { type: Date, required: true }, privacyAcceptedAt: { type: Date, required: true }, dataProcessingAcceptedAt: { type: Date, required: true }, pdaUnits: { type: Number, required: true, min: 1, max: 50 }, pdaUnitCostCents: { type: Number, required: true, enum: [30000] }, pdaCostAcceptedAt: { type: Date, required: true }, openingHours: { type: Schema.Types.Mixed, required: true }, documents: { type: [partnerDocument], default: [] } }, { _id: false });
const selectedOrderOption = new Schema({ groupId: { type: String, required: true }, groupName: { type: String, required: true }, optionId: { type: String, required: true }, optionName: { type: String, required: true }, unitPriceCents: { type: Number, min: 0, required: true } }, { _id: false });
const orderItem = new Schema({ itemId: { type: String, required: true }, name: { type: String, required: true }, quantity: { type: Number, min: 1, max: 20, required: true }, unitPriceCents: { type: Number, min: 0, required: true }, selectedOptions: { type: [selectedOrderOption], default: [] } }, { _id: false });
const orderEvent = new Schema({ status: { type: String, required: true }, actorRole: { type: String, required: true }, reason: { type: String, default: "" }, at: { type: Date, default: Date.now } }, { _id: false });
const cashLedgerEntrySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  // Handover entries reconcile a rider balance and therefore do not belong to a single order.
  orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  actorRole: { type: String, enum: ["rider", "admin", "fleet"], required: true },
  direction: { type: String, enum: ["in", "out"], required: true },
  amountCents: { type: Number, required: true, min: 0 },
  reason: { type: String, enum: ["customer_cash_collection", "cash_handover", "cash_adjustment"], required: true },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  note: { type: String, default: "" },
  reference: { type: String, default: "", index: true },
}, { timestamps: true, collection: "cash_ledger_entries" });
cashLedgerEntrySchema.index({ riderId: 1, createdAt: -1 });

const marketplaceLedgerEntrySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
  currency: { type: String, enum: ["eur"], default: "eur" },
  accountType: { type: String, enum: ["customer_cash", "partner_payable", "rider_payable", "platform_revenue"], required: true, index: true },
  direction: { type: String, enum: ["debit", "credit"], required: true },
  amountCents: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true },
  source: { type: String, required: true },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
}, { timestamps: true, collection: "marketplace_ledger_entries" });
marketplaceLedgerEntrySchema.index({ restaurantId: 1, createdAt: -1 });
const riderPayoutBatchSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  orderIds: { type: [Schema.Types.ObjectId], ref: "Order", default: [] },
  startsAt: { type: Date, required: true, index: true },
  endsAt: { type: Date, required: true, index: true },
  amountCents: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ["eur"], default: "eur" },
  status: { type: String, enum: ["prepared", "approved", "paid", "failed", "cancelled"], default: "prepared", index: true },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  externalTransferId: { type: String, default: null, index: true },
}, { timestamps: true, collection: "rider_payout_batches" });
riderPayoutBatchSchema.index({ riderId: 1, startsAt: 1, endsAt: 1 }, { unique: true });
const partnerPayoutBatchSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
  orderIds: { type: [Schema.Types.ObjectId], ref: "Order", default: [] },
  startsAt: { type: Date, required: true, index: true },
  endsAt: { type: Date, required: true, index: true },
  amountCents: { type: Number, required: true, min: 0 },
  currency: { type: String, enum: ["eur"], default: "eur" },
  status: { type: String, enum: ["prepared", "approved", "paid", "failed", "cancelled"], default: "prepared", index: true },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  externalTransferId: { type: String, default: null, index: true },
}, { timestamps: true, collection: "partner_payout_batches" });
partnerPayoutBatchSchema.index({ restaurantId: 1, startsAt: 1, endsAt: 1 }, { unique: true });
const stripeEventSchema = new Schema({ stripeEventId: { type: String, required: true, unique: true, index: true }, type: { type: String, required: true }, orderCode: { type: String, default: null }, receivedAt: { type: Date, default: Date.now }, processingStatus: { type: String, enum: ["processing", "processed", "failed"], default: "processed", index: true }, processingStartedAt: { type: Date, default: null, index: true }, processedAt: { type: Date, default: null }, failedAt: { type: Date, default: null }, lastError: { type: String, default: null, maxlength: 120 } }, { timestamps: true, collection: "stripe_events" });
const passkeyCredentialSchema = new Schema({
  ownerType: { type: String, enum: ["customer", "employee"], required: true, index: true },
  ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
  credentialId: { type: String, required: true, unique: true, index: true },
  publicKey: { type: Buffer, required: true },
  counter: { type: Number, required: true, default: 0 },
  transports: { type: [String], default: [] },
  deviceName: { type: String, default: "" },
}, { timestamps: true, collection: "passkey_credentials" });
passkeyCredentialSchema.index({ ownerType: 1, ownerId: 1 });
// Challenges must survive API restarts and concurrent replicas. They are
// single-use and are removed by MongoDB once their short validity expires.
const passkeyChallengeSchema = new Schema({
  ownerType: { type: String, enum: ["customer", "employee"], required: true, index: true },
  ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
  kind: { type: String, enum: ["registration", "authentication"], required: true, index: true },
  challenge: { type: String, required: true },
  expiresAt: { type: Date, required: true, index: true, expires: 0 },
  consumedAt: { type: Date, default: null, index: true },
}, { timestamps: true, collection: "passkey_challenges" });
passkeyChallengeSchema.index({ ownerType: 1, ownerId: 1, kind: 1, createdAt: -1 });
const realtimeEventSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  channel: { type: String, enum: ["partner", "fleet", "admin", "rider", "customer"], required: true, index: true },
  audienceKey: { type: String, required: true, index: true },
  type: { type: String, required: true, index: true },
  payload: { type: Schema.Types.Mixed, required: true },
  dedupeKey: { type: String },
}, { timestamps: true, collection: "realtime_events" });
realtimeEventSchema.index({ channel: 1, audienceKey: 1, _id: 1 });
realtimeEventSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });
realtimeEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86_400 });
const trackingSessionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  shiftId: { type: Schema.Types.ObjectId, ref: "RiderSlot", default: null, index: true },
  status: { type: String, enum: ["active", "stopped", "degraded"], default: "active", index: true },
  platform: { type: String, enum: ["ios", "android", "web"], required: true },
  appVersion: { type: String, default: "unknown", maxlength: 80 },
  consentVersion: { type: String, required: true, maxlength: 80 },
  startedAt: { type: Date, default: Date.now, index: true },
  stoppedAt: { type: Date, default: null },
  lastSampleAt: { type: Date, default: null },
  lastAckAt: { type: Date, default: null },
}, { timestamps: true, collection: "tracking_sessions" });
trackingSessionSchema.index({ riderId: 1, status: 1, startedAt: -1 });
const locationSampleSchema = new Schema({
  sampleId: { type: String, required: true, unique: true, index: true },
  sessionId: { type: Schema.Types.ObjectId, ref: "TrackingSession", required: true, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  point: { type: geoPoint, required: true },
  accuracyMeters: { type: Number, required: true, min: 0, max: 10_000 },
  recordedAt: { type: Date, required: true, index: true },
  receivedAt: { type: Date, default: Date.now },
}, { timestamps: true, collection: "location_samples" });
locationSampleSchema.index({ riderId: 1, recordedAt: -1 });
locationSampleSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 2_592_000 });
const pushSubscriptionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  surface: { type: String, enum: ["customer", "partner", "fleet", "admin", "rider"], required: true, index: true },
  ownerType: { type: String, enum: ["customer", "employee"], required: true, index: true },
  ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
  provider: { type: String, enum: ["webpush", "fcm"], default: "webpush", required: true, index: true },
  platform: { type: String, enum: ["web", "android", "ios"], default: "web", required: true },
  endpoint: { type: String, default: null, select: false },
  endpointHash: { type: String, required: true, index: true },
  keys: {
    p256dh: { type: String, default: null, select: false },
    auth: { type: String, default: null, select: false },
  },
  fcmToken: { type: String, default: null, select: false },
  expirationTime: { type: Number, default: null },
  status: { type: String, enum: ["active", "revoked", "expired", "failed"], default: "active", index: true },
  failureCount: { type: Number, default: 0 },
  lastSuccessAt: { type: Date, default: null },
  lastFailureAt: { type: Date, default: null },
}, { timestamps: true, collection: "push_subscriptions" });
pushSubscriptionSchema.index({ ownerType: 1, ownerId: 1, surface: 1, endpointHash: 1 }, { unique: true });
pushSubscriptionSchema.index({ surface: 1, status: 1, updatedAt: -1 });
const notificationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  surface: { type: String, enum: ["customer", "partner", "fleet", "admin", "rider"], required: true, index: true },
  ownerType: { type: String, enum: ["customer", "employee"], required: true, index: true },
  ownerId: { type: Schema.Types.ObjectId, required: true, index: true },
  category: { type: String, required: true, index: true },
  title: { type: String, required: true, maxlength: 120 },
  body: { type: String, required: true, maxlength: 240 },
  url: { type: String, required: true, maxlength: 500 },
  entityType: { type: String, default: "", maxlength: 40 },
  entityId: { type: String, default: "", maxlength: 120 },
  dedupeKey: { type: String, required: true, unique: true, index: true },
  readAt: { type: Date, default: null, index: true },
  pushStatus: { type: String, enum: ["pending", "sending", "retry", "sent", "unavailable", "dead"], default: "pending", index: true },
  pushAttempts: { type: Number, default: 0 },
  pushNextAttemptAt: { type: Date, default: Date.now, index: true },
  pushLockUntil: { type: Date, default: null, index: true },
}, { timestamps: true, collection: "notifications" });
notificationSchema.index({ ownerType: 1, ownerId: 1, surface: 1, tenantId: 1, _id: -1 });
notificationSchema.index({ pushStatus: 1, pushNextAttemptAt: 1, pushLockUntil: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7_776_000 });
const riderAssignmentReservationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true, index: true },
  slot: { type: Number, enum: [1, 2], required: true },
  mode: { type: String, enum: ["normal", "saturated"], required: true },
  status: { type: String, enum: ["reserved", "released", "completed", "cancelled"], default: "reserved", index: true },
  expiresAt: { type: Date, default: null, index: true },
}, { timestamps: true, collection: "rider_assignment_reservations" });
riderAssignmentReservationSchema.index({ riderId: 1, status: 1, slot: 1 }, { unique: true, partialFilterExpression: { status: "reserved" } });
const dispatchDecisionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true }, riderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true }, algorithmVersion: { type: String, required: true }, score: { type: Number, required: true }, pickupDistanceKm: { type: Number, required: true }, customerEtaMinutes: { type: Number, required: true }, totalEtaMinutes: { type: Number, required: true }, pickupEtaMinutes: { type: Number, required: true }, routeDistanceKm: { type: Number, default: null }, requiredVehicleClasses: { type: [String], default: [] }, reasons: { type: [String], default: [] }, outcome: { type: String, enum: ["preview", "offered", "accepted", "rejected", "expired", "race_lost"], required: true }, actorRole: { type: String, default: "system" } }, { timestamps: true, collection: "dispatch_decisions" });
const dispatchOutboxSchema = new Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  type: { type: String, enum: ["dispatch.order.ready"], required: true, index: true },
  payloadVersion: { type: Number, required: true, default: 1 },
  payload: { type: Schema.Types.Mixed, default: {} },
  idempotencyKey: { type: String, required: true, unique: true, index: true },
  availableAt: { type: Date, required: true, default: Date.now, index: true },
  attempts: { type: Number, required: true, default: 0, min: 0 },
  status: { type: String, enum: ["pending", "processing", "retry", "processed", "dead_letter"], required: true, default: "pending", index: true },
  leaseOwner: { type: String, default: null, index: true },
  leaseUntil: { type: Date, default: null, index: true },
  lastError: { type: String, default: null, maxlength: 1000 },
  processedAt: { type: Date, default: null },
  deadLetteredAt: { type: Date, default: null, index: true },
}, { timestamps: true, collection: "dispatch_outbox" });
dispatchOutboxSchema.index({ status: 1, availableAt: 1, leaseUntil: 1 });
dispatchOutboxSchema.index({ orderId: 1, type: 1, createdAt: -1 });
const riderOrderMessageSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  senderRole: { type: String, enum: ["rider", "customer", "admin"], required: true },
  body: { type: String, required: true, trim: true, maxlength: 500 },
}, { timestamps: true, collection: "rider_order_messages" });
riderOrderMessageSchema.index({ orderId: 1, createdAt: 1 });
const riderIncidentSchema = new Schema({ tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true }, reason: { type: String, required: true, enum: ["late_acceptance", "late_delivery", "no_show", "unsafe_driving", "fraud_signal", "customer_complaint", "document_expired", "other"] }, evidence: { type: [String], default: [] }, acknowledged: { type: Boolean, default: false }, resolved: { type: Boolean, default: false }, occurredAt: { type: Date, default: Date.now }, createdByRole: { type: String, required: true } }, { timestamps: true, collection: "rider_incidents" });
riderIncidentSchema.index({ riderId: 1, occurredAt: -1 });
const supportMessageSchema = new Schema({ senderRole: { type: String, enum: ["support", "rider", "system"], required: true }, senderEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, senderName: { type: String, default: "", trim: true, maxlength: 160 }, body: { type: String, required: true, trim: true, maxlength: 2000 }, createdAt: { type: Date, default: Date.now } }, { _id: true });
const supportActionSchema = new Schema({ action: { type: String, required: true }, actorEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, reason: { type: String, default: "" }, metadata: { type: Schema.Types.Mixed, default: {} }, createdAt: { type: Date, default: Date.now } }, { _id: true });
const supportTicketSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, customerId: { type: String, default: "", trim: true, index: true }, ticketNumber: { type: String, required: true, unique: true, index: true }, orderReference: { type: String, default: "", trim: true, index: true }, orderId: { type: Schema.Types.ObjectId, ref: "Order", default: null, index: true }, reporterEmail: { type: String, default: "", lowercase: true, trim: true, index: true }, sourceSurface: { type: String, enum: ["customer", "partner", "fleet", "admin", "rider", "support"], default: "admin", index: true }, sourceRole: { type: String, default: "", index: true }, category: { type: String, enum: ["order", "rider", "partner", "account", "technical", "billing", "finance", "other"], default: "order", index: true }, priority: { type: String, enum: ["low", "normal", "high", "urgent"], default: "normal", index: true }, status: { type: String, enum: ["open", "in_progress", "waiting", "resolved", "closed"], default: "open", index: true }, subject: { type: String, required: true, trim: true, maxlength: 180 }, description: { type: String, required: true, trim: true, maxlength: 4000 }, assignedTo: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true }, riderTypingAt: { type: Date, default: null }, agentTypingAt: { type: Date, default: null }, messages: { type: [supportMessageSchema], default: [] }, actions: { type: [supportActionSchema], default: [] }, createdBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, resolvedAt: { type: Date, default: null } }, { timestamps: true, collection: "support_tickets" });
supportTicketSchema.index({ status: 1, priority: 1, updatedAt: -1 });
const riderDocumentSchema = new Schema({ type: { type: String, enum: ["identity", "residence_permit", "social_security_number", "bank_certificate", "profile_photo", "driving_license", "insurance", "vehicle_registration", "vehicle_technical_sheet", "scooter_responsible_declaration", "dgt_mvp_homologation", "work_authorization_confirmation", "ppe_and_safety", "other"], required: true }, fileName: { type: String, required: true, trim: true }, mimeType: { type: String, required: true, trim: true }, sizeBytes: { type: Number, required: true, min: 1, max: 2_500_000 }, sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/i }, documentRequestId: { type: Schema.Types.ObjectId, ref: "DocumentRequest", default: null, index: true }, contentBase64: { type: String, required: true, select: false }, status: { type: String, enum: ["received", "approved", "rejected"], default: "received" }, reviewNotes: { type: String, default: "" }, reviewedAt: { type: Date, default: null }, reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, viewedAt: { type: Date, default: null }, viewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null } }, { _id: true });
const riderApplicationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, name: { type: String, required: true, trim: true }, email: { type: String, required: true, lowercase: true, trim: true, index: true }, phone: { type: String, required: true, trim: true }, city: { type: String, required: true, trim: true }, vehicle: { type: String, enum: ["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"], required: true }, availability: { type: String, required: true, trim: true }, socialSecurityNumber: { type: String, required: true, trim: true }, identityVerificationMethod: { type: String, enum: ["online_scan"], required: true }, identityVerificationStatus: { type: String, enum: ["pending", "verified", "rejected"], default: "pending" }, safetyDeclarationAccepted: { type: Boolean, required: true }, documents: { type: [riderDocumentSchema], default: [] }, status: { type: String, enum: ["pending", "contacted", "approved", "rejected"], default: "pending", index: true }, source: { type: String, default: "rider_landing" }, notes: { type: String, default: "" }, reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, reviewedAt: { type: Date, default: null }, assignedFleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null, index: true } }, { timestamps: true, collection: "rider_applications" });
riderApplicationSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
const webLeadHistorySchema = new Schema({ status: { type: String, enum: ["new", "info_requested", "qualified", "rejected"], required: true }, notes: { type: String, default: "", maxlength: 1000 }, actorEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, changedAt: { type: Date, default: Date.now } }, { _id: false });
const leadDocumentSchema = new Schema({ type: { type: String, required: true, trim: true }, fileName: { type: String, required: true, trim: true, maxlength: 180 }, mimeType: { type: String, required: true, enum: ["application/pdf", "image/jpeg", "image/png"] }, sizeBytes: { type: Number, required: true, min: 1, max: 2_500_000 }, sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/i }, documentRequestId: { type: Schema.Types.ObjectId, ref: "DocumentRequest", default: null, index: true }, contentBase64: { type: String, required: true, select: false }, status: { type: String, enum: ["received", "approved", "rejected"], default: "received" }, reviewNotes: { type: String, default: "", maxlength: 1000 }, reviewedAt: { type: Date, default: null }, reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, viewedAt: { type: Date, default: null }, viewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null } }, { _id: true });
const partnerLeadSchema = new Schema({ tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, name: { type: String, required: true, trim: true, maxlength: 160 }, email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true }, phone: { type: String, required: true, trim: true, maxlength: 40 }, address: { type: String, required: true, trim: true, maxlength: 280 }, city: { type: String, required: true, trim: true, maxlength: 100 }, source: { type: String, default: "customer_join_page" }, privacyNoticeAcceptedAt: { type: Date, required: true }, status: { type: String, enum: ["new", "info_requested", "qualified", "rejected"], default: "new", index: true }, prlStatus: { type: String, enum: ["not_requested", "requested", "completed"], default: "not_requested", index: true }, prlRequestedAt: { type: Date, default: null }, prlRequestedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, assignedFleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null, index: true }, assignedManagerId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true }, assignedZoneSlug: { type: String, default: null, index: true }, routedAt: { type: Date, default: null }, routedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, notes: { type: String, default: "", maxlength: 1000 }, documents: { type: [leadDocumentSchema], default: [] }, reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, reviewedAt: { type: Date, default: null }, history: { type: [webLeadHistorySchema], default: [] } }, { timestamps: true, collection: "partner_leads" });
partnerLeadSchema.index({ status: 1, createdAt: -1 });
const riderLeadSchema = new Schema({ tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, name: { type: String, required: true, trim: true, maxlength: 160 }, email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true }, phone: { type: String, required: true, trim: true, maxlength: 40 }, city: { type: String, required: true, trim: true, maxlength: 120 }, vehicle: { type: String, enum: ["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"], required: true }, availability: { type: String, required: true, trim: true, maxlength: 160 }, source: { type: String, default: "customer_join_page" }, privacyNoticeAcceptedAt: { type: Date, required: true }, status: { type: String, enum: ["new", "info_requested", "qualified", "rejected"], default: "new", index: true }, prlStatus: { type: String, enum: ["not_requested", "requested", "completed"], default: "not_requested", index: true }, prlRequestedAt: { type: Date, default: null }, prlRequestedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, assignedFleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null, index: true }, assignedManagerId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true }, assignedZoneSlug: { type: String, default: null, index: true }, routedAt: { type: Date, default: null }, routedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, notes: { type: String, default: "", maxlength: 1000 }, documents: { type: [leadDocumentSchema], default: [] }, reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, reviewedAt: { type: Date, default: null }, history: { type: [webLeadHistorySchema], default: [] } }, { timestamps: true, collection: "rider_leads" });
riderLeadSchema.index({ status: 1, createdAt: -1 });
const documentRequestRequirementSchema = new Schema({ type: { type: String, required: true, trim: true, maxlength: 80 }, inputMode: { type: String, enum: ["file", "form"], default: "file" }, label: { type: String, required: true, trim: true, maxlength: 160 }, description: { type: String, default: "", trim: true, maxlength: 500 } }, { _id: false });
const documentRequestDocumentSchema = new Schema({ type: { type: String, required: true, trim: true, maxlength: 80 }, documentRequestId: { type: Schema.Types.ObjectId, ref: "DocumentRequest", default: null, index: true }, fileName: { type: String, required: true, trim: true, maxlength: 180 }, mimeType: { type: String, required: true, trim: true, maxlength: 120 }, sizeBytes: { type: Number, required: true, min: 1, max: 2_500_000 }, sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/i }, uploadedAt: { type: Date, default: Date.now } }, { _id: false });
const documentRequestSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  subjectType: { type: String, enum: ["rider_application", "restaurant", "rider_lead", "partner_lead"], required: true, index: true },
  subjectId: { type: Schema.Types.ObjectId, required: true, index: true },
  recipientName: { type: String, required: true, trim: true, maxlength: 160 },
  recipientEmail: { type: String, required: true, trim: true, lowercase: true, maxlength: 254 },
  createdBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true, index: true },
  message: { type: String, required: true, trim: true, maxlength: 2000 },
  requirements: { type: [documentRequestRequirementSchema], validate: [(value: unknown[]) => value.length > 0 && value.length <= 12, "requirements_required"] },
  dueAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true, index: true },
  tokenHash: { type: String, required: true, unique: true, select: false, index: true },
  tokenPrefix: { type: String, required: true, maxlength: 12 },
  emailSentAt: { type: Date, default: null },
  emailSendingAt: { type: Date, default: null },
  emailSendLock: { type: String, default: null, select: false },
  status: { type: String, enum: ["open", "partially_submitted", "submitted", "revoked", "expired"], default: "open", index: true },
  documents: { type: [documentRequestDocumentSchema], default: [] },
  formResponses: { type: [{ type: String, value: String, completedAt: { type: Date, default: Date.now } }], default: [] },
  lastAccessedAt: { type: Date, default: null },
  submittedAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
}, { timestamps: true, collection: "document_requests" });
documentRequestSchema.index({ subjectType: 1, subjectId: 1, createdAt: -1 });
documentRequestSchema.index({ tenantId: 1, subjectType: 1, subjectId: 1, createdAt: -1 });
const signatureRequestSchema = new Schema({ provider: { type: String, enum: ["signaturit"], required: true }, entityType: { type: String, enum: ["partner", "rider", "employee"], required: true }, entityId: { type: Schema.Types.ObjectId, required: true, index: true }, externalId: { type: String, default: null, index: true }, status: { type: String, enum: ["pending", "sent", "signed", "rejected", "expired", "failed"], default: "pending", index: true }, eventType: { type: String, default: null }, payloadDigest: { type: String, default: null } }, { timestamps: true, collection: "signature_requests" });
const customerAccountSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, name: { type: String, required: true, trim: true }, email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true }, passwordHash: { type: String, required: true }, sessionHash: { type: String, default: null, index: true }, phone: { type: String, default: "", trim: true, maxlength: 40 }, locality: { type: String, default: "", trim: true, maxlength: 120 }, deliveryAddress: { type: String, default: null, trim: true, maxlength: 280 }, deliveryLocation: { type: geoPoint, default: undefined }, deliveryAddressUpdatedAt: { type: Date, default: null }, lastSignedIn: { type: Date, default: Date.now } }, { timestamps: true, collection: "customer_accounts" });
	const employeeAccountSchema = new Schema({
	  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, name: { type: String, required: true, trim: true }, email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true }, employeeCode: { type: String, unique: true, sparse: true, trim: true, uppercase: true, immutable: true, index: true }, jobRole: { type: String, enum: ["admin", "partner", "rider", "fleet", "zone_manager", "commercial", "gerente_comercial_zona", "finance", "support"], required: true }, apiRole: { type: String, enum: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"], required: true, index: true }, roles: { type: [String], enum: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"], default: undefined, index: true }, partnerRoles: { type: [String], enum: ["partner_admin", "area_manager", "zone_manager", "store_manager", "manager", "cashier", "cajero", "kitchen", "cocina", "cook", "catalog", "catalogue", "menu_manager", "viewer", "read_only", "solo_lectura"], default: [] }, primaryRole: { type: String, enum: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"], default: null, index: true }, accessLevel: { type: String, enum: ["superadmin", "subadmin"], default: "subadmin", index: true }, authorizationStatus: { type: String, enum: ["pending", "approved", "suspended", "revoked"], default: "approved", index: true }, authorizedAt: { type: Date, default: null }, authorizedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, authorizationReason: { type: String, default: "" }, portfolioId: { type: String, required: false, unique: false, index: true, default: () => `portfolio_${new mongoose.Types.ObjectId().toString()}` }, fleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null, index: true }, zoneSlugs: { type: [String], default: [] }, restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", default: null, index: true }, restaurantIds: { type: [Schema.Types.ObjectId], ref: "Restaurant", default: [] }, passwordHash: { type: String, required: true, select: false }, sessionHash: { type: String, default: null, select: false, index: true }, active: { type: Boolean, default: true, index: true }, mustChangePassword: { type: Boolean, default: true, index: true }, ownerProtected: { type: Boolean, default: false, index: true }, hiddenFromAdmin: { type: Boolean, default: false, index: true }, passwordChangedAt: { type: Date, default: null }, lastLoginAt: { type: Date, default: null } }, { timestamps: true, collection: "employee_accounts" });
employeeAccountSchema.pre("validate", function(this: any) {
  if (!this.employeeCode) this.employeeCode = `PIKI-E-${String(this._id).replace(/[^a-z0-9]/gi, "").slice(-8).toUpperCase()}`;
});

const restaurantSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  slug: { type: String, required: true, unique: true, index: true }, partnerCode: { type: String, unique: true, sparse: true, index: true, immutable: true }, name: { type: String, required: true, trim: true }, cuisine: { type: String, required: true }, category: { type: String, required: true, index: true }, locality: { type: String, default: "", index: true }, partnerGroupKey: { type: String, default: "", index: true }, tagline: { type: String, default: "" }, internalDemo: { type: Boolean, default: false, index: true }, demoMenuVersion: { type: Number, default: 0, min: 0 }, etaMinutes: { type: [Number], default: [20, 35] }, deliveryFeeCents: { type: Number, default: 0, min: 0 }, rating: { type: Number, default: 0, min: 0, max: 5 }, reviews: { type: Number, default: 0, min: 0 }, promoted: { type: Boolean, default: false }, image: { type: String, default: "" }, accent: { type: String, default: "#171715" }, availabilityStatus: { type: String, enum: ["available", "coming_soon"], default: "available", index: true }, upcomingAt: { type: Date, default: null }, upcomingMessage: { type: String, default: "", trim: true, maxlength: 240 }, onboardingStage: { type: String, enum: ["lead", "profile", "documents", "stripe", "review", "active", "rejected"], default: "lead", index: true }, onboardingChecklist: { type: Schema.Types.Mixed, default: { profile: false, documents: false, stripe: false, adminReview: false } }, marketplaceCompliance: { pikiStatus: { type: String, enum: ["pending", "in_review", "verified", "rejected", "expired", "suspended"], default: "pending", index: true }, stripeAccountId: { type: String, default: null, index: true }, stripeStatus: { type: String, enum: ["not_created", "onboarding", "pending_verification", "verified", "restricted", "disabled"], default: "not_created" }, chargesEnabled: { type: Boolean, default: false }, payoutsEnabled: { type: Boolean, default: false }, currentlyDue: { type: [String], default: [] }, pastDue: { type: [String], default: [] }, pendingVerification: { type: [String], default: [] }, rejectionReason: { type: String, default: null, maxlength: 1000 }, reviewedAt: { type: Date, default: null }, reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, lastSyncedAt: { type: Date, default: null } }, onboardingStatus: { type: String, enum: ["pending_review", "approved", "rejected", "suspended"], default: "approved", index: true }, onboardingReviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, onboardingReviewedAt: { type: Date, default: null }, qaExpiresAt: { type: Date, default: null, index: true }, isActive: { type: Boolean, default: true, index: true }, email: { type: String, default: "" }, commercialEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true }, phone: { type: String, default: "" }, address: { type: String, default: "" }, partnerProfile: { type: partnerProfile, default: undefined }, location: { type: geoPoint, default: undefined }, menu: { type: [menuItem], default: [] },
}, { timestamps: true, collection: "restaurants" });
restaurantSchema.index({ location: "2dsphere" }, { sparse: true });
restaurantSchema.index({ isActive: 1, category: 1, rating: -1 });
restaurantSchema.index({ isActive: 1, onboardingStatus: 1, promoted: -1, rating: -1, reviews: -1 });
restaurantSchema.index({ isActive: 1, cuisine: 1, promoted: -1, rating: -1, reviews: -1 });
restaurantSchema.index({ tenantId: 1, onboardingStatus: 1, createdAt: -1 });

const riderSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, isTestRider: { type: Boolean, default: false, index: true }, riderCode: { type: String, unique: true, sparse: true, index: true, immutable: true }, name: { type: String, required: true }, email: { type: String, required: true, unique: true }, phone: { type: String, default: "", trim: true, maxlength: 40 }, city: { type: String, default: "", trim: true, maxlength: 120 }, availability: { type: String, default: "", trim: true, maxlength: 160 }, fleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null }, zoneSlug: { type: String, default: null, index: true }, status: { type: String, enum: ["offline", "available", "busy", "paused"], default: "offline", index: true }, lifecycleStatus: { type: String, enum: ["pending_documents", "active", "suspended", "terminated"], default: "active", index: true }, lifecycleReason: { type: String, default: "", trim: true, maxlength: 500 }, lifecycleChangedAt: { type: Date, default: null }, lifecycleChangedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null }, vehicle: { type: String, enum: ["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"], default: "electric_scooter" }, location: { type: geoPoint, default: undefined }, lastLocationAt: { type: Date, default: null }, activeOrderId: { type: Schema.Types.ObjectId, ref: "Order", default: null }, reliabilityScore: { type: Number, min: 0, max: 1, default: 0.75 }, ratingScore: { type: Number, min: 0, max: 1, default: 0.75 }, ratingCount: { type: Number, min: 0, default: 0 } }, { timestamps: true, collection: "riders" });
riderSchema.index({ location: "2dsphere" }, { sparse: true });
const onboardingRequestSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  requestedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true, index: true },
  requestType: { type: String, enum: ["partner", "fleet", "rider"], required: true, index: true },
  payload: { type: Schema.Types.Mixed, required: true },
  zoneSlugs: { type: [String], default: [] },
  status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending", index: true },
  reviewedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null },
  reviewedAt: { type: Date, default: null },
  reviewReason: { type: String, default: "" },
}, { timestamps: true, collection: "onboarding_requests" });
onboardingRequestSchema.index({ requestedBy: 1, createdAt: -1 });
const accessAuthorizationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true, index: true },
  action: { type: String, enum: ["approved", "suspended", "revoked", "role_changed", "created", "credentials_sent", "profile_updated", "settings_updated"], required: true },
  previousStatus: { type: String, default: null },
  nextStatus: { type: String, required: true },
  previousRole: { type: String, default: null },
  nextRole: { type: String, required: true },
  accessLevel: { type: String, enum: ["superadmin", "subadmin"], required: true },
  actorEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true },
  reason: { type: String, default: "" },
}, { timestamps: true, collection: "access_authorizations" });
accessAuthorizationSchema.index({ employeeId: 1, createdAt: -1 });
const governanceAuditEventSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  actorEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true },
  actorRole: { type: String, required: true },
  action: { type: String, required: true, index: true },
  targetType: { type: String, enum: ["restaurant", "rider", "employee", "payout_batch", "rider_payout_batch", "system"], required: true, index: true },
  targetId: { type: Schema.Types.ObjectId, default: null, index: true },
  before: { type: Schema.Types.Mixed, default: null },
  after: { type: Schema.Types.Mixed, default: null },
  reason: { type: String, default: "", maxlength: 2000 },
}, { timestamps: true, collection: "governance_audit_events" });
governanceAuditEventSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
const riderSlotSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true }, zoneSlug: { type: String, required: true }, date: { type: String, required: true }, startTime: { type: String, required: true }, endTime: { type: String, required: true }, status: { type: String, enum: ["planned", "active", "completed", "cancelled"], default: "planned" }, notes: { type: String, default: "" } }, { timestamps: true, collection: "rider_slots" });
riderSlotSchema.index({ tenantId: 1, riderId: 1, date: 1, startTime: 1 }, { unique: true });
riderSlotSchema.index({ tenantId: 1, date: 1, status: 1 });

const fleetSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, createdBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true }, createdByRole: { type: String, default: null }, name: { type: String, required: true, trim: true }, managerName: { type: String, required: true, trim: true }, managerDni: { type: String, required: true, trim: true, uppercase: true }, contactEmail: { type: String, default: "", trim: true, lowercase: true }, contactPhone: { type: String, default: "", trim: true }, address: { type: String, default: "", trim: true }, postalCode: { type: String, default: "", trim: true }, city: { type: String, default: "", trim: true }, vehicleTypes: { type: [String], default: [] }, maxRiders: { type: Number, default: 50, min: 1, max: 10000 }, notes: { type: String, default: "", trim: true, maxlength: 2000 }, isActive: { type: Boolean, default: true }, serviceZones: { type: [String], default: [] } }, { timestamps: true, collection: "fleets" });
fleetSchema.index({ tenantId: 1, name: 1 }, { unique: true });

const orderSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  qaRiderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true }, publicCode: { type: String, required: true, unique: true, index: true }, displayCode: { type: String, default: null }, displayCodeDate: { type: String, default: null }, restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true }, customerId: { type: String, default: null, index: true }, customerName: { type: String, default: "", trim: true, maxlength: 160 }, customerPhone: { type: String, default: null, select: false }, riderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true }, isTestOrder: { type: Boolean, default: false, index: true }, status: { type: String, enum: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way", "delivered", "cancelled"], default: "pending", index: true }, paymentState: { type: String, enum: ["pending", "authorized", "paid", "failed", "refunded", "expired"], default: "pending", index: true }, paymentMethod: { type: String, enum: ["stripe", "cash"], default: "cash", index: true }, partnerPaymentRequired: { type: Boolean, default: false, index: true }, partnerPaymentCents: { type: Number, default: null, min: 0 }, cashCollectedAt: { type: Date, default: null }, cashCollectedByRiderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true }, stripeCheckoutSessionId: { type: String, default: null, index: true }, stripePaymentIntentId: { type: String, default: null, index: true }, assignmentState: { type: String, enum: ["unassigned", "offered", "assigned", "expired", "rejected"], default: "unassigned", index: true }, offerId: { type: String, default: null, index: true }, assignmentExpiresAt: { type: Date, default: null, index: true }, pickupDeadlineAt: { type: Date, default: null, index: true }, riderHeadingToPartnerAt: { type: Date, default: null, index: true }, riderArrivedAt: { type: Date, default: null, index: true }, riderArrivalDistanceMeters: { type: Number, default: null, min: 0 }, partnerPrepDeadlineAt: { type: Date, default: null, index: true }, dispatchScore: { type: Number, default: null }, dispatchAttempts: { type: Number, default: 0 }, items: { type: [orderItem], default: [] }, deliveryAddress: { type: String, default: "" }, deliveryNote: { type: String, default: "", maxlength: 500 }, deliveryLocation: { type: geoPoint, default: undefined }, coveragePolicySlug: { type: String, default: null }, coveragePolicyVersion: { type: Number, default: null }, coverageDecision: { type: String, default: null }, straightLineDistanceKm: { type: Number, default: null }, withinMunicipality: { type: Boolean, default: null }, deliveryBaseFeeCents: { type: Number, default: 0 }, outsideMunicipalitySurchargeCents: { type: Number, default: 0 }, routeDistanceKm: { type: Number, default: null }, routeDurationMinutes: { type: Number, default: null }, routeProvider: { type: String, default: null }, routingDegraded: { type: Boolean, default: false }, requiredVehicleClasses: { type: [String], default: [] }, subtotalCents: { type: Number, default: 0 }, deliveryFeeCents: { type: Number, default: 0 }, serviceFeeCents: { type: Number, default: 0 }, totalCents: { type: Number, default: 0 }, marketplaceCommissionRateBps: { type: Number, default: 1800, min: 0, max: 10000 }, marketplaceCommissionCents: { type: Number, default: 0, min: 0 }, partnerPayoutCents: { type: Number, default: 0, min: 0 }, riderEarningsCents: { type: Number, default: 0, min: 0 }, platformNetBeforeProcessingCents: { type: Number, default: 0 }, payoutStatus: { type: String, enum: ["pending", "blocked", "eligible", "paid", "failed"], default: "pending", index: true }, payoutBatchId: { type: String, default: null, index: true }, version: { type: Number, default: 0 }, statusHistory: { type: [orderEvent], default: [] }, deliveredAt: { type: Date, default: null }, cancelledAt: { type: Date, default: null }, archivedAt: { type: Date, default: null, index: true },
}, { timestamps: true, collection: "orders" });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, restaurantId: 1, archivedAt: -1 });
orderSchema.index({ displayCodeDate: 1, displayCode: 1 }, { unique: true, partialFilterExpression: { displayCodeDate: { $type: "string" }, displayCode: { $type: "string" } } });
orderSchema.index({ deliveryLocation: "2dsphere" }, { sparse: true });

const zoneSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true }, name: { type: String, required: true }, slug: { type: String, required: true }, isActive: { type: Boolean, default: true, index: true }, polygon: { type: { type: String, enum: ["Polygon"], default: "Polygon" }, coordinates: { type: [[[Number]]], required: true } }, serviceFeeCents: { type: Number, default: 0, min: 0 }, maxEtaMinutes: { type: Number, default: 60, min: 1 } }, { timestamps: true, collection: "zones" });
zoneSchema.index({ tenantId: 1, slug: 1 }, { unique: true });
zoneSchema.index({ tenantId: 1, name: 1 }, { unique: true });
zoneSchema.index({ polygon: "2dsphere" });

export type RestaurantDocument = InferSchemaType<typeof restaurantSchema>;
export const Tenant = mongoose.models.Tenant || mongoose.model("Tenant", tenantSchema);
export const TenantMembership = mongoose.models.TenantMembership || mongoose.model("TenantMembership", tenantMembershipSchema);
export const Restaurant = mongoose.models.Restaurant || mongoose.model("Restaurant", restaurantSchema);
export const PartnerAsset = mongoose.models.PartnerAsset || mongoose.model("PartnerAsset", partnerAssetSchema);
export const PartnerLocalityGroup = mongoose.models.PartnerLocalityGroup || mongoose.model("PartnerLocalityGroup", partnerLocalityGroupSchema);
export const MenuImportDraft = mongoose.models.MenuImportDraft || mongoose.model("MenuImportDraft", menuImportDraftSchema);
export const Rider = mongoose.models.Rider || mongoose.model("Rider", riderSchema);
export const Fleet = mongoose.models.Fleet || mongoose.model("Fleet", fleetSchema);
export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export const Zone = mongoose.models.Zone || mongoose.model("Zone", zoneSchema);
export const MarketplaceLedgerEntry = mongoose.models.MarketplaceLedgerEntry || mongoose.model("MarketplaceLedgerEntry", marketplaceLedgerEntrySchema);
export const PartnerPayoutBatch = mongoose.models.PartnerPayoutBatch || mongoose.model("PartnerPayoutBatch", partnerPayoutBatchSchema);
export const RiderPayoutBatch = mongoose.models.RiderPayoutBatch || mongoose.model("RiderPayoutBatch", riderPayoutBatchSchema);
export const StripeEvent = mongoose.models.StripeEvent || mongoose.model("StripeEvent", stripeEventSchema);
export const CashLedgerEntry = mongoose.models.CashLedgerEntry || mongoose.model("CashLedgerEntry", cashLedgerEntrySchema);
export const DispatchDecision = mongoose.models.DispatchDecision || mongoose.model("DispatchDecision", dispatchDecisionSchema);
export const DispatchOutbox = mongoose.models.DispatchOutbox || mongoose.model("DispatchOutbox", dispatchOutboxSchema);
export const RiderIncident = mongoose.models.RiderIncident || mongoose.model("RiderIncident", riderIncidentSchema);
export const RiderOrderMessage = mongoose.models.RiderOrderMessage || mongoose.model("RiderOrderMessage", riderOrderMessageSchema);
export const SupportTicket = mongoose.models.SupportTicket || mongoose.model("SupportTicket", supportTicketSchema);
export const RiderApplication = mongoose.models.RiderApplication || mongoose.model("RiderApplication", riderApplicationSchema);
export const PartnerLead = mongoose.models.PartnerLead || mongoose.model("PartnerLead", partnerLeadSchema);
export const RiderLead = mongoose.models.RiderLead || mongoose.model("RiderLead", riderLeadSchema);
export const DocumentRequest = mongoose.models.DocumentRequest || mongoose.model("DocumentRequest", documentRequestSchema);
export const CustomerAccount = mongoose.models.CustomerAccount || mongoose.model("CustomerAccount", customerAccountSchema);
export const EmployeeAccount = mongoose.models.EmployeeAccount || mongoose.model("EmployeeAccount", employeeAccountSchema);
export const AccessAuthorization = mongoose.models.AccessAuthorization || mongoose.model("AccessAuthorization", accessAuthorizationSchema);
export const GovernanceAuditEvent = mongoose.models.GovernanceAuditEvent || mongoose.model("GovernanceAuditEvent", governanceAuditEventSchema);
export const OnboardingRequest = mongoose.models.OnboardingRequest || mongoose.model("OnboardingRequest", onboardingRequestSchema);
export const RiderSlot = mongoose.models.RiderSlot || mongoose.model("RiderSlot", riderSlotSchema);
export const SignatureRequest = mongoose.models.SignatureRequest || mongoose.model("SignatureRequest", signatureRequestSchema);
export const PasskeyCredential = mongoose.models.PasskeyCredential || mongoose.model("PasskeyCredential", passkeyCredentialSchema);
export const PasskeyChallenge = mongoose.models.PasskeyChallenge || mongoose.model("PasskeyChallenge", passkeyChallengeSchema);
export const PushSubscription = mongoose.models.PushSubscription || mongoose.model("PushSubscription", pushSubscriptionSchema);
export const Notification = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);
export const RealtimeEvent = mongoose.models.RealtimeEvent || mongoose.model("RealtimeEvent", realtimeEventSchema);
export const RiderAssignmentReservation = mongoose.models.RiderAssignmentReservation || mongoose.model("RiderAssignmentReservation", riderAssignmentReservationSchema);
export const TrackingSession = mongoose.models.TrackingSession || mongoose.model("TrackingSession", trackingSessionSchema);
export const LocationSample = mongoose.models.LocationSample || mongoose.model("LocationSample", locationSampleSchema);

export async function ensureIndexes() {
  // Remove unique indexes from older schema versions before initialization.
  for (const [model, indexName] of [[Rider, "riderCode_1"], [EmployeeAccount, "portfolioId_1"], [Fleet, "name_1"], [Zone, "name_1"], [Zone, "slug_1"], [PartnerLocalityGroup, "localityKey_1"], [RiderSlot, "riderId_1_date_1_startTime_1"]] as const) {
    try { await model.collection.dropIndex(indexName); } catch (error: any) {
      if (error?.codeName !== "IndexNotFound" && error?.code !== 27) throw error;
    }
  }
  await Promise.all([PartnerLocalityGroup.syncIndexes(), Fleet.syncIndexes(), Zone.syncIndexes(), RiderSlot.syncIndexes(), RiderReferralProfile.syncIndexes(), RiderShiftIncentiveMetric.syncIndexes(), RiderIncentiveEntry.syncIndexes(), RiderIncentiveBudget.syncIndexes()]);
  await Promise.all([Tenant.init(), TenantMembership.init(), Restaurant.init(), PartnerAsset.init(), PartnerLocalityGroup.init(), MenuImportDraft.init(), Fleet.init(), Order.init(), Zone.init(), MarketplaceLedgerEntry.init(), PartnerPayoutBatch.init(), StripeEvent.init(), CashLedgerEntry.init(), DispatchDecision.init(), DispatchOutbox.init(), RiderIncident.init(), RiderOrderMessage.init(), RiderApplication.init(), PartnerLead.init(), RiderLead.init(), DocumentRequest.init(), CustomerAccount.init(), RiderSlot.init(), SignatureRequest.init(), PasskeyCredential.init(), PasskeyChallenge.init(), PushSubscription.init(), Notification.init(), RealtimeEvent.init(), RiderAssignmentReservation.init(), TrackingSession.init(), LocationSample.init(), EmployeeAccount.init(), AccessAuthorization.init(), OnboardingRequest.init(), RiderReferralProfile.init(), RiderShiftIncentiveMetric.init(), RiderIncentiveEntry.init(), RiderIncentiveBudget.init()]);
  const ridersWithoutCode = await Rider.find({ $or: [{ riderCode: { $exists: false } }, { riderCode: null }, { riderCode: "" }] }).select("_id").lean().exec();
  for (const rider of ridersWithoutCode) {
    const base = `PIKI-R-${String(rider._id).slice(-6).toUpperCase()}`;
    let riderCode = base;
    let suffix = 1;
    while (await Rider.exists({ riderCode })) riderCode = `${base}-${suffix++}`;
    await Rider.updateOne({ _id: rider._id, $or: [{ riderCode: { $exists: false } }, { riderCode: null }, { riderCode: "" }] }, { $set: { riderCode } }).exec();
  }
  await Rider.syncIndexes();
  await EmployeeAccount.syncIndexes();
}
