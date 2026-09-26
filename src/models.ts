import mongoose, { InferSchemaType, Schema } from "mongoose";

const geoPoint = new Schema({ type: { type: String, enum: ["Point"], default: "Point" }, coordinates: { type: [Number], default: [0, 0] } }, { _id: false });
const menuModifier = new Schema({ id: { type: String, required: true }, name: { type: String, required: true }, price: { type: Number, required: true, min: 0 }, required: { type: Boolean, default: false }, options: { type: [String], default: [] } }, { _id: false });
const menuItem = new Schema({ id: { type: String, required: true }, name: { type: String, required: true }, description: { type: String, default: "" }, price: { type: Number, required: true, min: 0 }, category: { type: String, default: "General" }, image: { type: String, default: "" }, allergens: { type: [String], default: [] }, modifiers: { type: [menuModifier], default: [] }, available: { type: Boolean, default: true }, vegetarian: { type: Boolean, default: false }, popular: { type: Boolean, default: false } }, { _id: false });
const partnerAssetSchema = new Schema({
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
  organizationKey: { type: String, required: true, index: true },
  folderKey: { type: String, required: true, index: true },
  locality: { type: String, required: true, index: true },
  kind: { type: String, enum: ["menu_image", "restaurant_image", "document"], required: true },
  fileName: { type: String, required: true, trim: true },
  mimeType: { type: String, enum: ["image/webp", "image/jpeg", "image/png"], required: true },
  sizeBytes: { type: Number, required: true, min: 1, max: 204800 },
  sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/i },
  contentBase64: { type: String, required: true, select: false },
}, { timestamps: true, collection: "partner_assets" });
partnerAssetSchema.index({ restaurantId: 1, kind: 1, createdAt: -1 });
const partnerLocalityGroupSchema = new Schema({
  localityKey: { type: String, required: true, unique: true, index: true },
  localityName: { type: String, required: true },
  province: { type: String, default: "Valencia" },
  restaurantIds: { type: [Schema.Types.ObjectId], ref: "Restaurant", default: [] },
  isActive: { type: Boolean, default: true, index: true },
}, { timestamps: true, collection: "partner_locality_groups" });

