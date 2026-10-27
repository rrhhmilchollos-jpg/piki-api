import { z } from "zod";

export const DEFAULT_PARTNER_TIME_ZONE = "Europe/Madrid";
export const WEEKDAY_KEYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"] as const;
export type WeekdayKey = typeof WEEKDAY_KEYS[number];

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "La hora debe estar en formato HH:MM");

export const openingHourSlotSchema = z.object({
  open: timeSchema,
  close: timeSchema,
  closed: z.boolean().optional().default(false),
});

const splitOpeningDaySchema = z.object({
  morning: openingHourSlotSchema,
  evening: openingHourSlotSchema,
  closed: z.boolean(),
});

const legacySplitOpeningDaySchema = z.object({
  morning: openingHourSlotSchema,
  afternoon: openingHourSlotSchema,
  closed: z.boolean(),
}).transform(({ morning, afternoon, closed }) => ({ morning, evening: afternoon, closed }));

const legacyOpeningDaySchema = z.object({
  open: timeSchema,
  close: timeSchema,
  closed: z.boolean(),
}).transform(({ open, close, closed }) => ({
  morning: { open, close, closed: false },
  evening: { open, close, closed: false },
  closed,
}));

export const openingDaySchema = z.union([
  splitOpeningDaySchema,
  legacySplitOpeningDaySchema,
  legacyOpeningDaySchema,
]);

const legacyOpeningHoursSchema = z.record(z.string().min(2).max(15), openingDaySchema);

const intervalSchema = z.object({
  open: timeSchema,
  close: timeSchema,
  endsNextDay: z.boolean().optional(),
});

const canonicalDaySchema = z.array(intervalSchema).max(12);
const specialHoursOverrideSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  closed: z.boolean().default(false),
  intervals: z.array(intervalSchema).max(24).default([]),
});

const canonicalOpeningHoursSchema = z.any()
  // Defaults below must not turn an invalid legacy-shaped object into a
  // canonical schedule. Require an actual canonical key in the raw input.
  .refine((value) => isCanonicalInput(value), "Debe incluir al menos un campo canónico de horario")
  .pipe(z.object({
    timeZone: z.string().trim().min(1).max(80).refine(isValidIanaTimeZone, "Zona horaria IANA no válida").default(DEFAULT_PARTNER_TIME_ZONE),
    regular: z.record(z.string(), canonicalDaySchema).default({}),
    overrides: z.array(specialHoursOverrideSchema).max(366).default([]),
    source: z.object({
      mode: z.enum(["google", "piki"]).default("piki"),
      locationName: z.string().max(300).nullable().optional(),
      revision: z.string().max(300).nullable().optional(),
      syncedAt: z.coerce.date().nullable().optional(),
    }).optional(),
  }).passthrough());

/**
 * Accepts the legacy split-day object as well as the canonical schedule. New
 * schedules keep every interval in `regular`; legacy keys may coexist as a
 * read-compatibility projection without affecting the evaluator.
 */
export const openingHoursSchema = z.union([legacyOpeningHoursSchema, canonicalOpeningHoursSchema]);
export type LegacyOpeningSlot = { open: string; close: string; closed?: boolean };
export type LegacyOpeningDay = { morning?: LegacyOpeningSlot; afternoon?: LegacyOpeningSlot; evening?: LegacyOpeningSlot; open?: string; close?: string; closed?: boolean };
export type LegacyOpeningHours = Record<string, LegacyOpeningDay>;

export type OpeningInterval = { open: string; close: string; endsNextDay?: boolean };
export type CanonicalOpeningHours = {
  timeZone: string;
  regular: Partial<Record<WeekdayKey, OpeningInterval[]>>;
  overrides: Array<{ date: string; endDate?: string; closed: boolean; intervals: OpeningInterval[] }>;
  source?: { mode: "google" | "piki"; locationName?: string | null; revision?: string | null; syncedAt?: Date | null };
};
export type OpeningHours = LegacyOpeningHours | CanonicalOpeningHours;

