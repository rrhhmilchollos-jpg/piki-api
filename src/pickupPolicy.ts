export type GeoPoint = { type?: string; coordinates?: unknown } | null | undefined;

export type LatePickupDecision =
  | { action: "keep"; distanceMeters: number | null; reason: "arrival_confirmed" }
  | { action: "mark_arrived"; distanceMeters: number; reason: "gps_within_partner_radius" }
  | { action: "reassign"; distanceMeters: number | null; reason: "outside_partner_radius_or_missing_gps" };

export function pointDistanceMeters(a: GeoPoint, b: GeoPoint): number | null {
  const first = Array.isArray(a?.coordinates) ? a.coordinates : [];
  const second = Array.isArray(b?.coordinates) ? b.coordinates : [];
  const [lon1, lat1] = first;
  const [lon2, lat2] = second;
  if (![lon1, lat1, lon2, lat2].every((value) => Number.isFinite(Number(value)))) return null;

  const radians = (value: number) => value * Math.PI / 180;
  const deltaLatitude = radians(Number(lat2) - Number(lat1));
  const deltaLongitude = radians(Number(lon2) - Number(lon1));
  const haversine = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(radians(Number(lat1))) * Math.cos(radians(Number(lat2))) * Math.sin(deltaLongitude / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(Math.max(0, 1 - haversine)));
}

/**
 * A deadline is only cleared by a recorded arrival or by fresh GPS inside the
 * configured radius of the Partner. Missing or stale GPS must never exempt an
 * assignment from reassignment.
 */
export function decideLatePickup(input: {
  riderArrivedAt?: Date | string | null;
  riderLocation?: GeoPoint;
  partnerLocation?: GeoPoint;
  riderLastLocationAt?: Date | string | null;
  arrivalRadiusMeters: number;
  maxLocationAgeMs?: number;
  now?: Date;
}): LatePickupDecision {
  if (input.riderArrivedAt) return { action: "keep", distanceMeters: null, reason: "arrival_confirmed" };
  const lastLocationAt = input.riderLastLocationAt ? new Date(input.riderLastLocationAt).getTime() : Number.NaN;
  const now = (input.now || new Date()).getTime();
  const maxLocationAgeMs = input.maxLocationAgeMs ?? 90_000;
  if (!Number.isFinite(lastLocationAt) || now - lastLocationAt > maxLocationAgeMs) {
    return { action: "reassign", distanceMeters: null, reason: "outside_partner_radius_or_missing_gps" };
  }
  const distanceMeters = pointDistanceMeters(input.riderLocation, input.partnerLocation);
  if (distanceMeters != null && distanceMeters <= input.arrivalRadiusMeters) {
    return { action: "mark_arrived", distanceMeters, reason: "gps_within_partner_radius" };
  }
  return { action: "reassign", distanceMeters, reason: "outside_partner_radius_or_missing_gps" };
}
