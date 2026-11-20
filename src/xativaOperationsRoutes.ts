import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { VEHICLE_TYPES, vehicleTypeSchema } from "./vehicleCatalog.js";

const idSchema = z.string().regex(/^[a-f\d]{24}$/i).transform((id) => id.toLowerCase());
export const XATIVA_ASSIGNMENT_CONFIRMATION = "ASSIGN_FOUR_RIDERS_TO_MARIA_XATIVA";
export const xativaAssignmentSchema = z.object({
  tenantId: idSchema,
  manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation: z.literal(XATIVA_ASSIGNMENT_CONFIRMATION),
}).strict();
const previewSchema = z.object({ tenantId: idSchema }).strict();
export const XATIVA_CANONICAL_ZONE = { slug: "xativa-municipio", name: "Xàtiva · Municipio completo", municipalityCode: "46145", coverage: "full" } as const;
const MANAGER_NAME = "maria deseada solas sanchis";
const LIST_LIMIT = 1000;
type Session = { withTransaction(callback: () => Promise<void>, options?: any): Promise<unknown>; endSession(): Promise<unknown> };
type Collection = {
  findOne(filter: any, options?: any): Promise<any>;
  find(filter: any, options?: any): { sort(order: any): any; limit(count: number): any; toArray(): Promise<any[]> };
};
type WritableCollection = Collection & { updateOne(filter: any, update: any, options?: any): Promise<{ matchedCount: number; modifiedCount: number }> };

/** This is NOT a switch to bypass the guards. An implementation must coordinate
 * every operational writer (including legacy/unscoped GPS), authorization,
 * manager/source binding and destination capacity for the duration of commit.
 * Snapshot reads alone do not prevent phantom inserts or capacity write skew.
 * No such implementation currently exists; server.ts deliberately passes null.
 */
export type XativaTransferCoordinator = {
  revision: string;
  acquire(input: { tenantId: unknown; actorEmployeeId: unknown; riderIds: unknown[]; employeeIds: unknown[]; fleetIds: unknown[]; session: Session }): Promise<boolean>;
};
export type XativaOperationsDependencies = {
  requireRole: (role: "admin") => RequestHandler;
  ownerEmail: string;
  objectId: (id: string) => unknown;
  tenants: Pick<Collection, "findOne">;
  employees: WritableCollection;
  fleets: Collection;
  riders: WritableCollection;
  zones: Collection;
  slots: Collection;
  orders: Collection;
  reservations: Collection;
  tracking: Collection;
  employeeSessions: Collection;
  transferCoordinator: XativaTransferCoordinator | null;
  startSession: () => Promise<Session>;
  createAudit: (row: any, session: Session) => Promise<unknown>;
  now?: () => Date;
};
type Blocker = { code: string; message: string };
class OperationError extends Error {
  constructor(public status: number, public code: string, public blockers?: Blocker[]) { super(code); }
}
const fail = (code: string, status = 409): never => { throw new OperationError(status, code); };
const validId = (id: unknown): boolean => id != null && /^[a-f\d]{24}$/i.test(String(id));
const sameId = (a: unknown, b: unknown): boolean => validId(a) && validId(b) && String(a).toLowerCase() === String(b).toLowerCase();
const nullableId = (id: unknown): string | null => validId(id) ? String(id).toLowerCase() : null;
const sameFleet = (a: unknown, b: unknown): boolean => a == null && b == null || sameId(a, b);
const normalize = (name: unknown): string => typeof name === "string" ? name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/\s+/g, " ") : "";
const fields = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, 1]));
const exact = (value: unknown) => value === undefined ? { $exists: false } : value === null ? { $eq: null, $exists: true } : value;
const timestamp = (value: any): string | null => value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
// Canonical snapshot: keys, rows and scope sets sorted; missing != null. No
// location geometry, contact data, credentials or clock time enters the manifest.
function canonical(value: any): any {
  if (value === undefined) return { $missing: true };
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return { $date: value.toISOString() };
  if (typeof value.toHexString === "function") return value.toHexString().toLowerCase();
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}
const employeeProjection = fields("_id", "tenantId", "name", "fleetId", "apiRole", "roles", "active", "authorizationStatus", "accessLevel", "ownerProtected", "zoneSlugs", "mustChangePassword", "updatedAt", "__v");
const riderProjection = fields("_id", "tenantId", "name", "riderCode", "fleetId", "zoneSlug", "vehicle", "status", "lifecycleStatus", "isTestRider", "activeOrderId", "locationPrivacyExpiresAt", "lastLocationAt", "updatedAt", "__v");
const fleetProjection = fields("_id", "tenantId", "name", "managerEmployeeId", "isActive", "vehicleTypes", "maxRiders", "serviceZones", "updatedAt", "__v");
const zoneProjection = fields("_id", "tenantId", "slug", "name", "isActive", "allowedVehicleTypes", "serviceFeeCents", "updatedAt", "__v");
const desiredRiders = [
  { first: ["jackson"], surname: "andres", code: "PIKI-R-785531" },
  { first: ["ivan"], surname: "rubio", code: "PIKI-R-894110" },
  { first: ["orelbis", "orelbys"], surname: "cabrera", code: null },
  { first: ["jonnathan", "jonathan"], surname: "rincon", code: null },
];
function matchesName(name: unknown, desired: typeof desiredRiders[number]) {
  const tokens = normalize(name).split(" ");
  return desired.first.includes(tokens[0]) && tokens.slice(1).includes(desired.surname);
}
function basicAuthorization(req: Request, tenant: string) {
  const auth = req.auth;
  if (!auth) fail("AUTHENTICATION_REQUIRED", 401);
  if (auth!.role !== "admin" || !validId(auth!.employeeId)) fail("PERSISTED_ADMIN_REQUIRED", 403);
  if (auth!.mustChangePassword) fail("PASSWORD_CHANGE_REQUIRED", 428);
  if (auth!.isRootOwner !== true && !sameId(auth!.tenantId, tenant)) fail("TENANT_FORBIDDEN", 403);
  if (auth!.tenantId !== undefined && !validId(auth!.tenantId)) fail("TENANT_FORBIDDEN", 403);
}