const partnerDocument = new Schema({ type: { type: String, enum: ["tax_id", "bank_certificate", "insurance", "activity_license", "food_sanitary_authorization", "identity", "other"], required: true }, fileName: { type: String, required: true }, mimeType: { type: String, required: true }, sizeBytes: { type: Number, required: true, max: 2_500_000 }, sha256: { type: String, required: true }, contentBase64: { type: String, required: true, select: false }, status: { type: String, enum: ["received", "approved", "rejected"], default: "received" }, reviewNotes: { type: String, default: "" }, reviewedAt: { type: Date, default: null } }, { _id: true });
const partnerProfile = new Schema({ legalName: { type: String, required: true, trim: true }, taxId: { type: String, required: true, uppercase: true, trim: true, index: true }, legalForm: { type: String, enum: ["autonomo", "sl", "sa", "cooperativa", "otra"], required: true }, representativeName: { type: String, required: true, trim: true }, representativeRole: { type: String, required: true, trim: true }, representativeDocument: { type: String, required: true, trim: true }, fiscalAddress: { type: String, required: true, trim: true }, operatingAddress: { type: String, required: true, trim: true }, postalCode: { type: String, required: true, trim: true }, city: { type: String, required: true, trim: true }, province: { type: String, required: true, trim: true }, iban: { type: String, required: true, uppercase: true, trim: true }, bankAccountHolder: { type: String, required: true, trim: true }, cuisine: { type: String, required: true, trim: true }, vatRate: { type: Number, enum: [4, 10, 21], required: true }, commissionAccepted: { type: Boolean, required: true }, termsAcceptedAt: { type: Date, required: true }, contractAcceptedAt: { type: Date, required: true }, privacyAcceptedAt: { type: Date, required: true }, dataProcessingAcceptedAt: { type: Date, required: true }, pdaUnits: { type: Number, required: true, min: 1, max: 50 }, pdaUnitCostCents: { type: Number, required: true, enum: [30000] }, pdaCostAcceptedAt: { type: Date, required: true }, openingHours: { type: Schema.Types.Mixed, required: true }, documents: { type: [partnerDocument], default: [] } }, { _id: false });
const orderItem = new Schema({ itemId: { type: String, required: true }, name: { type: String, required: true }, quantity: { type: Number, min: 1, max: 20, required: true }, unitPriceCents: { type: Number, min: 0, required: true } }, { _id: false });
const orderEvent = new Schema({ status: { type: String, required: true }, actorRole: { type: String, required: true }, reason: { type: String, default: "" }, at: { type: Date, default: Date.now } }, { _id: false });
const stripeEventSchema = new Schema({ stripeEventId: { type: String, required: true, unique: true, index: true }, type: { type: String, required: true }, orderCode: { type: String, default: null }, receivedAt: { type: Date, default: Date.now } }, { timestamps: true, collection: "stripe_events" });
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
const riderAssignmentReservationSchema = new Schema({
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true, index: true },
  slot: { type: Number, enum: [1, 2], required: true },
  mode: { type: String, enum: ["normal", "saturated"], required: true },
  status: { type: String, enum: ["reserved", "released", "completed", "cancelled"], default: "reserved", index: true },
  expiresAt: { type: Date, default: null, index: true },
}, { timestamps: true, collection: "rider_assignment_reservations" });
riderAssignmentReservationSchema.index({ riderId: 1, status: 1, slot: 1 }, { unique: true, partialFilterExpression: { status: "reserved" } });
const dispatchDecisionSchema = new Schema({ orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true }, riderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true }, algorithmVersion: { type: String, required: true }, score: { type: Number, required: true }, pickupDistanceKm: { type: Number, required: true }, pickupEtaMinutes: { type: Number, required: true }, customerEtaMinutes: { type: Number, required: true }, totalEtaMinutes: { type: Number, required: true }, reasons: { type: [String], default: [] }, outcome: { type: String, enum: ["preview", "offered", "accepted", "rejected", "expired", "race_lost"], required: true }, actorRole: { type: String, default: "system" } }, { timestamps: true, collection: "dispatch_decisions" });
const riderOrderMessageSchema = new Schema({
  orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, index: true },
  riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true },
  senderRole: { type: String, enum: ["rider", "customer", "admin"], required: true },
  body: { type: String, required: true, trim: true, maxlength: 500 },
}, { timestamps: true, collection: "rider_order_messages" });
riderOrderMessageSchema.index({ orderId: 1, createdAt: 1 });
const riderIncidentSchema = new Schema({ riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true }, reason: { type: String, required: true, enum: ["late_acceptance", "late_delivery", "no_show", "unsafe_driving", "fraud_signal", "customer_complaint", "document_expired", "other"] }, evidence: { type: [String], default: [] }, acknowledged: { type: Boolean, default: false }, resolved: { type: Boolean, default: false }, occurredAt: { type: Date, default: Date.now }, createdByRole: { type: String, required: true } }, { timestamps: true, collection: "rider_incidents" });
riderIncidentSchema.index({ riderId: 1, occurredAt: -1 });
const riderDocumentSchema = new Schema({ type: { type: String, enum: ["identity", "residence_permit", "social_security_number", "bank_certificate", "driving_license", "insurance", "vehicle_registration", "vehicle_technical_sheet", "scooter_responsible_declaration", "dgt_mvp_homologation", "other"], required: true }, fileName: { type: String, required: true, trim: true }, mimeType: { type: String, required: true, trim: true }, sizeBytes: { type: Number, required: true, min: 1, max: 2_500_000 }, sha256: { type: String, required: true, match: /^[a-f0-9]{64}$/i }, contentBase64: { type: String, required: true, select: false }, status: { type: String, enum: ["received", "approved", "rejected"], default: "received" }, reviewNotes: { type: String, default: "" }, reviewedAt: { type: Date, default: null } }, { _id: true });
const riderApplicationSchema = new Schema({ name: { type: String, required: true, trim: true }, email: { type: String, required: true, lowercase: true, trim: true, index: true }, phone: { type: String, required: true, trim: true }, city: { type: String, required: true, trim: true }, vehicle: { type: String, enum: ["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"], required: true }, availability: { type: String, required: true, trim: true }, socialSecurityNumber: { type: String, required: true, trim: true }, identityVerificationMethod: { type: String, enum: ["online_scan"], required: true }, identityVerificationStatus: { type: String, enum: ["pending", "verified", "rejected"], default: "pending" }, safetyDeclarationAccepted: { type: Boolean, required: true }, documents: { type: [riderDocumentSchema], default: [] }, status: { type: String, enum: ["pending", "contacted", "approved", "rejected"], default: "pending", index: true }, source: { type: String, default: "rider_landing" }, notes: { type: String, default: "" }, assignedFleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null, index: true } }, { timestamps: true, collection: "rider_applications" });
const signatureRequestSchema = new Schema({ provider: { type: String, enum: ["signaturit"], required: true }, entityType: { type: String, enum: ["partner", "rider", "employee"], required: true }, entityId: { type: Schema.Types.ObjectId, required: true, index: true }, externalId: { type: String, default: null, index: true }, status: { type: String, enum: ["pending", "sent", "signed", "rejected", "expired", "failed"], default: "pending", index: true }, eventType: { type: String, default: null }, payloadDigest: { type: String, default: null } }, { timestamps: true, collection: "signature_requests" });
const customerAccountSchema = new Schema({ name: { type: String, required: true, trim: true }, email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true }, passwordHash: { type: String, required: true }, sessionHash: { type: String, default: null, index: true }, lastSignedIn: { type: Date, default: Date.now } }, { timestamps: true, collection: "customer_accounts" });
	const employeeAccountSchema = new Schema({ name: { type: String, required: true, trim: true }, email: { type: String, required: true, lowercase: true, trim: true, unique: true, index: true }, jobRole: { type: String, enum: ["admin", "partner", "rider", "fleet", "zone_manager", "commercial"], required: true }, apiRole: { type: String, enum: ["admin", "partner", "rider", "fleet", "commercial"], required: true, index: true }, portfolioId: { type: String, required: false, unique: false, index: true, default: () => `portfolio_${new mongoose.Types.ObjectId().toString()}` }, fleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null, index: true }, zoneSlugs: { type: [String], default: [] }, restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", default: null, index: true }, passwordHash: { type: String, required: true, select: false }, sessionHash: { type: String, default: null, select: false, index: true }, active: { type: Boolean, default: true, index: true }, mustChangePassword: { type: Boolean, default: true, index: true }, ownerProtected: { type: Boolean, default: false, index: true }, hiddenFromAdmin: { type: Boolean, default: false, index: true }, passwordChangedAt: { type: Date, default: null }, lastLoginAt: { type: Date, default: null } }, { timestamps: true, collection: "employee_accounts" });

const restaurantSchema = new Schema({
  slug: { type: String, required: true, unique: true, index: true }, name: { type: String, required: true, trim: true }, cuisine: { type: String, required: true }, category: { type: String, required: true, index: true }, locality: { type: String, default: "", index: true }, partnerGroupKey: { type: String, default: "", index: true }, tagline: { type: String, default: "" }, etaMinutes: { type: [Number], default: [20, 35] }, deliveryFeeCents: { type: Number, default: 0, min: 0 }, rating: { type: Number, default: 0, min: 0, max: 5 }, reviews: { type: Number, default: 0, min: 0 }, promoted: { type: Boolean, default: false }, image: { type: String, default: "" }, accent: { type: String, default: "#171715" }, onboardingStatus: { type: String, enum: ["pending_review", "approved", "rejected", "suspended"], default: "approved", index: true }, isActive: { type: Boolean, default: true, index: true }, email: { type: String, default: "" }, commercialEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null, index: true }, phone: { type: String, default: "" }, address: { type: String, default: "" }, partnerProfile: { type: partnerProfile, default: undefined }, location: { type: geoPoint, default: undefined }, menu: { type: [menuItem], default: [] },
}, { timestamps: true, collection: "restaurants" });
restaurantSchema.index({ location: "2dsphere" }, { sparse: true });
restaurantSchema.index({ isActive: 1, category: 1, rating: -1 });

