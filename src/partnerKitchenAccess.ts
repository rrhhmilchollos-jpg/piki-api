import type { Express, Request, RequestHandler } from "express";
import { z } from "zod";
import { isObjectIdLike } from "./tenantScope.js";
import { partnerRolesForEmployee, permissionsForPartnerRoles } from "./partnerAccess.js";
import { isPublishedCustomerPartner } from "./customerCatalogPolicy.js";
import { normalizeOpeningHours, openingHoursSchema } from "./openingHours.js";

export const kitchenAccessSchema = z.object({
  restaurantId: z.string().regex(/^[a-f\d]{24}$/i).transform((id) => id.toLowerCase()),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  displayName: z.string().trim().min(2).max(160),
  sendActivation: z.boolean().default(false),
  openingHours: openingHoursSchema.transform(normalizeOpeningHours).refine((hours) => hours !== null, "INVALID_OPENING_HOURS").optional(),
}).strict();

export class KitchenAccessError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
type Session = {
  withTransaction(fn: () => Promise<void>, options?: any): Promise<unknown>;
  endSession(): Promise<unknown>;
};
type Collection = {
  findOne(filter: any, options?: any): Promise<any>;
  updateOne(filter: any, update: any, options?: any): Promise<{ matchedCount: number; modifiedCount: number }>;
};
export type KitchenAccessDependencies = {
  requireOwner: () => RequestHandler;
  ownerEmail: string;
  objectId: (id: string) => unknown;
  newId: () => unknown;
  employeeCodeFor: (id: unknown) => string;
  passwordHash: () => string;
  employees: Collection & { indexes(): Promise<any[]> };
  memberships: Collection & { find(filter: any, options?: any): { toArray(): Promise<any[]> }; indexes(): Promise<any[]> };
  tenants: Collection;
  restaurants: Collection;
  createEmployee: (row: any, session: Session) => Promise<any>;
  createMembership: (row: any, session: Session) => Promise<unknown>;
  createAuthorization: (row: any, session?: Session) => Promise<unknown>;
  startSession: () => Promise<Session>;
  sendActivation: (employee: any) => Promise<{ sent: boolean; error?: string }>;
};
const kitchenPermissions = ["orders:read", "orders:prepare"];
const fail = (code: string, status = 409): never => { throw new KitchenAccessError(status, code); };
const exactValues = (values: unknown, expected: string[]) => Array.isArray(values)
  && values.length === expected.length && values.every((value, index) => String(value) === expected[index]);
const emailOf = (row: any) => String(row?.email || "").trim().toLowerCase();
function sameId(left: unknown, right: unknown) { return isObjectIdLike(left) && isObjectIdLike(right) && String(left) === String(right); }

/** Contact is a second target boundary: the restaurant must already offer this email.
 * No implicit email lookup, global restaurant assignment, or rebinding is performed.
 */
function assertRestaurant(restaurant: any, tenantId: unknown, email: string) {
  if (!restaurant || !sameId(restaurant.tenantId, tenantId)) fail("KITCHEN_RESTAURANT_NOT_FOUND_IN_TENANT", 404);
  if (!["pending_review", "approved"].includes(restaurant.onboardingStatus)
    || !["official_partner", "restaurant"].includes(restaurant.listingType)
    || restaurant.internalDemo === true) fail("KITCHEN_RESTAURANT_SETUP_INVALID");
  if (emailOf(restaurant) !== email) fail("KITCHEN_RESTAURANT_CONTACT_CONFLICT");
}

/** Runtime and activation re-read the real relationship. Membership scopes are
 * persisted coherently, not used as a substitute for the employee's permissions.
 */