export function registerXativaOperationsRoutes(app: Express, deps: XativaOperationsDependencies) {
  async function snapshot(req: Request, tenantString: string, session: Session) {
    const tenantId = deps.objectId(tenantString);
    const now = deps.now?.() ?? new Date();
    const blockers: Blocker[] = [];
    const block = (code: string, message: string) => { if (!blockers.some((item) => item.code === code && item.message === message)) blockers.push({ code, message }); };
    async function list(collection: Collection, filter: any, projection: any, label: string, limit = LIST_LIMIT): Promise<any[]> {
      // Explicit target tenant ALWAYS, even for root; never tenantScope({root}).
      const rows: any[] = await collection.find({ ...filter, tenantId }, { session, projection }).sort({ _id: 1 }).limit(limit + 1).toArray();
      if (rows.length > limit) { block("BOUNDED_LIST_TRUNCATED", `${label} exceeds the safe preview bound; no assignment is permitted.`); return []; }
      if (rows.some((row) => !sameId(row.tenantId, tenantId) || !validId(row._id))) {
        block("INVALID_TENANT_ROWS", `${label} contains an invalid scoped row.`); return [];
      }
      return rows;
    }
    const actorId = deps.objectId(req.auth!.employeeId!);
    // Root actor uses its exact authenticated HOME tenant (or explicit null for
    // the protected bootstrap account), not the target and never a global query.
    const actorTenantId = req.auth!.tenantId ? deps.objectId(req.auth!.tenantId) : null;
    const actorFilter = { _id: actorId, tenantId: actorTenantId, active: true, authorizationStatus: "approved",
      ...(req.auth!.isRootOwner === true ? { email: deps.ownerEmail, ownerProtected: true, accessLevel: "superadmin" } : {}) };
    const actor = await deps.employees.findOne(actorFilter, { session, projection: employeeProjection });
    if (!actor || !sameId(actor._id, actorId) || !sameFleet(actor.tenantId, actorTenantId) || actor.active !== true
      || actor.authorizationStatus !== "approved" || !(Array.isArray(actor.roles) ? actor.roles.includes("admin") : actor.apiRole === "admin")
      || (req.auth!.isRootOwner === true && (actor.ownerProtected !== true || actor.accessLevel !== "superadmin"))) fail("PERSISTED_ADMIN_REQUIRED", 403);
    if (actor.mustChangePassword !== false) fail("PASSWORD_CHANGE_REQUIRED", 428);
    if (req.auth!.isRootOwner !== true && !sameId(actor.tenantId, tenantId)) fail("TENANT_FORBIDDEN", 403);
    const tenant = await deps.tenants.findOne({ _id: tenantId, status: "active" }, { session, projection: fields("_id", "status", "updatedAt", "__v") });
    if (!tenant || !sameId(tenant._id, tenantId) || tenant.status !== "active") fail("TENANT_NOT_ACTIVE", 404);
    const employees = await list(deps.employees, {}, employeeProjection, "Employee directory");
    const managers = employees.filter((row) => normalize(row.name) === MANAGER_NAME);
    const manager = managers.length === 1 ? managers[0] : null;
    if (!manager) block("MANAGER_MISSING_OR_AMBIGUOUS", "Exactly one Maria Deseada Solas Sanchis must exist in the explicit tenant.");
    let fleet: any = null;
    if (manager) {
      if (manager.active !== true || manager.authorizationStatus !== "approved" || manager.apiRole !== "fleet"
        || !Array.isArray(manager.roles) || !manager.roles.includes("fleet") || manager.roles.includes("admin")
        || manager.ownerProtected === true || manager.accessLevel === "superadmin" || !validId(manager.fleetId))
        block("MANAGER_BINDING_INVALID", "Maria must be an active approved Fleet manager, not a protected/admin account.");
      if (validId(manager.fleetId)) fleet = await deps.fleets.findOne({ _id: deps.objectId(String(manager.fleetId)), tenantId, isActive: true, managerEmployeeId: manager._id }, { session, projection: fleetProjection });
      if (!fleet || !sameId(fleet._id, manager.fleetId) || !sameId(fleet.tenantId, tenantId) || fleet.isActive !== true || !sameId(fleet.managerEmployeeId, manager._id)) {
        fleet = null; block("MANAGER_FLEET_NOT_RECIPROCAL", "The active same-tenant Fleet and manager must bind reciprocally.");
      }
    }
    const directory = await list(deps.riders, {}, riderProjection, "Rider directory");
    const riders: any[] = [];
    for (const desired of desiredRiders) {
      const matches = directory.filter((row) => matchesName(row.name, desired) || desired.code && row.riderCode === desired.code);
      if (matches.length !== 1 || !matchesName(matches[0]?.name, desired) || desired.code && matches[0]?.riderCode !== desired.code) {
        block("RIDER_MISSING_OR_AMBIGUOUS", `Exactly one ${desired.first.join("/")} ${desired.surname}${desired.code ? ` (${desired.code})` : ""} must match in the explicit tenant.`);
      } else riders.push(matches[0]);
    }
    if (new Set(riders.map((row) => String(row._id))).size !== riders.length) block("RIDER_MISSING_OR_AMBIGUOUS", "The four identities must be distinct.");
    const zones = await list(deps.zones, {}, zoneProjection, "Zone directory", 250);
    const sourceFleets: any[] = [];
    const bindings: any[] = [];
    for (const rider of riders) {
      if (rider.lifecycleStatus !== "active" || rider.isTestRider !== false) block("RIDER_NOT_ACTIVE", "Every selected Rider must be a verified active non-test Rider.");
      if (rider.status !== "offline" || rider.activeOrderId != null) block("ACTIVE_OPERATIONAL_WORK", "Selected Riders must be offline without an active order link.");
      if (rider.locationPrivacyExpiresAt != null && (!timestamp(rider.locationPrivacyExpiresAt) || rider.locationPrivacyExpiresAt > now)
        || rider.lastLocationAt != null && (!timestamp(rider.lastLocationAt) || now.getTime() - rider.lastLocationAt.getTime() <= 90_000))
        block("ACTIVE_TRACKING", "An active location/privacy or fresh GPS flag prevents a transfer.");
      if (!(rider.updatedAt instanceof Date)) block("RIDER_REVISION_MISSING", "An exact persisted Rider update timestamp is required.");
      if (rider.fleetId != null) {
        const source = validId(rider.fleetId) ? await deps.fleets.findOne({ _id: deps.objectId(String(rider.fleetId)), tenantId, isActive: true }, { session, projection: fleetProjection }) : null;
        if (!source || !sameId(source._id, rider.fleetId) || !sameId(source.tenantId, tenantId) || source.isActive !== true)
          block("SOURCE_FLEET_INVALID", "A bound source Fleet must be active in the exact tenant.");
        else if (!sourceFleets.some((row) => sameId(row._id, source._id))) sourceFleets.push(source);
      }
      // Existing models link Rider <-> Employee by exact canonical email, not by
      // name. Read it ONLY for this selected ID; never expose/audit the email.
      const identity = await deps.riders.findOne({ _id: rider._id, tenantId }, { session, projection: fields("_id", "tenantId", "email") });
      const email = identity?.email;
      if (!identity || !sameId(identity._id, rider._id) || !sameId(identity.tenantId, tenantId)
        || typeof email !== "string" || !email || email !== email.trim().toLowerCase()) {
        block("RIDER_EMPLOYEE_BINDING_INVALID", "A canonical same-tenant Rider account binding is required."); continue;
      }
      const associated = await list(deps.employees, { email }, employeeProjection, "Rider account binding", 2);
      const reciprocal = await list(deps.riders, { email }, fields("_id", "tenantId"), "Reciprocal Rider binding", 2);
      const employee = associated.length === 1 ? associated[0] : null;
      if (!employee || reciprocal.length !== 1 || !sameId(reciprocal[0]._id, rider._id) || employee.active !== true
        || employee.authorizationStatus !== "approved" || employee.apiRole !== "rider" || employee.ownerProtected === true
        || employee.accessLevel === "superadmin" || !Array.isArray(employee.roles) || employee.roles.length !== 1 || employee.roles[0] !== "rider"
        || !sameFleet(employee.fleetId, rider.fleetId) || !(employee.updatedAt instanceof Date)) {
        block("RIDER_EMPLOYEE_BINDING_INVALID", "Each Rider must bind uniquely to an active approved Rider-only account with the same current Fleet."); continue;
      }
      bindings.push({ riderId: rider._id, employee, emailDigest: sha256(email) });
    }
    if (fleet) {
      const vehicles = z.array(vehicleTypeSchema).min(1).safeParse(fleet.vehicleTypes);
      if (!vehicles.success || riders.some((row) => !vehicles.data.includes(row.vehicle))) block("DESTINATION_VEHICLE_CONFLICT", "All four vehicles must be explicitly supported by Maria's Fleet.");
      const fleetScope = z.array(z.string().regex(/^[a-z0-9-]+$/)).safeParse(fleet.serviceZones);
      const managerScope = z.array(z.string().regex(/^[a-z0-9-]+$/)).safeParse(manager?.zoneSlugs);
      if (!fleetScope.success || !managerScope.success || managerScope.data.some((slug) => !fleetScope.data.includes(slug))) block("DESTINATION_SCOPE_INVALID", "Fleet and manager must have valid consistent existing zone scopes.");
      for (const rider of riders) {
        const matches = zones.filter((zone) => zone.slug === rider.zoneSlug);
        const zone = matches.length === 1 ? matches[0] : null;
        const allowed = z.array(vehicleTypeSchema).safeParse(zone?.allowedVehicleTypes === undefined ? [...VEHICLE_TYPES] : zone.allowedVehicleTypes);
        if (!zone || zone.isActive !== true || !fleetScope.success || !fleetScope.data.includes(rider.zoneSlug)
          || !managerScope.success || !managerScope.data.includes(rider.zoneSlug)) block("EXISTING_ZONE_SCOPE_CONFLICT", "Every preserved Rider zone must be active and covered by both destination scopes.");
        if (!allowed.success || !allowed.data.includes(rider.vehicle)) block("ZONE_VEHICLE_CONFLICT", "Every preserved zone must allow its Rider's vehicle.");
      }
      const current = directory.filter((row) => sameId(row.fleetId, fleet._id)).length;
      const incoming = riders.filter((row) => !sameId(row.fleetId, fleet._id)).length;
      if (!Number.isInteger(fleet.maxRiders) || fleet.maxRiders < 1 || fleet.maxRiders > 10000 || current + incoming > fleet.maxRiders)
        block("DESTINATION_CAPACITY_CONFLICT", "The destination's exact current Rider count plus incoming Riders must fit maxRiders.");
    }
    const riderIds = riders.map((row) => row._id);
    const slots = riderIds.length ? await list(deps.slots, { riderId: { $in: riderIds } }, fields("_id", "tenantId", "riderId", "zoneSlug", "status", "startedAt", "stoppedAt", "assignmentRevision", "updatedAt"), "Rider slots") : [];
    const orders = riderIds.length ? await list(deps.orders, { $or: [{ riderId: { $in: riderIds } }, { qaRiderId: { $in: riderIds } }], status: { $nin: ["delivered", "cancelled"] } }, fields("_id", "tenantId", "riderId", "qaRiderId", "status", "assignmentState", "offerId", "assignmentExpiresAt", "updatedAt", "version"), "Active orders/offers") : [];
    const reservations = riderIds.length ? await list(deps.reservations, { riderId: { $in: riderIds }, status: { $nin: ["released", "completed", "cancelled"] } }, fields("_id", "tenantId", "riderId", "status", "updatedAt"), "Reservations") : [];
    const tracking = riderIds.length ? await list(deps.tracking, { riderId: { $in: riderIds }, $or: [{ status: { $ne: "stopped" } }, { stoppedAt: null }] }, fields("_id", "tenantId", "riderId", "status", "stoppedAt", "updatedAt"), "Tracking sessions") : [];
    const sessions = bindings.length ? await list(deps.employeeSessions, { employeeId: { $in: bindings.map((row) => row.employee._id) }, role: "rider", expiresAt: { $gt: now } }, fields("_id", "tenantId", "employeeId", "role", "issuedAt", "expiresAt"), "Live Rider sessions") : [];
    const activeSlots = slots.filter((slot) => slot.status === "active" || slot.startedAt != null && slot.stoppedAt == null || !["planned", "completed", "cancelled"].includes(slot.status));
    if (activeSlots.length || orders.length || reservations.length || sessions.length) block("ACTIVE_OPERATIONAL_WORK", "Active slots, orders/offers, reservations or live Rider sessions prohibit assignment.");
    if (tracking.length) block("ACTIVE_TRACKING", "Active, degraded or unclosed tracking sessions prohibit assignment.");
    if (!deps.transferCoordinator) block("ACTIVE_WORK_GUARD_UNAVAILABLE", "Existing operational writers lack a shared atomic transfer/capacity guard; legacy rider_locations and LocationSample lack tenant scope. Snapshot reads cannot guarantee absence of ongoing work. Assignment is disabled until these references and writers are coordinated.");
    const assignmentBlockers = [...blockers];
    block("ZONE_CONSOLIDATION_REQUIRES_REFERENCE_MIGRATION", "Preserve the xativa-centro monetary guarantee in settlements, historical Rider slots and existing coverage policy. Checkout uses static xativaBoundary/OPERATIONAL_AREAS geometry independently of Mongo Zone geometry. Canonical full-municipality coverage requires a separately reviewed reference and coverage migration; no zones or payments are changed here.");
    const destinationCount = fleet ? directory.filter((row) => sameId(row.fleetId, fleet._id)).length : 0;
    const publicRiders = riders.map((row) => ({ id: String(row._id), name: row.name, riderCode: row.riderCode ?? null, fleetId: nullableId(row.fleetId), zoneSlug: row.zoneSlug ?? null, vehicle: row.vehicle ?? null }));
    const activity = { activeSlots: activeSlots.length > 0, orders: orders.length > 0, offers: orders.some((row) => row.assignmentState === "offered"), reservations: reservations.length > 0, tracking: tracking.length > 0 || blockers.some((row) => row.code === "ACTIVE_TRACKING"), liveRiderSessions: sessions.length > 0, guaranteesAvailable: !!deps.transferCoordinator };
    const expectedAssignments = riders.map((row) => ({ riderId: String(row._id), fleetId: nullableId(row.fleetId), updatedAt: timestamp(row.updatedAt), revision: row.__v ?? null, zoneSlug: row.zoneSlug ?? null, status: row.status ?? null, lifecycleStatus: row.lifecycleStatus ?? null }));
    const publicView = { tenantId: tenantString,
      manager: manager ? { id: String(manager._id), name: manager.name, fleetId: nullableId(manager.fleetId) } : null,
      fleet: fleet ? { id: String(fleet._id), name: fleet.name } : null,
      riders: publicRiders,
      zones: zones.map((zone) => ({ id: String(zone._id), slug: zone.slug, name: zone.name, isActive: zone.isActive === true })).sort((a, b) => a.slug.localeCompare(b.slug)),
      canonical: XATIVA_CANONICAL_ZONE,
      destination: fleet ? { vehicleTypes: fleet.vehicleTypes, maxRiders: fleet.maxRiders, currentRiders: destinationCount, incomingRiders: riders.filter((row) => !sameId(row.fleetId, fleet._id)).length,
        serviceZones: fleet.serviceZones, managerZoneSlugs: manager.zoneSlugs, fleetUpdatedAt: timestamp(fleet.updatedAt), managerUpdatedAt: timestamp(manager.updatedAt), fleetRevision: fleet.__v ?? null, managerRevision: manager.__v ?? null } : null,
      expectedAssignments, activity, assignmentReady: assignmentBlockers.length === 0 && riders.length === 4 && bindings.length === 4 && !!fleet,
      consolidationReady: false as const, blockers,
    };
    const manifestHash = sha256(JSON.stringify(canonical({ version: 1, tenant, manager, fleet, riders, bindings, sourceFleets, zones, slots, orders, reservations, tracking, sessions,
      destinationCount, activity, blockers, coordinatorRevision: deps.transferCoordinator?.revision ?? null })));
    return { publicView: { ...publicView, manifestHash }, assignmentBlockers, tenantId, actorId, fleet, manager, riders, bindings, sourceFleets };
  }
  async function transaction<T>(callback: (session: Session) => Promise<T>): Promise<T> {
    const session = await deps.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => { result = await callback(session); }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      return result;
    } finally { await session.endSession(); }
  }
  const respondError = (error: unknown, res: any) => {
    if (error instanceof OperationError) return res.status(error.status).json({ error: error.code, ...(error.blockers ? { blockers: error.blockers } : {}) });
    throw error; // Audit/transaction failure MUST abort; never a standalone retry.
  };
  app.get("/api/v1/admin/xativa-operations/preview", deps.requireRole("admin"), async (req, res) => {
    const parsed = previewSchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: "EXPLICIT_TENANT_REQUIRED" });
    try {
      basicAuthorization(req, parsed.data.tenantId);
      const view = await transaction(async (session) => (await snapshot(req, parsed.data.tenantId, session)).publicView);
      res.setHeader("Cache-Control", "no-store");
      return res.json(view);
    } catch (error) { return respondError(error, res); }
  });
  app.post("/api/v1/admin/xativa-operations/assign-riders", deps.requireRole("admin"), async (req, res) => {
    const parsed = xativaAssignmentSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_XATIVA_ASSIGNMENT" });
    try {
      basicAuthorization(req, parsed.data.tenantId);
      const response = await transaction(async (session) => {
        const preview = await snapshot(req, parsed.data.tenantId, session);
        if (preview.publicView.manifestHash !== parsed.data.manifestHash) fail("STALE_MANIFEST");
        const { fleet, manager, riders, bindings, tenantId, actorId } = preview;
        const alreadyAssigned = !!fleet && !!manager && riders.length === 4 && bindings.length === 4
          && riders.every((row) => sameId(row.fleetId, fleet._id)) && bindings.every((row) => sameId(row.employee.fleetId, fleet._id));
        // A verified no-op needs no transfer coordinator, but still rejects
        // stale manifests, ambiguity, invalid scope, bindings or active work.
        const safeNoop = alreadyAssigned && preview.assignmentBlockers.every((row) => row.code === "ACTIVE_WORK_GUARD_UNAVAILABLE");
        if (!preview.publicView.assignmentReady && !safeNoop) throw new OperationError(409, "XATIVA_ASSIGNMENT_BLOCKED", preview.assignmentBlockers);
        if (!alreadyAssigned) {
          const coordinated = await deps.transferCoordinator!.acquire({ tenantId, actorEmployeeId: actorId, riderIds: riders.map((row) => row._id),
            employeeIds: [manager._id, ...bindings.map((row) => row.employee._id)], fleetIds: [fleet._id, ...preview.sourceFleets.filter((row) => !sameId(row._id, fleet._id)).map((row) => row._id)], session });
          if (!coordinated) fail("ACTIVE_WORK_GUARD_UNAVAILABLE");
          for (const rider of riders) {
            const binding = bindings.find((row) => sameId(row.riderId, rider._id))!;
            if (sameId(rider.fleetId, fleet._id)) continue;
            const filter: Record<string, any> = Object.fromEntries(Object.keys(riderProjection).map((key) => [key, exact(rider[key])]));
            filter.tenantId = tenantId; filter._id = rider._id;
            const result = await deps.riders.updateOne(filter, { $set: { fleetId: fleet._id } }, { session, upsert: false });
            if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("RIDER_ASSIGNMENT_CAS_FAILED");
            const employee = binding.employee;
            const employeeFilter: Record<string, any> = Object.fromEntries(Object.keys(employeeProjection).map((key) => [key, exact(employee[key])]));
            employeeFilter.tenantId = tenantId; employeeFilter._id = employee._id;
            const updated = await deps.employees.updateOne(employeeFilter, { $set: { fleetId: fleet._id } }, { session, upsert: false });
            if (updated.matchedCount !== 1 || updated.modifiedCount !== 1) fail("RIDER_EMPLOYEE_CAS_FAILED");
          }
          const accountAssignments = bindings.map((row) => ({ riderId: String(row.riderId), employeeId: String(row.employee._id), fleetId: nullableId(row.employee.fleetId),
            updatedAt: timestamp(row.employee.updatedAt), revision: row.employee.__v ?? null }));
          await deps.createAudit({ tenantId, actorEmployeeId: actorId, actorRole: "admin", action: "xativa_four_riders_assigned", targetType: "system", targetId: fleet._id,
            before: { manifestHash: parsed.data.manifestHash, assignments: preview.publicView.expectedAssignments, accountAssignments },
            after: { managerEmployeeId: String(manager._id), fleetId: String(fleet._id), assignments: preview.publicView.expectedAssignments.map((row) => ({ ...row, fleetId: String(fleet._id) })),
              accountAssignments: accountAssignments.map((row) => ({ ...row, fleetId: String(fleet._id) })) },
            reason: "Explicit assignment of exactly four verified Riders and their uniquely bound Rider accounts; existing zones, slots, contracts, GPS, roles, credentials and all payment references preserved.",
          }, session);
        }
        return { assigned: true, tenantId: parsed.data.tenantId, fleetId: String(fleet._id), managerEmployeeId: String(manager._id), riderIds: riders.map((row) => String(row._id)) };
      });
      return res.json(response);
    } catch (error) { return respondError(error, res); }
  });
}
