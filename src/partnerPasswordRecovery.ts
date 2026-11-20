import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { isPartnerEmployee, partnerBindingErrorResponse, partnerBindingForEmployee } from "./employeePartnerBinding.js";
import type { KitchenBindingDependencies } from "./partnerKitchenAccess.js";

const id = z.string().regex(/^[a-f\d]{24}$/i).transform((value) => value.toLowerCase());
export const partnerRecoveryPreviewSchema = z.object({ tenantId: id, restaurantId: id }).strict();
export const partnerRecoverySendSchema = partnerRecoveryPreviewSchema.extend({ employeeId: id, manifestHash: z.string().regex(/^[a-f\d]{64}$/), confirmation: z.literal("SEND_PARTNER_PASSWORD_RECOVERY") }).strict();
export const PARTNER_PASSWORD_RECOVERY_PATH = "/api/v1/admin/partner-password-recovery";
export type PartnerRecoveryPreview = {
  tenantId: string;
  restaurant: { id: string; name: string };
  employee: { id: string; name: string; email: string } | null;
  ready: boolean;
  blockers: { code: string; message: string }[];
  manifestHash: string;
};
export type PartnerPasswordRecoveryDependencies = {
  requireOwner(): RequestHandler;
  sendRateLimit: RequestHandler;
  objectId(id: string): unknown;
  restaurant(filter: any): Promise<any>;
  employees(filter: any): Promise<any[]>;
  binding: KitchenBindingDependencies;
  canUsePartner(employee: any): boolean;
  sendEmployeePasswordLink(employee: any, surface: "partner", purpose: "recovery"): Promise<{ delivery: { sent: boolean } }>;
  audit?: (event: { tenantId: string; restaurantId: string; employeeId: string; actorEmployeeId: string; sent: boolean }) => Promise<unknown>;
};
const emailOf = (value: unknown) => typeof value === "string" ? value.trim().toLowerCase() : "";
const sameId = (a: unknown, b: string) => String(a || "").toLowerCase() === b;
const associated = (employee: any, restaurantId: string) => sameId(employee.restaurantId, restaurantId)
  || (Array.isArray(employee.restaurantIds) && employee.restaurantIds.some((value: any) => sameId(value, restaurantId)));