const riderSchema = new Schema({ riderCode: { type: String, unique: true, sparse: true, index: true, immutable: true }, name: { type: String, required: true }, email: { type: String, required: true, unique: true }, fleetId: { type: Schema.Types.ObjectId, ref: "Fleet", default: null }, status: { type: String, enum: ["offline", "available", "busy", "paused"], default: "offline", index: true }, vehicle: { type: String, enum: ["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"], default: "electric_scooter" }, location: { type: geoPoint, default: undefined }, lastLocationAt: { type: Date, default: null }, activeOrderId: { type: Schema.Types.ObjectId, ref: "Order", default: null }, reliabilityScore: { type: Number, min: 0, max: 1, default: 0.75 } }, { timestamps: true, collection: "riders" });
riderSchema.index({ location: "2dsphere" }, { sparse: true });
const riderSlotSchema = new Schema({ riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, index: true }, zoneSlug: { type: String, required: true }, date: { type: String, required: true }, startTime: { type: String, required: true }, endTime: { type: String, required: true }, status: { type: String, enum: ["planned", "active", "completed", "cancelled"], default: "planned" }, notes: { type: String, default: "" } }, { timestamps: true, collection: "rider_slots" });
riderSlotSchema.index({ riderId: 1, date: 1, startTime: 1 }, { unique: true });

