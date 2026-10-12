export const SETTLEMENT_TIME_ZONE = "Europe/Madrid" as const;

export type SettlementPeriod = {
  party: "rider" | "partner";
  startsOn: string;
  endsBefore: string;
  paymentDate: string | null;
  paymentStatus: "scheduled" | "pending_configuration";
  timeZone: typeof SETTLEMENT_TIME_ZONE;
};

type CalendarDate = { year: number; month: number; day: number };

function parseDateKey(dateKey: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) throw new Error("INVALID_SETTLEMENT_DATE");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getUTCFullYear() !== year || candidate.getUTCMonth() !== month - 1 || candidate.getUTCDate() !== day) throw new Error("INVALID_SETTLEMENT_DATE");
  return { year, month, day };
}

function formatDate({ year, month, day }: CalendarDate): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstOfNextMonth(date: CalendarDate): CalendarDate {
  return date.month === 12 ? { year: date.year + 1, month: 1, day: 1 } : { year: date.year, month: date.month + 1, day: 1 };
}

function firstOfPreviousMonth(date: CalendarDate): CalendarDate {
  return date.month === 1 ? { year: date.year - 1, month: 12, day: 1 } : { year: date.year, month: date.month - 1, day: 1 };
}

/** Converts an instant to the civil date used for Spanish settlement cutoffs. */
export function madridDateKey(instant: Date): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new Error("INVALID_SETTLEMENT_INSTANT");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SETTLEMENT_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * The period containing a Madrid civil date. Days 1–14 are paid on the 15th;
 * days 15–month-end are paid on the 1st of the following month.
 */
export function riderSettlementPeriodForLocalDate(dateKey: string): SettlementPeriod {
  const date = parseDateKey(dateKey);
  if (date.day <= 14) {
    return {
      party: "rider",
      startsOn: formatDate({ ...date, day: 1 }),
      endsBefore: formatDate({ ...date, day: 15 }),
      paymentDate: formatDate({ ...date, day: 15 }),
      paymentStatus: "scheduled",
      timeZone: SETTLEMENT_TIME_ZONE,
    };
  }
  const nextMonth = firstOfNextMonth(date);
  return {
    party: "rider",
    startsOn: formatDate({ ...date, day: 15 }),
    endsBefore: formatDate(nextMonth),
    paymentDate: formatDate(nextMonth),
    paymentStatus: "scheduled",
    timeZone: SETTLEMENT_TIME_ZONE,
  };
}

export function riderSettlementPeriodForInstant(instant: Date): SettlementPeriod {
  return riderSettlementPeriodForLocalDate(madridDateKey(instant));
}

/** A partner period is one natural Madrid month; its payment day remains deliberately unconfigured. */
export function partnerSettlementPeriodForLocalDate(dateKey: string): SettlementPeriod {
  const date = parseDateKey(dateKey);
  return {
    party: "partner",
    startsOn: formatDate({ ...date, day: 1 }),
    endsBefore: formatDate(firstOfNextMonth(date)),
    paymentDate: null,
    paymentStatus: "pending_configuration",
    timeZone: SETTLEMENT_TIME_ZONE,
  };
}

export function partnerSettlementPeriodForInstant(instant: Date): SettlementPeriod {
  return partnerSettlementPeriodForLocalDate(madridDateKey(instant));
}

/** Exposed for reports/tests: a day-1 payout settles the preceding 15th–month-end period. */
export function riderPeriodPaidOnFirstOfMonth(dateKey: string): SettlementPeriod {
  const date = parseDateKey(dateKey);
  if (date.day !== 1) throw new Error("RIDER_PAYOUT_DATE_MUST_BE_DAY_1");
  const previous = firstOfPreviousMonth(date);
  return {
    party: "rider",
    startsOn: formatDate({ ...previous, day: 15 }),
    endsBefore: formatDate({ ...date, day: 1 }),
    paymentDate: formatDate(date),
    paymentStatus: "scheduled",
    timeZone: SETTLEMENT_TIME_ZONE,
  };
}
