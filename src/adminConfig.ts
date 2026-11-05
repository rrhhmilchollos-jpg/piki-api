/**
 * Configuración persistente del panel de administración.
 *
 * La pantalla de seguridad y la de ajustes globales guardaban sus cambios
 * contra rutas que nunca existieron en la API: el botón respondía, la petición
 * devolvía 404 y los valores se perdían al recargar. Estas rutas persisten la
 * configuración en MongoDB y dejan rastro en la auditoría de gobernanza.
 */
import { Router } from "express";
import mongoose from "mongoose";

import { requireRole } from "./auth.js";
import { EmployeeSession } from "./employeeSessions.js";
import { recordGovernanceEvent } from "./pikiGovernance.js";

const configSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true, collection: "admin_configs" },
);

const AdminConfig =
  (mongoose.models.AdminConfig as mongoose.Model<any>) ||
  mongoose.model("AdminConfig", configSchema);

export const SECURITY_DEFAULTS = {
  twoFactorEnabled: true,
  twoFactorMethod: "app",
  minPasswordLength: 12,
  requireSpecialChars: false,
  passwordExpiryDays: 90,
  maxFailedAttempts: 3,
  lockoutMinutes: 15,
} as const;

export const GLOBAL_CONFIG_DEFAULTS = {
  maintenanceMode: false,
  baseDeliveryFee: 2.5,
  pricePerKm: 0.6,
  merchantCommission: 18,
  demandSurcharge: 0,
  weatherSurcharge: 0,
  openingTime: "12:00",
  closingTime: "23:30",
  deliveryRadiusKm: 8,
  prepTimeMinutes: 15,
  riderOfferTimeoutMinutes: 2,
  stripeEnabled: false,
  stripePublicKey: "",
  localTerminalEnabled: false,
  localTerminalName: "",
} as const;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeSecurity(input: any) {
  const source = input && typeof input === "object" ? input : {};
  const method = ["app", "email", "sms"].includes(String(source.twoFactorMethod))
    ? String(source.twoFactorMethod)
    : SECURITY_DEFAULTS.twoFactorMethod;
  return {
    twoFactorEnabled: Boolean(source.twoFactorEnabled ?? SECURITY_DEFAULTS.twoFactorEnabled),
    twoFactorMethod: method,
    minPasswordLength: clampInt(source.minPasswordLength, 8, 64, SECURITY_DEFAULTS.minPasswordLength),
    requireSpecialChars: Boolean(source.requireSpecialChars ?? SECURITY_DEFAULTS.requireSpecialChars),
    passwordExpiryDays: clampInt(source.passwordExpiryDays, 0, 365, SECURITY_DEFAULTS.passwordExpiryDays),
    maxFailedAttempts: clampInt(source.maxFailedAttempts, 3, 10, SECURITY_DEFAULTS.maxFailedAttempts),
    lockoutMinutes: clampInt(source.lockoutMinutes, 1, 1440, SECURITY_DEFAULTS.lockoutMinutes),
  };
}

function sanitizeGlobal(input: any) {
  const source = input && typeof input === "object" ? input : {};
  const text = (key: string, fallback: string, max = 200) => {
    const value = source[key];
    return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : fallback;
  };
  return {
    maintenanceMode: Boolean(source.maintenanceMode ?? GLOBAL_CONFIG_DEFAULTS.maintenanceMode),
    baseDeliveryFee: clampNumber(source.baseDeliveryFee, 0, 50, GLOBAL_CONFIG_DEFAULTS.baseDeliveryFee),
    pricePerKm: clampNumber(source.pricePerKm, 0, 20, GLOBAL_CONFIG_DEFAULTS.pricePerKm),
    merchantCommission: clampNumber(source.merchantCommission, 0, 100, GLOBAL_CONFIG_DEFAULTS.merchantCommission),
    demandSurcharge: clampNumber(source.demandSurcharge, 0, 200, GLOBAL_CONFIG_DEFAULTS.demandSurcharge),
    weatherSurcharge: clampNumber(source.weatherSurcharge, 0, 200, GLOBAL_CONFIG_DEFAULTS.weatherSurcharge),
    openingTime: text("openingTime", GLOBAL_CONFIG_DEFAULTS.openingTime, 8),
    closingTime: text("closingTime", GLOBAL_CONFIG_DEFAULTS.closingTime, 8),
    deliveryRadiusKm: clampNumber(source.deliveryRadiusKm, 0, 100, GLOBAL_CONFIG_DEFAULTS.deliveryRadiusKm),
    prepTimeMinutes: clampInt(source.prepTimeMinutes, 0, 240, GLOBAL_CONFIG_DEFAULTS.prepTimeMinutes),
    riderOfferTimeoutMinutes: clampInt(source.riderOfferTimeoutMinutes, 1, 60, GLOBAL_CONFIG_DEFAULTS.riderOfferTimeoutMinutes),
    stripeEnabled: Boolean(source.stripeEnabled ?? GLOBAL_CONFIG_DEFAULTS.stripeEnabled),
    stripePublicKey: text("stripePublicKey", GLOBAL_CONFIG_DEFAULTS.stripePublicKey, 200),
    localTerminalEnabled: Boolean(source.localTerminalEnabled ?? GLOBAL_CONFIG_DEFAULTS.localTerminalEnabled),
    localTerminalName: text("localTerminalName", GLOBAL_CONFIG_DEFAULTS.localTerminalName, 80),
  };
}

