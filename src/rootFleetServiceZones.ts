import type { Express, RequestHandler } from "express";
import { z } from "zod";
import { isObjectIdLike } from "./tenantScope.js";
import { VEHICLE_CATALOG_VERSION, VEHICLE_TYPES, incompatibleVehicles, vehicleTypeSchema, type VehicleType } from "./vehicleCatalog.js";

const idSchema = z.string().regex(/^[a-f\d]{24}$/i).transform((id) => id.toLowerCase());
const slugSchema = z.string().regex(/^[a-z0-9-]+$/).max(200);
export const rootFleetServiceZonesSchema = z.object({
  addZoneSlugs: z.array(slugSchema).min(1).max(100).refine((slugs) => new Set(slugs).size === slugs.length),
  expectedManagerEmployeeId: idSchema,
}).strict();

type Session = {
  withTransaction(fn: () => Promise<void>, options?: any): Promise<unknown>;
  endSession(): Promise<unknown>;
};
type ReadCollection = { findOne(filter: any, options?: any): Promise<any> };
type WriteCollection = ReadCollection & {
  updateOne(filter: any, update: any, options?: any): Promise<{ matchedCount: number; modifiedCount: number }>;
};
export type RootFleetServiceZonesDependencies = {
  requireOwner: () => RequestHandler;
  ownerEmail: string;
  objectId: (id: string) => unknown;
  tenants: ReadCollection;
  employees: WriteCollection;
  fleets: WriteCollection;
  zones: ReadCollection;
  startSession: () => Promise<Session>;
  createAudit: (row: any, session: Session) => Promise<unknown>;
};
class ScopeError extends Error {
  constructor(public status: number, public code: string, public details?: unknown) { super(code); }
}
const fail = (code: string, status = 409, details?: unknown): never => { throw new ScopeError(status, code, details); };
const sameId = (left: unknown, right: unknown) => isObjectIdLike(left) && isObjectIdLike(right) && String(left).toLowerCase() === String(right).toLowerCase();
const exact = (value: unknown) => value === undefined ? { $exists: false } : value;
const hasSameUniqueScope = (current: string[], union: string[]) => current.length === union.length && new Set(current).size === current.length && union.every((slug) => current.includes(slug));

/** Add existing active same-tenant zones to ONE Fleet and its bound manager.
 * No creation, tenant moves, role changes, account resets or rider assignments.
 */
