/**
 * Contrato de jornada del rider: persistencia, cómputo de horas trabajadas y
 * corte real de la sesión.
 *
 * La flota fija en Fleet un contrato de 10, 20, 30 o 40 horas semanales y los
 * tramos de cada día. Este módulo guarda ese contrato en MongoDB, calcula las
 * horas realmente trabajadas en la semana en curso a partir de los turnos
 * iniciados y ejecuta el corte: el rider pasa a offline, pierde la sesión y sus
 * pedidos vuelven a la cola.
 */

import mongoose, { Schema } from "mongoose";
import { EmployeeAccount, Order, Rider, RiderSlot } from "./models.js";
import { revokeEmployeeSessions } from "./employeeSessions.js";
import { publishRealtimeEvent } from "./realtime.js";
import { dispatchRequeueIdempotencyKey, enqueueDispatchOutbox } from "./dispatchOutbox.js";
import {
  CONTRACT_HOURS,
  evaluateShift,
  isValidPlan,
  planFitsContract,
  plannedMinutes,
  type ContractHours,
  type RiderShiftPlan,
  type Shift,
  type ShiftDecision,
} from "./shiftEnforcement.js";
import { ABANDONED_AFTER_MINUTES, isReleasable, isStaleInRoute, planSweep, type AssignedOrder, type SweepAction } from "./shiftSweep.js";

/** Zona horaria de referencia del centro de operaciones de PIKI. */
export const OPERATIONS_TIME_ZONE = "Europe/Madrid";

function madridDateTime(now: Date): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: OPERATIONS_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).reduce<Record<string, string>>((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

async function notifyUpcomingRiderShiftStarts(now: Date): Promise<number> {
  const local = madridDateTime(now);
  const currentMinutes = Number(local.time.slice(0, 2)) * 60 + Number(local.time.slice(3, 5));
  const slots = await RiderSlot.find({ date: local.date, status: "planned" }).select("_id riderId tenantId startTime endTime").lean().exec() as any[];
  let notified = 0;
  for (const slot of slots) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(slot.startTime));
    if (!match) continue;
    const startMinutes = Number(match[1]) * 60 + Number(match[2]);
    const minutesUntilStart = startMinutes - currentMinutes;
    // The worker runs every five minutes. A small late window prevents a
    // reminder being lost if a run starts just after the scheduled minute.
    if (minutesUntilStart < -4 || minutesUntilStart > 5) continue;
    const event = await publishRealtimeEvent({
      channel: "rider",
      audienceKey: `rider:${String(slot.riderId)}`,
      tenantId: slot.tenantId || null,
      type: "rider.shift_start_reminder",
      payload: {
        riderId: String(slot.riderId),
        shiftId: String(slot._id),
        date: local.date,
        startTime: slot.startTime,
        endTime: slot.endTime,
        sound: "start_shift",
      },
      dedupeKey: `rider-shift-start:${String(slot.riderId)}:${local.date}:${slot.startTime}`,
    });
    if (event) notified += 1;
  }
  return notified;
}

const shiftSchema = new Schema(
  {
    weekday: { type: Number, required: true, min: 0, max: 6 },
    start: { type: String, required: true },
    end: { type: String, required: true },
  },
  { _id: false },
);

const shiftPlanSchema = new Schema(
  {
    riderId: { type: Schema.Types.ObjectId, ref: "Rider", required: true, unique: true, index: true },
    tenantId: { type: Schema.Types.ObjectId, default: null, index: true },
    weeklyHours: { type: Number, enum: [...CONTRACT_HOURS], required: true },
    shifts: { type: [shiftSchema], default: [] },
    timezoneOffsetMinutes: { type: Number, default: 60 },
    plannedMinutes: { type: Number, default: 0 },
    updatedBy: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", default: null },
    lastCutAt: { type: Date, default: null },
    lastCutReason: { type: String, default: "" },
  },
  { timestamps: true, collection: "rider_shift_plans" },
);

