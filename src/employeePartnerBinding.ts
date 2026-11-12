import type { Request } from "express";
import { isObjectIdLike } from "./tenantScope.js";
import { canReceivePartnerLocations, partnerRolesForEmployee, permissionsForPartnerRoles } from "./partnerAccess.js";
import { KitchenAccessError, kitchenBindingForEmployee, type KitchenAccessDependencies, type KitchenBindingDependencies } from "./partnerKitchenAccess.js";

export class PartnerBindingError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const fail = (code: string, status = 409): never => { throw new PartnerBindingError(status, code); };
const same = (a: unknown, b: unknown) => isObjectIdLike(a) && isObjectIdLike(b) && String(a) === String(b);
const sameSet = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && a.every((v) => b.includes(String(v)));
export function isPartnerEmployee(employee: any) {
  return employee?.apiRole === "partner" || employee?.jobRole === "partner" || employee?.roles?.includes("partner");
}
export function partnerBindingIds(employee: any): string[] {
  const values = [...(Array.isArray(employee?.restaurantIds) ? employee.restaurantIds : []), ...(employee?.restaurantId ? [employee.restaurantId] : [])];
  if (values.some((v) => !isObjectIdLike(v))) fail("PARTNER_RESTAURANT_ASSIGNMENT_INVALID");
  const ids = [...new Set(values.map(String))];
  if (!ids.length || ids.length > 100) fail("PARTNER_RESTAURANT_NOT_ASSIGNED");
  return ids;
}
function assertRestaurant(restaurant: any, tenant: unknown) {
  if (!restaurant || !same(restaurant.tenantId, tenant)) fail("PARTNER_RESTAURANT_NOT_FOUND_IN_TENANT");
  if (!["pending_review", "approved"].includes(restaurant.onboardingStatus)
    || !["official_partner", "restaurant"].includes(restaurant.listingType) || restaurant.internalDemo === true) fail("PARTNER_RESTAURANT_SETUP_INVALID");
}

/** Reuse the existing versioned/optional-legacy membership contract at runtime. */
export function partnerMembershipForEmployee(employee: any, memberships: any[], ids: string[]) {
  const matching = memberships.filter((row: any) => same(row.tenantId, employee.tenantId));
  const membership = matching[0];
  if (employee.partnerBindingVersion === 1) {
    if (matching.length !== 1 || membership.status !== "active" || !sameSet(membership.restaurantIds, ids)) fail("PARTNER_MEMBERSHIP_BINDING_REQUIRED");
  } else if (matching.length > 1 || (membership && (membership.status !== "active" || (membership.restaurantIds?.length && !sameSet(membership.restaurantIds, ids))))) {
    fail("PARTNER_MEMBERSHIP_BINDING_REQUIRED");
  }
  return membership;
}

/** No lookup by email and no mutation: all credential paths use the persisted relationship. */
export async function partnerBindingForEmployee(employee: any, deps: KitchenBindingDependencies) {
  if (employee?.kitchenAccessSetupVersion === 1) {
    const binding = await kitchenBindingForEmployee(employee, deps);
    return { restaurants: [binding.restaurant], membership: binding.membership };
  }
  if (!isPartnerEmployee(employee) || !isObjectIdLike(employee?._id) || !isObjectIdLike(employee?.tenantId)) fail("PARTNER_TENANT_BINDING_REQUIRED");
  if (!employee.active || employee.authorizationStatus !== "approved") fail("EMPLOYEE_NOT_APPROVED");
  const ids = partnerBindingIds(employee);
  const [tenant, memberships, restaurants] = await Promise.all([
    deps.tenants.findOne({ _id: employee.tenantId, status: "active" }),
    deps.memberships.find({ employeeId: employee._id }).toArray(),
    Promise.all(ids.map((id) => deps.restaurants.findOne({ _id: deps.objectId(id), tenantId: employee.tenantId }))),
  ]);
  if (!tenant) fail("PARTNER_TENANT_NOT_ACTIVE");
  restaurants.forEach((row) => assertRestaurant(row, employee.tenantId));
  const membership = partnerMembershipForEmployee(employee, memberships, ids);
  // Operational permissions come from the unchanged role resolver, not membership role.
  const permissions = [...permissionsForPartnerRoles(partnerRolesForEmployee(employee))];
  if (!permissions.length) fail("PARTNER_ROLES_REQUIRED");
  if (employee.partnerBindingVersion === 1 && membership.role === "partner" && !sameSet(membership.scopes, permissions)) fail("PARTNER_MEMBERSHIP_SCOPE_CONFLICT");
  return { restaurants, membership };
}

