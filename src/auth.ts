import type { NextFunction, Request, Response } from "express";

export const apiRoles = ["admin", "partner", "rider", "fleet"] as const;
export type ApiRole = (typeof apiRoles)[number];

declare global {
  namespace Express {
    interface Request {
      auth?: { role: ApiRole };
    }
  }
}

const tokenEntries: Array<[ApiRole, string | undefined]> = [
  ["admin", process.env.ADMIN_API_TOKEN],
  ["partner", process.env.PARTNER_API_TOKEN],
  ["rider", process.env.RIDER_API_TOKEN],
  ["fleet", process.env.FLEET_API_TOKEN],
];

function resolveRole(request: Request): ApiRole | null {
  const header = request.header("authorization") || "";
  const [scheme, token] = header.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const match = tokenEntries.find(([, configured]) => configured && configured === token);
  return match?.[0] || null;
}

export function requireRole(...allowedRoles: ApiRole[]) {
  return (request: Request, response: Response, next: NextFunction) => {
    const role = resolveRole(request);
    if (!role) {
      response.setHeader("WWW-Authenticate", "Bearer");
      return response.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    }
    if (!allowedRoles.includes(role)) return response.status(403).json({ error: "FORBIDDEN", role });
    request.auth = { role };
    return next();
  };
}

export function configuredAuthRoles() {
  return tokenEntries.filter(([, token]) => Boolean(token)).map(([role]) => role);
}