const sweepRunSchema = new Schema(
  {
    source: { type: String, enum: ["manual", "worker"], default: "manual" },
    actorId: { type: Schema.Types.ObjectId, default: null },
    dryRun: { type: Boolean, default: true },
    checked: { type: Number, default: 0 },
    loggedOut: { type: Number, default: 0 },
    released: { type: Number, default: 0 },
    errors: { type: [String], default: [] },
    actions: { type: [Schema.Types.Mixed], default: [] },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    durationMs: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "shift_sweep_runs" },
);
sweepRunSchema.index({ createdAt: -1 });

export const RiderShiftPlanModel =
  mongoose.models.RiderShiftPlan || mongoose.model("RiderShiftPlan", shiftPlanSchema);
export const ShiftSweepRun =
  mongoose.models.ShiftSweepRun || mongoose.model("ShiftSweepRun", sweepRunSchema);

export type StoredShiftPlan = {
  riderId: string;
  tenantId: string | null;
  weeklyHours: ContractHours;
  shifts: Shift[];
  timezoneOffsetMinutes: number;
  plannedMinutes: number;
};

/* ------------------------------------------------------------------ */
/* Calendario local                                                    */
/* ------------------------------------------------------------------ */

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: OPERATIONS_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  hourCycle: "h23",
});