const fields = (row: any, keys: string[]) => Object.fromEntries(keys.map((key) => [key, row?.[key] ?? null]));
const employeeKeys = ["_id", "name", "email", "tenantId", "active", "authorizationStatus", "apiRole", "jobRole", "primaryRole", "roles", "partnerRoles", "restaurantId", "restaurantIds", "accessLevel", "ownerProtected", "kitchenAccessSetupVersion", "partnerBindingVersion", "fleetId", "zoneSlugs", "updatedAt", "kitchenAccessRevision"];
const restaurantKeys = ["_id", "tenantId", "name", "email", "onboardingStatus", "listingType", "internalDemo", "updatedAt", "kitchenAccessRevision"];
const membershipKeys = ["_id", "employeeId", "tenantId", "role", "status", "scopes", "restaurantIds", "updatedAt", "kitchenAccessRevision"];
// Fixed, count-safe messages only. Binding errors must also pass the existing
// response helper: neither arbitrary error.code nor error.message is public.
const diagnosticMessages = {
  ACCOUNT_NOT_FOUND_IN_TENANT: "No existe una cuenta con el correo de contacto del restaurante en el tenant seleccionado.",
  ACCOUNT_RESTAURANT_ASSOCIATION_MISSING: "La cuenta con el correo de contacto no tiene una asociación persistida válida al restaurante seleccionado.",
  ACCOUNT_AMBIGUOUS_IN_TENANT: "El correo de contacto es ambiguo en el tenant seleccionado; no se elegirá una cuenta sin asociación.",
  ACCOUNT_LOOKUP_SCOPE_CONFLICT: "La cuenta devuelta no cumple los límites de correo, tenant y asociación del destino.",
  ACCOUNT_LOOKUP_CHANGED: "Las consultas de comprobación no coinciden sobre la asociación persistida. Actualiza la vista previa; este diagnóstico no habilita el envío.",
  ACCOUNT_INACTIVE: "Una cuenta asociada con el correo de contacto no está activa.",
  ACCOUNT_NOT_APPROVED: "Una cuenta asociada con el correo de contacto no está aprobada.",
  ACCOUNT_NOT_PARTNER: "Una cuenta asociada con el correo de contacto no tiene rol Partner.",
  ACCOUNT_PARTNER_SURFACE_NOT_ALLOWED: "Una cuenta asociada con el correo de contacto no tiene acceso a la superficie Partner.",
  PARTNER_TENANT_BINDING_REQUIRED: "La cuenta Partner no tiene un vínculo de identidad y tenant válido.",
  EMPLOYEE_NOT_APPROVED: "El binding requiere una cuenta activa y aprobada.",
  PARTNER_RESTAURANT_ASSIGNMENT_INVALID: "La asignación persistida de restaurantes de la cuenta Partner no es válida.",
  PARTNER_RESTAURANT_NOT_ASSIGNED: "La cuenta Partner no tiene una asignación de restaurantes válida.",
  PARTNER_TENANT_NOT_ACTIVE: "El tenant vinculado a la cuenta Partner no está activo.",
  PARTNER_RESTAURANT_NOT_FOUND_IN_TENANT: "Un restaurante del binding Partner no existe en el tenant de la cuenta.",
  PARTNER_RESTAURANT_SETUP_INVALID: "La configuración persistida de un restaurante del binding Partner no es válida.",
  PARTNER_MEMBERSHIP_BINDING_REQUIRED: "La membresía Partner persistida no coincide con el tenant, estado o restaurantes del binding.",
  PARTNER_ROLES_REQUIRED: "La cuenta no tiene roles operativos Partner válidos.",
  PARTNER_MEMBERSHIP_SCOPE_CONFLICT: "Los permisos persistidos de la membresía Partner no coinciden con sus roles operativos.",
  KITCHEN_ACCOUNT_BINDING_CONFLICT: "La cuenta de cocina no cumple su contrato de binding persistido.",
  KITCHEN_TENANT_NOT_ACTIVE: "El tenant vinculado a la cuenta de cocina no está activo.",
  KITCHEN_RESTAURANT_NOT_FOUND_IN_TENANT: "El restaurante del binding de cocina no existe en el tenant de la cuenta.",
  KITCHEN_RESTAURANT_SETUP_INVALID: "La configuración persistida del restaurante de cocina no es válida.",
  KITCHEN_RESTAURANT_CONTACT_CONFLICT: "El correo persistido de la cuenta de cocina no coincide con el contacto de su restaurante vinculado.",
  KITCHEN_MEMBERSHIP_CONFLICT: "La membresía de cocina no cumple el contrato persistido de tenant, rol, estado, restaurante y permisos.",
  ACCOUNT_BINDING_VALIDATION_UNAVAILABLE: "No se pudo validar el binding persistido de la cuenta Partner. Actualiza la vista previa o inténtalo más tarde.",
} as const;
type DiagnosticCode = keyof typeof diagnosticMessages;
function bindingDiagnostic(error: unknown): DiagnosticCode {
  const code = partnerBindingErrorResponse(error)?.error;
  return code && Object.hasOwn(diagnosticMessages, code) && (code.startsWith("PARTNER_") || code.startsWith("KITCHEN_") || code === "EMPLOYEE_NOT_APPROVED")
    ? code as DiagnosticCode : "ACCOUNT_BINDING_VALIDATION_UNAVAILABLE";
}
function canonical(value: any): any {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value?.toHexString === "function") return value.toHexString();
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

/** Read-only resolution. The contact email is a boundary, never a hint for
 * global discovery. Different employee email means blocked, not repaired.
 */