const fleetSchema = new Schema({ name: { type: String, required: true, unique: true }, managerName: { type: String, default: "" }, isActive: { type: Boolean, default: true }, serviceZones: { type: [String], default: [] } }, { timestamps: true, collection: "fleets" });

const orderSchema = new Schema({
  publicCode: { type: String, required: true, unique: true, index: true }, displayCode: { type: String, default: null }, displayCodeDate: { type: String, default: null }, restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true }, customerId: { type: String, default: null, index: true }, customerPhone: { type: String, default: null, select: false }, riderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true }, isTestOrder: { type: Boolean, default: false, index: true }, status: { type: String, enum: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way", "delivered", "cancelled"], default: "pending", index: true }, paymentState: { type: String, enum: ["pending", "paid", "failed", "refunded", "expired"], default: "pending", index: true }, stripeCheckoutSessionId: { type: String, default: null, index: true }, stripePaymentIntentId: { type: String, default: null, index: true }, assignmentState: { type: String, enum: ["unassigned", "offered", "assigned", "expired", "rejected"], default: "unassigned", index: true }, assignmentExpiresAt: { type: Date, default: null, index: true }, dispatchScore: { type: Number, default: null }, dispatchAttempts: { type: Number, default: 0 }, items: { type: [orderItem], default: [] }, deliveryAddress: { type: String, default: "" }, deliveryLocation: { type: geoPoint, default: undefined }, subtotalCents: { type: Number, default: 0 }, deliveryFeeCents: { type: Number, default: 0 }, totalCents: { type: Number, default: 0 }, version: { type: Number, default: 0 }, statusHistory: { type: [orderEvent], default: [] }, deliveredAt: { type: Date, default: null }, cancelledAt: { type: Date, default: null },
}, { timestamps: true, collection: "orders" });
orderSchema.index({ status: 1, createdAt: -1 });
orderSchema.index({ displayCodeDate: 1, displayCode: 1 }, { unique: true, partialFilterExpression: { displayCodeDate: { $type: "string" }, displayCode: { $type: "string" } } });
orderSchema.index({ deliveryLocation: "2dsphere" }, { sparse: true });