async function readConfig(key: string): Promise<Record<string, unknown>> {
  const document = await AdminConfig.findOne({ key }).lean().exec();
  const data = document && typeof (document as any).data === "object" ? (document as any).data : {};
  return data || {};
}

async function writeConfig(key: string, data: Record<string, unknown>): Promise<void> {
  await AdminConfig.updateOne({ key }, { $set: { data } }, { upsert: true }).exec();
}

export const adminConfigRouter = Router();

adminConfigRouter.get("/api/v1/admin/security/settings", requireRole("admin"), async (_request, response) => {
  const stored = await readConfig("security");
  response.json({ ...SECURITY_DEFAULTS, ...sanitizeSecurity({ ...SECURITY_DEFAULTS, ...stored }) });
});

adminConfigRouter.put("/api/v1/admin/security/settings", requireRole("admin"), async (request, response) => {
  const before = sanitizeSecurity({ ...SECURITY_DEFAULTS, ...(await readConfig("security")) });
  const after = sanitizeSecurity({ ...before, ...(request.body || {}) });
  await writeConfig("security", after);
  await recordGovernanceEvent({
    actor: { employeeId: request.auth?.employeeId ?? null, role: request.auth?.role ?? "admin", tenantId: request.auth?.tenantId ?? null },
    action: "security_settings_updated",
    targetType: "system",
    before,
    after,
    reason: "Actualización de política de seguridad desde el panel",
  }).catch(() => undefined);
  response.json(after);
});

adminConfigRouter.post("/api/v1/admin/security/sessions/revoke-all", requireRole("admin"), async (request, response) => {
  const now = new Date();
  const result = await EmployeeSession.updateMany(
    { employeeId: request.auth?.employeeId, expiresAt: { $gt: now } },
    { $set: { expiresAt: new Date(now.getTime() - 1000) } },
  ).exec();
  await recordGovernanceEvent({
    actor: { employeeId: request.auth?.employeeId ?? null, role: request.auth?.role ?? "admin", tenantId: request.auth?.tenantId ?? null },
    action: "employee_sessions_revoked",
    targetType: "employee",
    after: { revoked: result.modifiedCount ?? 0 },
    reason: "Cierre de sesiones solicitado desde el panel",
  }).catch(() => undefined);
  response.json({ revoked: result.modifiedCount ?? 0 });
});

adminConfigRouter.get("/api/v1/admin/global-config", requireRole("admin"), async (_request, response) => {
  const stored = await readConfig("global");
  response.json({ ...GLOBAL_CONFIG_DEFAULTS, ...sanitizeGlobal({ ...GLOBAL_CONFIG_DEFAULTS, ...stored }) });
});

adminConfigRouter.put("/api/v1/admin/global-config", requireRole("admin"), async (request, response) => {
  const before = sanitizeGlobal({ ...GLOBAL_CONFIG_DEFAULTS, ...(await readConfig("global")) });
  const after = sanitizeGlobal({ ...before, ...(request.body || {}) });
  await writeConfig("global", after);
  await recordGovernanceEvent({
    actor: { employeeId: request.auth?.employeeId ?? null, role: request.auth?.role ?? "admin", tenantId: request.auth?.tenantId ?? null },
    action: "global_config_updated",
    targetType: "system",
    before,
    after,
    reason: "Actualización de ajustes globales desde el panel",
  }).catch(() => undefined);
  response.json(after);
});
