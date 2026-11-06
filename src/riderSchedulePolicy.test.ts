import assert from "node:assert/strict";
import test from "node:test";
import { assignedScheduleFields, expandWeeklySchedule, isValidScheduleWindow, nextScheduleRevision } from "./riderSchedulePolicy.js";

test("expande de forma determinista una semana completa de lunes a domingo", () => {
  assert.deepEqual(expandWeeklySchedule("2026-11-02", [0, 1, 2, 3, 4, 5, 6]), [
    "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08",
  ]);
});

test("el horario nocturno 12:00–00:00 es válido y el horario idéntico no lo es", () => {
  assert.equal(isValidScheduleWindow("12:00", "00:00"), true);
  assert.equal(isValidScheduleWindow("12:00", "12:00"), false);
});

test("los campos persistidos de asignación no incluyen el estado operativo enviado por el cliente", () => {
  assert.deepEqual(assignedScheduleFields({ date: "2026-11-02", startTime: "12:00", endTime: "00:00", zoneSlug: "xativa", notes: "Turno fijo" }), {
    date: "2026-11-02", startTime: "12:00", endTime: "00:00", zoneSlug: "xativa", notes: "Turno fijo",
  });
});

test("cada cambio de horario incrementa la revisión y nunca vuelve atrás", () => {
  assert.equal(nextScheduleRevision(undefined), 1);
  assert.equal(nextScheduleRevision(1), 2);
  assert.equal(nextScheduleRevision(8), 9);
  assert.equal(nextScheduleRevision(0), 1);
});
