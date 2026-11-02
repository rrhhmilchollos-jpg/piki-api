import assert from "node:assert/strict";
import test from "node:test";
import { planSweep, isReleasable } from "./shiftSweep.js";

const plan = { riderId: "r1", weeklyHours: 10 as const, timezoneOffsetMinutes: 60, shifts: [{ weekday: 1, start: "12:00", end: "16:00" }] };

test("al acabar el tramo se le corta y se libera su pedido", () => {
  const r = planSweep({
    now: new Date("2026-11-02T17:00:00Z"),
    riders: [{ riderId: "r1", plan, workedMinutesThisWeek: 0 }],
    orders: [{ orderId: "o1", publicCode: "PIKI-1", riderId: "r1", status: "assigned", assignedMinutes: 5 }],
  });
  assert.equal(r.loggedOut, 1);
  assert.equal(r.released, 1);
  assert.equal(r.actions[1].kind, "release_order");
});

test("en jornada no se toca nada", () => {
  const r = planSweep({
    now: new Date("2026-11-02T12:30:00Z"),
    riders: [{ riderId: "r1", plan, workedMinutesThisWeek: 0 }],
    orders: [{ orderId: "o1", publicCode: "PIKI-1", riderId: "r1", status: "assigned", assignedMinutes: 10 }],
  });
  assert.equal(r.loggedOut, 0);
  assert.equal(r.released, 0);
});

test("un pedido abandonado se libera aunque el rider siga en jornada", () => {
  const r = planSweep({
    now: new Date("2026-11-02T12:30:00Z"),
    riders: [{ riderId: "r1", plan, workedMinutesThisWeek: 0 }],
    orders: [{ orderId: "o1", publicCode: "PIKI-9", riderId: "r1", status: "assigned", assignedMinutes: 120 }],
  });
  assert.equal(r.released, 1);
  assert.equal((r.actions[0] as any).reason, "pedido_abandonado");
});

test("solo se reasignan estados seguros", () => {
  assert.equal(isReleasable("assigned"), true);
  assert.equal(isReleasable("on_the_way"), false);
  assert.equal(isReleasable("delivered"), false);
});
