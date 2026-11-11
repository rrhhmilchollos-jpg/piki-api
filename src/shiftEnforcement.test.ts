import assert from "node:assert/strict";
import test from "node:test";
import { evaluateShift, isValidPlan, minutesSinceWeekStart, planFitsContract, plannedMinutes } from "./shiftEnforcement.js";

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

test("acepta y activa un turno nocturno 12:00–00:00", () => {
  const nocturno = { ...plan, shifts: [{ weekday: 6, start: "12:00", end: "00:00" }] };
  assert.equal(isValidPlan(nocturno), true);
  assert.equal(plannedMinutes(nocturno), 720);
  const saturday = new Date("2026-11-07T13:00:00Z"); // 14:00 en Madrid
  assert.equal(evaluateShift(nocturno, 0, saturday).onlineAllowed, true);
  const sundayMidnight = new Date("2026-11-07T23:00:00Z"); // domingo 00:00 en Madrid
  assert.equal(evaluateShift(nocturno, 0, sundayMidnight).onlineAllowed, false);
});

test("12:00–00:00 usa Madrid en invierno y verano, con fin exclusivo", () => {
  for (const [start, beforeEnd, end] of [
    ["2026-11-02T11:00:00Z", "2026-11-02T22:59:00Z", "2026-11-02T23:00:00Z"],
    ["2026-07-06T10:00:00Z", "2026-07-06T21:59:00Z", "2026-07-06T22:00:00Z"],
  ]) {
    const middayToMidnight = { ...plan, shifts: [{ weekday: 1, start: "12:00", end: "00:00" }] };
    assert.equal(evaluateShift(middayToMidnight, 0, new Date(start)).onlineAllowed, true);
    assert.equal(evaluateShift(middayToMidnight, 0, new Date(beforeEnd)).minutesRemaining, 1);
    assert.equal(evaluateShift(middayToMidnight, 0, new Date(end)).onlineAllowed, false);
    // El offset persistido, incluso obsoleto, no sustituye el reloj oficial.
    assert.equal(evaluateShift({ ...middayToMidnight, timezoneOffsetMinutes: -300 }, 0, new Date(start)).onlineAllowed, true);
  }
});

test("el inicio semanal es lunes 00:00 de Madrid también en verano", () => {
  assert.equal(minutesSinceWeekStart(new Date("2026-11-01T23:00:00Z")), 0);
  assert.equal(minutesSinceWeekStart(new Date("2026-07-05T22:00:00Z"), 60), 0);
  assert.equal(minutesSinceWeekStart(new Date("2026-07-05T21:59:00Z")), 10079);
});

test("los domingos de cambio horario no aplican un offset fijo", () => {
  const sunday = { ...plan, shifts: [{ weekday: 0, start: "12:00", end: "00:00" }] };
  assert.equal(evaluateShift(sunday, 0, new Date("2026-03-29T10:00:00Z")).onlineAllowed, true);
  assert.equal(evaluateShift(sunday, 0, new Date("2026-10-25T11:00:00Z")).onlineAllowed, true);
});
