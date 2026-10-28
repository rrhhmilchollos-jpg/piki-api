/**
 * Query-scope builders for tenant-owned data.
 *
 * These functions intentionally have no Mongoose dependency so they are safe to
 * unit-test and can be reused by HTTP handlers, jobs and realtime consumers.
 * An absent or malformed context always produces an impossible query instead
 * of an unscoped query.
 */
export type TenantScopedQuery = Record<string, unknown>;

export type FleetEntityScopeInput = {
  tenantId: unknown;
  role: unknown;
  fleetId?: unknown;
  /** Field containing the owning Fleet on the queried entity. */
  fleetField?: string;
};

const objectIdPattern = /^[a-f\d]{24}$/i;
const safeFieldPattern = /^(?:[A-Za-z_][A-Za-z\d_]*)(?:\.[A-Za-z_][A-Za-z\d_]*)*$/;

/** Returns a fresh impossible predicate; never replace this with `{}`. */
export function denyTenantScope(): TenantScopedQuery {
  return { _id: null };
}

/**
 * Accept strings and BSON ObjectId-like values without importing Mongoose.
 * Keeping the original value lets Mongoose use its native ObjectId when one
 * was already resolved by the caller.
 */
export function isObjectIdLike(value: unknown): boolean {
  if (typeof value === "string") return objectIdPattern.test(value);
  if (!value || typeof value !== "object" || !("toHexString" in value)) return false;
  const toHexString = (value as { toHexString?: unknown }).toHexString;
  if (typeof toHexString !== "function") return false;
  try {
    return objectIdPattern.test(toHexString.call(value));
  } catch {
    return false;
  }
}

function isSafeEntityField(field: string): boolean {
  // tenantId may never be overwritten by a caller-provided entity field.
  return safeFieldPattern.test(field) && field !== "tenantId";
}

/** Builds the mandatory tenant predicate from a frozen authenticated context. */
export function buildTenantScope(tenantId: unknown): TenantScopedQuery {
  return isObjectIdLike(tenantId) ? { tenantId } : denyTenantScope();
}

/**
 * Adds an exact tenant-owned entity id. Both the tenant and entity must be
 * valid IDs; a missing value is never broadened into a list query.
 */
export function buildTenantEntityScope(
  tenantId: unknown,
  entityId: unknown,
  entityField = "_id",
): TenantScopedQuery {
  if (!isSafeEntityField(entityField) || !isObjectIdLike(tenantId) || !isObjectIdLike(entityId)) return denyTenantScope();
  return { tenantId, [entityField]: entityId };
}

/**
 * Adds a non-empty set of tenant-owned entity ids. Useful after a Fleet-owned
 * rider query has produced rider ids. An empty set is deliberately impossible
 * rather than a condition that a future refactor might remove.
 */
export function buildTenantEntitySetScope(
  tenantId: unknown,
  entityIds: readonly unknown[],
  entityField = "_id",
): TenantScopedQuery {
  if (!isSafeEntityField(entityField) || !isObjectIdLike(tenantId)) return denyTenantScope();
  const ids = entityIds.filter(isObjectIdLike);
  if (!ids.length) return denyTenantScope();
  return { tenantId, [entityField]: { $in: ids } };
}

/**
 * Builds a direct ownership scope for Fleet actors. A Fleet actor without a
 * fleetId receives no data. Non-Fleet roles remain tenant-scoped, never
 * platform/global-scoped. Use this only for entities that store fleetId
 * directly (for orders, first derive authorised rider ids and use
 * buildTenantEntitySetScope with `riderId`).
 */
export function buildFleetEntityScope({
  tenantId,
  role,
  fleetId,
  fleetField = "fleetId",
}: FleetEntityScopeInput): TenantScopedQuery {
  if (!isSafeEntityField(fleetField) || !isObjectIdLike(tenantId)) return denyTenantScope();
  if (role !== "fleet") return { tenantId };
  if (!isObjectIdLike(fleetId)) return denyTenantScope();
  return { tenantId, [fleetField]: fleetId };
}


/**
 * Scope for a Fleet's Rider picker: its own Riders plus same-tenant Riders that
 * have not yet been claimed by any fleet. Assigned Riders from other fleets
 * remain invisible; an absent/invalid context still fails closed.
 */
export function buildFleetRiderPickerScope({ tenantId, role, fleetId }: FleetEntityScopeInput): TenantScopedQuery {
  const tenant = buildTenantScope(tenantId);
  if (role !== "fleet") return tenant;
  if (!isObjectIdLike(tenantId) || !isObjectIdLike(fleetId)) return denyTenantScope();
  return { ...tenant, $or: [{ fleetId }, { fleetId: null }] };
}
