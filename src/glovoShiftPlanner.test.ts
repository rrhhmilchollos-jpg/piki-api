import assert from "node:assert/strict";
import test from "node:test";
import { MIN_REST_HOURS, blocksForWeeklyHours, fitsRest, planWeek, restHoursBetween, weekStartOf } from "./glovoShiftPlanner.js";
import { calculatePayroll, payrollGap, requiredDeductionRate } from "./payroll.js";

test("la semana empieza siempre en lunes", () => {
  assert.equal(weekStartOf("2026-11-04"), "2026-11-02");
  assert.equal(weekStartOf("2026-11-08"), "2026-11-02");
});

test("los bloques de cuatro horas cubren las horas contratadas", () => {
  assert.equal(blocksForWeeklyHours(10), 3);
  assert.equal(blocksForWeeklyHours(20), 5);
  assert.equal(blocksForWeeklyHours(30), 8);
  assert.equal(blocksForWeeklyHours(40), 10);
});

test("el contrato de 10 h reserva las noches del fin de semana", () => {
  const plan = planWeek(10, "2026-11-02");
  assert.deepEqual(plan.shifts.map((shift) => shift.date), ["2026-11-06", "2026-11-07", "2026-11-08"]);
  assert.ok(plan.shifts.every((shift) => shift.block === "night"));
});

test("el contrato de 20 h reparte cinco bloques alternando mediodía y noche", () => {
  const plan = planWeek(20, "2026-11-02");
  assert.equal(plan.shifts.length, 5);
  assert.deepEqual(plan.shifts.map((shift) => shift.block), ["midday", "night", "midday", "night", "midday"]);
});

test("el contrato de 40 h cubre mediodía y noche de lunes a viernes sin romper el descanso", () => {
  const plan = planWeek(40, "2026-11-02");
  assert.equal(plan.shifts.length, 10);
  assert.equal(plan.plannedHours, 40);
  assert.deepEqual(plan.restViolations, []);
});

test("el descanso entre la noche y el mediodía siguiente es de 12 horas", () => {
  const plan = planWeek(40, "2026-11-02");
  const night = plan.shifts.find((shift) => shift.date === "2026-11-02" && shift.block === "night");
  const midday = plan.shifts.find((shift) => shift.date === "2026-11-03" && shift.block === "midday");
  assert.ok(night && midday);
  assert.equal(restHoursBetween(night!, midday!), MIN_REST_HOURS);
});

test("un turno que no deja descanso suficiente se rechaza", () => {
  const plan = planWeek(40, "2026-11-02");
  const early = { date: "2026-11-03", block: "midday" as const, startTime: "08:00", endTime: "12:00", hours: 4 };
  // La noche del lunes termina a las 00:00 del martes: empezar a las 08:00 deja
  // solo 8 horas de descanso.
  const result = fitsRest(plan.shifts, early);
  assert.equal(result.ok, false);
  assert.equal(result.restHours, 8);
});

test("la nómina de 30 h aplica 6,47% de Seguridad Social y 2% de IRPF", () => {
  const payroll = calculatePayroll({ weeklyHours: 30 });
  assert.equal(payroll.monthlyGrossCents, 134_000);
  assert.equal(payroll.socialSecurityCents, 8_670);
  assert.equal(payroll.irpfCents, 2_680);
  assert.equal(payroll.netCents, 122_650);
  assert.equal(Math.round(payroll.effectiveDeductionRate * 100) / 100, 8.47);
});

test("las propinas van íntegras al rider", () => {
  const payroll = calculatePayroll({ weeklyHours: 30, tipsCents: 2_500 });
  assert.equal(payroll.netCents, 122_650);
  assert.equal(payroll.totalToRiderCents, 125_150);
});

test("para llegar a 1.180 € netos haría falta una retención mayor que la pactada", () => {
  const gap = payrollGap({ weeklyHours: 30 }, 118_000);
  assert.equal(gap.deltaCents, -4_650);
  assert.equal(Math.round(gap.requiredRate * 100) / 100, 11.94);
  assert.ok(requiredDeductionRate(134_000, 118_000) > 8.47);
});
