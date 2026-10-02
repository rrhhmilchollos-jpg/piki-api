export type RiderSlotLike = {
  date: string;
  startTime: string;
  endTime: string;
  status: "planned" | "active" | "completed" | "cancelled";
};

export function slotContainsTime(slot: Pick<RiderSlotLike, "startTime" | "endTime">, time: string) {
  return slot.startTime < slot.endTime
    ? slot.startTime <= time && time < slot.endTime
    : time >= slot.startTime || time < slot.endTime;
}

export function isSlotCurrent(slot: RiderSlotLike, now: { date: string; time: string }, previousDate: string) {
  if (!(slot.status === "planned" || slot.status === "active")) return false;
  if (!slotContainsTime(slot, now.time)) return false;
  return slot.date === now.date || (slot.date === previousDate && slot.startTime >= slot.endTime);
}

export function selectCurrentSlot(slots: RiderSlotLike[], now: { date: string; time: string }, previousDate: string) {
  return slots.find((slot) => isSlotCurrent(slot, now, previousDate)) ?? null;
}

export function effectiveRiderStatus(input: { riderStatus: "offline" | "available" | "busy" | "paused"; hasActiveOrder: boolean; slotStatus?: RiderSlotLike["status"] | null }) {
  if (input.hasActiveOrder) return "busy" as const;
  return input.slotStatus === "active" ? input.riderStatus : "offline" as const;
}
