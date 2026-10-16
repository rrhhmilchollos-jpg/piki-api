import mongoose from "mongoose";
import { Rider, RiderSlot } from "./models.js";
import { publishRealtimeEvent, tenantAudienceKey } from "./realtime.js";

export const RIDER_SHIFT_POLICY = {
  reminderBeforeMs: 15 * 60_000,
  warningAfterMs: 5 * 60_000,
  revokeAfterMs: 15 * 60_000,
  dispatchShieldBeforeMs: 2 * 60_000,
} as const;

type MadridParts = { date: string; time: string; timeZone: "Europe/Madrid" };

export function madridNow(instant = new Date()): MadridParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const hour = values.hour === "24" ? "00" : values.hour;
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${hour}:${values.minute}`, timeZone: "Europe/Madrid" };
}

export function madridLocalToUtc(date: string, time: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = target;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
    const observed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, 0);
    const difference = target - observed;
    guess += difference;
    if (difference === 0) break;
  }
  return new Date(guess);
}

export type ShiftConnectionDecision = "before_shift" | "reminder_due" | "within_grace" | "warning_due" | "revoke_due" | "after_shift";

export function decideShiftConnectionAction(input: { now: Date; scheduledStart: Date; scheduledEnd: Date; status: string; connected: boolean; reminderSentAt?: Date | null; warningAt?: Date | null; revokedAt?: Date | null }): ShiftConnectionDecision {
  const elapsed = input.now.getTime() - input.scheduledStart.getTime();
  if (input.now.getTime() < input.scheduledStart.getTime() - RIDER_SHIFT_POLICY.reminderBeforeMs) return "before_shift";
  if (input.now.getTime() < input.scheduledStart.getTime()) return input.reminderSentAt ? "before_shift" : "reminder_due";
  if (input.revokedAt || input.status === "cancelled") return "after_shift";
  if (input.now.getTime() >= input.scheduledEnd.getTime()) return "after_shift";
  if (input.connected) return "within_grace";
  if (elapsed >= RIDER_SHIFT_POLICY.revokeAfterMs) return "revoke_due";
  if (elapsed >= RIDER_SHIFT_POLICY.warningAfterMs) return input.warningAt ? "within_grace" : "warning_due";
  return "within_grace";
}

export function isDispatchShielded(now: Date, slot: { date: string; startTime: string; endTime: string; status: string }): boolean {
  if (slot.status !== "active") return false;
  const end = madridLocalToUtc(slot.date, slot.endTime);
  return now.getTime() >= end.getTime() - RIDER_SHIFT_POLICY.dispatchShieldBeforeMs;
}

function isFreshLocation(rider: any, now: Date) {
  return Boolean(rider?.lastLocationAt && new Date(rider.lastLocationAt).getTime() >= now.getTime() - 90_000);
}

function appendNote(existing: string, note: string) {
  const current = String(existing || "").trim();
  return `${current}${current ? " · " : ""}${note}`.slice(-1000);
}

async function publishShiftEvent(input: { type: string; rider: any; slot: any; title: string; message: string; action?: "updated" | "cancelled" }) {
  const riderId = String(input.rider._id);
  const slotId = String(input.slot._id);
  const payload = {
    riderId,
    riderCode: input.rider.riderCode || null,
    riderName: input.rider.name || null,
    slotId,
    date: input.slot.date,
    startTime: input.slot.startTime,
    endTime: input.slot.endTime,
    title: input.title,
    message: input.message,
    action: input.action || "updated",
    occurredAt: new Date().toISOString(),
  };
  await Promise.allSettled([
    publishRealtimeEvent({ channel: "rider", audienceKey: `rider:${riderId}`, tenantId: input.rider.tenantId, type: input.type, payload, dedupeKey: `shift:${input.type}:${slotId}` }),
    publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(input.rider.tenantId, "fleet"), tenantId: input.rider.tenantId, type: input.type, payload, dedupeKey: `shift:${input.type}:fleet:${slotId}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(input.rider.tenantId, "admin"), tenantId: input.rider.tenantId, type: input.type, payload, dedupeKey: `shift:${input.type}:admin:${slotId}` }),
  ]);
}

