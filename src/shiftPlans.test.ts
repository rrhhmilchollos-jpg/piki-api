import assert from "node:assert/strict";
import test from "node:test";
import { buildScopedRiderOwnershipFilter, buildScopedShiftSweepOrderFilter, buildShiftSweepRiderFilter, normalizeShiftSweepRunErrors, operationsClock, shiftPlanForSweep, ShiftSweepRun, validateShiftPlan, weekStart, workedMinutesFromSlots, type WorkedSlot } from "./shiftPlans.js";
import { isStaleInRoute, planSweep } from "./shiftSweep.js";

test("el historial de barridos evita la ruta reservada y conserva errores históricos", () => {
  assert.ok(ShiftSweepRun.schema.path("errorMessages"));
  assert.equal(ShiftSweepRun.schema.path("errors"), undefined);
  assert.ok(ShiftSweepRun.schema.path("tenantId"));
  assert.ok(ShiftSweepRun.schema.path("fleetId"));
  assert.deepEqual(normalizeShiftSweepRunErrors({ errorMessages: ["nuevo"] }), ["nuevo"]);
  assert.deepEqual(normalizeShiftSweepRunErrors({ errors: ["histórico"] }), ["histórico"]);
});

test("el barrido global solo se representa con scope omitido y una flota vacía no coincide con nadie", () => {
  const riderId = "507f1f77bcf86cd799439011";
  assert.deepEqual(buildShiftSweepRiderFilter(), {});
  assert.deepEqual(buildShiftSweepRiderFilter([]), { riderId: { $in: [] } });
  assert.deepEqual(buildShiftSweepRiderFilter([riderId, riderId, "no-es-id"]), { riderId: { $in: [riderId] } });
});

test("el corte y liberación scoped comparan tenant/flota actuales y fallan cerrados", () => {
  const riderId = "507f1f77bcf86cd799439011";
  const tenantId = "507f1f77bcf86cd799439012";
  const fleetId = "507f1f77bcf86cd799439013";
  const riderFilter = buildScopedRiderOwnershipFilter({ riderId, tenantId, fleetId });
  assert.equal(String(riderFilter?._id), riderId);
  assert.equal(String(riderFilter?.tenantId), tenantId);
  assert.equal(String(riderFilter?.fleetId), fleetId);
  assert.equal(buildScopedRiderOwnershipFilter({ riderId, fleetId }), null);
  assert.equal(buildScopedRiderOwnershipFilter({ riderId: "bad-id", tenantId, fleetId }), null);

  const orderFilter = buildScopedShiftSweepOrderFilter({ orderId: riderId, riderId, tenantId, statuses: ["assigned"] });
  assert.equal(String(orderFilter?.tenantId), tenantId);
  assert.deepEqual(orderFilter?.status, { $in: ["assigned"] });
  assert.equal(buildScopedShiftSweepOrderFilter({ orderId: riderId, riderId, tenantId: "bad-id", statuses: ["assigned"] }), null);
});

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