export async function kitchenBindingForEmployee(employee: any, deps: KitchenAccessDependencies, session?: Session) {
  if (!employee || employee.kitchenAccessSetupVersion !== 1 || !isObjectIdLike(employee._id)
    || !isObjectIdLike(employee.tenantId) || !isObjectIdLike(employee.restaurantId)
    || !exactValues(employee.restaurantIds, [String(employee.restaurantId)])
    || employee.jobRole !== "partner" || employee.apiRole !== "partner" || employee.primaryRole !== "partner"
    || !exactValues(employee.roles, ["partner"]) || !exactValues(employee.partnerRoles, ["kitchen"])
    || employee.accessLevel !== "subadmin" || employee.ownerProtected === true
    || emailOf(employee) === deps.ownerEmail || !employee.active || employee.authorizationStatus !== "approved"
    || employee.fleetId || (employee.zoneSlugs?.length ?? 0) > 0) fail("KITCHEN_ACCOUNT_BINDING_CONFLICT");
  const options = session ? { session } : {};
  const [restaurant, memberships, tenant] = await Promise.all([
    deps.restaurants.findOne({ _id: employee.restaurantId, tenantId: employee.tenantId }, options),
    deps.memberships.find({ employeeId: employee._id }, options).toArray(),
    deps.tenants.findOne({ _id: employee.tenantId, status: "active" }, options),
  ]);
  if (!tenant) fail("KITCHEN_TENANT_NOT_ACTIVE");
  assertRestaurant(restaurant, employee.tenantId, emailOf(employee));
  const membership = memberships[0];
  if (memberships.length !== 1 || !sameId(membership?.tenantId, employee.tenantId)
    || membership.role !== "partner" || membership.status !== "active"
    || !exactValues(membership.restaurantIds, [String(employee.restaurantId)])
    || !exactValues(membership.scopes, kitchenPermissions)) fail("KITCHEN_MEMBERSHIP_CONFLICT");
  return { restaurant, membership };
}

/** Setup/credentials do not approve food service. Apply the current publication
 * guard plus verified PIKI compliance and known allergens only to these new accounts.
 */
export function kitchenRestaurantCanOperate(restaurant: any): boolean {
  const menu = restaurant?.menu;
  return isPublishedCustomerPartner(restaurant)
    && restaurant.marketplaceCompliance?.pikiStatus === "verified"
    && Array.isArray(menu) && menu.some((item: any) => item.available !== false)
    && menu.filter((item: any) => item.available !== false).every((item: any) => Array.isArray(item.allergens));
}

async function actorContext(req: Request, deps: KitchenAccessDependencies, session?: Session) {
  const actorId = req.auth?.employeeId;
  const tenantId = req.auth?.tenantId;
  if (req.auth?.role !== "admin" || !isObjectIdLike(actorId)) fail("SUPERADMIN_ONLY", 403);
  if (!isObjectIdLike(tenantId)) fail("TENANT_CONTEXT_REQUIRED");
  const tenant = deps.objectId(tenantId!);
  const actor = deps.objectId(actorId!);
  const options = session ? { session } : {};
  const [owner, tenantRow, membership] = await Promise.all([
    deps.employees.findOne({ _id: actor, email: deps.ownerEmail, tenantId: tenant, active: true, authorizationStatus: "approved", accessLevel: "superadmin", ownerProtected: true }, options),
    deps.tenants.findOne({ _id: tenant, status: "active" }, options),
    deps.memberships.findOne({ tenantId: tenant, employeeId: actor, status: "active", role: { $in: ["owner", "admin"] } }, options),
  ]);
  if (!owner || req.auth?.mustChangePassword) fail("SUPERADMIN_ONLY", 403);
  if (!tenantRow || !membership) fail("OWNER_TENANT_MEMBERSHIP_REQUIRED", 403);
  return { actor, tenant, tenantRow, membership };
}

/** A real increment makes the snapshot validation conflict with concurrent
 * restaurant/tenant/membership changes, unlike a no-op $set. No commercial flag
 * or Owner account is modified. A CAS miss aborts the entire transaction.
 */
async function fence(collection: Collection, row: any, predicate: any, session: Session, fields: Record<string, unknown> = {}) {
  const revision = row.kitchenAccessRevision;
  const result = await collection.updateOne({
    _id: row._id, ...predicate,
    kitchenAccessRevision: revision === undefined ? { $exists: false } : revision,
  }, { $inc: { kitchenAccessRevision: 1 }, ...(Object.keys(fields).length ? { $set: fields } : {}) }, { session });
  if (result.matchedCount !== 1 || result.modifiedCount !== 1) fail("KITCHEN_BINDING_CHANGED");
}
async function uniqueIndexes(deps: KitchenAccessDependencies) {
  const [employees, memberships] = await Promise.all([deps.employees.indexes(), deps.memberships.indexes()]);
  const unique = (indexes: any[], keys: Record<string, number>) => indexes.some((index) => index.unique === true
    && !index.partialFilterExpression && !index.sparse && !index.collation
    && JSON.stringify(index.key) === JSON.stringify(keys));
  if (!unique(employees, { email: 1 }) || !unique(memberships, { tenantId: 1, employeeId: 1 })) fail("KITCHEN_ACCESS_UNIQUE_INDEX_REQUIRED", 503);
}

