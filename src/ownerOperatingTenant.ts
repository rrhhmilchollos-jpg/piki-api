import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { createSessionToken, hashSessionToken } from "./employeeAuth.js";
import { isRootOwnerAccount, sessionRole, sessionTenantMatchesEmployee } from "./employeeSessions.js";
import { isObjectIdLike } from "./tenantScope.js";

const idSchema = z.string().regex(/^[a-f\d]{24}$/i).transform((id) => id.toLowerCase());
export const ownerOperatingTenantSchema = z.object({
  targetTenantId: idSchema,
  expectedTenantId: z.null(),
  // Required: use the fresh own probe rather than guessing a legacy snapshot.
  expectedUpdatedAt: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value))),
}).strict();
const probeSchema = z.object({ targetTenantId: idSchema }).strict();
const ADMIN_BIND_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
type Session = { withTransaction(fn: () => Promise<void>, options?: any): Promise<unknown>; endSession(): Promise<unknown> };
type ReadCollection = { findOne(filter: any, options?: any): Promise<any>; find(filter: any, options?: any): { toArray(): Promise<any[]> } };
export type OwnerOperatingTenantDependencies = {
  requireOwner: () => RequestHandler;
  resolveAuth: (req: Request) => Promise<Request["auth"] | null>;
  objectId: (id: string) => unknown;
  employees: Pick<ReadCollection, "findOne"> & { updateOne(filter: any, update: any, options?: any): Promise<{ matchedCount: number; modifiedCount: number }> };
  tenants: Pick<ReadCollection, "findOne">;
  memberships: ReadCollection;
  restaurants: Pick<ReadCollection, "findOne">;
  fleets: ReadCollection;
  riders: ReadCollection;
  orders: Pick<ReadCollection, "findOne">;
  sessions: Pick<ReadCollection, "findOne"> & { deleteMany(filter: any, options?: any): Promise<{ acknowledged: boolean; deletedCount: number }> };
  startSession: () => Promise<Session>;
  createMembership: (row: any, session: Session) => Promise<any>;
  createSession: (row: any, session: Session) => Promise<any>;
  createAudit: (row: any, session: Session) => Promise<unknown>;
  createAuthorization: (row: any, session: Session) => Promise<unknown>;
};
class BindingError extends Error { constructor(public status: number, public code: string) { super(code); } }
const fail = (code: string, status = 409): never => { throw new BindingError(status, code); };
const sameId = (a: unknown, b: unknown) => isObjectIdLike(a) && isObjectIdLike(b) && String(a).toLowerCase() === String(b).toLowerCase();
const time = (value: unknown) => value instanceof Date ? value.getTime() : NaN;
const ownerProjection = { _id: 1, tenantId: 1, updatedAt: 1, email: 1, apiRole: 1, roles: 1, primaryRole: 1, ownerProtected: 1, accessLevel: 1, active: 1, authorizationStatus: 1, mustChangePassword: 1, passwordChangedAt: 1, restaurantId: 1, restaurantIds: 1, fleetId: 1, riderId: 1 };

