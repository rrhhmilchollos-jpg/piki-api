/**
 * Control de jornada del rider.
 *
 * Reglas que fija la flota en el contrato de cada rider:
 *  - jornada semanal contratada: 10, 20, 30 o 40 horas
 *  - tramos asignados por día de la semana (hora de inicio y fin)
 *
 * El sistema no deja al rider trabajar fuera de su tramo ni pasarse de las
 * horas contratadas. Al agotarse la jornada se le pone fuera de línea, y no
 * vuelve hasta el siguiente tramo asignado. Esto es requisito legal, así que el
 * cálculo es determinista y se prueba aparte de la base de datos.
 */

export const CONTRACT_HOURS = [10, 20, 30, 40] as const;
export type ContractHours = (typeof CONTRACT_HOURS)[number];

export type Shift = {
  /** 0 = domingo … 6 = sábado (igual que Date.getDay). */
  weekday: number;
  /** "HH:MM" en hora local del centro de operaciones. */
  start: string;
  end: string;
};

export type RiderShiftPlan = {
  riderId: string;
  weeklyHours: ContractHours;
  shifts: Shift[];
  timezoneOffsetMinutes?: number;
};

export type ShiftDecision = {
  onlineAllowed: boolean;
  reason:
    | "dentro_de_jornada"
    | "fuera_de_tramo"
    | "jornada_completa"
    | "sin_tramos"
    | "plan_invalido";
  minutesRemaining: number;
  currentShiftEndsAt?: string;
  nextShiftStartsAt?: string;
};

const MINUTES_PER_WEEK = 7 * 24 * 60;

function toMinutes(hhmm: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function isValidPlan(plan: RiderShiftPlan): boolean {
  if (!CONTRACT_HOURS.includes(plan.weeklyHours)) return false;
  if (!Array.isArray(plan.shifts) || plan.shifts.length === 0) return false;
  return plan.shifts.every((shift) => {
    const start = toMinutes(shift.start);
    const end = toMinutes(shift.end);
    return (
      Number.isInteger(shift.weekday) &&
      shift.weekday >= 0 &&
      shift.weekday <= 6 &&
      start !== null &&
      end !== null &&
      end !== start
    );
  });
}

/** Minutos de tramo asignados en la semana (lo que la flota ha planificado). */
export function plannedMinutes(plan: RiderShiftPlan): number {
  return plan.shifts.reduce((total, shift) => {
    const start = toMinutes(shift.start) ?? 0;
    const end = toMinutes(shift.end) ?? 0;
    const duration = end > start ? end - start : end + 1440 - start;
    return total + duration;
  }, 0);
}

/**
 * Un plan no puede superar las horas contratadas: si la flota asigna 45 h a un
 * contrato de 40, el exceso es ilegal y hay que corregirlo antes de publicarlo.
 */
export function planFitsContract(plan: RiderShiftPlan): boolean {
  return plannedMinutes(plan) <= plan.weeklyHours * 60;
}

function localNow(now: Date, offsetMinutes: number) {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  return {
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  };
}

/**
 * Decide si el rider puede estar en línea ahora mismo.
 *
 * `workedMinutesThisWeek` incluye lo ya trabajado desde el inicio de la semana
 * de convenio (lunes 00:00). Si alcanza su contrato, se le deja fuera hasta la
 * semana siguiente aunque esté dentro de un tramo.
 */
export function evaluateShift(
  plan: RiderShiftPlan,
  workedMinutesThisWeek: number,
  now = new Date()
): ShiftDecision {
  if (!isValidPlan(plan)) {
    return { onlineAllowed: false, reason: "plan_invalido", minutesRemaining: 0 };
  }
  const offset = plan.timezoneOffsetMinutes ?? 60; // España peninsular
  const { weekday, minutes } = localNow(now, offset);
  const capacity = plan.weeklyHours * 60;
  const remaining = Math.max(0, capacity - Math.max(0, workedMinutesThisWeek));

  if (remaining === 0) {
    return { onlineAllowed: false, reason: "jornada_completa", minutesRemaining: 0 };
  }

  const today = plan.shifts
    .filter((shift) => shift.weekday === weekday)
    .map((shift) => ({ start: toMinutes(shift.start)!, end: toMinutes(shift.end)! }))
    .sort((a, b) => a.start - b.start);
  const previousWeekday = (weekday + 6) % 7;
  const previousOvernight = plan.shifts
    .filter((shift) => shift.weekday === previousWeekday)
    .map((shift) => ({ start: toMinutes(shift.start)!, end: toMinutes(shift.end)! }))
    .filter((shift) => shift.end <= shift.start && minutes < shift.end)
    .sort((a, b) => b.start - a.start)[0];
  const activo = previousOvernight || today.find((shift) =>
    shift.end > shift.start ? minutes >= shift.start && minutes < shift.end : minutes >= shift.start || minutes < shift.end,
  );
  if (activo) {
    const restanteDelTramo = activo.end > activo.start
      ? activo.end - minutes
      : minutes >= activo.start ? (1440 - minutes) + activo.end : activo.end - minutes;
    return {
      onlineAllowed: true,
      reason: "dentro_de_jornada",
      minutesRemaining: Math.min(remaining, restanteDelTramo),
      currentShiftEndsAt: `${String(Math.floor(activo.end / 60)).padStart(2, "0")}:${String(activo.end % 60).padStart(2, "0")}`,
    };
  }

  // Siguiente tramo de la semana, para poder avisar al rider con antelación.
  let siguiente: { weekday: number; start: number } | null = null;
  for (let delta = 0; delta < 7; delta += 1) {
    const dia = (weekday + delta) % 7;
    const tramos = plan.shifts
      .filter((shift) => shift.weekday === dia)
      .map((shift) => ({ weekday: dia, start: toMinutes(shift.start)! }))
      .filter((shift) => delta > 0 || shift.start > minutes)
      .sort((a, b) => a.start - b.start);
    if (tramos.length) {
      siguiente = tramos[0];
      break;
    }
  }

  return {
    onlineAllowed: false,
    reason: "fuera_de_tramo",
    minutesRemaining: remaining,
    nextShiftStartsAt: siguiente
      ? `${["dom", "lun", "mar", "mié", "jue", "vie", "sáb"][siguiente.weekday]} ${String(
          Math.floor(siguiente.start / 60)
        ).padStart(2, "0")}:${String(siguiente.start % 60).padStart(2, "0")}`
      : undefined,
  };
}

/**
 * Minutos de esta semana desde el lunes a las 00:00 locales. Se calcula a partir
 * de los tramos de conexión reales, no de lo que el rider diga.
 */
export function minutesSinceWeekStart(now: Date, offsetMinutes = 60): number {
  const shifted = new Date(now.getTime() + offsetMinutes * 60_000);
  const dayFromMonday = (shifted.getUTCDay() + 6) % 7;
  return dayFromMonday * 1440 + shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Recorta un exceso de conexión al límite legal de la semana. */
export function clampToWeekLimit(workedMinutesThisWeek: number, plan: RiderShiftPlan): number {
  return Math.min(Math.max(0, workedMinutesThisWeek), plan.weeklyHours * 60);
}

export { MINUTES_PER_WEEK };