test("permite finalizar a medianoche y cuenta 12:00–00:00 como doce horas", () => {
  const result = validateShiftPlan({
    weeklyHours: 20,
    shifts: [{ weekday: 1, start: "12:00", end: "00:00" }],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.plannedMinutes, 12 * 60);
});

test("un turno que continúa pasada medianoche sigue siendo inválido", () => {
  const result = validateShiftPlan({
    weeklyHours: 20,
    shifts: [{ weekday: 1, start: "20:00", end: "02:00" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "SHIFT_TIME_RANGE_INVALID");
});

test("el turno que termina a medianoche solapa con otro tramo tardío", () => {
  const result = validateShiftPlan({
    weeklyHours: 20,
    shifts: [
      { weekday: 1, start: "12:00", end: "00:00" },
      { weekday: 1, start: "23:00", end: "23:30" },
    ],
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error, "SHIFT_OVERLAP");
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

test("un pedido recogido hace diez horas se da por abandonado", () => {
  const now = new Date("2026-11-02T05:11:00Z");
  assert.equal(isStaleInRoute({ status: "on_the_way", riderArrivedAt: "2026-11-01T18:11:00Z" }, now), true);
});

test("un pedido que acaba de salir del local no se toca", () => {
  const now = new Date("2026-11-02T05:11:00Z");
  assert.equal(isStaleInRoute({ status: "on_the_way", riderArrivedAt: "2026-11-02T05:00:00Z" }, now), false);
});

test("el pedido que aún no se ha recogido no entra por esta regla", () => {
  const now = new Date("2026-11-02T05:11:00Z");
  assert.equal(isStaleInRoute({ status: "ready_for_pickup", assignedAt: "2026-11-01T18:11:00Z" }, now), false);
});

test("stoppedAt histórico conserva 120 minutos hoy y mañana, no 720", () => {
  const slots = [{ riderId: "r1", date: "2026-11-02", startTime: "12:00", endTime: "00:00", status: "completed", stoppedAt: "2026-11-02T13:00:00Z" }];
  assert.equal(workedMinutesFromSlots(slots, new Date("2026-11-02T14:00:00Z")), 120);
  assert.equal(workedMinutesFromSlots(slots, new Date("2026-11-03T14:00:00Z")), 120);
  assert.equal(workedMinutesFromSlots(slots, new Date("2026-11-08T14:00:00Z")), 120);
});

test("inicio real a las 18:00 no cuenta desde las 12:00, activo y cerrado", () => {
  const slot = { riderId: "r1", date: "2026-11-02", startTime: "12:00", endTime: "00:00", status: "active", startedAt: "2026-11-02T17:00:00Z" };
  assert.equal(workedMinutesFromSlots([slot], new Date("2026-11-02T19:00:00Z")), 120);
  assert.equal(workedMinutesFromSlots([{ ...slot, status: "completed", stoppedAt: "2026-11-02T19:00:00Z" }], new Date("2026-11-03T13:00:00Z")), 120);
  assert.equal(workedMinutesFromSlots([{ ...slot, stoppedAt: "2026-11-02T19:00:00Z" }], new Date("2026-11-03T13:00:00Z")), 120);
});

test("caducidad natural con startedAt y sin stoppedAt termina a medianoche asignada", () => {
  for (const [date, startedAt, nextDay] of [
    ["2026-11-02", "2026-11-02T17:00:00Z", "2026-11-03T14:00:00Z"],
    ["2026-07-06", "2026-07-06T16:00:00Z", "2026-07-07T14:00:00Z"],
  ]) {
    for (const status of ["active", "completed"]) {
      assert.equal(workedMinutesFromSlots([{ riderId: "r1", date, startTime: "12:00", endTime: "00:00", status, startedAt }], new Date(nextDay)), 360);
    }
  }
});

test("fichajes se recortan a franja y ahora; futuros y no iniciados no suman", () => {
  const slot = { riderId: "r1", date: "2026-11-02", startTime: "12:00", endTime: "16:00", status: "completed", startedAt: "2026-11-02T09:00:00Z", stoppedAt: "2026-11-02T21:00:00Z" };
  assert.equal(workedMinutesFromSlots([slot], new Date("2026-11-02T12:00:00Z")), 60);
  assert.equal(workedMinutesFromSlots([slot], new Date("2026-11-03T12:00:00Z")), 240);
  assert.equal(workedMinutesFromSlots([{ ...slot, date: "2026-11-04" }], new Date("2026-11-03T12:00:00Z")), 0);
  assert.equal(workedMinutesFromSlots([{ ...slot, status: "planned" }, { ...slot, status: "cancelled" }], new Date("2026-11-03T12:00:00Z")), 0);
  assert.equal(workedMinutesFromSlots([{ ...slot, startedAt: "2026-11-02T16:00:00Z", stoppedAt: "2026-11-02T15:00:00Z" }], new Date("2026-11-03T12:00:00Z")), 0);
});

test("legacy sin startedAt conserva inicio programado y sin stop el fin asignado", () => {
  const slot = { riderId: "r1", date: "2026-11-02", startTime: "12:00", endTime: "00:00", status: "completed" };
  assert.equal(workedMinutesFromSlots([slot], new Date("2026-11-03T12:00:00Z")), 720);
});

test("intervalos nocturnos y el límite semanal se recortan por instantes reales", () => {
  const slot = { riderId: "r1", date: "2026-11-08", startTime: "20:00", endTime: "02:00", status: "completed", startedAt: "2026-11-08T19:00:00Z", stoppedAt: "2026-11-09T00:00:00Z" };
  assert.equal(workedMinutesFromSlots([slot], new Date("2026-11-08T22:59:00Z")), 239);
  assert.equal(workedMinutesFromSlots([slot], new Date("2026-11-09T12:00:00Z")), 60);
});

test("cambio DST cuenta tiempo transcurrido real, no minutos del reloj civil", () => {
  assert.equal(workedMinutesFromSlots([{ riderId: "r1", date: "2026-03-29", startTime: "00:00", endTime: "04:00", status: "completed" }], new Date("2026-03-29T12:00:00Z")), 180);
  assert.equal(workedMinutesFromSlots([{ riderId: "r1", date: "2026-10-25", startTime: "00:00", endTime: "04:00", status: "completed" }], new Date("2026-10-25T12:00:00Z")), 300);
});

const oldPlan = { riderId: "r1", weeklyHours: 10 as const, shifts: [{ weekday: 1, start: "12:00", end: "16:00" }] };
const currentSlot: WorkedSlot = { riderId: "r1", tenantId: "tenant-a", date: "2026-11-02", startTime: "12:00", endTime: "00:00", status: "active", startedAt: "2026-11-02T17:00:00Z" };
const sweepAt = new Date("2026-11-02T19:00:00Z");
function slotAwareSweep(slots: WorkedSlot[], worked = 120, plan = oldPlan) {
  return planSweep({ now: sweepAt, riders: [{ riderId: plan.riderId, plan: shiftPlanForSweep(plan, slots, sweepAt, "tenant-a"), workedMinutesThisWeek: worked }], orders: [{ orderId: "o1", publicCode: "PIKI-1", riderId: "r1", status: "assigned", assignedMinutes: 5 }] });
}

test("slot vigente 12–00 impide corte por plan antiguo 12–16", () => {
  for (const status of ["active", "planned"]) {
    const result = slotAwareSweep([{ ...currentSlot, status }]);
    assert.equal(result.loggedOut, 0);
    assert.equal(result.released, 0);
  }
});

test("slot no evita corte y liberación cuando se agota la cuota real", () => {
  const result = slotAwareSweep([currentSlot], 600);
  assert.equal(result.loggedOut, 1);
  assert.equal(result.released, 1);
  assert.equal(result.actions[0].reason, "jornada_completa");
});

test("sin slot vigente se conserva el corte del plan y no se usa otro tenant/rider", () => {
  for (const slots of [[], [{ ...currentSlot, status: "completed" }], [{ ...currentSlot, status: "cancelled" }], [{ ...currentSlot, riderId: "r2" }], [{ ...currentSlot, tenantId: "tenant-b" }], [{ ...currentSlot, date: "2026-11-03" }]]) {
    assert.equal(slotAwareSweep(slots).actions[0].reason, "fuera_de_tramo");
  }
});

test("slot vigente no valida un contrato inválido o sobreplanificado", () => {
  for (const plan of [{ ...oldPlan, shifts: [] }, { ...oldPlan, weeklyHours: 25 as any }, { ...oldPlan, shifts: [{ weekday: 1, start: "12:00", end: "00:00" }] }]) {
    assert.equal(slotAwareSweep([currentSlot], 0, plan).actions[0].reason, "plan_invalido");
  }
});

test("slot vigente sigue teniendo un fin exclusivo en invierno y verano", () => {
  for (const [date, beforeEnd, midnight] of [
    ["2026-11-02", "2026-11-02T22:59:00Z", "2026-11-02T23:00:00Z"],
    ["2026-07-06", "2026-07-06T21:59:00Z", "2026-07-06T22:00:00Z"],
  ]) {
    const slots = [{ ...currentSlot, date }];
    assert.notDeepEqual(shiftPlanForSweep(oldPlan, slots, new Date(beforeEnd)), oldPlan);
    assert.deepEqual(shiftPlanForSweep(oldPlan, slots, new Date(midnight)), oldPlan);
  }
});