/** No arbitrary employee parameter, no role elevation, no resource reassignment. */
export function registerOwnerOperatingTenantRoutes(app: Express, deps: OwnerOperatingTenantDependencies) {
  const authenticate = async (req: Request) => {
    const auth = await deps.resolveAuth(req);
    if (!auth) fail("AUTHENTICATION_REQUIRED", 401);
    if (auth!.role !== "admin" || !isObjectIdLike(auth!.employeeId) || auth!.isRootOwner !== true) fail("ROOT_OWNER_REQUIRED", 403);
    if (auth!.mustChangePassword) fail("PASSWORD_CHANGE_REQUIRED", 428);
    // Never trust a previous/request-injected auth object instead of the credential.
    if (!req.auth || req.auth.role !== auth!.role || !sameId(req.auth.employeeId, auth!.employeeId)
      || !sessionTenantMatchesEmployee(req.auth.tenantId, auth!.tenantId)) fail("AUTH_CONTEXT_CHANGED", 403);
    return auth!;
  };
  const snapshot = async (auth: NonNullable<Request["auth"]>, targetId: unknown, session: Session) => {
    const employeeId = deps.objectId(auth.employeeId!);
    const opts = { session, projection: ownerProjection };
    const employee = await deps.employees.findOne({ _id: employeeId }, opts);
    if (!employee || !sameId(employee._id, employeeId) || !isRootOwnerAccount(employee)
      || employee.active !== true || employee.authorizationStatus !== "approved") fail("ROOT_OWNER_REQUIRED", 403);
    if (employee.mustChangePassword !== false) fail("PASSWORD_CHANGE_REQUIRED", 428);
    if (sessionRole(employee, "admin", "admin") !== "admin") fail("ROOT_ADMIN_ROLE_REQUIRED", 403);
    if (!sessionTenantMatchesEmployee(auth.tenantId, employee.tenantId)) fail("SESSION_TENANT_CHANGED", 401);
    const tenant = await deps.tenants.findOne({ _id: targetId }, { session, projection: { _id: 1, status: 1 } });
    if (tenant && !sameId(tenant._id, targetId)) fail("TARGET_TENANT_INVALID");
    const memberships = await deps.memberships.find({ tenantId: targetId, employeeId }, { session, projection: { _id: 1, tenantId: 1, employeeId: 1, role: 1, status: 1, restaurantIds: 1 } }).toArray();
    if (memberships.length > 1) fail("OWNER_MEMBERSHIP_CONFLICT");
    const membership = memberships[0] || null;
    if (membership && (!sameId(membership.tenantId, targetId) || !sameId(membership.employeeId, employeeId))) fail("OWNER_MEMBERSHIP_CONFLICT");
    const ownerActive = membership?.role === "owner" && membership?.status === "active";
    const restaurantIds: string[] = [];
    const appendId = (id: unknown, ids: string[]) => {
      if (!isObjectIdLike(id)) fail("EXISTING_BINDING_INVALID");
      const normalized = String(id).toLowerCase(); if (!ids.includes(normalized)) ids.push(normalized);
    };
    if (employee.restaurantId != null) appendId(employee.restaurantId, restaurantIds);
    for (const source of [employee.restaurantIds, membership?.restaurantIds]) {
      if (source !== undefined && !Array.isArray(source)) fail("EXISTING_BINDING_INVALID");
      for (const id of source || []) appendId(id, restaurantIds);
    }
    let bindingsMatchTarget = true;
    for (const id of restaurantIds) {
      const restaurant = await deps.restaurants.findOne({ _id: deps.objectId(id) }, { session, projection: { _id: 1, tenantId: 1 } });
      if (!restaurant || !sameId(restaurant._id, id) || !sameId(restaurant.tenantId, targetId)) bindingsMatchTarget = false;
    }
    const fleetIds: string[] = [];
    if (employee.fleetId != null) appendId(employee.fleetId, fleetIds);
    const linkedFleets = await deps.fleets.find({ managerEmployeeId: employeeId }, { session, projection: { _id: 1, tenantId: 1 } }).toArray();
    for (const fleet of linkedFleets) { appendId(fleet._id, fleetIds); if (!sameId(fleet.tenantId, targetId)) bindingsMatchTarget = false; }
    // Rider identity is canonically email-bound in the existing model. Do not
    // return that email or grant the Rider role; validate any existing link only.
    const riderFilter = employee.riderId == null ? { email: employee.email } : { $or: [{ email: employee.email }, { _id: employee.riderId }] };
    const riders = await deps.riders.find(riderFilter, { session, projection: { _id: 1, tenantId: 1, fleetId: 1, activeOrderId: 1 } }).toArray();
    if (employee.riderId != null && (!isObjectIdLike(employee.riderId) || !riders.some((rider) => sameId(rider._id, employee.riderId)))) bindingsMatchTarget = false;
    let hasActiveRiderOrder = false;
    for (const rider of riders) {
      if (!sameId(rider.tenantId, targetId)) bindingsMatchTarget = false;
      if (rider.fleetId != null) appendId(rider.fleetId, fleetIds);
      if (rider.activeOrderId != null) hasActiveRiderOrder = true;
    }
    for (const id of fleetIds) {
      const fleet = await deps.fleets.findOne({ _id: deps.objectId(id) }, { session, projection: { _id: 1, tenantId: 1 } });
      if (!fleet || !sameId(fleet._id, id) || !sameId(fleet.tenantId, targetId)) bindingsMatchTarget = false;
    }
    return { employee, employeeId, tenant, membership, ownerActive, restaurantIds, bindingsMatchTarget, hasActiveRiderOrder };
  };
  const privateResponse: RequestHandler = (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Vary", "Authorization, Cookie"); next();
  };
  const respondError = (error: unknown, res: any) => {
    if (error instanceof BindingError) return res.status(error.status).json({ error: error.code });
    if ((error as any)?.code === 11000) return res.status(409).json({ error: "OWNER_BINDING_CONFLICT" });
    // Driver/session/audit errors must not leak hashes, tokens or raw messages.
    return res.status(503).json({ error: "OWNER_BINDING_TRANSACTION_FAILED" });
  };
  app.get("/api/v1/admin/owner/operating-tenant", privateResponse, deps.requireOwner(), async (req, res) => {
    const parsed = probeSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_OWNER_TENANT_PROBE" });
    try {
      const auth = await authenticate(req); const targetId = deps.objectId(parsed.data.targetTenantId);
      const session = await deps.startSession(); let response: any;
      try {
        await session.withTransaction(async () => {
          const s = await snapshot(auth, targetId, session);
          response = { employee: { id: String(s.employeeId), tenantId: s.employee.tenantId == null ? null : String(s.employee.tenantId), updatedAt: Number.isFinite(time(s.employee.updatedAt)) ? s.employee.updatedAt.toISOString() : null,
            protectedRoot: true, active: true, approved: true, mustChangePassword: false },
            targetTenant: { id: String(targetId), status: s.tenant?.status || null, ownActiveOwnerMembership: s.ownerActive, membershipConflict: Boolean(s.membership && !s.ownerActive) },
            canonicalRestaurantBindingIds: s.restaurantIds, bindingsMatchTarget: s.bindingsMatchTarget, hasActiveRiderOrder: s.hasActiveRiderOrder };
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      } finally { await session.endSession(); }
      return res.json(response);
    } catch (error) { return respondError(error, res); }
  });
  app.post("/api/v1/admin/owner/operating-tenant", privateResponse, deps.requireOwner(), async (req, res) => {
    const parsed = ownerOperatingTenantSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_OWNER_TENANT_BINDING" });
    try {
      const auth = await authenticate(req); const body = parsed.data;
      const targetId = deps.objectId(body.targetTenantId);
      const session = await deps.startSession(); let response: any;
      try {
        await session.withTransaction(async () => {
          // Reset on every driver retry. No credential leaves the callback until commit.
          response = undefined;
          const s = await snapshot(auth, targetId, session);
          if (s.tenant?.status !== "active") fail("TENANT_NOT_ACTIVE", 404);
          if (!s.bindingsMatchTarget) fail("EXISTING_BINDING_TENANT_CONFLICT");
          if (s.membership && !s.ownerActive) fail("OWNER_MEMBERSHIP_CONFLICT");
          if (sameId(s.employee.tenantId, targetId) && s.ownerActive) {
            response = { result: "already_bound", employee: { id: String(s.employeeId), tenantId: String(targetId) }, sessionRotated: false }; return;
          }
          // This endpoint only binds a NULL protected root, never moves an employee.
          if (s.employee.tenantId !== null || time(s.employee.updatedAt) !== Date.parse(body.expectedUpdatedAt)) fail("OWNER_TENANT_CAS_FAILED");
          if (s.hasActiveRiderOrder) fail("OWNER_ACTIVE_ORDER");
          // Rider has an email identity, not an EmployeeAccount.riderId in the
          // current schema. Resolve only the persisted own email in the target.
          // Match the existing deletion/dispatch terminal set: any nonterminal
          // assigned/current order blocks even if activeOrderId is stale/null.
          const ownRiders = await deps.riders.find({ email: s.employee.email, tenantId: targetId }, { session, projection: { _id: 1, tenantId: 1 } }).toArray();
          for (const rider of ownRiders) {
            if (!isObjectIdLike(rider._id) || !sameId(rider.tenantId, targetId)) fail("EXISTING_BINDING_TENANT_CONFLICT");
            const busy = await deps.orders.findOne({ tenantId: targetId, riderId: rider._id, status: { $nin: ["delivered", "cancelled"] } }, { session, projection: { _id: 1 } });
            if (busy) fail("OWNER_ACTIVE_ORDER");
          }
          // Prevent a residual legacy credential from later adopting the new tenant.
          const legacy = await deps.employees.findOne({ _id: s.employeeId, sessionHash: { $exists: true, $nin: [null, ""] } }, { session, projection: { _id: 1 } });
          if (legacy) fail("OWNER_LEGACY_SESSION_CONFLICT");
          const rawToken = (req.header("authorization") || "").split(" ")[1];
          if (!rawToken) fail("AUTHENTICATION_REQUIRED", 401);
          const oldSession = await deps.sessions.findOne({ tokenHash: hashSessionToken(rawToken), employeeId: s.employeeId, role: "admin", tenantId: null, expiresAt: { $gt: new Date() } }, { session, projection: { _id: 1, employeeId: 1, role: 1, tenantId: 1, issuedAt: 1, expiresAt: 1 } });
          if (!oldSession || !Object.prototype.hasOwnProperty.call(oldSession, "tenantId") || oldSession.tenantId !== null
            || !sameId(oldSession.employeeId, s.employeeId) || oldSession.role !== "admin" || !Number.isFinite(time(oldSession.issuedAt))
            || !(time(oldSession.expiresAt) > Date.now()) || (s.employee.passwordChangedAt && time(s.employee.passwordChangedAt) > time(oldSession.issuedAt))) fail("OWNER_SESSION_CHANGED", 401);
          const now = new Date(); const expiresAt = new Date(now.getTime() + ADMIN_BIND_SESSION_TTL_MS);
          const moved = await deps.employees.updateOne({ _id: s.employeeId, tenantId: null, updatedAt: new Date(body.expectedUpdatedAt), sessionHash: null,
            email: s.employee.email, ownerProtected: true, accessLevel: "superadmin", active: true, authorizationStatus: "approved", mustChangePassword: false },
            { $set: { tenantId: targetId, updatedAt: now } }, { session, upsert: false });
          if (moved.matchedCount !== 1 || moved.modifiedCount !== 1) fail("OWNER_TENANT_CAS_FAILED");
          if (!s.membership) {
            const member = await deps.createMembership({ tenantId: targetId, employeeId: s.employeeId, role: "owner", status: "active", scopes: ["*"] }, session);
            if (!member || !sameId(member.tenantId, targetId) || !sameId(member.employeeId, s.employeeId) || member.role !== "owner" || member.status !== "active") fail("OWNER_MEMBERSHIP_WRITE_FAILED", 503);
          }
          const revoked = await deps.sessions.deleteMany({ employeeId: s.employeeId }, { session });
          if (!revoked.acknowledged || revoked.deletedCount < 1) fail("OWNER_SESSION_REVOKE_FAILED", 503);
          const token = createSessionToken();
          const row = { tokenHash: hashSessionToken(token), employeeId: s.employeeId, tenantId: targetId, role: "admin", surface: "admin", issuedAt: now, expiresAt };
          const created = await deps.createSession(row, session);
          if (!created || created.tokenHash !== row.tokenHash || !sameId(created.employeeId, s.employeeId) || !sameId(created.tenantId, targetId)
            || created.role !== "admin" || created.surface !== "admin" || time(created.issuedAt) !== time(now) || time(created.expiresAt) !== time(expiresAt)) fail("OWNER_SESSION_WRITE_FAILED", 503);
          const authorization = await deps.createAuthorization({ tenantId: targetId, employeeId: s.employeeId, action: "profile_updated", previousStatus: "approved", nextStatus: "approved",
            previousRole: s.employee.apiRole, nextRole: s.employee.apiRole, accessLevel: "superadmin", actorEmployeeId: s.employeeId,
            reason: "Explicit protected root Owner operating tenant binding; business roles and credentials preserved." }, session);
          if (!authorization || (Array.isArray(authorization) && authorization.length !== 1)) fail("OWNER_AUTHORIZATION_WRITE_FAILED", 503);
          const audit = await deps.createAudit({ tenantId: targetId, actorEmployeeId: s.employeeId, actorRole: "admin", action: "root_owner_operating_tenant_bound", targetType: "employee", targetId: s.employeeId,
            before: { tenantId: null, updatedAt: s.employee.updatedAt }, after: { tenantId: targetId, updatedAt: now, membershipRole: "owner", membershipStatus: "active", sessionRotated: true },
            reason: "Explicit own-account protected root binding; no resource reassignment or commercial approval." }, session);
          if (!audit || (Array.isArray(audit) && audit.length !== 1)) fail("OWNER_AUDIT_WRITE_FAILED", 503);
          response = { result: "bound", accessToken: token, sessionExpiresAt: expiresAt.toISOString(), requiresPasswordChange: false, sessionRotated: true,
            employee: { id: String(s.employeeId), tenantId: String(targetId), apiRole: "admin", ownerProtected: true, accessLevel: "superadmin", authorizationStatus: "approved", isRootOwner: true } };
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      } finally { await session.endSession(); }
      return res.json(response);
    } catch (error) { return respondError(error, res); }
  });
}
