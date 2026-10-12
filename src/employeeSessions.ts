import mongoose, { Schema } from "mongoose";
import { EmployeeAccount, Rider } from "./models.js";
import { createSessionToken, hashSessionToken } from "./employeeAuth.js";
import { buildTenantScope } from "./tenantScope.js";

export const OWNER_EMAIL = "rrhh.milchollos@gmail.com";
// Persistent PWA sessions survive closing/reopening the app while remaining
// bounded; password changes, suspension and explicit logout still revoke them.
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const schema = new Schema({
  tokenHash: { type: String, required: true, unique: true, index: true },
  employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
  // The authenticated tenant is a security property of a session, not a
  // mutable lookup on EmployeeAccount. `null` is only permitted for the
  // protected platform owner while it is not yet assigned to a root tenant.
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", default: null },
  role: { type: String, enum: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"], required: true },
  surface: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  issuedAt: { type: Date, required: true },
}, { collection: "employee_sessions" });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const EmployeeSession = mongoose.models.EmployeeSession || mongoose.model("EmployeeSession", schema);

type SessionEmployee = {
  email?: unknown;
  tenantId?: unknown;
  ownerProtected?: unknown;
  accessLevel?: unknown;
};

/** Converts a persisted BSON/string tenant id to its stable comparison form. */
export function frozenTenantId(tenantId: unknown): string | null {
  if (tenantId === null || tenantId === undefined) return null;
  const value = String(tenantId).trim();
  return value && value !== "null" && value !== "undefined" ? value : null;
}

/** A session must never inherit a newly assigned tenant from its employee. */
export function sessionTenantMatchesEmployee(sessionTenantId: unknown, employeeTenantId: unknown): boolean {
  return frozenTenantId(sessionTenantId) === frozenTenantId(employeeTenantId);
}

/**
 * The legacy platform owner may administer tenant setup before being attached
 * to the root tenant. This is deliberately identity-based, never role-based.
 */
export function isRootOwnerAccount(employee: SessionEmployee | null | undefined): boolean {
  return Boolean(
    employee
    && typeof employee.email === "string"
    && employee.email.toLowerCase() === OWNER_EMAIL
    && employee.ownerProtected === true
    && employee.accessLevel === "superadmin",
  );
}

/** Human employee sessions require a tenant context, except the protected owner. */
export function canIssueEmployeeSession(employee: SessionEmployee | null | undefined): boolean {
  return Boolean(frozenTenantId(employee?.tenantId) || isRootOwnerAccount(employee));
}

/** A surface can narrow a role, never grant privileges from a request header. */
export function sessionRole(employee: { email: string; apiRole: string; roles?: string[]; primaryRole?: string | null; ownerProtected?: boolean; authorizationStatus?: string }, surface: string, requestedRole?: string): string | null {
  if (employee.authorizationStatus && employee.authorizationStatus !== "approved") return null;
  const availableRoles = Array.isArray(employee.roles) && employee.roles.length ? employee.roles : [employee.apiRole];
  // An explicitly persisted admin membership must open the administrative
  // surface as admin even when the account's operational default is Partner.
  if (surface === "admin" && availableRoles.includes("admin")) return "admin";
  // A multi-role employee opening a specific app must receive that app's
  // role by default. Partner and Rider sessions remain independent.
  const surfaceDefault = surface === "rider" ? "rider" : surface === "partner" || surface === "partners" ? "partner" : surface === "fleet" ? "fleet" : surface === "admin" ? "admin" : null;
  const selectedRole = requestedRole || (surfaceDefault && availableRoles.includes(surfaceDefault) ? surfaceDefault : employee.primaryRole || employee.apiRole);
  // The protected owner account may operate internal surfaces even though its
  // persisted business role remains admin. Keep the issued session scoped to
  // the requested app and apply this exception before the ordinary role list.
  if (employee.email === OWNER_EMAIL && employee.ownerProtected && ["admin", "partner", "fleet"].includes(selectedRole) && ["partner", "fleet"].includes(surface)) return surface;
  if (surface === "rider" && employee.email === OWNER_EMAIL && employee.ownerProtected && ["admin", "rider"].includes(selectedRole)) return "rider";
  if (!availableRoles.includes(selectedRole)) return null;
  const permitted: Record<string, string[]> = { rider: ["rider"], partner: ["partner"], partners: ["partner"], fleet: ["fleet", "commercial", "gerente_comercial_zona"], admin: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"] };
  return permitted[surface] && !permitted[surface].includes(selectedRole) ? null : selectedRole;
}

export async function issueEmployeeSession(employee: any, surface: string, requestedRole?: string) {
  const role = sessionRole(employee, surface, requestedRole);
  const tenantId = frozenTenantId(employee?.tenantId);
  if (!role || !canIssueEmployeeSession(employee) || (!tenantId && role !== "admin")) return null;
  const token = createSessionToken();
  const now = new Date();
  await EmployeeSession.create({
    tokenHash: hashSessionToken(token),
    employeeId: employee._id,
    tenantId: tenantId ? employee.tenantId : null,
    role,
    surface: surface || employee.apiRole,
    issuedAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  await EmployeeAccount.updateOne({ _id: employee._id }, { $set: { lastLoginAt: now } }).exec();
  return { token, role };
}

export async function resolveEmployeeSession(token: string) {
  const session = await EmployeeSession.findOne({ tokenHash: hashSessionToken(token), expiresAt: { $gt: new Date() } }).lean().exec() as any;
  if (!session) return null;
  const employee = await EmployeeAccount.findOne({ _id: session.employeeId, active: true }).lean().exec() as any;
  if (!employee || (employee.passwordChangedAt && new Date(employee.passwordChangedAt) > new Date(session.issuedAt))) return null;
  // Sessions issued before tenant binding are intentionally not upgraded from
  // EmployeeAccount, except the pre-existing protected root-admin session.
  // That narrow path is converted once and can no longer silently switch.
  if (!Object.prototype.hasOwnProperty.call(session, "tenantId")) {
    if (session.role !== "admin" || !isRootOwnerAccount(employee)) return null;
    const tenantId = frozenTenantId(employee.tenantId) ? employee.tenantId : null;
    await EmployeeSession.updateOne({ _id: session._id, tenantId: { $exists: false } }, { $set: { tenantId } }).exec();
    session.tenantId = tenantId;
  }
  if (!sessionTenantMatchesEmployee(session.tenantId, employee.tenantId)) return null;
  const tenantId = frozenTenantId(session.tenantId);
  // No ordinary human session is valid without a private tenant context. The
  // protected root owner keeps only its existing administrative bootstrap path.
  if (!tenantId && !(session.role === "admin" && isRootOwnerAccount(employee))) return null;
  if (sessionRole(employee, session.surface, session.role) !== session.role) return null;
  if (session.role === "rider") {
    const riderScope = buildTenantScope(tenantId);
    if (!(await Rider.exists({ email: employee.email, ...riderScope }))) return null;
  }
  return {
    role: session.role,
    employeeId: String(employee._id),
    tenantId: tenantId || undefined,
    mustChangePassword: Boolean(employee.mustChangePassword),
    isRootOwner: session.role === "admin" && isRootOwnerAccount(employee),
  };
}

/**
 * Compatibility path for the pre-employee_sessions token of the protected
 * root owner only. It converts that token once into a tenant-frozen session
 * and clears the mutable legacy hash. Ordinary legacy employee tokens are
 * deliberately rejected rather than inheriting a changed tenant.
 */
export async function adoptLegacyRootOwnerSession(token: string) {
  const tokenHash = hashSessionToken(token);
  const employee = await EmployeeAccount.findOne({ sessionHash: tokenHash, active: true }).lean().exec() as any;
  if (!isRootOwnerAccount(employee)) return null;
  const role = sessionRole(employee, "admin", "admin");
  if (role !== "admin") return null;
  const now = new Date();
  await EmployeeSession.updateOne(
    { tokenHash },
    {
      $setOnInsert: {
        employeeId: employee._id,
        tenantId: frozenTenantId(employee.tenantId) ? employee.tenantId : null,
        role,
        surface: "admin",
        issuedAt: now,
        expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
      },
    },
    { upsert: true },
  ).exec();
  await EmployeeAccount.updateOne({ _id: employee._id, sessionHash: tokenHash }, { $set: { sessionHash: null, lastLoginAt: now } }).exec();
  return resolveEmployeeSession(token);
}

export async function revokeEmployeeSessions(employeeId: unknown) {
  await EmployeeSession.deleteMany({ employeeId }).exec();
}
