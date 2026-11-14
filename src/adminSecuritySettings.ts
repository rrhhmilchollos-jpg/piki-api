import type { Express, Request, Response } from "express";
import mongoose, { Schema } from "mongoose";
import { requireOwner } from "./auth.js";
import { EmployeeSession } from "./employeeSessions.js";
import { hashSessionToken } from "./employeeAuth.js";
import { CASH_PAYMENTS_ENABLED, setCashPaymentsEnabled } from "./paymentPolicy.js";

const securitySchema = new Schema({
  twoFactorEnabled: { type: Boolean, default: true },
  twoFactorMethod: { type: String, enum: ["app", "email", "sms"], default: "app" },
  minPasswordLength: { type: Number, min: 8, max: 64, default: 12 },
  requireSpecialChars: { type: Boolean, default: true },
  passwordExpiryDays: { type: Number, min: 0, max: 365, default: 90 },
  maxFailedAttempts: { type: Number, enum: [3, 5], default: 5 },
  lockoutMinutes: { type: Number, min: 1, max: 1440, default: 15 },
}, { timestamps: true, collection: "security_settings" });

const globalSchema = new Schema({
  configKey: { type: String, default: "default", unique: true, index: true },
  values: { type: Schema.Types.Mixed, default: {} },
  updatedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null },
}, { timestamps: true, collection: "global_configs" });

const auditSchema = new Schema({
  actor: { type: String, required: true },
  action: { type: String, required: true },
  target: { type: String, required: true },
  ip: { type: String, required: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true, collection: "audit_logs" });
auditSchema.index({ createdAt: -1 });

const SecuritySettings = mongoose.models.AdminSecuritySettings || mongoose.model("AdminSecuritySettings", securitySchema);
const GlobalConfig = mongoose.models.AdminGlobalConfig || mongoose.model("AdminGlobalConfig", globalSchema);
const AdminAuditLog = mongoose.models.AdminAuditLog || mongoose.model("AdminAuditLog", auditSchema);

const defaultGlobalValues = {
  baseDeliveryFee: 2.5, pricePerKm: 0.65, merchantCommission: 18, demandSurcharge: 12, weatherSurcharge: 8,
  openingTime: "08:00", closingTime: "23:30", deliveryRadiusKm: 8, prepTimeMinutes: 20, riderOfferTimeoutMinutes: 2,
  maintenanceMode: false, stripeEnabled: true, stripePublicKey: "", paypalEnabled: false, paypalClientId: "",
  localTerminalEnabled: true, localTerminalName: "Terminal PIKI · Valencia", cashPaymentsEnabled: CASH_PAYMENTS_ENABLED,
};

function requestIp(req: Request) { return req.ip || req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || "unknown"; }
async function logAudit(req: Request, action: string, target: string, metadata: Record<string, unknown> = {}) {
  await AdminAuditLog.create({ actor: req.auth?.employeeId || "superadmin", action, target, ip: requestIp(req), metadata });
}

export function mountAdminSecuritySettings(app: Express) {
  app.get("/api/v1/admin/security/settings", requireOwner(), async (_req: Request, res: Response) => {
    const settings = await SecuritySettings.findOneAndUpdate({}, {}, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
    return res.json({ settings });
  });
  app.put("/api/v1/admin/security/settings", requireOwner(), async (req: Request, res: Response) => {
    const body = req.body || {};
    const settings = await SecuritySettings.findOneAndUpdate({}, { $set: {
      twoFactorEnabled: Boolean(body.twoFactorEnabled),
      twoFactorMethod: ["app", "email", "sms"].includes(body.twoFactorMethod) ? body.twoFactorMethod : "app",
      minPasswordLength: Math.max(8, Math.min(64, Number(body.minPasswordLength) || 12)),
      requireSpecialChars: Boolean(body.requireSpecialChars),
      passwordExpiryDays: Math.max(0, Math.min(365, Number(body.passwordExpiryDays) || 90)),
      maxFailedAttempts: Number(body.maxFailedAttempts) === 3 ? 3 : 5,
      lockoutMinutes: Math.max(1, Math.min(1440, Number(body.lockoutMinutes) || 15)),
    } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
    await logAudit(req, "Actualizó la política de seguridad", "security_settings");
    return res.json({ settings });
  });
  app.get("/api/v1/admin/global-config", requireOwner(), async (_req: Request, res: Response) => {
    const config = await GlobalConfig.findOneAndUpdate({ configKey: "default" }, { $setOnInsert: { values: defaultGlobalValues } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
    const settings = { ...defaultGlobalValues, ...(config?.values as Record<string, unknown> || {}), cashPaymentsEnabled: typeof (config?.values as any)?.cashPaymentsEnabled === "boolean" ? Boolean((config?.values as any).cashPaymentsEnabled) : CASH_PAYMENTS_ENABLED };
    setCashPaymentsEnabled(Boolean(settings.cashPaymentsEnabled));
    return res.json({ settings });
  });
  app.put("/api/v1/admin/global-config", requireOwner(), async (req: Request, res: Response) => {
    const settings = { ...defaultGlobalValues, ...(req.body || {}) };
    const config = await GlobalConfig.findOneAndUpdate({ configKey: "default" }, { $set: { values: settings, updatedBy: req.auth?.employeeId || null } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
    setCashPaymentsEnabled(Boolean(settings.cashPaymentsEnabled));
    await logAudit(req, "Actualizó la configuración global", "global_configs", { changedKeys: Object.keys(req.body || {}) });
    return res.json({ settings: { ...defaultGlobalValues, ...(config?.values as Record<string, unknown> || {}) } });
  });
  app.get("/api/v1/admin/security/sessions", requireOwner(), async (req: Request, res: Response) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const currentHash = token ? hashSessionToken(token) : "";
    const rows = await EmployeeSession.find({ employeeId: req.auth?.employeeId, expiresAt: { $gt: new Date() } }).sort({ issuedAt: -1 }).lean().exec();
    return res.json({ sessions: rows.map((row: any) => ({ id: String(row._id), device: row.device || "Sesión administrativa", location: row.location || "No disponible", ip: row.ip || requestIp(req), lastActive: row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString("es-ES") : new Date(row.issuedAt).toLocaleString("es-ES"), current: Boolean(currentHash && row.tokenHash === currentHash) })) });
  });
  app.post("/api/v1/admin/security/sessions/revoke-all", requireOwner(), async (req: Request, res: Response) => {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
    const currentHash = token ? hashSessionToken(token) : "";
    await EmployeeSession.deleteMany({ employeeId: req.auth?.employeeId, tokenHash: { $ne: currentHash } }).exec();
    await logAudit(req, "Cerró las sesiones en todos los dispositivos", "employee_sessions");
    return res.json({ success: true });
  });
  app.get("/api/v1/admin/security/audit", requireOwner(), async (_req: Request, res: Response) => {
    const logs = await AdminAuditLog.find().sort({ createdAt: -1 }).limit(100).lean().exec();
    return res.json({ logs: logs.map((log: any) => ({ id: String(log._id), actor: log.actor, action: log.action, target: log.target, date: new Date(log.createdAt).toLocaleString("es-ES"), ip: log.ip })) });
  });
}
