export const RIDER_OFFER_RETRY_COOLDOWN_MS = 15 * 60_000;

export type RiderOfferAttempt = {
  riderId?: unknown;
  outcome?: unknown;
  createdAt?: Date | string | number | null;
};

/**
 * Riders whose offer for the same order expired recently are temporarily
 * excluded from the next dispatch pass, so the same stale offer is not pushed
 * straight back to the rider who just missed it.
 */
export function recentlyExpiredOfferRiderIds(
  attempts: RiderOfferAttempt[],
  now = Date.now(),
  cooldownMs = RIDER_OFFER_RETRY_COOLDOWN_MS,
): Set<string> {
  const cutoff = now - cooldownMs;
  const ids = new Set<string>();
  for (const attempt of attempts) {
    if (attempt.outcome !== "expired" && attempt.outcome !== "rejected") continue;
    const riderId = attempt.riderId == null ? "" : String(attempt.riderId).trim();
    const createdAt = attempt.createdAt instanceof Date ? attempt.createdAt.getTime() : new Date(attempt.createdAt ?? Number.NaN).getTime();
    if (riderId && Number.isFinite(createdAt) && createdAt >= cutoff && createdAt <= now) ids.add(riderId);
  }
  return ids;
}
