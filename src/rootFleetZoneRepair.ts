import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { isObjectIdLike } from "./tenantScope.js";

const idSchema = z.string().regex(/^[a-f\d]{24}$/i).transform((id) => id.toLowerCase());
export const rootFleetZoneRepairSchema = z.object({
  tenantId: idSchema,
  fleetId: idSchema,
  managerEmployeeId: idSchema,
  expectedZoneUpdatedAt: z.string().datetime({ offset: true }).refine((value) => Number.isFinite(Date.parse(value))),
  expectedSlug: z.string().regex(/^[a-z0-9-]+$/).max(200),
  contactEmail: z.string().trim().email().max(254).transform((email) => email.toLowerCase()).optional(),
}).strict();

type Session = {
  withTransaction(fn: () => Promise<void>, options?: any): Promise<unknown>;
  endSession(): Promise<unknown>;
};
type ReadCollection = { findOne(filter: any, options?: any): Promise<any> };
type WriteCollection = ReadCollection & {
  updateOne(filter: any, update: any, options?: any): Promise<{ matchedCount: number; modifiedCount: number }>;
};
export type RootFleetZoneRepairDependencies = {
  requireOwner: () => RequestHandler;
  ownerEmail: string;
  objectId: (id: string) => unknown;
  tenants: ReadCollection;
  employees: ReadCollection;
  fleets: WriteCollection;
  zones: WriteCollection;
  startSession: () => Promise<Session>;
  createAudit: (row: any, session: Session) => Promise<unknown>;
};
class RepairError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (code: string, status = 409): never => { throw new RepairError(status, code); };
const sameId = (left: unknown, right: unknown) => isObjectIdLike(left) && isObjectIdLike(right) && String(left) === String(right);
const timestamp = (value: unknown) => value instanceof Date ? value.getTime() : NaN;

/** Explicit maintenance of one existing root Zone, never an alternative creation path.
 * Employee credentials, resets, roles and service-zone lists remain entirely untouched.
 */
