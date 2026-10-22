export const FREE_DELIVERY_LAUNCH_LIMIT = 30;

export type FreeDeliveryPromotionClaim = {
  restaurantId: string;
  publicCode: string;
  slot: number;
};

export type FreeDeliveryPromotionState = {
  usedSlots: number;
};

/**
 * All operations must run in the same database transaction when used with a
 * database-backed store. This module deliberately has no Mongo dependency so
 * the allocation policy can be unit-tested with an in-memory mock.
 */
export type FreeDeliveryPromotionStore = {
  findClaim(restaurantId: string, publicCode: string): Promise<FreeDeliveryPromotionClaim | null>;
  ensureState(restaurantId: string, legacyUsedSlots: number, limit: number): Promise<FreeDeliveryPromotionState>;
  getState(restaurantId: string): Promise<FreeDeliveryPromotionState | null>;
  incrementIfBelowLimit(restaurantId: string, limit: number): Promise<FreeDeliveryPromotionState | null>;
  insertClaim(claim: FreeDeliveryPromotionClaim): Promise<void>;
};

export type FreeDeliveryPromotionResult = {
  eligible: boolean;
  remaining: number;
  slot: number | null;
  idempotent: boolean;
};

function remainingSlots(state: FreeDeliveryPromotionState | null, claim: FreeDeliveryPromotionClaim, limit: number) {
  return Math.max(0, limit - Math.max(Number(state?.usedSlots || 0), claim.slot));
}

/**
 * Claims one of the fixed promotion slots. The backing store must make the
 * increment conditional (`usedSlots < limit`) and protect a claim by the
 * unique `(restaurantId, publicCode)` key. Therefore a retry for the same
 * order does not consume a second slot and concurrent different orders can
 * never obtain a slot above the limit.
 */
export async function claimFreeDeliveryPromotion(input: {
  restaurantId: string;
  publicCode: string;
  legacyUsedSlots: number;
  store: FreeDeliveryPromotionStore;
  limit?: number;
}): Promise<FreeDeliveryPromotionResult> {
  const limit = input.limit ?? FREE_DELIVERY_LAUNCH_LIMIT;
  const prior = await input.store.findClaim(input.restaurantId, input.publicCode);
  if (prior) {
    const state = await input.store.getState(input.restaurantId);
    return { eligible: true, remaining: remainingSlots(state, prior, limit), slot: prior.slot, idempotent: true };
  }

  const initialized = await input.store.ensureState(input.restaurantId, Math.max(0, Math.floor(input.legacyUsedSlots)), limit);
  if (initialized.usedSlots >= limit) return { eligible: false, remaining: 0, slot: null, idempotent: false };

  const updated = await input.store.incrementIfBelowLimit(input.restaurantId, limit);
  if (!updated) return { eligible: false, remaining: 0, slot: null, idempotent: false };

  const claim = { restaurantId: input.restaurantId, publicCode: input.publicCode, slot: updated.usedSlots };
  try {
    await input.store.insertClaim(claim);
    return { eligible: true, remaining: Math.max(0, limit - updated.usedSlots), slot: claim.slot, idempotent: false };
  } catch (error: any) {
    // A concurrent retry of this public code can win after the first lookup.
    // In production this is inside a transaction, so a non-matching error
    // aborts the increment rather than silently leaking a promotion slot.
    if (error?.code === 11000) {
      const concurrent = await input.store.findClaim(input.restaurantId, input.publicCode);
      if (concurrent) {
        const state = await input.store.getState(input.restaurantId);
        return { eligible: true, remaining: remainingSlots(state, concurrent, limit), slot: concurrent.slot, idempotent: true };
      }
    }
    throw error;
  }
}