export type OpeningHoursEvaluation = {
  open: boolean;
  timeZone: string;
  localDate: string;
  reason: "legacy_unscheduled" | "scheduled_open" | "scheduled_closed" | "invalid_schedule";
};

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function minuteOf(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function isCanonicalInput(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && ("regular" in value || "timeZone" in value || "overrides" in value);
}

function legacyIntervals(value: any): OpeningInterval[] {
  if (!value || value.closed === true) return [];
  const slots = value.morning || value.afternoon || value.evening
    ? [value.morning, value.afternoon || value.evening]
    : [value];
  return slots
    .filter((slot: any) => slot && slot.closed !== true && typeof slot.open === "string" && typeof slot.close === "string")
    .map((slot: any) => ({ open: slot.open, close: slot.close, endsNextDay: minuteOf(slot.close) <= minuteOf(slot.open) }));
}

/** Converts persisted legacy opening hours to a lossless-in-use canonical shape. */
export function normalizeOpeningHours(value: unknown): CanonicalOpeningHours | null {
  if (!value || typeof value !== "object") return null;
  if (isCanonicalInput(value)) {
    const parsed = canonicalOpeningHoursSchema.safeParse(value);
    if (!parsed.success) return null;
    const regular: Partial<Record<WeekdayKey, OpeningInterval[]>> = {};
    for (const day of WEEKDAY_KEYS) {
      const intervals = parsed.data.regular[day];
      if (intervals) regular[day] = intervals.map((interval) => ({
        open: interval.open,
        close: interval.close,
        endsNextDay: interval.endsNextDay ?? minuteOf(interval.close) <= minuteOf(interval.open),
      }));
    }
    return {
      timeZone: parsed.data.timeZone,
      regular,
      overrides: parsed.data.overrides.map((override) => ({
        date: override.date,
        ...(override.endDate ? { endDate: override.endDate } : {}),
        closed: override.closed,
        intervals: override.intervals.map((interval) => ({
          open: interval.open,
          close: interval.close,
          endsNextDay: interval.endsNextDay ?? minuteOf(interval.close) <= minuteOf(interval.open),
        })),
      })),
      ...(parsed.data.source ? { source: parsed.data.source } : {}),
    };
  }

  const parsed = legacyOpeningHoursSchema.safeParse(value);
  if (!parsed.success) return null;
  const regular: Partial<Record<WeekdayKey, OpeningInterval[]>> = {};
  for (const day of WEEKDAY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(parsed.data, day)) regular[day] = legacyIntervals(parsed.data[day]);
  }
  return { timeZone: DEFAULT_PARTNER_TIME_ZONE, regular, overrides: [] };
}

function localDateParts(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value || "";
  const weekdayMap: Record<string, WeekdayKey> = { Mon: "lunes", Tue: "martes", Wed: "miércoles", Thu: "jueves", Fri: "viernes", Sat: "sábado", Sun: "domingo" };
  const year = get("year"); const month = get("month"); const day = get("day");
  return {
    date: `${year}-${month}-${day}`,
    weekday: weekdayMap[get("weekday")] || "lunes",
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function previousLocalDate(date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const previous = new Date(Date.UTC(year, month - 1, day - 1));
  const dateString = previous.toISOString().slice(0, 10);
  const weekdayMap: WeekdayKey[] = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
  return { date: dateString, weekday: weekdayMap[previous.getUTCDay()] };
}

function overrideForDate(schedule: CanonicalOpeningHours, date: string) {
  return schedule.overrides.find((override) => override.date <= date && (override.endDate || override.date) >= date) || null;
}

function intervalsForDate(schedule: CanonicalOpeningHours, date: string, weekday: WeekdayKey) {
  const override = overrideForDate(schedule, date);
  if (override) return override.closed ? [] : override.intervals;
  return schedule.regular[weekday] || [];
}

function intervalCrossesMidnight(interval: OpeningInterval) {
  return interval.endsNextDay === true || minuteOf(interval.close) <= minuteOf(interval.open);
}

/** Evaluates the current local calendar date plus an overnight period from the previous local date. */
export function evaluateOpeningHours(value: unknown, now = new Date()): OpeningHoursEvaluation {
  const hasSchedule = Boolean(value && typeof value === "object" && Object.keys(value as object).length > 0);
  if (!hasSchedule) return { open: true, timeZone: DEFAULT_PARTNER_TIME_ZONE, localDate: "", reason: "legacy_unscheduled" };
  const schedule = normalizeOpeningHours(value);
  if (!schedule) return { open: false, timeZone: DEFAULT_PARTNER_TIME_ZONE, localDate: "", reason: "invalid_schedule" };
  const local = localDateParts(now, schedule.timeZone);
  const today = intervalsForDate(schedule, local.date, local.weekday);
  const previous = previousLocalDate(local.date);
  const previousIntervals = intervalsForDate(schedule, previous.date, previous.weekday);
  const inToday = today.some((interval) => {
    const open = minuteOf(interval.open); const close = minuteOf(interval.close);
    return intervalCrossesMidnight(interval)
      ? local.minutes >= open
      : local.minutes >= open && local.minutes < close;
  });
  const currentOverride = overrideForDate(schedule, local.date);
  const inPreviousOvernight = !currentOverride?.closed && previousIntervals.some((interval) => intervalCrossesMidnight(interval) && local.minutes < minuteOf(interval.close));
  const open = inToday || inPreviousOvernight;
  return { open, timeZone: schedule.timeZone, localDate: local.date, reason: open ? "scheduled_open" : "scheduled_closed" };
}

/** A compact legacy projection for old Partner clients; canonical `regular` remains authoritative. */
export function legacyOpeningHoursProjection(schedule: CanonicalOpeningHours): Record<string, any> {
  const result: Record<string, any> = {};
  for (const day of WEEKDAY_KEYS) {
    const intervals = schedule.regular[day] || [];
    // The canonical intervals are authoritative. A legacy day only has two
    // named slots, so a sole period is exposed through its evening slot rather
    // than classifying it by an arbitrary hour cutoff; its actual range stays
    // unchanged and the canonical array retains every period.
    const [first, second] = intervals;
    const morning = second ? first : undefined;
    const evening = second || first;
    result[day] = {
      morning: morning ? { open: morning.open, close: morning.close, closed: false } : { open: "10:00", close: "14:00", closed: true },
      evening: evening ? { open: evening.open, close: evening.close, closed: false } : { open: "18:00", close: "23:00", closed: true },
      closed: intervals.length === 0,
    };
  }
  return result;
}
