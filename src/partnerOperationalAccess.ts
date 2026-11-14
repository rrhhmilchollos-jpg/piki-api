import type { Request, RequestHandler } from "express";
import mongoose from "mongoose";
import { resolveRole } from "./auth.js";
import { isRootOwnerAccount, OWNER_EMAIL } from "./employeeSessions.js";
import { EmployeeAccount, Restaurant, Tenant, TenantMembership } from "./models.js";
import { partnerCan, partnerRolesForEmployee, permissionsForPartnerRoles, type PartnerPermission } from "./partnerAccess.js";
import { kitchenBindingForEmployee, kitchenRestaurantCanOperate, type KitchenBindingDependencies } from "./partnerKitchenAccess.js";
import { isPartnerEmployee, partnerBindingForEmployee, partnerBindingErrorResponse, partnerMembershipForEmployee } from "./employeePartnerBinding.js";
import { isObjectIdLike } from "./tenantScope.js";
import { CUSTOMER_HIDDEN_TEST_SLUGS } from "./customerCatalogPolicy.js";
import { customerAvailability, type CustomerAvailabilityReason } from "./customerAvailability.js";

export type PartnerOperationalDependencies = {
  resolveAuth: typeof resolveRole;
  employeeById: (id: string) => Promise<any>;
  binding: KitchenBindingDependencies;
  ownerRestaurants?: (tenantId: string) => Promise<any[]>;
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
  // Identity portfolio, not the public/orderable catalog. The explicit frozen
  // tenant is mandatory even for a root-admin session; filtering below also
  // defends against an incoherent result or an over-broad adapter.
  ownerRestaurants: (tenantId) => Restaurant.find({ tenantId })
    .select("_id tenantId slug listingType fulfillmentMode internalDemo onboardingStatus isActive availabilityStatus marketplaceCompliance.pikiStatus menu.available menu.allergens")
    .sort({ _id: 1 }).lean().exec(),
};
export type PartnerOperationalAccess = {
  employee: any;
  restaurantIds: string[];
  roles: string[];
  permissions: string[];
  kitchenRestaurant: any;
  bindingRestaurants: any[] | null;
  tenantId: string;
  ownerPortfolio?: boolean;
};
export type PartnerAccessDenial = { status: number; error: string; reason?: CustomerAvailabilityReason };
const denied = (error: string, status = 403) => ({ access: null, denial: { status, error } });
const sameId = (a: unknown, b: unknown) => isObjectIdLike(a) && isObjectIdLike(b) && String(a) === String(b);

export function assignedRestaurantIds(employee: any): string[] {
  return [...new Set([...(Array.isArray(employee?.restaurantIds) ? employee.restaurantIds : []), employee?.restaurantId]
    .filter(isObjectIdLike).map(String))];
}

export function partnerReadinessReason(restaurant: any): CustomerAvailabilityReason {
  if (kitchenRestaurantCanOperate(restaurant)) return "open";
  if (restaurant?.onboardingStatus !== "approved") return "not_approved";
  const { reason } = customerAvailability({ ...restaurant, hasMenu: Array.isArray(restaurant?.menu) && restaurant.menu.length > 0 });
  return reason === "open" ? "not_orderable" : reason;
}

/** No bootstrap import, email discovery, cached session snapshot or claim-only
 * privilege. Resolve the credential and re-read its account and frozen tenant.
 */
