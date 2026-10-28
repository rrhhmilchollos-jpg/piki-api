export const MAX_RIDER_LIST_PAGE_SIZE = 500;

export type RiderListPage = { limit: number; offset: number };

function queryInteger(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parses a bounded page request; malformed values fail closed instead of silently truncating. */
export function parseRiderListPagination(
  limitValue: unknown,
  offsetValue: unknown,
  defaultLimit: number,
): RiderListPage | null {
  if (!Number.isSafeInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > MAX_RIDER_LIST_PAGE_SIZE) return null;
  const limit = queryInteger(limitValue, defaultLimit);
  const offset = queryInteger(offsetValue, 0);
  if (limit === null || limit < 1 || limit > MAX_RIDER_LIST_PAGE_SIZE) return null;
  if (offset === null || offset < 0 || offset > Number.MAX_SAFE_INTEGER - limit) return null;
  return { limit, offset };
}
