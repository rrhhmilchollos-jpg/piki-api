export type RiderScheduleWindow = {
  date: string;
  startTime: string;
  endTime: string;
};

const CLOCK_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function minutesSinceMidnight(value: string): number | null {
  if (!CLOCK_TIME.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function isValidScheduleWindow(startTime: string, endTime: string): boolean {
  const start = minutesSinceMidnight(startTime);
  const end = minutesSinceMidnight(endTime);
  return start !== null && end !== null && start !== end;
}

/** Returns same-day ranges for overlap checks; a reversed clock range crosses midnight. */
export function normalizedScheduleRanges(startTime: string, endTime: string): Array<[number, number]> {
  const start = minutesSinceMidnight(startTime);
  const end = minutesSinceMidnight(endTime);
  if (start === null || end === null || start === end) return [];
  if (end > start) return [[start, end]];
  return end === 0 ? [[start, 1440]] : [[start, 1440], [0, end]];
}

export function scheduleWindowsOverlap(left: RiderScheduleWindow, right: RiderScheduleWindow): boolean {
  if (left.date !== right.date) return false;
  const leftRanges = normalizedScheduleRanges(left.startTime, left.endTime);
  const rightRanges = normalizedScheduleRanges(right.startTime, right.endTime);
  return leftRanges.some(([leftStart, leftEnd]) => rightRanges.some(([rightStart, rightEnd]) => leftStart < rightEnd && rightStart < leftEnd));
}

export function expandWeeklySchedule(startDate: string, weekdays: number[]): string[] {
  const anchor = new Date(`${startDate}T12:00:00Z`);
  return [...new Set(weekdays)].sort((a, b) => a - b).map((weekday) => {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() + weekday);
    return date.toISOString().slice(0, 10);
  });
}

/**
 * Fleet assigns the schedule; operational state is controlled by the server.
 * Client payloads must never be allowed to overwrite lifecycle state.
 */
export function assignedScheduleFields(input: RiderScheduleWindow & { zoneSlug: string; notes?: string }) {
  return {
    zoneSlug: input.zoneSlug,
    date: input.date,
    startTime: input.startTime,
    endTime: input.endTime,
    notes: input.notes ?? "",
  };
}

export function nextScheduleRevision(current: unknown): number {
  const revision = typeof current === "number" && Number.isInteger(current) && current >= 1 ? current : 0;
  return revision + 1;
}
