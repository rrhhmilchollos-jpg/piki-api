import assert from "node:assert/strict";
import test from "node:test";
import { operationsClock, validateShiftPlan, weekStart, workedMinutesFromSlots } from "./shiftPlans.js";

test("el contrato solo admite 10, 20, 30 o 40 horas", () => {
  const result = validateShiftPlan({ weeklyHours: 25, shifts: [{ weekday: 1, start: "10:00", end: "14:00" }] });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "CONTRACT_HOURS_INVALID");
});

test("un plan que excede las horas firmadas se rechaza", () => {
  const result = validateShiftPlan({
    weeklyHours: 10,
    shifts: [
      { weekday: 1, start: "08:00", end: "18:00" },
      { weekday: 2, start: "08:00", end: "12:00" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "PLAN_EXCEEDS_CONTRACT");
});

test("los tramos solapados del mismo día se rechazan", () => {
  const result = validateShiftPlan({
    weeklyHours: 20,
    shifts: [
      { weekday: 3, start: "10:00", end: "14:00" },
      { weekday: 3, start: "13:00", end: "16:00" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "SHIFT_OVERLAP");
});

test("un plan válido se acepta y calcula los minutos planificados", () => {
  const result = validateShiftPlan({
    weeklyHours: 20,
    shifts: [
      { weekday: 1, start: "12:00", end: "16:00" },
      { weekday: 2, start: "12:00", end: "16:00" },
      { weekday: 3, start: "18:00", end: "22:00" },
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plannedMinutes, 12 * 60);
});

test("una hora mal escrita invalida el tramo", () => {
  const result = validateShiftPlan({ weeklyHours: 10, shifts: [{ weekday: 1, start: "25:00", end: "14:00" }] });
  assert.equal(result.ok, false);
});

test("la semana de convenio empieza en lunes", () => {
  assert.equal(weekStart("2026-11-02"), "2026-11-02");
  assert.equal(weekStart("2026-11-08"), "2026-11-02");
  assert.equal(weekStart("2026-11-09"), "2026-11-09");
});

test("el reloj de operaciones usa la hora de Madrid", () => {
  const clock = operationsClock(new Date("2026-11-02T11:30:00Z"));
  assert.equal(clock.date, "2026-11-02");
  assert.equal(clock.time, "12:30");
  assert.equal(clock.minutes, 750);
  assert.equal(clock.weekday, 1);
});

test("las horas trabajadas suman solo los turnos iniciados de esta semana", () => {
  const now = new Date("2026-11-04T15:00:00Z"); // miércoles 16:00 en Madrid
  const worked = workedMinutesFromSlots(
    [
      { riderId: "r1", date: "2026-11-02", startTime: "12:00", endTime: "16:00", status: "completed" },
      { riderId: "r1", date: "2026-11-04", startTime: "12:00", endTime: "18:00", status: "active" },
      { riderId: "r1", date: "2026-11-04", startTime: "19:00", endTime: "22:00", status: "planned" },
      { riderId: "r1", date: "2026-10-26", startTime: "12:00", endTime: "16:00", status: "completed" },
    ],
    now,
    "r1",
  );
  // 4 h del lunes + 4 h transcurridas del turno abierto; el planificado y la
  // semana anterior no cuentan.
  assert.equal(worked, 8 * 60);
});

test("un turno abierto olvidado no supera su propia franja", () => {
  const now = new Date("2026-11-04T23:00:00Z"); // 00:00 del jueves en Madrid
  const worked = workedMinutesFromSlots(
    [{ riderId: "r1", date: "2026-11-04", startTime: "12:00", endTime: "18:00", status: "active" }],
    now,
    "r1",
  );
  assert.equal(worked, 6 * 60);
});

test("un turno cerrado por el barrido cuenta hasta la hora del corte", () => {
  const now = new Date("2026-11-02T16:30:00Z"); // lunes 17:30 Madrid
  const worked = workedMinutesFromSlots(
    [{ riderId: "r1", date: "2026-11-02", startTime: "12:00", endTime: "20:00", status: "completed", stoppedAt: "2026-11-02T16:00:00Z" }],
    now,
    "r1",
  );
  assert.equal(worked, 5 * 60);
});

test("los turnos de otro rider no contaminan el cómputo", () => {
  const now = new Date("2026-11-02T16:00:00Z");
  const worked = workedMinutesFromSlots(
    [
      { riderId: "r1", date: "2026-11-02", startTime: "12:00", endTime: "15:00", status: "completed" },
      { riderId: "r2", date: "2026-11-02", startTime: "12:00", endTime: "18:00", status: "completed" },
    ],
    now,
    "r1",
  );
  assert.equal(worked, 3 * 60);
});