async function loadPartnerAccess(req: Request, deps: PartnerOperationalDependencies): Promise<{ access: PartnerOperationalAccess | null; denial: PartnerAccessDenial | null }> {
  const auth = await deps.resolveAuth(req);
  if (!auth?.employeeId) return denied("AUTHENTICATION_REQUIRED", 401);
  if (!["partner", "admin"].includes(auth.role)) return denied("FORBIDDEN");
  if (!isObjectIdLike(auth.employeeId) || !isObjectIdLike(auth.tenantId)) return denied("TENANT_CONTEXT_REQUIRED");
  if (auth.mustChangePassword) return denied("PASSWORD_CHANGE_REQUIRED", 428);
  if (req.auth && (req.auth.employeeId !== auth.employeeId || req.auth.tenantId !== auth.tenantId || req.auth.role !== auth.role)) return denied("AUTHENTICATION_REQUIRED", 401);
  const employee = await deps.employeeById(auth.employeeId);
  if (!employee || employee.active !== true || employee.authorizationStatus !== "approved") return denied("PARTNER_ACCOUNT_INVALID");
  if (employee.mustChangePassword) return denied("PASSWORD_CHANGE_REQUIRED", 428);
  if (!sameId(employee._id, auth.employeeId) || !sameId(employee.tenantId, auth.tenantId)) return denied("PARTNER_TENANT_BINDING_REQUIRED");
  const owner = isRootOwnerAccount(employee);
  if (auth.role !== "partner" && !owner) return denied("FORBIDDEN");
  if (!isPartnerEmployee(employee) && !owner) return denied("PARTNER_ACCOUNT_INVALID");
  const assignedIds = assignedRestaurantIds(employee);
  if (owner) {
    // Persisted Owner + active Owner/Admin membership in exactly this tenant.
    // Old assignments neither restrict this portfolio nor rescue a revoked one.
    // Other-tenant memberships never substitute for or expand the frozen tenant.
    if (employee.kitchenAccessSetupVersion === 1) return denied("PARTNER_BINDING_INVALID");
    const [tenant, memberships] = await Promise.all([
      deps.binding.tenants.findOne({ _id: employee.tenantId, status: "active" }),
      deps.binding.memberships.find({ employeeId: employee._id, tenantId: employee.tenantId }).toArray(),
    ]);
    if (!tenant || !sameId(tenant._id, employee.tenantId) || tenant.status !== "active"
      || memberships.length !== 1 || !["owner", "admin"].includes(memberships[0].role) || memberships[0].status !== "active"
      || !sameId(memberships[0].employeeId, employee._id) || !sameId(memberships[0].tenantId, employee.tenantId)) return denied("OWNER_TENANT_MEMBERSHIP_REQUIRED");
    if (!deps.ownerRestaurants) return denied("OWNER_PARTNER_PORTFOLIO_UNAVAILABLE");
    const restaurants = (await deps.ownerRestaurants(String(employee.tenantId))).filter((row) => sameId(row.tenantId, employee.tenantId)
      && isObjectIdLike(row._id) && ["pending_review", "approved"].includes(row.onboardingStatus)
      && row.internalDemo !== true && !(CUSTOMER_HIDDEN_TEST_SLUGS as readonly string[]).includes(row.slug)
      && row.fulfillmentMode !== "assisted_purchase" && (row.listingType === undefined || ["official_partner", "restaurant"].includes(row.listingType)));
    const foundIds = [...new Set(restaurants.map((row) => String(row._id)))];
    const restaurantIds = [...assignedIds.filter((id) => foundIds.includes(id)), ...foundIds.filter((id) => !assignedIds.includes(id))];
    req.auth = auth;
    return { access: { employee, restaurantIds, roles: ["owner"], permissions: ["*"], kitchenRestaurant: null, bindingRestaurants: restaurants, tenantId: String(employee.tenantId), ownerPortfolio: true }, denial: null };
  }
  const restaurantIds = assignedIds;
  if (!restaurantIds.length) return denied("PARTNER_RESTAURANT_NOT_ASSIGNED");
  let kitchenRestaurant: any = null;
  let bindingRestaurants: any[] | null = null;
  try {
    if (employee.kitchenAccessSetupVersion === 1) {
      kitchenRestaurant = (await kitchenBindingForEmployee(employee, deps.binding)).restaurant;
    } else if (employee.partnerBindingVersion === 1) {
      bindingRestaurants = (await partnerBindingForEmployee(employee, deps.binding)).restaurants;
    } else {
      // Keep legacy scoped managers and their optional membership contract.
      const [tenant, memberships, restaurants] = await Promise.all([
        deps.binding.tenants.findOne({ _id: employee.tenantId, status: "active" }),
        deps.binding.memberships.find({ employeeId: employee._id }).toArray(),
        Promise.all(restaurantIds.map((id) => deps.binding.restaurants.findOne({ _id: deps.binding.objectId(id), tenantId: employee.tenantId }))),
      ]);
      if (!tenant || restaurants.some((row) => !row || !sameId(row.tenantId, employee.tenantId))) return denied("PARTNER_TENANT_BINDING_REQUIRED");
      if (memberships.some((row) => !sameId(row.tenantId, employee.tenantId))) return denied("PARTNER_MEMBERSHIP_BINDING_REQUIRED");
      partnerMembershipForEmployee(employee, memberships, restaurantIds);
    }
  } catch (error) {
    if (partnerBindingErrorResponse(error)) return denied("PARTNER_BINDING_INVALID");
    throw error;
  }
  const roles = partnerRolesForEmployee(employee);
  req.auth = auth;
  return { access: { employee, restaurantIds, roles, permissions: [...permissionsForPartnerRoles(roles)], kitchenRestaurant, bindingRestaurants, tenantId: String(employee.tenantId) }, denial: null };
}

