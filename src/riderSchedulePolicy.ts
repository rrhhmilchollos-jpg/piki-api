export type RiderScheduleWindow = {
  date: string;
  startTime: string;
  endTime: string;
};

export function isValidScheduleWindow(startTime: string, endTime: string): boolean {
  return startTime !== endTime;
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
