import assert from "node:assert/strict";
import test from "node:test";
import { decideShiftConnectionAction, isDispatchShielded, madridLocalToUtc, RIDER_SHIFT_POLICY } from "./riderShiftAutomation.js";

const start = madridLocalToUtc("2026-10-16", "18:00");
const end = madridLocalToUtc("2026-10-16", "22:00");

test("envía el recordatorio 15 minutos antes y no antes", () => {
  assert.equal(decideShiftConnectionAction({ now: new Date(start.getTime() - RIDER_SHIFT_POLICY.reminderBeforeMs), scheduledStart: start, scheduledEnd: end, status: "planned", connected: false }), "reminder_due");
  assert.equal(decideShiftConnectionAction({ now: new Date(start.getTime() - RIDER_SHIFT_POLICY.reminderBeforeMs - 1), scheduledStart: start, scheduledEnd: end, status: "planned", connected: false }), "before_shift");
});

test("advierte a los 5 minutos y revoca a los 15 solo si sigue desconectado", () => {
  assert.equal(decideShiftConnectionAction({ now: new Date(start.getTime() + 5 * 60_000), scheduledStart: start, scheduledEnd: end, status: "planned", connected: false }), "warning_due");
  assert.equal(decideShiftConnectionAction({ now: new Date(start.getTime() + 15 * 60_000), scheduledStart: start, scheduledEnd: end, status: "planned", connected: false }), "revoke_due");
  assert.equal(decideShiftConnectionAction({ now: new Date(start.getTime() + 20 * 60_000), scheduledStart: start, scheduledEnd: end, status: "active", connected: true }), "within_grace");
});

test("protege los últimos 2 minutos del turno frente a nuevas asignaciones", () => {
  assert.equal(isDispatchShielded(new Date(end.getTime() - 2 * 60_000), { date: "2026-10-16", startTime: "18:00", endTime: "22:00", status: "active" }), true);
  assert.equal(isDispatchShielded(new Date(end.getTime() - 2 * 60_000 - 1), { date: "2026-10-16", startTime: "18:00", endTime: "22:00", status: "active" }), false);
  assert.equal(isDispatchShielded(new Date(end.getTime() - 60_000), { date: "2026-10-16", startTime: "18:00", endTime: "22:00", status: "completed" }), false);
});

test("completa un slot después de su hora de fin", () => {
  assert.equal(decideShiftConnectionAction({ now: new Date(end.getTime() + 1), scheduledStart: start, scheduledEnd: end, status: "active", connected: true }), "after_shift");
});
