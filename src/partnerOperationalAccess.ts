import type { Request } from "express";
import mongoose from "mongoose";
import { resolveRole } from "./auth.js";
import { isRootOwnerAccount, OWNER_EMAIL } from "./employeeSessions.js";
import { EmployeeAccount, Restaurant, Tenant, TenantMembership } from "./models.js";
import { partnerCan, partnerRolesForEmployee, permissionsForPartnerRoles, type PartnerPermission } from "./partnerAccess.js";
import { kitchenBindingForEmployee, kitchenRestaurantCanOperate, type KitchenBindingDependencies } from "./partnerKitchenAccess.js";
import { isPartnerEmployee, partnerBindingForEmployee, partnerBindingErrorResponse, partnerMembershipForEmployee } from "./employeePartnerBinding.js";
import { isObjectIdLike } from "./tenantScope.js";

export type PartnerOperationalDependencies = {
  resolveAuth: typeof resolveRole;
  employeeById: (id: string) => Promise<any>;
  binding: KitchenBindingDependencies;
};
const dependencies: PartnerOperationalDependencies = {
  resolveAuth: resolveRole,
  employeeById: (id) => EmployeeAccount.findById(id).select("_id email restaurantId restaurantIds tenantId jobRole apiRole roles primaryRole partnerRoles accessLevel ownerProtected active authorizationStatus mustChangePassword fleetId zoneSlugs kitchenAccessSetupVersion partnerBindingVersion").lean().exec(),
  binding: {
    ownerEmail: OWNER_EMAIL,
    objectId: (id) => new mongoose.Types.ObjectId(id),
    restaurants: Restaurant.collection,
    tenants: Tenant.collection,
    memberships: TenantMembership.collection,
  },
};
export type PartnerOperationalAccess = {
  employee: any;
  restaurantIds: string[];
  roles: string[];
  permissions: string[];
  kitchenRestaurant: any;
  bindingRestaurants: any[] | null;
  tenantId: string;
};
export type PartnerAccessDenial = { status: number; error: string };
const denied = (error: string, status = 403) => ({ access: null, denial: { status, error } });
const sameId = (a: unknown, b: unknown) => isObjectIdLike(a) && isObjectIdLike(b) && String(a) === String(b);

export function assignedRestaurantIds(employee: any): string[] {
  return [...new Set([...(Array.isArray(employee?.restaurantIds) ? employee.restaurantIds : []), employee?.restaurantId]
    .filter(isObjectIdLike).map(String))];
}

/** No bootstrap import, no lookup by email, no cached req.auth/session snapshot.
 * resolveRole re-reads session expiry/revocation, passwordChangedAt, frozen tenant
 * and role. The second account read guards its current operative state too.
 */