export async function buildPartnerRecoveryPreview(target: { tenantId: string; restaurantId: string }, deps: PartnerPasswordRecoveryDependencies): Promise<{ preview: PartnerRecoveryPreview; employee: any | null }> {
  const blockers: PartnerRecoveryPreview["blockers"] = [];
  const add = (code: string, message: string) => blockers.push({ code, message });
  const restaurant = await deps.restaurant({ _id: deps.objectId(target.restaurantId), tenantId: deps.objectId(target.tenantId) });
  const eligible: any[] = [];
  const snapshot: any[] = [];
  const diagnostics = new Set<DiagnosticCode>();
  let contactDiagnosticSnapshot: any[] = [];
  let contact = "";
  if (!restaurant || !sameId(restaurant.tenantId, target.tenantId) || !sameId(restaurant._id, target.restaurantId)) {
    add("RESTAURANT_NOT_FOUND_IN_TENANT", "El restaurante no existe en el tenant seleccionado.");
  } else {
    contact = emailOf(restaurant.email);
    if (!z.string().email().max(254).safeParse(contact).success) add("RESTAURANT_CONTACT_EMAIL_REQUIRED", "El restaurante no tiene un correo de contacto válido.");
    else {
      // Native reads preserve both BSON types: legacy string associations are
      // exact persisted IDs, not a fallback account or an inferred binding.
      const restaurantIds = [deps.objectId(target.restaurantId), target.restaurantId];
      const candidates = await deps.employees({ tenantId: deps.objectId(target.tenantId), email: contact, $or: [{ restaurantId: { $in: restaurantIds } }, { restaurantIds: { $in: restaurantIds } }] });
      for (const employee of candidates) {
        const reasons: DiagnosticCode[] = [];
        const reject = (code: DiagnosticCode) => { reasons.push(code); diagnostics.add(code); };
        const entry: any = { employee: fields(employee, employeeKeys), valid: false, diagnostics: reasons };
        snapshot.push(entry);
        if (!sameId(employee.tenantId, target.tenantId) || emailOf(employee.email) !== contact || !associated(employee, target.restaurantId)) {
          reject("ACCOUNT_LOOKUP_SCOPE_CONFLICT"); continue;
        }
        if (employee.active !== true) reject("ACCOUNT_INACTIVE");
        if (employee.authorizationStatus !== "approved") reject("ACCOUNT_NOT_APPROVED");
        if (!isPartnerEmployee(employee)) reject("ACCOUNT_NOT_PARTNER");
        if (reasons.length) continue;
        if (!deps.canUsePartner(employee)) { reject("ACCOUNT_PARTNER_SURFACE_NOT_ALLOWED"); continue; }
        try {
          const binding = await partnerBindingForEmployee(employee, deps.binding);
          entry.binding = { restaurants: binding.restaurants.map((row: any) => fields(row, restaurantKeys)), membership: fields(binding.membership, membershipKeys) };
          if (!binding.restaurants.some((row: any) => sameId(row._id, target.restaurantId) && sameId(row.tenantId, target.tenantId))) {
            reject("ACCOUNT_RESTAURANT_ASSOCIATION_MISSING"); continue;
          }
          entry.valid = true; eligible.push(employee);
        } catch (error) {
          reject(bindingDiagnostic(error));
        }
      }
      if (!candidates.length) {
        // Diagnostic only: exactly the same contact and tenant, never a global
        // email search or an alternate login. These rows NEVER enter eligible.
        const contactAccounts = await deps.employees({ tenantId: deps.objectId(target.tenantId), email: contact });
        const scoped = contactAccounts.filter((row) => sameId(row.tenantId, target.tenantId) && emailOf(row.email) === contact);
        contactDiagnosticSnapshot = scoped.map((row) => fields(row, employeeKeys));
        if (scoped.length !== contactAccounts.length) diagnostics.add("ACCOUNT_LOOKUP_SCOPE_CONFLICT");
        if (!scoped.length) diagnostics.add("ACCOUNT_NOT_FOUND_IN_TENANT");
        else if (scoped.length !== 1) diagnostics.add("ACCOUNT_AMBIGUOUS_IN_TENANT");
        else diagnostics.add(associated(scoped[0], target.restaurantId) ? "ACCOUNT_LOOKUP_CHANGED" : "ACCOUNT_RESTAURANT_ASSOCIATION_MISSING");
      }
      if (!eligible.length) {
        add("PARTNER_RECOVERY_ACCOUNT_NOT_ELIGIBLE", "No hay una cuenta Partner activa y aprobada con este correo de contacto, este tenant y una asociación válida al restaurante. No se buscará otra cuenta ni se modificará su correo.");
        for (const code of [...diagnostics].sort()) add(code, diagnosticMessages[code]);
      }
      else if (eligible.length !== 1) add("PARTNER_RECOVERY_ACCOUNT_AMBIGUOUS", "Hay más de una cuenta Partner elegible. Revisa la asociación antes de enviar.");
    }
  }
  const employee = blockers.length === 0 && eligible.length === 1 ? eligible[0] : null;
  const publicEmployee = employee ? { id: String(employee._id), name: String(employee.name || ""), email: emailOf(employee.email) } : null;
  const publicRestaurant = { id: target.restaurantId, name: restaurant && sameId(restaurant.tenantId, target.tenantId) ? String(restaurant.name || "") : "" };
  // Explicit whitelist only: password/session/token fields never enter this hash.
  const manifestHash = createHash("sha256").update(JSON.stringify(canonical({ version: 1, target, restaurant: fields(restaurant, restaurantKeys), contact, candidates: snapshot, contactDiagnostic: contactDiagnosticSnapshot, employee: publicEmployee, blockers }))).digest("hex");
  return { preview: { tenantId: target.tenantId, restaurant: publicRestaurant, employee: publicEmployee, ready: Boolean(employee), blockers, manifestHash }, employee };
}
function tenantAllowed(req: Request, tenantId: string) {
  return Boolean(req.auth?.role === "admin" && req.auth.employeeId && !req.auth.mustChangePassword
    && (req.auth.isRootOwner === true || req.auth.tenantId?.toLowerCase() === tenantId));
}
export function registerPartnerPasswordRecoveryRoutes(app: Pick<Express, "get" | "post">, deps: PartnerPasswordRecoveryDependencies) {
  app.get(`${PARTNER_PASSWORD_RECOVERY_PATH}/preview`, deps.requireOwner(), async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const parsed = partnerRecoveryPreviewSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARTNER_RECOVERY_TARGET", message: "Indica tenantId y restaurantId válidos de 24 caracteres hexadecimales." });
    if (!tenantAllowed(req, parsed.data.tenantId)) return res.status(403).json({ error: "PARTNER_RECOVERY_TENANT_FORBIDDEN", message: "No tienes autorización para este tenant." });
    try { return res.json((await buildPartnerRecoveryPreview(parsed.data, deps)).preview); }
    catch { return res.status(503).json({ error: "PARTNER_RECOVERY_UNAVAILABLE", message: "No se pudo verificar el destino. Inténtalo más tarde." }); }
  });
  app.post(`${PARTNER_PASSWORD_RECOVERY_PATH}/send`, deps.requireOwner(), deps.sendRateLimit, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const parsed = partnerRecoverySendSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_PARTNER_RECOVERY_CONFIRMATION", message: "Confirma el destinatario y el resumen actualizado antes de enviar." });
    const input = parsed.data;
    if (!tenantAllowed(req, input.tenantId)) return res.status(403).json({ error: "PARTNER_RECOVERY_TENANT_FORBIDDEN", message: "No tienes autorización para este tenant." });
    let current: Awaited<ReturnType<typeof buildPartnerRecoveryPreview>>;
    try { current = await buildPartnerRecoveryPreview({ tenantId: input.tenantId, restaurantId: input.restaurantId }, deps); }
    catch { return res.status(503).json({ error: "PARTNER_RECOVERY_UNAVAILABLE", message: "No se pudo verificar el destino. Inténtalo más tarde." }); }
    if (current.preview.manifestHash !== input.manifestHash) return res.status(409).json({ error: "PARTNER_RECOVERY_PREVIEW_CHANGED", message: "El destino o su autorización han cambiado. Actualiza la vista previa y vuelve a confirmar." });
    if (!current.preview.ready || !current.employee || String(current.employee._id) !== input.employeeId) return res.status(409).json({ error: "PARTNER_RECOVERY_BLOCKED", message: "El destinatario no es elegible. Actualiza la vista previa y revisa los bloqueos.", blockers: current.preview.blockers });
    let sent = false;
    try {
      // A final binding check plus the existing helper's own validation; no
      // transaction is held open while SMTP runs, no password/role changes.
      await partnerBindingForEmployee(current.employee, deps.binding);
      sent = (await deps.sendEmployeePasswordLink(current.employee, "partner", "recovery")).delivery.sent === true;
    } catch { /* Never leak provider errors, tokens, URLs or password data. */ }
    if (deps.audit) { try { await deps.audit({ tenantId: input.tenantId, restaurantId: input.restaurantId, employeeId: input.employeeId, actorEmployeeId: req.auth!.employeeId!, sent }); } catch { /* Do not report accepted mail as failed because an audit write failed. */ } }
    if (!sent) return res.status(503).json({ error: "PARTNER_RECOVERY_DELIVERY_UNAVAILABLE", message: "No se pudo confirmar el envío del correo de recuperación. Inténtalo más tarde." });
    return res.json({ sent: true, tenantId: input.tenantId, restaurantId: input.restaurantId, employeeId: input.employeeId, recipient: current.preview.employee!.email, expiresInMinutes: 30 });
  });
}