const zoneSchema = new Schema({ name: { type: String, required: true, unique: true }, slug: { type: String, required: true, unique: true }, isActive: { type: Boolean, default: true, index: true }, polygon: { type: { type: String, enum: ["Polygon"], default: "Polygon" }, coordinates: { type: [[[Number]]], required: true } }, serviceFeeCents: { type: Number, default: 0, min: 0 }, maxEtaMinutes: { type: Number, default: 60, min: 1 } }, { timestamps: true, collection: "zones" });
zoneSchema.index({ polygon: "2dsphere" });

export type RestaurantDocument = InferSchemaType<typeof restaurantSchema>;
export const Restaurant = mongoose.models.Restaurant || mongoose.model("Restaurant", restaurantSchema);
export const PartnerAsset = mongoose.models.PartnerAsset || mongoose.model("PartnerAsset", partnerAssetSchema);
export const PartnerLocalityGroup = mongoose.models.PartnerLocalityGroup || mongoose.model("PartnerLocalityGroup", partnerLocalityGroupSchema);
export const Rider = mongoose.models.Rider || mongoose.model("Rider", riderSchema);
export const Fleet = mongoose.models.Fleet || mongoose.model("Fleet", fleetSchema);
export const Order = mongoose.models.Order || mongoose.model("Order", orderSchema);
export const Zone = mongoose.models.Zone || mongoose.model("Zone", zoneSchema);
export const StripeEvent = mongoose.models.StripeEvent || mongoose.model("StripeEvent", stripeEventSchema);
export const DispatchDecision = mongoose.models.DispatchDecision || mongoose.model("DispatchDecision", dispatchDecisionSchema);
export const RiderIncident = mongoose.models.RiderIncident || mongoose.model("RiderIncident", riderIncidentSchema);
export const RiderOrderMessage = mongoose.models.RiderOrderMessage || mongoose.model("RiderOrderMessage", riderOrderMessageSchema);
export const RiderApplication = mongoose.models.RiderApplication || mongoose.model("RiderApplication", riderApplicationSchema);
export const CustomerAccount = mongoose.models.CustomerAccount || mongoose.model("CustomerAccount", customerAccountSchema);
export const EmployeeAccount = mongoose.models.EmployeeAccount || mongoose.model("EmployeeAccount", employeeAccountSchema);
export const RiderSlot = mongoose.models.RiderSlot || mongoose.model("RiderSlot", riderSlotSchema);
export const SignatureRequest = mongoose.models.SignatureRequest || mongoose.model("SignatureRequest", signatureRequestSchema);
export const PasskeyCredential = mongoose.models.PasskeyCredential || mongoose.model("PasskeyCredential", passkeyCredentialSchema);
export const RiderAssignmentReservation = mongoose.models.RiderAssignmentReservation || mongoose.model("RiderAssignmentReservation", riderAssignmentReservationSchema);

export async function ensureIndexes() {
  await Promise.all([Restaurant.init(), PartnerAsset.init(), PartnerLocalityGroup.init(), Rider.init(), Fleet.init(), Order.init(), Zone.init(), StripeEvent.init(), DispatchDecision.init(), RiderIncident.init(), RiderOrderMessage.init(), RiderApplication.init(), CustomerAccount.init(), EmployeeAccount.init(), RiderSlot.init(), SignatureRequest.init(), PasskeyCredential.init(), RiderAssignmentReservation.init()]);
  const ridersWithoutCode = await Rider.find({ $or: [{ riderCode: { $exists: false } }, { riderCode: null }, { riderCode: "" }] }).select("_id").lean().exec();
  for (const rider of ridersWithoutCode) {
    const base = `PIKI-R-${String(rider._id).slice(-6).toUpperCase()}`;
    let riderCode = base;
    let suffix = 1;
    while (await Rider.exists({ riderCode })) riderCode = `${base}-${suffix++}`;
    await Rider.updateOne({ _id: rider._id, $or: [{ riderCode: { $exists: false } }, { riderCode: null }, { riderCode: "" }] }, { $set: { riderCode } }).exec();
  }
}
