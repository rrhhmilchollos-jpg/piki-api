import mongoose, { Schema } from "mongoose";
import { EmployeeAccount, Rider } from "./models.js";
import { createSessionToken, hashSessionToken } from "./employeeAuth.js";

export const OWNER_EMAIL = "rrhh.milchollos@gmail.com";
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const schema = new Schema({
  tokenHash: { type: String, required: true, unique: true, index: true },
  employeeId: { type: Schema.Types.ObjectId, required: true, index: true },
  role: { type: String, enum: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona"], required: true },
  surface: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  issuedAt: { type: Date, required: true },
}, { collection: "employee_sessions" });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const EmployeeSession = mongoose.models.EmployeeSession || mongoose.model("EmployeeSession", schema);

/** A surface can narrow a role, never grant privileges from a request header. */
export function sessionRole(employee: { email: string; apiRole: string; ownerProtected?: boolean; authorizationStatus?: string }, surface: string): string | null {
  if (employee.authorizationStatus && employee.authorizationStatus !== "approved") return null;
  // The protected owner account may operate internal surfaces. The session
  // role remains scoped to the requested app; ordinary employees are still
  // restricted by the surface map below.
  if (employee.email === OWNER_EMAIL && employee.ownerProtected && employee.apiRole === "admin" && ["partner", "fleet"].includes(surface)) return surface;
  if (surface === "rider" && employee.email === OWNER_EMAIL && employee.ownerProtected && employee.apiRole === "admin") return "rider";
  const permitted: Record<string, string[]> = { rider: ["rider"], partner: ["partner"], partners: ["partner"], fleet: ["fleet", "commercial", "gerente_comercial_zona"], admin: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona"] };
  return permitted[surface] && !permitted[surface].includes(employee.apiRole) ? null : employee.apiRole;
}

export async function issueEmployeeSession(employee: any, surface: string) {
  const role = sessionRole(employee, surface);
  if (!role) return null;
  const token = createSessionToken();
  const now = new Date();
  await EmployeeSession.create({ tokenHash: hashSessionToken(token), employeeId: employee._id, role, surface: surface || employee.apiRole, issuedAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) });
  await EmployeeAccount.updateOne({ _id: employee._id }, { $set: { lastLoginAt: now } }).exec();
  return { token, role };
}

export async function resolveEmployeeSession(token: string) {
  const session = await EmployeeSession.findOne({ tokenHash: hashSessionToken(token), expiresAt: { $gt: new Date() } }).lean().exec() as any;
  if (!session) return null;
  const employee = await EmployeeAccount.findOne({ _id: session.employeeId, active: true }).lean().exec() as any;
  if (!employee || (employee.passwordChangedAt && new Date(employee.passwordChangedAt) > new Date(session.issuedAt))) return null;
  if (sessionRole(employee, session.surface) !== session.role) return null;
  if (session.role === "rider" && !(await Rider.exists({ email: employee.email }))) return null;
  return { role: session.role, employeeId: String(employee._id), tenantId: employee.tenantId ? String(employee.tenantId) : undefined, mustChangePassword: Boolean(employee.mustChangePassword) };
}

export async function revokeEmployeeSessions(employeeId: unknown) {
  await EmployeeSession.deleteMany({ employeeId }).exec();
}