/** Fecha, hora y minuto del día en el huso del centro de operaciones. */
export function operationsClock(instant = new Date()) {
  const parts = dateFormatter.formatToParts(instant);
  const values: Record<string, string> = {};
  for (const part of parts) if (part.type !== "literal") values[part.type] = part.value;
  const hour = values.hour === "24" ? "00" : values.hour;
  const date = `${values.year}-${values.month}-${values.day}`;
  return {
    date,
    time: `${hour}:${values.minute}`,
    minutes: Number(hour) * 60 + Number(values.minute),
    weekday: new Date(`${date}T12:00:00Z`).getUTCDay(),
  };
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Lunes de la semana de convenio a la que pertenece la fecha. */
export function weekStart(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  const fromMonday = (value.getUTCDay() + 6) % 7;
  return addDays(date, -fromMonday);
}

function toMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(hhmm || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export type WorkedSlot = {
  riderId: string;
  date: string;
  startTime: string;
  endTime: string;
  status: string;
  stoppedAt?: Date | string | null;
};

function slotDuration(start: number, end: number): number {
  return end > start ? end - start : end + 1440 - start;
}

/**
 * Horas trabajadas esta semana según los turnos realmente iniciados. No se
 * fía de lo que declare el rider: solo cuentan los turnos activos o cerrados,
 * y un turno activo cuenta hasta el minuto actual.
 */
export function workedMinutesFromSlots(
  slots: WorkedSlot[],
  now = new Date(),
  riderId?: string,
): number {
  const clock = operationsClock(now);
  const start = weekStart(clock.date);
  const end = addDays(start, 6);
  let total = 0;
  for (const slot of slots) {
    if (riderId && String(slot.riderId) !== riderId) continue;
    if (!slot.date || slot.date < start || slot.date > end) continue;
    if (!["active", "completed"].includes(String(slot.status))) continue;
    const slotStart = toMinutes(slot.startTime);
    const slotEnd = toMinutes(slot.endTime);
    if (slotStart === null || slotEnd === null) continue;
    const duration = slotDuration(slotStart, slotEnd);
    if (slot.status === "active") {
      // Un turno que sigue abierto cuenta lo transcurrido, nunca más que su
      // franja: un rider olvidado conectado no infla la nómina de la semana.
      total += slot.date === clock.date ? Math.max(0, Math.min(duration, clock.minutes - slotStart)) : duration;
      continue;
    }
    if (slot.stoppedAt && slot.date === clock.date) {
      const stopped = operationsClock(new Date(slot.stoppedAt)).minutes;
      total += Math.max(0, Math.min(duration, stopped - slotStart));
      continue;
    }
    total += duration;
  }
  return Math.round(total);
}

export async function computeWorkedMinutesThisWeek(
  riderIds: string[],
  now = new Date(),
): Promise<Map<string, number>> {
  const clock = operationsClock(now);
  const start = weekStart(clock.date);
  const end = addDays(start, 6);
  const oids = riderIds.filter((id) => mongoose.isValidObjectId(id)).map((id) => new mongoose.Types.ObjectId(id));
  const result = new Map<string, number>();
  if (!oids.length) return result;
  const slots = (await RiderSlot.find({
    riderId: { $in: oids },
    date: { $gte: start, $lte: end },
    status: { $in: ["active", "completed"] },
  })
    .select("riderId date startTime endTime status stoppedAt")
    .lean()
    .exec()) as any[];
  const grouped = new Map<string, WorkedSlot[]>();
  for (const slot of slots) {
    const key = String(slot.riderId);
    const list = grouped.get(key) ?? [];
    list.push({
      riderId: key,
      date: slot.date,
      startTime: slot.startTime,
      endTime: slot.endTime,
      status: slot.status,
      stoppedAt: slot.stoppedAt ?? null,
    });
    grouped.set(key, list);
  }
  for (const riderId of riderIds) {
    result.set(riderId, workedMinutesFromSlots(grouped.get(riderId) ?? [], now, riderId));
  }
  return result;
}

/* ------------------------------------------------------------------ */
/* Validación del contrato                                             */
/* ------------------------------------------------------------------ */

export type ShiftPlanInput = { weeklyHours: number; shifts: Array<{ weekday: number; start: string; end: string }> };

export type PlanValidation =
  | { ok: true; plan: RiderShiftPlan; plannedMinutes: number }
  | { ok: false; error: string; message: string };

const WEEKDAY_NAMES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/**
 * Un contrato se publica solo si cabe en las horas firmadas. Si la flota
 * asigna más horas de las contratadas, el exceso es ilegal: se rechaza.
 */
export function validateShiftPlan(input: ShiftPlanInput): PlanValidation {
  if (!CONTRACT_HOURS.includes(input.weeklyHours as ContractHours)) {
    return {
      ok: false,
      error: "CONTRACT_HOURS_INVALID",
      message: "El contrato debe ser de 10, 20, 30 o 40 horas semanales.",
    };
  }
  if (!Array.isArray(input.shifts) || input.shifts.length === 0) {
    return { ok: false, error: "SHIFTS_REQUIRED", message: "Añade al menos un tramo de jornada." };
  }
  if (input.shifts.length > 21) {
    return { ok: false, error: "SHIFTS_TOO_MANY", message: "No se pueden asignar más de 21 tramos por semana." };
  }
  const normalized: Shift[] = [];
  for (const shift of input.shifts) {
    const weekday = Number(shift.weekday);
    const start = toMinutes(shift.start);
    const end = toMinutes(shift.end);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { ok: false, error: "SHIFT_WEEKDAY_INVALID", message: "Cada tramo debe indicar un día de la semana válido." };
    }
    if (start === null || end === null) {
      return { ok: false, error: "SHIFT_TIME_INVALID", message: "Las horas de los tramos deben tener formato HH:MM." };
    }
    if (end <= start) {
      return {
        ok: false,
        error: "SHIFT_TIME_RANGE_INVALID",
        message: `El tramo del ${WEEKDAY_NAMES[weekday]} termina antes de empezar. Un tramo no puede cruzar la medianoche.`,
      };
    }
    normalized.push({ weekday, start: String(shift.start).trim(), end: String(shift.end).trim() });
  }

  const byDay = new Map<number, Shift[]>();
  for (const shift of normalized) {
    const list = byDay.get(shift.weekday) ?? [];
    list.push(shift);
    byDay.set(shift.weekday, list);
  }
  for (const [weekday, shifts] of byDay) {
    shifts.sort((a, b) => (toMinutes(a.start) ?? 0) - (toMinutes(b.start) ?? 0));
    for (let index = 1; index < shifts.length; index += 1) {
      const previous = shifts[index - 1];
      const current = shifts[index];
      if ((toMinutes(current.start) ?? 0) < (toMinutes(previous.end) ?? 0)) {
        return {
          ok: false,
          error: "SHIFT_OVERLAP",
          message: `Los tramos del ${WEEKDAY_NAMES[weekday]} se solapan (${previous.start}–${previous.end} y ${current.start}–${current.end}).`,
        };
      }
    }
  }

  const plan: RiderShiftPlan = {
    riderId: "",
    weeklyHours: input.weeklyHours as ContractHours,
    shifts: normalized,
    timezoneOffsetMinutes: 60,
  };
  if (!isValidPlan(plan)) {
    return { ok: false, error: "PLAN_INVALID", message: "El plan de jornada no es válido." };
  }
  const planned = plannedMinutes(plan);
  if (!planFitsContract(plan)) {
    return {
      ok: false,
      error: "PLAN_EXCEEDS_CONTRACT",
      message: `El plan suma ${Math.round((planned / 60) * 100) / 100} h y el contrato es de ${plan.weeklyHours} h. Ajusta los tramos o sube el contrato.`,
    };
  }
  return { ok: true, plan, plannedMinutes: planned };
}

/* ------------------------------------------------------------------ */
/* Persistencia                                                        */
/* ------------------------------------------------------------------ */

export async function loadShiftPlan(riderId: string): Promise<StoredShiftPlan | null> {
  if (!mongoose.isValidObjectId(riderId)) return null;
  const doc = await RiderShiftPlanModel.findOne({ riderId: new mongoose.Types.ObjectId(riderId) }).lean().exec() as any;
  if (!doc) return null;
  return {
    riderId: String(doc.riderId),
    tenantId: doc.tenantId ? String(doc.tenantId) : null,
    weeklyHours: doc.weeklyHours as ContractHours,
    shifts: (doc.shifts || []).map((shift: any) => ({ weekday: Number(shift.weekday), start: String(shift.start), end: String(shift.end) })),
    timezoneOffsetMinutes: Number(doc.timezoneOffsetMinutes ?? 60),
    plannedMinutes: Number(doc.plannedMinutes ?? plannedMinutes(doc as RiderShiftPlan)),
  };
}

export async function saveShiftPlan(input: {
  riderId: string;
  tenantId: string | null;
  weeklyHours: number;
  shifts: Array<{ weekday: number; start: string; end: string }>;
  updatedBy?: string | null;
}): Promise<PlanValidation & { stored?: StoredShiftPlan }> {
  const validation = validateShiftPlan({ weeklyHours: input.weeklyHours, shifts: input.shifts });
  if (!validation.ok) return validation;
  const riderObjectId = new mongoose.Types.ObjectId(input.riderId);
  await RiderShiftPlanModel.updateOne(
    { riderId: riderObjectId },
    {
      $set: {
        tenantId: input.tenantId && mongoose.isValidObjectId(input.tenantId) ? new mongoose.Types.ObjectId(input.tenantId) : null,
        weeklyHours: validation.plan.weeklyHours,
        shifts: validation.plan.shifts,
        timezoneOffsetMinutes: 60,
        plannedMinutes: validation.plannedMinutes,
        updatedBy: input.updatedBy && mongoose.isValidObjectId(input.updatedBy) ? new mongoose.Types.ObjectId(input.updatedBy) : null,
      },
    },
    { upsert: true },
  ).exec();
  const stored = await loadShiftPlan(input.riderId);
  return { ...validation, stored: stored ?? undefined };
}

export async function deleteShiftPlan(riderId: string): Promise<boolean> {
  if (!mongoose.isValidObjectId(riderId)) return false;
  const result = await RiderShiftPlanModel.deleteOne({ riderId: new mongoose.Types.ObjectId(riderId) }).exec();
  return (result.deletedCount ?? 0) > 0;
}

export type ShiftSnapshot = {
  riderId: string;
  weeklyHours: ContractHours | null;
  plannedMinutes: number;
  workedMinutesThisWeek: number;
  remainingMinutes: number | null;
  shifts: Shift[];
  onlineAllowed: boolean | null;
  reason: ShiftDecision["reason"] | null;
  currentShiftEndsAt?: string | null;
  nextShiftStartsAt?: string | null;
  updatedAt?: string | null;
};

export async function buildShiftSnapshot(riderId: string, now = new Date()): Promise<ShiftSnapshot> {
  const plan = await loadShiftPlan(riderId);
  const worked = (await computeWorkedMinutesThisWeek([riderId], now)).get(riderId) ?? 0;
  if (!plan) {
    return {
      riderId,
      weeklyHours: null,
      plannedMinutes: 0,
      workedMinutesThisWeek: worked,
      remainingMinutes: null,
      shifts: [],
      onlineAllowed: null,
      reason: null,
      currentShiftEndsAt: null,
      nextShiftStartsAt: null,
      updatedAt: null,
    };
  }
  const decision = evaluateShift(plan, worked, now);
  return {
    riderId,
    weeklyHours: plan.weeklyHours,
    plannedMinutes: plan.plannedMinutes,
    workedMinutesThisWeek: worked,
    remainingMinutes: Math.max(0, plan.weeklyHours * 60 - worked),
    shifts: plan.shifts,
    onlineAllowed: decision.onlineAllowed,
    reason: decision.reason,
    currentShiftEndsAt: decision.currentShiftEndsAt ?? null,
    nextShiftStartsAt: decision.nextShiftStartsAt ?? null,
    updatedAt: null,
  };
}

/* ------------------------------------------------------------------ */
/* Corte de jornada                                                    */
/* ------------------------------------------------------------------ */

export type ShiftCutResult = {
  riderId: string;
  riderName: string;
  reason: string;
  alreadyOffline: boolean;
  sessionsRevoked: number;
  slotsClosed: number;
};

/**
 * Corta la jornada de verdad: revoca la sesión del rider, lo deja fuera de
 * línea y cierra su turno abierto. Los pedidos los libera el barrido.
 */
export async function cutRiderShift(input: {
  riderId: string;
  reason: string;
  now?: Date;
}): Promise<ShiftCutResult | null> {
  if (!mongoose.isValidObjectId(input.riderId)) return null;
  const now = input.now ?? new Date();
  const rider = (await Rider.findById(input.riderId).select("_id name email status tenantId activeOrderId").lean().exec()) as any;
  if (!rider) return null;

  const closed = await RiderSlot.updateMany(
    { riderId: rider._id, status: "active" },
    { $set: { status: "completed", stoppedAt: now, stoppedReason: input.reason } },
  ).exec();

  await Rider.updateOne(
    { _id: rider._id },
    { $set: { status: "offline", activeOrderId: null } },
  ).exec();

  let sessionsRevoked = 0;
  if (rider.email) {
    const employees = (await EmployeeAccount.find({
      email: rider.email,
      ...(rider.tenantId ? { tenantId: rider.tenantId } : {}),
    })
      .select("_id")
      .lean()
      .exec()) as any[];
    for (const employee of employees) {
      await revokeEmployeeSessions(employee._id);
      sessionsRevoked += 1;
    }
  }

  await RiderShiftPlanModel.updateOne(
    { riderId: rider._id },
    { $set: { lastCutAt: now, lastCutReason: input.reason } },
  ).exec();

  await publishRealtimeEvent({
    channel: "rider",
    audienceKey: `rider:${String(rider._id)}`,
    tenantId: rider.tenantId || null,
    type: "rider.shift_forced_end",
    payload: { riderId: String(rider._id), reason: input.reason, endedAt: now.toISOString() },
    dedupeKey: `shift-forced-end:${String(rider._id)}:${now.getTime()}`,
  }).catch((error) => console.warn("No se pudo publicar el fin de jornada del rider", error instanceof Error ? error.message : error));

  return {
    riderId: String(rider._id),
    riderName: String(rider.name || rider.email || rider._id),
    reason: input.reason,
    alreadyOffline: String(rider.status || "") === "offline" && !closed.modifiedCount,
    sessionsRevoked,
    slotsClosed: closed.modifiedCount ?? 0,
  };
}

/* ------------------------------------------------------------------ */
/* Liberación de pedidos                                               */
/* ------------------------------------------------------------------ */

export async function releaseOrderFromRider(input: {
  orderId: string;
  riderId: string;
  publicCode: string;
  reason: string;
  now?: Date;
  /** Pedido ya en ruta (picked_up/on_the_way) que lleva horas sin entregarse. */
  fromInProgress?: boolean;
}): Promise<boolean> {
  const now = input.now ?? new Date();
  if (!mongoose.isValidObjectId(input.orderId)) return false;
  const statuses = input.fromInProgress ? ["picked_up", "on_the_way"] : ["assigned", "accepted", "preparing", "ready_for_pickup"];
  const statusFields = input.fromInProgress
    ? { status: "ready_for_pickup", riderArrivedAt: null, riderArrivalDistanceMeters: null, pickupDeadlineAt: null }
    : {};
  const updated = (await Order.findOneAndUpdate(
    { _id: input.orderId, riderId: input.riderId, status: { $in: statuses } },
    {
      $set: {
        ...statusFields,
        assignmentState: "expired",
        offerId: null,
        assignmentExpiresAt: null,
        releasedAt: now,
        releaseReason: input.reason,
      },
      $unset: { riderId: "" },
      $inc: { version: 1 },
      $push: {
        statusHistory: {
          status: "ready_for_pickup",
          actorRole: "system",
          at: now,
          reason: input.fromInProgress
            ? "El rider no completó la entrega en el tiempo máximo. PIKI devuelve el pedido a la cola para reasignarlo."
            : "Jornada finalizada: el pedido vuelve a la cola para reasignarse.",
        },
      },
    },
    { new: true },
  )
    .select("_id tenantId publicCode status version riderId")
    .lean()
    .exec()) as any;
  if (!updated) return false;

  await Rider.updateOne({ _id: input.riderId, activeOrderId: updated._id }, { $set: { activeOrderId: null } }).exec();
  await enqueueDispatchOutbox({
    orderId: updated._id,
    tenantId: updated.tenantId || null,
    idempotencyKey: dispatchRequeueIdempotencyKey(updated._id, Number(updated.version || 0)),
    reason: "shift_release",
  }).catch((error) => console.warn("No se pudo reencolar el pedido liberado", error instanceof Error ? error.message : error));

  await publishRealtimeEvent({
    channel: "fleet",
    audienceKey: `tenant:${String(updated.tenantId || "default")}:role:fleet`,
    tenantId: updated.tenantId || null,
    type: "order.rider_released",
    payload: {
      orderId: String(updated._id),
      publicCode: updated.publicCode,
      riderId: input.riderId,
      reason: input.reason,
      status: updated.status,
    },
    dedupeKey: `rider-released:${String(updated._id)}:${Number(updated.version || 0)}`,
  }).catch(() => undefined);

  return true;
}

/* ------------------------------------------------------------------ */
/* Barrido                                                             */
/* ------------------------------------------------------------------ */

export type ShiftSweepDetail = {
  riderId: string;
  riderName?: string;
  reason: string;
  orders: string[];
  sessionRevoked: boolean;
  errors: string[];
};

export type ShiftSweepReport = {
  dryRun: boolean;
  source: "manual" | "worker";
  checked: number;
  loggedOut: number;
  released: number;
  applied: number;
  actions: SweepAction[];
  details: ShiftSweepDetail[];
  errors: string[];
  startedAt: string;
  finishedAt: string;
};

/** Ejecuta el barrido de jornada. Sin `apply` solo calcula qué haría. */
export async function runShiftSweep(options: {
  apply: boolean;
  source?: "manual" | "worker";
  actorId?: string | null;
  now?: Date;
}): Promise<ShiftSweepReport> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  if (options.apply) await notifyUpcomingRiderShiftStarts(now).catch((error) => console.warn("No se pudo notificar el inicio de turnos Rider", error instanceof Error ? error.message : error));
  const plans = (await RiderShiftPlanModel.find({}).lean().exec()) as any[];
  const riders = plans
    .filter((plan) => mongoose.isValidObjectId(plan.riderId))
    .map((plan) => ({
      riderId: String(plan.riderId),
      plan: {
        riderId: String(plan.riderId),
        weeklyHours: plan.weeklyHours,
        shifts: (plan.shifts || []).map((shift: any) => ({ weekday: Number(shift.weekday), start: String(shift.start), end: String(shift.end) })),
        timezoneOffsetMinutes: Number(plan.timezoneOffsetMinutes ?? 60),
      } as RiderShiftPlan,
    }));

  const workedByRider = await computeWorkedMinutesThisWeek(riders.map((rider) => rider.riderId), now);

  const activeOrders = (await Order.find({
    riderId: { $exists: true, $ne: null },
    status: { $in: ["assigned", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"] },
  })
    .select("publicCode riderId status assignedAt createdAt riderArrivedAt")
    .lean()
    .exec()) as any[];

  const orders: AssignedOrder[] = activeOrders.map((order) => ({
    orderId: String(order._id),
    publicCode: order.publicCode,
    riderId: String(order.riderId),
    status: order.status,
    assignedMinutes: Math.max(0, Math.round((now.getTime() - new Date(order.assignedAt || order.createdAt || now).getTime()) / 60000)),
  }));

  // Solo entra en el barrido quien está trabajando de verdad: en línea, con un
  // turno abierto o con un pedido encima. Un rider ya offline no necesita que
  // se le corte nada cada cinco minutos.
  const activeRiderIds = new Set<string>();
  const planRiderIds = riders.map((rider) => rider.riderId).filter((riderId) => mongoose.isValidObjectId(riderId));
  if (planRiderIds.length) {
    const planObjectIds = planRiderIds.map((riderId) => new mongoose.Types.ObjectId(riderId));
    const [riderDocs, openSlots] = await Promise.all([
      Rider.find({ _id: { $in: planObjectIds } }).select("_id status activeOrderId").lean().exec() as Promise<any[]>,
      RiderSlot.find({ riderId: { $in: planObjectIds }, status: "active" }).select("riderId").lean().exec() as Promise<any[]>,
    ]);
    for (const doc of riderDocs) {
      if (String(doc.status || "") !== "offline" || doc.activeOrderId) activeRiderIds.add(String(doc._id));
    }
    for (const slot of openSlots) activeRiderIds.add(String(slot.riderId));
  }

  const result = planSweep({
    now,
    riders: riders.filter((rider) => activeRiderIds.has(rider.riderId)).map((rider) => ({
      riderId: rider.riderId,
      plan: rider.plan,
      workedMinutesThisWeek: workedByRider.get(rider.riderId) ?? 0,
    })),
    // Los pedidos ya en ruta los resuelve la pasada de "en ruta abandonado".
    orders: orders.filter((order) => isReleasable(order.status)),
  });

  const details = new Map<string, ShiftSweepDetail>();
  const errors: string[] = [];
  const riderNames = new Map<string, string>();
  // Un rider con pedido encima entra en el barrido aunque no tenga contrato
  // guardado: un pedido abandonado no puede quedarse muerto por papeleo.
  const ridersWithOrders = [...new Set(orders.map((order) => order.riderId))];
  const ridersWithoutPlan = ridersWithOrders.filter((riderId) => !riders.some((rider) => rider.riderId === riderId));
  const allRiderIds = [...new Set([...riders.map((rider) => rider.riderId), ...ridersWithOrders])].filter((id) => mongoose.isValidObjectId(id));
  if (allRiderIds.length) {
    const docs = (await Rider.find({ _id: { $in: allRiderIds.map((riderId) => new mongoose.Types.ObjectId(riderId)) } })
      .select("_id name email")
      .lean()
      .exec()) as any[];
    for (const doc of docs) riderNames.set(String(doc._id), String(doc.name || doc.email || doc._id));
  }

  let applied = 0;
  const abandonedActions: SweepAction[] = orders
    .filter((order) => ridersWithoutPlan.includes(order.riderId) && order.assignedMinutes >= ABANDONED_AFTER_MINUTES && isReleasable(order.status))
    .map((order) => ({ kind: "release_order" as const, riderId: order.riderId, publicCode: order.publicCode, reason: "pedido_abandonado" as const }));
  result.actions.push(...abandonedActions);
  result.released += abandonedActions.length;
  for (const action of result.actions) {
    const detail = details.get(action.riderId) ?? {
      riderId: action.riderId,
      riderName: riderNames.get(action.riderId),
      reason: action.kind === "logout" ? action.reason : action.reason,
      orders: [],
      sessionRevoked: false,
      errors: [],
    };
    if (action.kind === "logout") {
      detail.reason = action.reason;
      details.set(action.riderId, detail);
      if (options.apply) {
        try {
          const cut = await cutRiderShift({ riderId: action.riderId, reason: action.reason, now });
          detail.sessionRevoked = Boolean(cut && cut.sessionsRevoked > 0);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          detail.errors.push(message);
          errors.push(`logout ${action.riderId}: ${message}`);
        }
      }
      continue;
    }
    detail.orders.push(action.publicCode);
    details.set(action.riderId, detail);
    if (!options.apply) continue;
    const order = activeOrders.find((item) => item.publicCode === action.publicCode);
    if (!order || !isReleasable(order.status)) continue;
    try {
      const released = await releaseOrderFromRider({
        orderId: String(order._id),
        riderId: action.riderId,
        publicCode: action.publicCode,
        reason: action.reason,
        now,
      });
      if (released) applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      detail.errors.push(message);
      errors.push(`release ${action.publicCode}: ${message}`);
    }
  }

  // Pedidos que el rider ya recogió y nunca entregó. El barrido no los toca al
  // minuto (puede ir en ruta), pero pasadas unas horas el pedido está muerto y
  // el rider bloqueado: se devuelve a la cola con motivo registrado.
  const staleInRoute = activeOrders.filter((order) => isStaleInRoute(order, now));
  for (const order of staleInRoute) {
    const riderId = String(order.riderId);
    const detail = details.get(riderId) ?? { riderId, riderName: riderNames.get(riderId), reason: "pedido_abandonado", orders: [], sessionRevoked: false, errors: [] };
    if (!detail.orders.includes(order.publicCode)) detail.orders.push(order.publicCode);
    details.set(riderId, detail);
    result.released += 1;
    if (!options.apply) continue;
    try {
      const released = await releaseOrderFromRider({ orderId: String(order._id), riderId, publicCode: order.publicCode, reason: "pedido_abandonado_en_ruta", now, fromInProgress: true });
      if (released) applied += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      detail.errors.push(message);
      errors.push(`release ${order.publicCode}: ${message}`);
    }
  }

  const finishedAt = new Date().toISOString();
  const report: ShiftSweepReport = {
    dryRun: !options.apply,
    source: options.source ?? "manual",
    checked: result.checked,
    loggedOut: result.loggedOut,
    released: result.released,
    applied,
    actions: result.actions,
    details: [...details.values()],
    errors,
    startedAt,
    finishedAt,
  };

  await ShiftSweepRun.create({
    source: report.source,
    actorId: options.actorId && mongoose.isValidObjectId(options.actorId) ? new mongoose.Types.ObjectId(options.actorId) : null,
    dryRun: report.dryRun,
    checked: report.checked,
    loggedOut: report.loggedOut,
    released: report.released,
    errors: report.errors,
    actions: report.actions,
    startedAt: new Date(startedAt),
    finishedAt: new Date(finishedAt),
    durationMs: new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
  }).catch((error) => console.warn("No se pudo registrar el barrido de jornada", error instanceof Error ? error.message : error));

  return report;
}
