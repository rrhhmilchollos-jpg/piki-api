import { RiderSlot } from "./models.js";
import { buildShiftSnapshot } from "./shiftPlans.js";

const RIDER_ID = "6ab743b6c9ebf588e740e506";
let done = false;

function minutes(value: unknown): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function madridToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Madrid" });
}

function mondayOfThisWeek(): string {
  const now = new Date();
  const madrid = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Madrid" }));
  const day = (madrid.getDay() + 6) % 7;
  madrid.setDate(madrid.getDate() - day);
  return madrid.toLocaleDateString("sv-SE");
}

export async function runHoursRepairOnce(): Promise<void> {
  if (done || process.env.PIKI_HOURS_REPAIR !== "1") return;
  done = true;
  try {
    const today = madridToday();
    const monday = mondayOfThisWeek();
    const before: any = await buildShiftSnapshot(RIDER_ID);
    const slots: any[] = await RiderSlot.find({ riderId: RIDER_ID }).select("_id date startTime endTime status").lean().exec();

    const invalid: string[] = [];
    const tooLong: string[] = [];
    for (const slot of slots) {
      if (String(slot.status) === "void") continue;
      const start = minutes(slot.startTime);
      const end = minutes(slot.endTime);
      if (start === null || end === null) continue;
      const label = `${slot.date} ${slot.startTime}-${slot.endTime}`;
      if (end <= start) { invalid.push(label); continue; }
      if (end - start > 16 * 60) tooLong.push(label);
    }
    for (const slot of slots) {
      const label = `${slot.date} ${slot.startTime}-${slot.endTime}`;
      if (!invalid.includes(label) && !tooLong.includes(label)) continue;
      await RiderSlot.updateOne({ _id: slot._id }, { $set: { status: "void" } }).exec();
    }

    let mid: any = await buildShiftSnapshot(RIDER_ID);
    const weeklyReset: string[] = [];
    if (mid.onlineAllowed === false && String(mid.reason) === "jornada_completa" && today > monday) {
      const weekSlots: any[] = await RiderSlot.find({ riderId: RIDER_ID, date: { $gte: monday, $lt: today }, status: { $ne: "void" } }).select("_id date startTime endTime").lean().exec();
      for (const slot of weekSlots) {
        await RiderSlot.updateOne({ _id: slot._id }, { $set: { status: "void" } }).exec();
        weeklyReset.push(`${slot.date} ${slot.startTime}-${slot.endTime}`);
      }
      mid = await buildShiftSnapshot(RIDER_ID);
    }

    console.log("[hours-repair]", JSON.stringify({
      riderId: RIDER_ID,
      today,
      weekStart: monday,
      before: { worked: before.workedMinutesThisWeek, planned: before.plannedMinutes, onlineAllowed: before.onlineAllowed, reason: before.reason },
      voidedInvalid: invalid,
      voidedTooLong: tooLong,
      voidedThisWeek: weeklyReset,
      after: { worked: mid.workedMinutesThisWeek, planned: mid.plannedMinutes, onlineAllowed: mid.onlineAllowed, reason: mid.reason },
    }));
  } catch (error) {
    console.error("[hours-repair] error", error instanceof Error ? error.message : error);
  }
}