export function registerRootFleetServiceZonesRoutes(app: Express, deps: RootFleetServiceZonesDependencies) {
  app.patch("/api/v1/admin/fleets/:id/service-zones", deps.requireOwner(), async (req, res) => {
    // The persisted Owner middleware is mandatory; env/emergency tokens cannot
    // replace a real employee, nor can a tenant admin invoke the handler alone.
    if (req.auth?.role !== "admin" || !isObjectIdLike(req.auth.employeeId) || req.auth.isRootOwner !== true)
      return res.status(403).json({ error: "ROOT_OWNER_REQUIRED" });
    if (req.auth.mustChangePassword) return res.status(428).json({ error: "PASSWORD_CHANGE_REQUIRED" });
    const parsed = rootFleetServiceZonesSchema.safeParse(req.body);
    const parsedId = idSchema.safeParse(req.params.id);
    if (!parsed.success || !parsedId.success) return res.status(400).json({ error: "INVALID_FLEET_SERVICE_ZONES" });
    const fleetId = deps.objectId(parsedId.data);
    const managerId = deps.objectId(parsed.data.expectedManagerEmployeeId);
    const actorId = deps.objectId(req.auth.employeeId!);
    let response: any;
    try {
      const session = await deps.startSession();
      try {
        await session.withTransaction(async () => {
          // Every retry re-reads and validates a fresh transaction snapshot.
          const fleet = await deps.fleets.findOne({ _id: fleetId, isActive: true, managerEmployeeId: managerId }, { session,
            projection: { _id: 1, tenantId: 1, isActive: 1, managerEmployeeId: 1, serviceZones: 1, vehicleTypes: 1, updatedAt: 1 } });
          if (!fleet || !sameId(fleet._id, fleetId) || fleet.isActive !== true || !sameId(fleet.managerEmployeeId, managerId)
            || !isObjectIdLike(fleet.tenantId)) fail("FLEET_BINDING_INVALID");
          // Tenant is taken only from the existing Fleet, never from a body,
          // global fallback or a different Fleet found by city/name/email.
          const tenantId = deps.objectId(String(fleet.tenantId));
          const tenant = await deps.tenants.findOne({ _id: tenantId, status: "active" }, { session, projection: { _id: 1, status: 1 } });
          if (!tenant || !sameId(tenant._id, tenantId) || tenant.status !== "active") fail("TENANT_NOT_ACTIVE", 404);
          const employee = await deps.employees.findOne({ _id: managerId, tenantId, fleetId, active: true, authorizationStatus: "approved" }, { session,
            projection: { _id: 1, tenantId: 1, fleetId: 1, active: 1, authorizationStatus: 1, apiRole: 1, roles: 1, ownerProtected: 1, accessLevel: 1, email: 1, zoneSlugs: 1, updatedAt: 1 } });
          if (!employee || !sameId(employee._id, managerId) || !sameId(employee.tenantId, tenantId) || !sameId(employee.fleetId, fleetId)
            || employee.active !== true || employee.authorizationStatus !== "approved" || employee.apiRole !== "fleet"
            || !Array.isArray(employee.roles) || !employee.roles.includes("fleet") || employee.roles.includes("admin")
            || employee.ownerProtected === true || employee.accessLevel === "superadmin"
            || String(employee.email || "").trim().toLowerCase() === deps.ownerEmail.trim().toLowerCase()) fail("MANAGER_BINDING_INVALID");
          if (!z.array(slugSchema).safeParse(fleet.serviceZones).success || !z.array(slugSchema).safeParse(employee.zoneSlugs).success)
            fail("INCONSISTENT_SCOPE");
          const currentFleet: string[] = fleet.serviceZones;
          const currentEmployee: string[] = employee.zoneSlugs;
          // Reject extra pre-existing employee authority BEFORE considering
          // requested additions: a request must not legitimize inconsistent scope.
          if (currentEmployee.some((slug) => !currentFleet.includes(slug))) fail("INCONSISTENT_SCOPE");
          const union = [...new Set([...currentFleet, ...currentEmployee, ...parsed.data.addZoneSlugs])];
          const vehicles = z.array(vehicleTypeSchema).min(1).max(VEHICLE_TYPES.length).safeParse(fleet.vehicleTypes);
          if (!vehicles.success) return fail("INVALID_FLEET_VEHICLES");
          let allowedForEveryZone: VehicleType[] = [...VEHICLE_TYPES];
          for (const slug of union) {
            const zone = await deps.zones.findOne({ tenantId, slug, isActive: true }, { session,
              projection: { _id: 1, tenantId: 1, slug: 1, isActive: 1, allowedVehicleTypes: 1 } });
            if (!zone || !isObjectIdLike(zone._id) || !sameId(zone.tenantId, tenantId) || zone.slug !== slug || zone.isActive !== true)
              fail("INVALID_FLEET_ZONES", 400);
            // Legacy catalog fallback ONLY for an absent field. An explicit
            // empty restriction allows nothing; null/malformed data fails closed.
            const allowed = z.array(vehicleTypeSchema).safeParse(zone.allowedVehicleTypes === undefined ? [...VEHICLE_TYPES] : zone.allowedVehicleTypes);
            if (!allowed.success) return fail("INVALID_FLEET_ZONES", 400);
            const allowedTypes = allowed.data;
            allowedForEveryZone = allowedForEveryZone.filter((vehicle) => allowedTypes.includes(vehicle));
          }
          const incompatible = incompatibleVehicles(vehicles.data, allowedForEveryZone);
          if (incompatible.length) fail("INCOMPATIBLE_FLEET_VEHICLES", 400, { vehicleTypes: incompatible, catalogVersion: VEHICLE_CATALOG_VERSION });
          const fleetChanged = !hasSameUniqueScope(currentFleet, union);
          const employeeChanged = !hasSameUniqueScope(currentEmployee, union);
          if (fleetChanged || employeeChanged) {
            const updatedAt = new Date();
            // CAS/write-lock BOTH documents even when only the manager subset
            // needs filling. A read-only Fleet snapshot cannot guard against a
            // concurrent scope/binding change while the employee is updated.
            const fleetUpdate = await deps.fleets.updateOne({ _id: fleetId, tenantId, isActive: true, managerEmployeeId: managerId,
              updatedAt: exact(fleet.updatedAt), serviceZones: currentFleet, vehicleTypes: fleet.vehicleTypes,
            }, { $set: { serviceZones: union, updatedAt } }, { session, upsert: false });
            if (fleetUpdate.matchedCount !== 1 || fleetUpdate.modifiedCount !== 1) fail("FLEET_SCOPE_CAS_FAILED");
            const employeeUpdate = await deps.employees.updateOne({ _id: managerId, tenantId, fleetId, active: true, authorizationStatus: "approved", apiRole: "fleet",
              roles: employee.roles, ownerProtected: exact(employee.ownerProtected), accessLevel: exact(employee.accessLevel), email: exact(employee.email),
              updatedAt: exact(employee.updatedAt), zoneSlugs: currentEmployee,
            }, { $set: { zoneSlugs: union, updatedAt } }, { session, upsert: false });
            if (employeeUpdate.matchedCount !== 1 || employeeUpdate.modifiedCount !== 1) fail("MANAGER_SCOPE_CAS_FAILED");
            await deps.createAudit({ tenantId, actorEmployeeId: actorId, actorRole: "admin", action: "root_fleet_service_zones_extended",
              targetType: "system", targetId: fleetId,
              before: { resource: "fleet_service_zones", serviceZones: currentFleet, managerZoneSlugs: currentEmployee },
              after: { resource: "fleet_service_zones", serviceZones: union, managerZoneSlugs: union, fleetChanged, employeeChanged },
              reason: "Explicit root Owner additive extension of an existing Fleet and its bound manager; no other account or assignment changes.",
            }, session);
          }
          response = { fleetId: String(fleetId), managerEmployeeId: String(managerId), tenantId: String(tenantId), serviceZones: union,
            result: fleetChanged || employeeChanged ? "extended" : "already_scoped" };
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      } finally { await session.endSession(); }
      return res.json(response);
    } catch (error) {
      if (error instanceof ScopeError) return res.status(error.status).json({ error: error.code, ...(error.details ? { details: error.details } : {}) });
      throw error; // Never fall back to nontransactional writes.
    }
  });
}