export function registerRootFleetZoneRepairRoutes(app: Express, deps: RootFleetZoneRepairDependencies) {
  app.post("/api/v1/admin/zones/:id/repair-fleet-scope", deps.requireOwner(), async (req, res) => {
    // requireOwner validates the persisted Owner; also reject emergency env tokens
    // and tenant administrators even if this handler is invoked independently.
    if (req.auth?.role !== "admin" || !isObjectIdLike(req.auth.employeeId) || req.auth.isRootOwner !== true)
      return res.status(403).json({ error: "ROOT_OWNER_REQUIRED" });
    if (req.auth.mustChangePassword) return res.status(428).json({ error: "PASSWORD_CHANGE_REQUIRED" });
    const parsed = rootFleetZoneRepairSchema.safeParse(req.body);
    const parsedId = idSchema.safeParse(req.params.id);
    if (!parsed.success || !parsedId.success) return res.status(400).json({ error: "INVALID_ZONE_REPAIR" });
    const body = parsed.data;
    const tenantId = deps.objectId(body.tenantId);
    const fleetId = deps.objectId(body.fleetId);
    const managerId = deps.objectId(body.managerEmployeeId);
    const zoneId = deps.objectId(parsedId.data);
    const actorId = deps.objectId(req.auth.employeeId!);
    let response: any;
    try {
      const session = await deps.startSession();
      try {
        await session.withTransaction(async () => {
          // Retry callbacks must revalidate everything within the new snapshot.
          const tenant = await deps.tenants.findOne({ _id: tenantId, status: "active" }, { session, projection: { _id: 1, status: 1 } });
          if (!tenant || !sameId(tenant._id, tenantId) || tenant.status !== "active") fail("TENANT_NOT_ACTIVE", 404);
          const zone = await deps.zones.findOne({ _id: zoneId, tenantId: { $in: [null, tenantId] } }, { session, projection: { _id: 1, tenantId: 1, slug: 1, name: 1, updatedAt: 1 } });
          if (!zone || !sameId(zone._id, zoneId) || (zone.tenantId !== null && !sameId(zone.tenantId, tenantId))) fail("ROOT_ZONE_NOT_FOUND", 404);
          if (zone.slug !== body.expectedSlug) fail("ZONE_SLUG_CHANGED");
          const alreadyScoped = sameId(zone.tenantId, tenantId);
          // A retry of the same _id already at the target is a no-op, even with
          // the pre-move timestamp. A root move ALWAYS requires the exact CAS.
          if (!alreadyScoped && timestamp(zone.updatedAt) !== Date.parse(body.expectedZoneUpdatedAt)) fail("ZONE_CAS_FAILED");
          const fleet = await deps.fleets.findOne({ _id: fleetId, tenantId, isActive: true, managerEmployeeId: managerId }, { session, projection: { _id: 1, tenantId: 1, isActive: 1, managerEmployeeId: 1, serviceZones: 1, contactEmail: 1, updatedAt: 1 } });
          if (!fleet || !sameId(fleet._id, fleetId) || !sameId(fleet.tenantId, tenantId) || fleet.isActive !== true || !sameId(fleet.managerEmployeeId, managerId)) fail("FLEET_BINDING_INVALID");
          const employee = await deps.employees.findOne({ _id: managerId, tenantId, fleetId, active: true, authorizationStatus: "approved" }, { session, projection: { _id: 1, tenantId: 1, fleetId: 1, active: 1, authorizationStatus: 1, apiRole: 1, roles: 1, ownerProtected: 1, accessLevel: 1, email: 1, zoneSlugs: 1 } });
          if (!employee || !sameId(employee._id, managerId) || !sameId(employee.tenantId, tenantId) || !sameId(employee.fleetId, fleetId)
            || employee.active !== true || employee.authorizationStatus !== "approved" || employee.apiRole !== "fleet"
            || !Array.isArray(employee.roles) || !employee.roles.includes("fleet") || employee.roles.includes("admin")
            || employee.ownerProtected === true || employee.accessLevel === "superadmin"
            || String(employee.email || "").trim().toLowerCase() === deps.ownerEmail.toLowerCase()) fail("MANAGER_BINDING_INVALID");
          if (!Array.isArray(fleet.serviceZones) || !fleet.serviceZones.includes(zone.slug)
            || !Array.isArray(employee.zoneSlugs) || !employee.zoneSlugs.includes(zone.slug)) fail("ZONE_LINKS_REQUIRED");
          const conflict = await deps.zones.findOne({ tenantId, _id: { $ne: zoneId }, $or: [{ slug: zone.slug }, { name: zone.name }] }, { session, projection: { _id: 1 } });
          if (conflict) fail("TARGET_ZONE_CONFLICT");

          let updatedAt = zone.updatedAt;
          if (!alreadyScoped) {
            updatedAt = new Date();
            const moved = await deps.zones.updateOne({ _id: zoneId, tenantId: null, slug: body.expectedSlug, updatedAt: new Date(body.expectedZoneUpdatedAt) }, { $set: { tenantId, updatedAt } }, { session, upsert: false });
            if (moved.matchedCount !== 1 || moved.modifiedCount !== 1) fail("ZONE_CAS_FAILED");
          }
          const contactEmailRestored = body.contactEmail !== undefined && body.contactEmail !== fleet.contactEmail;
          if (contactEmailRestored) {
            const restored = await deps.fleets.updateOne({ _id: fleetId, tenantId, isActive: true, managerEmployeeId: managerId,
              updatedAt: fleet.updatedAt === undefined ? { $exists: false } : fleet.updatedAt,
              contactEmail: fleet.contactEmail === undefined ? { $exists: false } : fleet.contactEmail,
              serviceZones: zone.slug,
            }, { $set: { contactEmail: body.contactEmail } }, { session, upsert: false });
            if (restored.matchedCount !== 1 || restored.modifiedCount !== 1) fail("FLEET_CONTACT_CAS_FAILED");
          }
          if (!alreadyScoped || contactEmailRestored) {
            // GovernanceAuditEvent has no zone/fleet target enum. Its existing
            // system target permits this event without a schema migration/PII.
            await deps.createAudit({ tenantId, actorEmployeeId: actorId, actorRole: "admin", action: "root_zone_fleet_scope_repaired",
              targetType: "system", targetId: zoneId,
              before: { resource: "zone", tenantId: zone.tenantId, slug: zone.slug, updatedAt: zone.updatedAt },
              after: { resource: "zone", tenantId, slug: zone.slug, updatedAt, fleetId, managerEmployeeId: managerId, contactEmailRestored },
              reason: "Explicit root Owner repair of an existing Zone fleet scope; no accounts or permissions changed.",
            }, session);
          }
          response = { zone: { id: String(zoneId), tenantId: String(tenantId), slug: zone.slug }, result: alreadyScoped ? "already_scoped" : "repaired", contactEmailRestored };
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      } finally { await session.endSession(); }
      return res.json(response);
    } catch (error) {
      if (error instanceof RepairError) return res.status(error.status).json({ error: error.code });
      if ((error as any)?.code === 11000) return res.status(409).json({ error: "TARGET_ZONE_CONFLICT" });
      throw error; // No nontransactional fallback if Mongo transactions are unavailable.
    }
  });
}
