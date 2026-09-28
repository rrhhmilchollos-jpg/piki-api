import type { NextFunction, Request, Response } from "express";
import { EmployeeAccount, Rider } from "./models.js";
import { hashSessionToken } from "./employeeAuth.js";
import { resolveEmployeeSession } from "./employeeSessions.js";

export const apiRoles = ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona"] as const;
export type ApiRole = (typeof apiRoles)[number];
export const PIKI_OWNER_EMAIL = "rrhh.milchollos@gmail.com";

declare global {
  namespace Express {
    interface Request {
      auth?: { role: ApiRole; employeeId?: string; tenantId?: string; mustChangePassword?: boolean; accessLevel?: "superadmin" | "subadmin" };
    }
  }
}

const tokenEntries: Array<[ApiRole, string | undefined]> = [
  ["admin", process.env.ADMIN_API_TOKEN],
  ["partner", process.env.PARTNER_API_TOKEN],
  ["rider", process.env.RIDER_API_TOKEN],
  ["fleet", process.env.FLEET_API_TOKEN],
  ["commercial", process.env.COMMERCIAL_API_TOKEN],
];

export async function resolveRole(request: Request): Promise<{ role: ApiRole; employeeId?: string; tenantId?: string; mustChangePassword?: boolean; accessLevel?: "superadmin" | "subadmin" } | null> {
  const header = request.header("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const match = tokenEntries.find(([, configured]) => configured && configured === token);
  if (match?.[0]) return { role: match[0] };
  const scoped = await resolveEmployeeSession(token);
  if (scoped) return { ...scoped, role: scoped.role as ApiRole };
  const employee = await EmployeeAccount.findOne({ sessionHash: hashSessionToken(token), active: true }).lean().exec() as any;
  return employee ? { role: employee.apiRole as ApiRole, employeeId: String(employee._id), tenantId: employee.tenantId ? String(employee.tenantId) : undefined, mustChangePassword: employee.mustChangePassword, accessLevel: employee.accessLevel } : null;
}

export function requireRole(...allowedRoles: ApiRole[]) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const auth = await resolveRole(request);
    if (!auth) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return response.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (!allowedRoles.includes(auth.role)) return response.status(403).json({ error: "FORBIDDEN", role: auth.role });
    if (auth.mustChangePassword && !request.path.endsWith("/employee/change-password") && !request.path.endsWith("/employee/me")) return response.status(428).json({ error: "PASSWORD_CHANGE_REQUIRED" });
    request.auth = auth;
    const riderResource = request.path.match(/^\/api\/v1\/riders\/([a-f\d]{24})(?:\/|$)/i);
    if (auth.role === "rider" && riderResource) {
      const employee = auth.employeeId ? await EmployeeAccount.findById(auth.employeeId).select("email").lean().exec() as any : null;
      const allowed = employee ? await Rider.exists({ _id: riderResource[1], email: employee.email }) : process.env.RIDER_API_RIDER_ID === riderResource[1];
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