/** Bounded keys: persisted actor and explicit destination only, never bearer,
 * email, arbitrary surface headers or raw body values. A shared counter may be
 * injected; failures use bounded local buckets as in the existing API policy.
 */
export function partnerRecoverySendRateLimit(options: { increment?: (key: string, windowMs: number) => Promise<number | null>; now?: () => number; limit?: number; windowMs?: number } = {}): RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const limit = options.limit ?? 3;
  const windowMs = options.windowMs ?? 15 * 60_000;
  return async (req, res, next) => {
    if (!req.auth?.employeeId) return res.status(403).json({ error: "SUPERADMIN_ONLY" });
    const now = options.now?.() ?? Date.now();
    for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
    const target = partnerRecoveryPreviewSchema.safeParse({ tenantId: req.body?.tenantId, restaurantId: req.body?.restaurantId });
    const keys = [`piki:partner-recovery:actor:${createHash("sha256").update(req.auth.employeeId).digest("hex")}`];
    if (target.success) keys.push(`piki:partner-recovery:target:${target.data.tenantId}:${target.data.restaurantId}`);
    for (const key of keys) {
      // Capacity exhaustion fails closed rather than dropping active limits.
      if (!buckets.has(key) && buckets.size >= 10_000) return res.status(503).json({ error: "PARTNER_RECOVERY_UNAVAILABLE" });
      const bucket = buckets.get(key) || { count: 0, resetAt: now + windowMs };
      bucket.count++; buckets.set(key, bucket);
      let count: number | null = null;
      if (options.increment) { try { count = await options.increment(key, windowMs); } catch { /* bounded local fallback */ } }
      if (Math.max(bucket.count, typeof count === "number" && Number.isFinite(count) ? count : 0) > limit) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader("Retry-After", String(retryAfterSeconds));
        return res.status(429).json({ error: "RATE_LIMITED", message: "Espera antes de solicitar otro correo de recuperación.", retryAfterSeconds });
      }
    }
    return next();
  };
}
