import assert from "node:assert/strict";
import test from "node:test";
import { riderSlotHasEnded, riderSlotIsCurrent } from "./riderSchedulePolicy.js";

const overnight = { date: "2026-11-10", startTime: "20:00", endTime: "02:00" };
const clock = (date: string, time: string) => ({ date, time });

test("overnight interval: only the evening of its own date and the following morning", () => {
  assert.equal(riderSlotIsCurrent(overnight, clock("2026-11-10", "00:30")), false);
  assert.equal(riderSlotHasEnded(overnight, clock("2026-11-10", "00:30")), false);
  assert.equal(riderSlotIsCurrent(overnight, clock("2026-11-10", "20:00")), true);
  assert.equal(riderSlotIsCurrent(overnight, clock("2026-11-11", "00:30")), true);
  assert.equal(riderSlotHasEnded(overnight, clock("2026-11-11", "00:30")), false);
  assert.equal(riderSlotIsCurrent(overnight, clock("2026-11-11", "02:00")), false);
  assert.equal(riderSlotHasEnded(overnight, clock("2026-11-11", "02:00")), true);
  assert.equal(riderSlotIsCurrent(overnight, clock("2026-11-11", "20:30")), false);
  assert.equal(riderSlotIsCurrent(overnight, clock("2026-11-12", "00:30")), false);
});

test("midnight is an exclusive end, never a full extra day", () => {
  const slot = { date: "2026-11-10", startTime: "20:00", endTime: "00:00" };
  assert.equal(riderSlotIsCurrent(slot, clock("2026-11-10", "23:59")), true);
  assert.equal(riderSlotIsCurrent(slot, clock("2026-11-11", "00:00")), false);
  assert.equal(riderSlotHasEnded(slot, clock("2026-11-11", "00:00")), true);
});

test("same-day future slots are not expired; starts inclusive and ends exclusive", () => {
  const slot = { date: "2026-11-11", startTime: "12:00", endTime: "14:00" };
  assert.equal(riderSlotIsCurrent(slot, clock(slot.date, "11:59")), false);
  assert.equal(riderSlotHasEnded(slot, clock(slot.date, "11:59")), false);
  assert.equal(riderSlotIsCurrent(slot, clock(slot.date, "12:00")), true);
  assert.equal(riderSlotIsCurrent(slot, clock(slot.date, "14:00")), false);
  assert.equal(riderSlotHasEnded(slot, clock(slot.date, "14:00")), true);
  assert.equal(riderSlotIsCurrent(slot, clock("2026-11-10", "13:00")), false);
});

test("month/year rollover and invalid equal clocks fail closed", () => {
  const slot = { date: "2026-12-31", startTime: "20:00", endTime: "02:00" };
  assert.equal(riderSlotIsCurrent(slot, clock("2027-01-01", "01:59")), true);
  assert.equal(riderSlotHasEnded(slot, clock("2027-01-01", "02:00")), true);
  assert.equal(riderSlotIsCurrent({ ...slot, endTime: "20:00" }, clock(slot.date, "21:00")), false);
});
