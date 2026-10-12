import test from "node:test";
import assert from "node:assert/strict";
import { effectiveRiderStatus, isSlotCurrent, selectCurrentSlot, slotContainsTime, type RiderSlotLike } from "./shiftPolicy.js";

const base = (overrides: Partial<RiderSlotLike> = {}): RiderSlotLike => ({ date: "2026-10-02", startTime: "09:00", endTime: "17:00", status: "planned", ...overrides });
const now = { date: "2026-10-02", time: "10:30" };
const previous = "2026-10-01";

test("integration contract: a planned slot inside its time window is eligible", () => {
  const slot = base();
  assert.equal(isSlotCurrent(slot, now, previous), true);
  assert.equal(selectCurrentSlot([slot], now, previous), slot);
});

test("integration contract: no slot means no jornada eligibility", () => {
  assert.equal(selectCurrentSlot([], now, previous), null);
  assert.equal(selectCurrentSlot([base({ date: "2026-10-01" })], now, previous), null);
  assert.equal(selectCurrentSlot([base({ status: "completed" })], now, previous), null);
});

test("integration contract: start and end boundaries are safe", () => {
  const slot = base();
  assert.equal(slotContainsTime(slot, "09:00"), true);
  assert.equal(slotContainsTime(slot, "17:00"), false);
  assert.equal(isSlotCurrent(slot, { date: now.date, time: "17:00" }, previous), false);
});

test("integration contract: overnight slots only continue from the previous calendar date", () => {
  const overnight = base({ date: previous, startTime: "22:00", endTime: "06:00" });
  assert.equal(isSlotCurrent(overnight, { date: now.date, time: "02:00" }, previous), true);
  assert.equal(isSlotCurrent(overnight, { date: now.date, time: "10:30" }, previous), false);
  assert.equal(isSlotCurrent(base({ startTime: "22:00", endTime: "06:00" }), { date: now.date, time: "02:00" }, previous), true);
});

test("integration contract: active slot preserves availability; missing slot forces offline", () => {
  assert.equal(effectiveRiderStatus({ riderStatus: "available", hasActiveOrder: false, slotStatus: "active" }), "available");
  assert.equal(effectiveRiderStatus({ riderStatus: "paused", hasActiveOrder: false, slotStatus: "planned" }), "offline");
  assert.equal(effectiveRiderStatus({ riderStatus: "offline", hasActiveOrder: true, slotStatus: null }), "busy");
});
