/**
 * Planificador de turnos partidos al estilo Glovo.
 *
 * La semana se divide en dos bloques de cuatro horas, que son las franjas de
 * máxima demanda: mediodía (12:00-16:00) y noche (20:00-00:00). Cada contrato
 * reserva un número de bloques según sus horas semanales, y siempre se respeta
 * el descanso mínimo de 12 horas entre el final de un turno y el inicio del
 * siguiente.
 */

export type ShiftBlockId = "midday" | "night";

export interface ShiftBlock {
  id: ShiftBlockId;
  label: string;
  startTime: string;
  endTime: string;
  /** Minutos desde las 00:00 del día en que empieza el bloque. */
  startMinute: number;
  endMinute: number;
}

export const SHIFT_BLOCKS: Record<ShiftBlockId, ShiftBlock> = {
  midday: { id: "midday", label: "Mediodía", startTime: "12:00", endTime: "16:00", startMinute: 12 * 60, endMinute: 16 * 60 },
  night: { id: "night", label: "Noche", startTime: "20:00", endTime: "00:00", startMinute: 20 * 60, endMinute: 24 * 60 },
};

export const MIN_REST_HOURS = 12;
export const BLOCK_HOURS = 4;
export const CONTRACT_HOURS = [10, 20, 30, 40] as const;
export type ContractHours = (typeof CONTRACT_HOURS)[number];

export interface PlannedShift {
  /** Fecha ISO (YYYY-MM-DD) del día en que empieza el bloque. */
  date: string;
  block: ShiftBlockId;
  startTime: string;
  endTime: string;
  hours: number;
}

export interface WeekPlan {
  weeklyHours: number;
  blocks: number;
  plannedHours: number;
  shifts: PlannedShift[];
  restViolations: string[];
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** 0 = domingo, 1 = lunes … 6 = sábado. */
function weekday(date: Date): number {
  return date.getUTCDay();
}

/**
 * Bloques necesarios para cubrir las horas contratadas. 30 h no es múltiplo de
 * 4: se redondea al bloque más cercano y se avisa de la diferencia.
 */
export function blocksForWeeklyHours(weeklyHours: number): number {
  if (!Number.isFinite(weeklyHours) || weeklyHours <= 0) return 0;
  return Math.max(1, Math.round(weeklyHours / BLOCK_HOURS));
}

/** Descanso en horas entre el final de un turno y el inicio del siguiente. */
export function restHoursBetween(previous: PlannedShift, next: PlannedShift): number {
  const previousEnd = new Date(`${previous.date}T${previous.endTime === "00:00" ? "00:00" : previous.endTime}:00Z`);
  if (previous.endTime === "00:00") previousEnd.setUTCDate(previousEnd.getUTCDate() + 1);
  const nextStart = new Date(`${next.date}T${next.startTime}:00Z`);
  return (nextStart.getTime() - previousEnd.getTime()) / 3_600_000;
}

export function restViolations(shifts: PlannedShift[]): string[] {
  const ordered = [...shifts].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const violations: string[] = [];
  for (let index = 1; index < ordered.length; index += 1) {
    // Un turno partido tiene dos bloques el mismo día: las 12 horas se exigen
    // entre el último bloque de un día y el primero del siguiente.
    if (ordered[index - 1].date === ordered[index].date) continue;
    const rest = restHoursBetween(ordered[index - 1], ordered[index]);
    if (rest < MIN_REST_HOURS) {
      violations.push(`${ordered[index].date} ${ordered[index].startTime}: solo ${rest} h de descanso desde el turno anterior`);
    }
  }
  return violations;
}

function shift(date: Date, block: ShiftBlockId): PlannedShift {
  const definition = SHIFT_BLOCKS[block];
  return { date: isoDate(date), block, startTime: definition.startTime, endTime: definition.endTime, hours: BLOCK_HOURS };
}

/**
 * Plan semanal según el contrato.
 *  - 10 h: fines de semana de noche (viernes, sábado y domingo).
 *  - 20 h: cinco bloques de lunes a viernes alternando mediodía y noche.
 *  - 30 h: turnos partidos en los días de más demanda (viernes a domingo).
 *  - 40 h: jornada completa de lunes a viernes, mediodía y noche.
 */
export function planWeek(weeklyHours: number, weekStart: string): WeekPlan {
  const raw = new Date(`${weekStart}T00:00:00Z`);
  if (Number.isNaN(raw.getTime())) throw new Error("WEEK_START_INVALID");
  // La semana siempre empieza en lunes, venga la fecha que venga.
  const start = new Date(`${weekStartOf(weekStart)}T00:00:00Z`);
  const needed = blocksForWeeklyHours(weeklyHours);
  const shifts: PlannedShift[] = [];

  const push = (dayOffset: number, block: ShiftBlockId) => {
    if (shifts.length >= needed) return;
    shifts.push(shift(addDays(start, dayOffset), block));
  };

  if (weeklyHours <= 10) {
    // Viernes, sábado y domingo de noche.
    for (const offset of [4, 5, 6]) push(offset, "night");
  } else if (weeklyHours <= 20) {
    // Cinco bloques de lunes a viernes, alternando mediodía y noche.
    for (let index = 0; index < 5; index += 1) push(index, index % 2 === 0 ? "midday" : "night");
  } else if (weeklyHours <= 30) {
    // Turnos partidos en los días de máxima demanda.
    for (const offset of [4, 5, 6]) push(offset, "midday");
    for (const offset of [4, 5, 6]) push(offset, "night");
    // 30 h no es múltiplo de 4: se completa con el bloque más cercano y se
    // avisa de la diferencia real en `plannedHours`.
    for (const [offset, block] of [[3, "night"], [3, "midday"], [2, "night"], [2, "midday"]] as Array<[number, ShiftBlockId]>) {
      push(offset, block);
    }
  } else {
    // Jornada completa de lunes a viernes.
    for (let index = 0; index < 5; index += 1) push(index, "midday");
    for (let index = 0; index < 5; index += 1) push(index, "night");
  }

  const plannedHours = shifts.length * BLOCK_HOURS;
  return {
    weeklyHours,
    blocks: shifts.length,
    plannedHours,
    shifts,
    restViolations: restViolations(shifts),
  };
}

/**
 * Comprueba si un turno propuesto choca con el descanso de 12 h respecto a los
 * turnos ya asignados al rider en la misma semana.
 */
export function fitsRest(existing: PlannedShift[], candidate: PlannedShift): { ok: boolean; restHours: number | null; reason?: string } {
  for (const shift of existing) {
    if (shift.date === candidate.date) continue;
    const pair = [shift, candidate].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    const rest = restHoursBetween(pair[0], pair[1]);
    if (rest < MIN_REST_HOURS) {
      return { ok: false, restHours: rest, reason: `Solo ${rest} h de descanso con el turno del ${pair[0].date} ${pair[0].startTime}` };
    }
  }
  return { ok: true, restHours: null };
}

/** Lunes de la semana a la que pertenece una fecha. */
export function weekStartOf(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const day = weekday(value);
  const diff = day === 0 ? -6 : 1 - day;
  return isoDate(addDays(value, diff));
}