export async function validateKitchenActivation(req: Request, target: any, deps: KitchenAccessDependencies) {
  const context = await actorContext(req, deps);
  if (!sameId(target.tenantId, context.tenant)) fail("KITCHEN_ACCOUNT_TENANT_CONFLICT", 403);
  // Do not trust the earlier route projection if authorization/binding changed.
  const current = await deps.employees.findOne({ _id: target._id, tenantId: context.tenant });
  await kitchenBindingForEmployee(current, deps);
  return current;
}

export function registerPartnerKitchenAccessRoutes(app: Express, deps: KitchenAccessDependencies) {
  app.post("/api/v1/admin/partners/kitchen-access", deps.requireOwner(), async (req, res) => {
    const parsed = kitchenAccessSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_KITCHEN_ACCESS", details: parsed.error.flatten() });
    const body = parsed.data;
    let employee: any;
    let created = false;
    try {
      if (body.email === deps.ownerEmail) fail("OWNER_ACCOUNT_PROTECTED", 403);
      // Fail before opening a transaction for shared env tokens/missing context.
      await actorContext(req, deps);
      await uniqueIndexes(deps);
      const session = await deps.startSession();
      try {
        await session.withTransaction(async () => {
          // Driver callbacks can retry. Only the committed attempt determines created/email.
          employee = undefined;
          created = false;
          const context = await actorContext(req, deps, session);
          const restaurantId = deps.objectId(body.restaurantId);
          const restaurant = await deps.restaurants.findOne({ _id: restaurantId, tenantId: context.tenant }, { session });
          assertRestaurant(restaurant, context.tenant, body.email);
          const existing = await deps.employees.findOne({ email: body.email }, { session });
          if (existing) {
            if (existing.ownerProtected || emailOf(existing) === deps.ownerEmail) fail("OWNER_ACCOUNT_PROTECTED", 403);
            if (!sameId(existing.restaurantId, restaurantId) || !sameId(existing.tenantId, context.tenant)
              || existing.name !== body.displayName) fail("KITCHEN_ACCOUNT_ALREADY_EXISTS_CONFLICT");
            await kitchenBindingForEmployee(existing, deps, session);
            if (body.openingHours && JSON.stringify(normalizeOpeningHours(restaurant.partnerProfile?.openingHours)) !== JSON.stringify(body.openingHours)) fail("KITCHEN_OPENING_HOURS_CONFLICT");
            employee = existing;
            return; // Exact retry: no mutation, no reset invalidation, no second email.
          }
          const hoursFields: Record<string, unknown> = {};
          if (body.openingHours) {
            if (restaurant.onboardingStatus !== "pending_review" || restaurant.isActive !== false) fail("KITCHEN_HOURS_PENDING_SETUP_ONLY");
            const profile = restaurant.partnerProfile;
            if (profile === null || profile === undefined) hoursFields.partnerProfile = { openingHours: body.openingHours };
            else if (typeof profile === "object" && !Array.isArray(profile)) hoursFields["partnerProfile.openingHours"] = body.openingHours;
            else fail("KITCHEN_RESTAURANT_PROFILE_INVALID");
          }
          await fence(deps.tenants, context.tenantRow, { status: "active" }, session);
          await fence(deps.memberships, context.membership, { tenantId: context.tenant, employeeId: context.actor, role: context.membership.role, status: "active" }, session);
          // Raw, narrowly targeted update avoids casting a partial legal profile
          // through Mongoose's required fiscal/bank fields. Nothing is invented.
          await fence(deps.restaurants, restaurant, { tenantId: context.tenant, email: restaurant.email, onboardingStatus: restaurant.onboardingStatus, isActive: restaurant.isActive, listingType: restaurant.listingType, internalDemo: restaurant.internalDemo === undefined ? { $exists: false } : restaurant.internalDemo }, session, hoursFields);
          const id = deps.newId();
          const now = new Date();
          employee = await deps.createEmployee({
            _id: id, employeeCode: deps.employeeCodeFor(id), name: body.displayName, email: body.email,
            tenantId: context.tenant, restaurantId, restaurantIds: [restaurantId],
            jobRole: "partner", apiRole: "partner", roles: ["partner"], primaryRole: "partner", partnerRoles: ["kitchen"],
            kitchenAccessSetupVersion: 1, accessLevel: "subadmin", ownerProtected: false,
            authorizationStatus: "approved", active: true, authorizedAt: now, authorizedBy: context.actor,
            authorizationReason: "Acceso exclusivo de cocina autorizado por Owner; no aprueba el restaurante.",
            passwordHash: deps.passwordHash(), mustChangePassword: true, sessionHash: null,
            fleetId: null, zoneSlugs: [],
          }, session);
          await deps.createMembership({ tenantId: context.tenant, employeeId: id, role: "partner", status: "active", scopes: kitchenPermissions, restaurantIds: [restaurantId] }, session);
          await deps.createAuthorization({ tenantId: context.tenant, employeeId: id, action: "created", previousStatus: null, nextStatus: "approved", previousRole: null, nextRole: JSON.stringify({ apiRole: "partner", partnerRoles: ["kitchen"], restaurantIds: [body.restaurantId] }), accessLevel: "subadmin", actorEmployeeId: context.actor, reason: employee.authorizationReason }, session);
          await kitchenBindingForEmployee(employee, deps, session);
          created = true;
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
      } finally { await session.endSession(); }
      // Nothing above this point sends email or creates reset tokens.
    } catch (error) {
      if (error instanceof KitchenAccessError) return res.status(error.status).json({ error: error.code });
      if ((error as any)?.code === 11000) return res.status(409).json({ error: "KITCHEN_ACCOUNT_CONCURRENT_CONFLICT", retry: "Repeat the same kitchen-access request; never use employee-create." });
      throw error;
    }
    let activationEmail: { sent: boolean; surface: "partner"; recipient: string; error?: string; skipped?: string } = { sent: false, surface: "partner", recipient: body.email, skipped: !created ? "EXACT_RETRY_NO_EMAIL" : "NOT_REQUESTED" };
    if (created && body.sendActivation) {
      try {
        const current = await validateKitchenActivation(req, employee, deps);
        const delivery = await deps.sendActivation(current);
        activationEmail = { ...delivery, surface: "partner", recipient: body.email };
        if (delivery.sent) await deps.createAuthorization({ tenantId: current.tenantId, employeeId: current._id, action: "credentials_sent", previousStatus: "approved", nextStatus: "approved", previousRole: "partner", nextRole: "partner", accessLevel: "subadmin", actorEmployeeId: deps.objectId(req.auth!.employeeId!), reason: "Enlace de activación enviado para PIKI Partner Orders." });
      } catch (error) {
        // An audit failure after SMTP acceptance must not masquerade as an
        // unsent email and cause the caller to resend the first credentials.
        activationEmail = { sent: activationEmail.sent, surface: "partner", recipient: body.email, error: error instanceof KitchenAccessError ? error.code : "CREDENTIAL_EMAIL_OR_AUDIT_FAILED" };
      }
    }
    const roles = partnerRolesForEmployee(employee);
    return res.status(created ? 201 : 200).json({
      created, bindingPersisted: true,
      employee: { id: String(employee._id), employeeCode: employee.employeeCode, name: employee.name, email: employee.email, tenantId: String(employee.tenantId), restaurantId: String(employee.restaurantId), restaurantIds: employee.restaurantIds.map(String), jobRole: employee.jobRole, apiRole: employee.apiRole, primaryRole: employee.primaryRole, roles: employee.roles, partnerRoles: roles, permissions: [...permissionsForPartnerRoles(roles)], accessLevel: employee.accessLevel, active: employee.active, authorizationStatus: employee.authorizationStatus, mustChangePassword: employee.mustChangePassword },
      activationEmail,
      restaurantApprovalChanged: false,
      openingHoursPersisted: Boolean(body.openingHours),
      warning: created && body.sendActivation && !activationEmail.sent ? "Binding persisted; do not recreate the account. Revalidate it before explicit send-activation." : undefined,
    });
  });
}
