import assert from "node:assert/strict";
import test from "node:test";
import { recentlyExpiredOfferRiderIds, RIDER_OFFER_RETRY_COOLDOWN_MS } from "./riderOfferRetryPolicy.js";

test("excludes a rider whose offer expired within the cooldown", () => {
  const now = Date.now();
  const excluded = recentlyExpiredOfferRiderIds([
    { riderId: "rider-1", outcome: "expired", createdAt: new Date(now - 1_000) },
    { riderId: "rider-2", outcome: "accepted", createdAt: new Date(now - 1_000) },
  ], now);
  assert.deepEqual([...excluded], ["rider-1"]);
});

test("does not exclude old, future, or malformed attempts", () => {
  const now = Date.now();
  const excluded = recentlyExpiredOfferRiderIds([
    { riderId: "old", outcome: "expired", createdAt: new Date(now - RIDER_OFFER_RETRY_COOLDOWN_MS - 1) },
    { riderId: "future", outcome: "expired", createdAt: new Date(now + 1_000) },
    { riderId: "bad", outcome: "expired", createdAt: "not-a-date" },
  ], now);
  assert.equal(excluded.size, 0);
});
