import assert from "node:assert/strict";
import test from "node:test";
import { evaluateShift, isValidPlan, planFitsContract, plannedMinutes } from "./shiftEnforcement.js";

const plan = {
  riderId: "r1",
  weeklyHours: 20 as const,
  timezoneOffsetMinutes: 60,
  shifts: [
    { weekday: 1, start: "12:00", end: "16:00" },
    { weekday: 3, start: "12:00", end: "16:00" },
  ],
};

test("acepta contratos de 10, 20, 30 y 40 horas", () => {
  for (const horas of [10, 20, 30, 40] as const) {
    assert.equal(isValidPlan({ ...plan, weeklyHours: horas }), true);
  }
  assert.equal(isValidPlan({ ...plan, weeklyHours: 25 as any }), false);
});

test("un plan no puede superar las horas contratadas", () => {
  const abusivo = { ...plan, weeklyHours: 10 as const, shifts: [...plan.shifts, { weekday: 5, start: "12:00", end: "16:00" }] };
  assert.equal(plannedMinutes(abusivo), 720);
  assert.equal(planFitsContract(abusivo), false);
});

test("dentro del tramo puede estar en linea", () => {
  const lunes = new Date("2026-11-02T12:30:00Z");
  const d = evaluateShift(plan, 0, lunes);
  assert.equal(d.onlineAllowed, true);
  assert.equal(d.reason, "dentro_de_jornada");
  assert.equal(d.currentShiftEndsAt, "16:00");
});

test("fuera del tramo queda en linea pero sin permiso de conexion", () => {
  const lunes = new Date("2026-11-02T09:00:00Z");
  const d = evaluateShift(plan, 0, lunes);
  assert.equal(d.onlineAllowed, false);
  assert.equal(d.reason, "fuera_de_tramo");
  assert.ok(d.nextShiftStartsAt?.includes("12:00"));
});

test("al agotar las horas contratadas se le corta aunque este en tramo", () => {
  const lunes = new Date("2026-11-02T12:30:00Z");
  const d = evaluateShift(plan, 20 * 60, lunes);
  assert.equal(d.onlineAllowed, false);
  assert.equal(d.reason, "jornada_completa");
});

test("los minutos restantes nunca superan lo que queda de tramo", () => {
  const lunes = new Date("2026-11-02T14:30:00Z");
  const d = evaluateShift(plan, 0, lunes);
  assert.equal(d.minutesRemaining, 30);
});
