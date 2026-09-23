import type { NextFunction, Request, Response } from "express";
import { EmployeeAccount } from "./models.js";
import { hashSessionToken } from "./employeeAuth.js";

export const apiRoles = ["admin", "partner", "rider", "fleet"] as const;
export type ApiRole = (typeof apiRoles)[number];

declare global {
  namespace Express {
    interface Request {
      auth?: { role: ApiRole; employeeId?: string; mustChangePassword?: boolean };
    }
  }
}

const tokenEntries: Array<[ApiRole, string | undefined]> = [
  ["admin", process.env.ADMIN_API_TOKEN],
  ["partner", process.env.PARTNER_API_TOKEN],
  ["rider", process.env.RIDER_API_TOKEN],
  ["fleet", process.env.FLEET_API_TOKEN],
];

async function resolveRole(request: Request): Promise<{ role: ApiRole; employeeId?: string; mustChangePassword?: boolean } | null> {
  const header = request.header("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const match = tokenEntries.find(([, configured]) => configured && configured === token);
  if (match?.[0]) return { role: match[0] };
  const employee = await EmployeeAccount.findOne({ sessionHash: hashSessionToken(token), active: true }).lean().exec() as any;
  return employee ? { role: employee.apiRole as ApiRole, employeeId: String(employee._id), mustChangePassword: employee.mustChangePassword } : null;
}

export function requireRole(...allowedRoles: ApiRole[]) {
  return async (request: Request, response: Response, next: NextFunction) => {
    const auth = await resolveRole(request);
    if (!auth) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return response.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (!allowedRoles.includes(auth.role)) return response.status(403).json({ error: "FORBIDDEN", role: auth.role });
    if (auth.mustChangePassword && !request.path.endsWith("/auth/change-password") && !request.path.endsWith("/auth/me")) return response.status(428).json({ error: "PASSWORD_CHANGE_REQUIRED" });
    request.auth = auth;
    return next();
  };
}

export function configuredAuthRoles() {
  return tokenEntries.filter(([, token]) => Boolean(token)).map(([role]) => role);
}
