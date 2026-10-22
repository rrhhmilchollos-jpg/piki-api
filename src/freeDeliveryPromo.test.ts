import assert from "node:assert/strict";
import test from "node:test";
import { claimFreeDeliveryPromotion, FREE_DELIVERY_LAUNCH_LIMIT, type FreeDeliveryPromotionClaim, type FreeDeliveryPromotionState, type FreeDeliveryPromotionStore } from "./freeDeliveryPromo.js";

class MemoryPromotionStore implements FreeDeliveryPromotionStore {
  private states = new Map<string, FreeDeliveryPromotionState>();
  private claims = new Map<string, FreeDeliveryPromotionClaim>();

  private key(restaurantId: string, publicCode: string) { return `${restaurantId}:${publicCode}`; }

  async findClaim(restaurantId: string, publicCode: string) {
    return this.claims.get(this.key(restaurantId, publicCode)) || null;
  }

  async ensureState(restaurantId: string, legacyUsedSlots: number, limit: number) {
    const existing = this.states.get(restaurantId);
    if (existing) return { ...existing };
    const state = { usedSlots: Math.min(limit, legacyUsedSlots) };
    this.states.set(restaurantId, state);
    return { ...state };
  }

  async getState(restaurantId: string) {
    const state = this.states.get(restaurantId);
    return state ? { ...state } : null;
  }

  async incrementIfBelowLimit(restaurantId: string, limit: number) {
    const state = this.states.get(restaurantId);
    if (!state || state.usedSlots >= limit) return null;
    state.usedSlots += 1;
    return { ...state };
  }

  async insertClaim(claim: FreeDeliveryPromotionClaim) {
    const key = this.key(claim.restaurantId, claim.publicCode);
    if (this.claims.has(key)) {
      const duplicate: any = new Error("duplicate claim");
      duplicate.code = 11000;
      throw duplicate;
    }
    this.claims.set(key, { ...claim });
  }
}

test("el claim atómico simulado nunca concede más de 30 promociones concurrentes", async () => {
  const store = new MemoryPromotionStore();
  const results = await Promise.all(Array.from({ length: FREE_DELIVERY_LAUNCH_LIMIT + 7 }, (_, index) =>
    claimFreeDeliveryPromotion({ restaurantId: "partner-a", publicCode: `ORDER-${index}`, legacyUsedSlots: 0, store }),
  ));
  const awarded = results.filter((result) => result.eligible);
  assert.equal(awarded.length, FREE_DELIVERY_LAUNCH_LIMIT);
  assert.deepEqual(awarded.map((result) => result.slot).sort((a, b) => Number(a) - Number(b)), Array.from({ length: FREE_DELIVERY_LAUNCH_LIMIT }, (_, index) => index + 1));
  assert.equal(results.filter((result) => !result.eligible).length, 7);
});

test("un reintento del mismo pedido es idempotente y no consume un segundo cupo", async () => {
  const store = new MemoryPromotionStore();
  const first = await claimFreeDeliveryPromotion({ restaurantId: "partner-a", publicCode: "ORDER-1", legacyUsedSlots: 0, store });
  const retry = await claimFreeDeliveryPromotion({ restaurantId: "partner-a", publicCode: "ORDER-1", legacyUsedSlots: 0, store });
  const next = await claimFreeDeliveryPromotion({ restaurantId: "partner-a", publicCode: "ORDER-2", legacyUsedSlots: 0, store });
  assert.deepEqual({ slot: first.slot, idempotent: first.idempotent }, { slot: 1, idempotent: false });
  assert.deepEqual({ slot: retry.slot, idempotent: retry.idempotent }, { slot: 1, idempotent: true });
  assert.equal(next.slot, 2);
});

test("los pedidos históricos ocupan la base del cupo antes del primer claim", async () => {
  const store = new MemoryPromotionStore();
  const final = await claimFreeDeliveryPromotion({ restaurantId: "partner-a", publicCode: "ORDER-30", legacyUsedSlots: 29, store });
  const exhausted = await claimFreeDeliveryPromotion({ restaurantId: "partner-a", publicCode: "ORDER-31", legacyUsedSlots: 29, store });
  assert.deepEqual(final, { eligible: true, remaining: 0, slot: 30, idempotent: false });
  assert.deepEqual(exhausted, { eligible: false, remaining: 0, slot: null, idempotent: false });
});
