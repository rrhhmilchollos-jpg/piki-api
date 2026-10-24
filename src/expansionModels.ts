import mongoose, { Schema } from "mongoose";

const municipalExpansionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  municipalityKey: { type: String, required: true, lowercase: true, trim: true },
  municipalityName: { type: String, required: true, trim: true },
  province: { type: String, default: "Valencia", trim: true },
  phase: { type: Number, required: true, min: 1, max: 3, index: true },
  phaseLabel: { type: String, required: true },
  status: { type: String, enum: ["planned", "ready", "active", "paused"], default: "planned", index: true },
  zoneSlug: { type: String, default: null, index: true },
  notes: { type: String, default: "" },
  activatedAt: { type: Date, default: null },
  activatedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null },
}, { timestamps: true, collection: "municipal_expansions" });
municipalExpansionSchema.index({ tenantId: 1, municipalityKey: 1 }, { unique: true });

export const MunicipalExpansion = mongoose.models.MunicipalExpansion || mongoose.model("MunicipalExpansion", municipalExpansionSchema);

const googleBusinessConnectionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, unique: true, index: true },
  googleAccountName: { type: String, default: null },
  googleLocationName: { type: String, default: null },
  googleLocationTitle: { type: String, default: null },
  accessTokenEncrypted: { type: String, default: null, select: false },
  refreshTokenEncrypted: { type: String, default: null, select: false },
  tokenExpiryAt: { type: Date, default: null },
  scopes: { type: [String], default: [] },
  status: { type: String, enum: ["connected", "needs_reauth", "error", "disconnected"], default: "connected", index: true },
  lastSyncAt: { type: Date, default: null },
  lastSyncStatus: { type: String, enum: ["never", "success", "error"], default: "never" },
  lastSyncError: { type: String, default: "" },
  lastGoogleUpdatedAt: { type: Date, default: null },
}, { timestamps: true, collection: "google_business_connections" });
googleBusinessConnectionSchema.index({ tenantId: 1, status: 1 });

export const GoogleBusinessConnection = mongoose.models.GoogleBusinessConnection || mongoose.model("GoogleBusinessConnection", googleBusinessConnectionSchema);

const googleOauthStateSchema = new Schema({
  stateHash: { type: String, required: true, unique: true, index: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, index: true },
  employeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", required: true },
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null, index: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
}, { timestamps: true, collection: "google_business_oauth_states" });
googleOauthStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const GoogleOauthState = mongoose.models.GoogleOauthState || mongoose.model("GoogleOauthState", googleOauthStateSchema);