async function ownerContext(req: Request, deps: KitchenAccessDependencies, session?: any) {
  if (req.auth?.role !== "admin" || !isObjectIdLike(req.auth.employeeId) || req.auth.mustChangePassword) fail("SUPERADMIN_ONLY", 403);
  if (!isObjectIdLike(req.auth?.tenantId)) fail("TENANT_CONTEXT_REQUIRED");
  const actor = deps.objectId(req.auth!.employeeId!);
  const tenant = deps.objectId(req.auth!.tenantId!);
  const options = session ? { session } : {};
  const [owner, tenantRow, membership] = await Promise.all([
    deps.employees.findOne({ _id: actor, email: deps.ownerEmail, active: true, authorizationStatus: "approved", accessLevel: "superadmin", ownerProtected: true }, options),
    deps.tenants.findOne({ _id: tenant, status: "active" }, options),
    deps.memberships.findOne({ tenantId: tenant, employeeId: actor, status: "active", role: { $in: ["owner", "admin"] } }, options),
  ]);
  if (!owner) fail("SUPERADMIN_ONLY", 403);
  if (!tenantRow || !membership) fail("OWNER_TENANT_MEMBERSHIP_REQUIRED", 403);
  return { actor, tenant, tenantRow, membership };
}
export async function validatePartnerCredentialTarget(req: Request, employee: any, deps: KitchenAccessDependencies) {
  const context = await ownerContext(req, deps);
  const current = await deps.employees.findOne({ _id: employee._id });
  if (!current || !same(current.tenantId, context.tenant)) fail("PARTNER_ACCOUNT_TENANT_CONFLICT", 403);
  await partnerBindingForEmployee(current, deps);
  return current;
}
async function fence(collection: any, row: any, session: any, fields: Record<string, unknown> = {}) {
  const result = await collection.updateOne({ _id: row._id, kitchenAccessRevision: row.kitchenAccessRevision === undefined ? { $exists: false } : row.kitchenAccessRevision }, { $inc: { kitchenAccessRevision: 1 }, ...(Object.keys(fields).length ? { $set: fields } : {}) }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("PARTNER_BINDING_CHANGED");
}
async function uniqueIndexes(deps: KitchenAccessDependencies) {
  const [employees, memberships] = await Promise.all([deps.employees.indexes(), deps.memberships.indexes()]);
  const unique = (indexes: any[], keys: any) => indexes.some((index) => index.unique === true && !index.partialFilterExpression && !index.sparse && !index.collation && JSON.stringify(index.key) === JSON.stringify(keys));
  if (!unique(employees, { email: 1 }) || !unique(memberships, { tenantId: 1, employeeId: 1 })) fail("PARTNER_BINDING_UNIQUE_INDEX_REQUIRED", 503);
}

/** Used by common create, authorization edits and explicit assignment. No tokens/mail
 * inside the transaction. A real tenant is derived only from the selected restaurants.
 * Existing roles and membership privileges are retained unless Owner explicitly edits them.
 */
export async function persistPartnerBinding(req: Request, deps: KitchenAccessDependencies, input: {
  employeeId?: unknown; newEmployee?: any; restaurantIds: string[]; partnerRoles?: string[]; employeeUpdate?: Record<string, unknown>; reason: string;
}) {
  const ids = [...new Set(input.restaurantIds.map((id) => id.toLowerCase()))];
  if (!ids.length || ids.length > 100 || ids.some((id) => !isObjectIdLike(id))) fail("PARTNER_RESTAURANT_ASSIGNMENT_INVALID");
  await ownerContext(req, deps);
  await uniqueIndexes(deps);
  const session = await deps.startSession();
  let committed: any;
  try {
    await session.withTransaction(async () => {
      committed = undefined;
      const context = await ownerContext(req, deps, session);
      const existing = input.employeeId ? await deps.employees.findOne({ _id: input.employeeId }, { session }) : null;
      if (input.employeeId && !existing) fail("EMPLOYEE_NOT_FOUND", 404);
      if (existing?.kitchenAccessSetupVersion === 1) fail("KITCHEN_ACCOUNT_CONTRACT_PROTECTED");
      const target = { ...(existing || input.newEmployee), ...input.employeeUpdate };
      if (!canReceivePartnerLocations(target, deps.ownerEmail)) fail("PARTNER_ACCOUNT_NOT_FOUND", 404);
      const protectedOwner = target.ownerProtected === true || target.email === deps.ownerEmail;
      if (protectedOwner && (!existing || String(target._id) !== String(context.actor))) fail("OWNER_ACCOUNT_PROTECTED", 403);
      if (target.tenantId && !same(target.tenantId, context.tenant)) fail("EMPLOYEE_TENANT_CONFLICT");
      const restaurants = await Promise.all(ids.map((id) => deps.restaurants.findOne({ _id: deps.objectId(id), tenantId: context.tenant }, { session })));
      restaurants.forEach((row) => assertRestaurant(row, context.tenant));
      const memberships = existing ? await deps.memberships.find({ employeeId: existing._id }, { session }).toArray() : [];
      if (memberships.some((row: any) => !same(row.tenantId, context.tenant))) fail("PARTNER_MEMBERSHIP_TENANT_CONFLICT");
      if (memberships.length > 1) fail("PARTNER_MEMBERSHIP_CONFLICT");
      const member = memberships[0];
      const roles = input.partnerRoles || partnerRolesForEmployee(target);
      const permissions = [...permissionsForPartnerRoles(roles)];
      if (!roles.length || !permissions.length) fail("PARTNER_ROLES_REQUIRED");
      const binding = { tenantId: context.tenant, restaurantId: deps.objectId(ids[0]), restaurantIds: ids.map((id) => deps.objectId(id)), ...(input.partnerRoles ? { partnerRoles: input.partnerRoles } : {}), ...(!protectedOwner ? { partnerBindingVersion: 1 } : {}) };
      // Every validated shared record receives a real write fence. Concurrent
      // tenant/restaurant/membership changes conflict with this snapshot commit.
      await fence(deps.tenants, context.tenantRow, session);
      if (!protectedOwner) await fence(deps.memberships, context.membership, session);
      for (const restaurant of restaurants) await fence(deps.restaurants, restaurant, session);
      if (existing) {
        await fence(deps.employees, existing, session, { ...input.employeeUpdate, ...binding, sessionHash: null });
        committed = { ...existing, ...input.employeeUpdate, ...binding };
      } else {
        committed = await deps.createEmployee({ ...input.newEmployee, ...binding }, session);
      }
      const membershipFields = { restaurantIds: binding.restaurantIds, ...(member?.role && member.role !== "partner" ? {} : { scopes: permissions }), ...(input.employeeUpdate?.authorizationStatus ? { status: input.employeeUpdate.authorizationStatus === "approved" ? "active" : input.employeeUpdate.authorizationStatus === "revoked" ? "revoked" : "suspended" } : {}) };
      if (member) await fence(deps.memberships, member, session, membershipFields);
      else await deps.createMembership({ tenantId: context.tenant, employeeId: committed._id, role: "partner", status: committed.active && committed.authorizationStatus === "approved" ? "active" : "suspended", scopes: permissions, restaurantIds: binding.restaurantIds }, session);
      await deps.createAuthorization({ tenantId: context.tenant, employeeId: committed._id, action: existing ? "role_changed" : "created", previousStatus: existing?.authorizationStatus || null, nextStatus: committed.authorizationStatus, previousRole: existing ? JSON.stringify({ roles: partnerRolesForEmployee(existing), restaurantIds: existing.restaurantIds || [], tenantId: existing.tenantId || null }) : null, nextRole: JSON.stringify({ roles, restaurantIds: ids, tenantId: String(context.tenant) }), accessLevel: committed.accessLevel || "subadmin", actorEmployeeId: context.actor, reason: input.reason }, session);
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally { await session.endSession(); }
  return committed;
}

export function partnerBindingErrorResponse(error: unknown): { status: number; error: string } | null {
  if (error instanceof PartnerBindingError || error instanceof KitchenAccessError) return { status: error.status, error: error.code };
  if ((error as any)?.code === 11000) return { status: 409, error: "PARTNER_ACCOUNT_CONCURRENT_CONFLICT" };
  return null;
}