async function loadPartnerAccess(req: Request, deps: PartnerOperationalDependencies): Promise<{ access: PartnerOperationalAccess | null; denial: PartnerAccessDenial | null }> {
  const auth = await deps.resolveAuth(req);
  if (!auth?.employeeId) return denied("AUTHENTICATION_REQUIRED", 401);
  if (auth.role !== "partner") return denied("FORBIDDEN");
  if (!isObjectIdLike(auth.employeeId) || !isObjectIdLike(auth.tenantId)) return denied("TENANT_CONTEXT_REQUIRED");
  if (auth.mustChangePassword) return denied("PASSWORD_CHANGE_REQUIRED", 428);
  // REST's subsequent query uses req.auth. Never authorize a different context.
  if (req.auth && (req.auth.employeeId !== auth.employeeId || req.auth.tenantId !== auth.tenantId || req.auth.role !== auth.role)) return denied("AUTHENTICATION_REQUIRED", 401);
  const employee = await deps.employeeById(auth.employeeId);
  if (!employee || employee.active !== true || employee.authorizationStatus !== "approved") return denied("PARTNER_ACCOUNT_INVALID");
  if (employee.mustChangePassword) return denied("PASSWORD_CHANGE_REQUIRED", 428);
  if (!sameId(employee._id, auth.employeeId) || !sameId(employee.tenantId, auth.tenantId)) return denied("PARTNER_TENANT_BINDING_REQUIRED");
  if (!isPartnerEmployee(employee) && !isRootOwnerAccount(employee)) return denied("PARTNER_ACCOUNT_INVALID");
  const restaurantIds = assignedRestaurantIds(employee);
  if (!restaurantIds.length) return denied("PARTNER_RESTAURANT_NOT_ASSIGNED");
  let kitchenRestaurant: any = null;
  let bindingRestaurants: any[] | null = null;
  try {
    if (employee.kitchenAccessSetupVersion === 1) {
      kitchenRestaurant = (await kitchenBindingForEmployee(employee, deps.binding)).restaurant;
    } else if (employee.partnerBindingVersion === 1) {
      bindingRestaurants = (await partnerBindingForEmployee(employee, deps.binding)).restaurants;
    } else {
      // Legacy accounts retain role permissions/readiness semantics and may
      // predate memberships/listingType. A present membership is not optional:
      // it must remain active and coherent. Owner admin/owner membership is not
      // converted to Partner or granted additional scopes/locations.
      const [tenant, memberships, restaurants] = await Promise.all([
        deps.binding.tenants.findOne({ _id: employee.tenantId, status: "active" }),
        deps.binding.memberships.find({ employeeId: employee._id }).toArray(),
        Promise.all(restaurantIds.map((id) => deps.binding.restaurants.findOne({ _id: deps.binding.objectId(id), tenantId: employee.tenantId }))),
      ]);
      if (!tenant || restaurants.some((row) => !row || !sameId(row.tenantId, employee.tenantId))) return denied("PARTNER_TENANT_BINDING_REQUIRED");
      // Same optional-legacy membership contract as partnerBindingForEmployee.
      // Foreign-tenant memberships never substitute for the frozen tenant.
      if (memberships.some((row) => !sameId(row.tenantId, employee.tenantId))) return denied("PARTNER_MEMBERSHIP_BINDING_REQUIRED");
      partnerMembershipForEmployee(employee, memberships, restaurantIds);
    }
  } catch (error) {
    if (partnerBindingErrorResponse(error)) return denied("PARTNER_BINDING_INVALID");
    throw error;
  }
  const roles = partnerRolesForEmployee(employee);
  return { access: { employee, restaurantIds, roles, permissions: [...permissionsForPartnerRoles(roles)], kitchenRestaurant, bindingRestaurants, tenantId: String(employee.tenantId) }, denial: null };
}

export async function partnerAccessForRequest(req: Request, deps = dependencies) {
  return (await loadPartnerAccess(req, deps)).access;
}

/** Shared operational contract. No header means REST's first assigned location,
 * not all assigned locations. Readiness remains exactly the existing versioned
 * kitchen/Partner policy; it does not turn setup identity into orders access.
 */
export async function partnerRequestAccess(req: Request, permission: PartnerPermission, deps = dependencies) {
  const resolved = await loadPartnerAccess(req, deps);
  const access = resolved.access;
  if (!access) return { ...resolved, allowed: false, restaurantId: null };
  const requested = String(req.header("x-piki-restaurant-id") || "").trim();
  const restaurantId = requested || access.restaurantIds[0];
  if (!access.restaurantIds.includes(restaurantId)) return { access, allowed: false, restaurantId: null, denial: { status: 403, error: "PARTNER_RESTAURANT_ACCESS_DENIED" } };
  let operationReady = access.employee.kitchenAccessSetupVersion !== 1 || !permission.startsWith("orders:") || kitchenRestaurantCanOperate(access.kitchenRestaurant);
  if (access.bindingRestaurants && permission.startsWith("orders:")) operationReady = kitchenRestaurantCanOperate(access.bindingRestaurants.find((row) => String(row._id) === restaurantId));
  const allowed = operationReady && partnerCan(access.roles, permission);
  return { access, allowed, restaurantId, denial: allowed ? null : { status: 403, error: "PARTNER_PERMISSION_DENIED" } };
}
