import type { NextFunction, Request, Response } from "express";
import { EmployeeAccount, Rider } from "./models.js";
import { adoptLegacyRootOwnerSession, resolveEmployeeSession } from "./employeeSessions.js";
import { buildTenantEntityScope, buildTenantScope } from "./tenantScope.js";

export const apiRoles = ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"] as const;
export type ApiRole = (typeof apiRoles)[number];
export const PIKI_OWNER_EMAIL = "rrhh.milchollos@gmail.com";

declare global {
  namespace Express {
    interface Request {
      auth?: { role: ApiRole; employeeId?: string; tenantId?: string; mustChangePassword?: boolean; accessLevel?: "superadmin" | "subadmin"; isRootOwner?: boolean };
    }
  }
}

const tokenEntries: Array<[ApiRole, string | undefined]> = [
  ["admin", process.env.ADMIN_API_TOKEN],
  ["partner", process.env.PARTNER_API_TOKEN],
  ["rider", process.env.RIDER_API_TOKEN],
  ["fleet", process.env.FLEET_API_TOKEN],
  ["commercial", process.env.COMMERCIAL_API_TOKEN],
  ["finance", process.env.FINANCE_API_TOKEN],
  ["support", process.env.SUPPORT_API_TOKEN],
];

export async function resolveRole(request: Request): Promise<{ role: ApiRole; employeeId?: string; tenantId?: string; mustChangePassword?: boolean; accessLevel?: "superadmin" | "subadmin"; isRootOwner?: boolean } | null> {
  const header = request.header("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const match = tokenEntries.find(([, configured]) => configured && configured === token);
  if (match?.[0]) return { role: match[0] };
  const scoped = await resolveEmployeeSession(token);
  if (scoped) return { ...scoped, role: scoped.role as ApiRole };
  // Only the protected platform owner may upgrade a pre-session credential;
  // ordinary legacy hashes cannot be allowed to inherit a mutable tenant.
  const legacyRoot = await adoptLegacyRootOwnerSession(token);
  return legacyRoot ? { ...legacyRoot, role: legacyRoot.role as ApiRole } : null;
}

export function isTemporaryPasswordAllowedPath(path: string): boolean {
  return path.endsWith("/employee/change-password");
}

export function requireRole(...allowedRoles: ApiRole[]) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const auth = await resolveRole(request);
    if (!auth) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return response.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (!allowedRoles.includes(auth.role)) return response.status(403).json({ error: "FORBIDDEN", role: auth.role });
    if (auth.employeeId && !auth.tenantId && !auth.isRootOwner) return response.status(403).json({ error: "TENANT_CONTEXT_REQUIRED" });
    // A temporary credential only grants access to the password-change endpoint.
    // The profile endpoint is deliberately blocked too, preventing API clients
    // from treating the UI-only gate as an optional warning.
    if (auth.mustChangePassword && !isTemporaryPasswordAllowedPath(request.path)) return response.status(428).json({ error: "PASSWORD_CHANGE_REQUIRED" });
    request.auth = auth;
    const riderResource = request.path.match(/^\/api\/v1\/riders\/([a-f\d]{24})(?:\/|$)/i);
    if (auth.role === "rider" && riderResource) {
      const employeeScope = buildTenantScope(auth.tenantId);
      const riderScope = buildTenantEntityScope(auth.tenantId, riderResource[1]);
      const employee = auth.employeeId && auth.tenantId
        ? await EmployeeAccount.findOne({ _id: auth.employeeId, ...employeeScope }).select("email").lean().exec() as any
        : null;
      const allowed = employee
        ? await Rider.exists({ ...riderScope, email: employee.email })
        : process.env.RIDER_API_RIDER_ID === riderResource[1];
      if (!allowed) return response.status(403).json({ error: "RIDER_ACCESS_DENIED" });
    }
    return next();
  };
}

/** Solo la cuenta protegida del propietario puede administrar accesos. */
export function requireOwner() {
  return async (request: Request, response: Response, next: NextFunction) => {
    const auth = await resolveRole(request);
    if (!auth) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return response.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (auth.role !== "admin" || !auth.employeeId) return response.status(403).json({ error: "SUPERADMIN_ONLY" });
    const owner = await EmployeeAccount.findOne({ _id: auth.employeeId, email: PIKI_OWNER_EMAIL, active: true, authorizationStatus: "approved", accessLevel: "superadmin" }).select("_id").lean().exec();
    if (!owner) return response.status(403).json({ error: "SUPERADMIN_ONLY", message: "Solo RRHH superadmin puede realizar esta operación." });
    if (auth.mustChangePassword) return response.status(428).json({ error: "PASSWORD_CHANGE_REQUIRED" });
    request.auth = auth;
    return next();
  };
}

export function configuredAuthRoles() {
  return tokenEntries.filter(([, token]) => Boolean(token)).map(([role]) => role);
}
