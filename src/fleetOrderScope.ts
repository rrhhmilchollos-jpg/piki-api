import {
  buildTenantScope,
  denyTenantScope,
  isObjectIdLike,
  type TenantScopedQuery,
} from "./tenantScope.js";

type FleetLocalityRecord = {
  localityName?: unknown;
  city?: unknown;
};

type FleetOrdersRestaurant = {
  locality?: unknown;
  city?: unknown;
};

type FleetOrdersScopeInput = {
  role: unknown;
  tenantId: unknown;
  fleetId?: unknown;
  isPlatformSuperadmin?: boolean;
  restaurantIds: readonly unknown[];
  riderIds?: readonly unknown[];
};

function distinctObjectIds(values: readonly unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  for (const value of values) {
    if (!isObjectIdLike(value)) continue;
    const key = typeof value === "string" ? value.toLowerCase() : String((value as { toHexString(): string }).toHexString()).toLowerCase();
    if (!byId.has(key)) byId.set(key, value);
  }
  return [...byId.values()];
}

/** The Fleet user's persisted locality is authoritative; the query string is never trusted for Fleet roles. */
export function resolveFleetOrdersLocality(
  role: unknown,
  requestedLocality: unknown,
  fleet?: FleetLocalityRecord | null,
): string | null {
  const candidate = role === "fleet"
    ? (fleet?.localityName || fleet?.city)
    : requestedLocality;
  const locality = String(candidate ?? "").trim().replace(/\s+/g, " ");
  return locality || null;
}

/** Normalize only for matching a persisted Fleet locality to its tenant's restaurants. */
export function normalizeFleetOrdersLocality(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .trim()
    .replace(/\s+/g, " ");
}

/** Match exact normalized locality in either legacy or canonical Restaurant field. */
export function restaurantBelongsToFleetOrdersLocality(
  restaurant: FleetOrdersRestaurant,
  locality: unknown,
): boolean {
  const target = normalizeFleetOrdersLocality(locality);
  if (!target) return false;
  return [restaurant.city, restaurant.locality].some((value) => normalizeFleetOrdersLocality(value) === target);
}

/**
 * Build the final Order query from server-derived restaurant and Rider relations.
 * Fleet actors must have a valid tenant and fleet context. Local restaurant
 * orders are visible only while unassigned; assigned orders require a Rider
 * owned by this Fleet and the same allowed-locality restaurant. Empty scopes
 * are always impossible. Platform-wide Admin scope must be explicit.
 */
export function buildFleetOrdersScope(input: FleetOrdersScopeInput): Record<string, unknown> {
  if (input.role !== "admin" && input.role !== "fleet") return denyTenantScope();

  const restaurantIds = distinctObjectIds(input.restaurantIds);
  if (!restaurantIds.length) return denyTenantScope();

  if (input.role === "fleet") {
    if (!isObjectIdLike(input.tenantId) || !isObjectIdLike(input.fleetId)) return denyTenantScope();
    const riderIds = distinctObjectIds(input.riderIds ?? []);
    const assignmentScope: Record<string, unknown>[] = [{ riderId: null }];
    if (riderIds.length) assignmentScope.push({ riderId: { $in: riderIds } });
    return {
      ...buildTenantScope(input.tenantId),
      restaurantId: { $in: restaurantIds },
      $or: assignmentScope,
    };
  }

  if (input.isPlatformSuperadmin === true) {
    return { restaurantId: { $in: restaurantIds } };
  }
  if (!isObjectIdLike(input.tenantId)) return denyTenantScope();
  const tenant = buildTenantScope(input.tenantId);
  return { ...tenant, restaurantId: { $in: restaurantIds } };
}