export async function runRiderShiftAutomation(now = new Date()) {
  if (mongoose.connection.readyState !== 1) return { reminders: 0, warnings: 0, revoked: 0, shielded: 0 };
  const today = madridNow(now).date;
  const slots = await RiderSlot.find({ date: today, status: { $in: ["planned", "active"] } }).lean().exec() as any[];
  if (!slots.length) return { reminders: 0, warnings: 0, revoked: 0, shielded: 0 };
  const riders = await Rider.find({ _id: { $in: slots.map((slot) => slot.riderId) } }).select("_id tenantId riderCode name email status lastLocationAt activeOrderId").lean().exec() as any[];
  const ridersById = new Map(riders.map((rider) => [String(rider._id), rider]));
  let reminders = 0;
  let warnings = 0;
  let revoked = 0;
  let shielded = 0;

  for (const slot of slots) {
    const rider = ridersById.get(String(slot.riderId));
    if (!rider) continue;
    const scheduledStart = madridLocalToUtc(slot.date, slot.startTime);
    const scheduledEnd = madridLocalToUtc(slot.date, slot.endTime);
    const connected = ["available", "busy"].includes(String(rider.status)) && isFreshLocation(rider, now);
    const decision = decideShiftConnectionAction({ now, scheduledStart, scheduledEnd, status: slot.status, connected, reminderSentAt: slot.connectionReminderSentAt, warningAt: slot.connectionWarningAt, revokedAt: slot.connectionRevokedAt });

    if (decision === "reminder_due") {
      const updated = await RiderSlot.findOneAndUpdate({ _id: slot._id, status: "planned", connectionReminderSentAt: null }, { $set: { connectionReminderSentAt: now } }, { new: true }).lean().exec();
      if (updated) {
        reminders += 1;
        await publishShiftEvent({ type: "rider.shift_start_reminder", rider, slot: updated, title: "Tu jornada empieza en 15 minutos", message: `Conéctate a las ${slot.startTime} para no perder tu turno.` });
      }
      continue;
    }

    if (decision === "warning_due") {
      const updated = await RiderSlot.findOneAndUpdate({ _id: slot._id, status: { $in: ["planned", "active"] }, connectionWarningAt: null }, { $set: { connectionWarningAt: now } }, { new: true }).lean().exec();
      if (updated) {
        warnings += 1;
        await publishShiftEvent({ type: "rider.shift_connection_warning", rider, slot: updated, title: "Conexión pendiente", message: "Llevas 5 minutos sin conexión al inicio de tu jornada. Conéctate ahora para conservar el turno." });
      }
      continue;
    }

    if (decision === "revoke_due") {
      const updated = await RiderSlot.findOneAndUpdate({ _id: slot._id, status: { $in: ["planned", "active"] }, connectionRevokedAt: null }, { $set: { status: "cancelled", connectionRevokedAt: now, notes: appendNote(slot.notes, `Turno revocado automáticamente por no conexión a las ${now.toISOString()}.`) } }, { new: true }).lean().exec();
      if (updated) {
        revoked += 1;
        if (!rider.activeOrderId) await Rider.updateOne({ _id: rider._id, activeOrderId: null }, { $set: { status: "offline" } }).exec();
        await publishShiftEvent({ type: "rider.shift_auto_revoked", rider, slot: updated, title: "Turno revocado", message: "Tu turno ha sido revocado por no conectarte durante los primeros 15 minutos.", action: "cancelled" });
      }
      continue;
    }

    if (isDispatchShielded(now, slot)) {
      shielded += 1;
      if (!slot.dispatchShieldedAt) {
        const updated = await RiderSlot.findOneAndUpdate({ _id: slot._id, status: "active", dispatchShieldedAt: null }, { $set: { dispatchShieldedAt: now } }, { new: true }).lean().exec();
        if (updated) await publishShiftEvent({ type: "rider.shift_dispatch_shielded", rider, slot: updated, title: "Fin de turno próximo", message: "No recibirás nuevos pedidos durante los últimos 2 minutos de tu turno." });
      }
    }

    if (decision === "after_shift" && slot.status === "active") {
      await RiderSlot.updateOne({ _id: slot._id, status: "active" }, { $set: { status: "completed" } }).exec();
    }
  }
  return { reminders, warnings, revoked, shielded };
}