export async function partnerAccessForRequest(req: Request, deps = dependencies) {
  return (await loadPartnerAccess(req, deps)).access;
}

/** Partner REST gate accepts a persisted Owner's admin session without opening
 * ordinary admin/shared-token access. It never changes the session's role. */
export function requirePartnerSurface(deps = dependencies): RequestHandler {
  return async (req, res, next) => {
    res.setHeader("Cache-Control", "no-store, no-cache, max-age=0, must-revalidate");
    res.setHeader("Vary", "X-PIKI-Restaurant-Id, Authorization");
    const result = await loadPartnerAccess(req, deps);
    if (!result.access) {
      const denial = result.denial!;
      if (denial.status === 401) res.setHeader("WWW-Authenticate", "Bearer");
      return res.status(denial.status).json({ error: denial.error });
    }
    return next();
  };
}

/** Same selected-location contract for REST/SSE. A pending Owner location is
 * consultative menu-read only, never an operational privilege or approval.
 * Ordinary versioned and legacy readiness/permission contracts are unchanged. */
export async function partnerRequestAccess(req: Request, permission: PartnerPermission, deps = dependencies) {
  const resolved = await loadPartnerAccess(req, deps);
  const access = resolved.access;
  if (!access) return { ...resolved, allowed: false, restaurantId: null };
  const requested = String(req.header("x-piki-restaurant-id") || "").trim();
  const restaurantId = requested || access.restaurantIds[0];
  if (!restaurantId || !access.restaurantIds.includes(restaurantId)) return { access, allowed: false, restaurantId: null, denial: { status: 403, error: "PARTNER_RESTAURANT_ACCESS_DENIED" } };
  const restaurant = access.kitchenRestaurant || access.bindingRestaurants?.find((row) => String(row._id) === restaurantId);
  // Store configuration and online/offline controls must work while a local
  // is paused or still being prepared. Order permissions keep the publication
  // gate; otherwise reopening a paused local would require it to be active.
  const needsReadiness = (access.ownerPortfolio && permission.startsWith("orders:"))
    || ((access.employee.kitchenAccessSetupVersion === 1 || access.bindingRestaurants) && permission.startsWith("orders:"));
  const operationReady = !needsReadiness || kitchenRestaurantCanOperate(restaurant);
  const allowed = operationReady && partnerCan(access.roles, permission);
  return { access, allowed, restaurantId, denial: allowed ? null : { status: 403, error: "PARTNER_PERMISSION_DENIED", ...(!operationReady ? { reason: partnerReadinessReason(restaurant) } : {}) } };
}
