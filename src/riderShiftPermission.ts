import mongoose from "mongoose";
import { computeWorkedMinutesThisWeek, loadShiftPlan, shiftPlanForSweep, type WorkedSlot } from "./shiftPlans.js";
import { evaluateShift, isValidPlan, planFitsContract, type RiderShiftPlan } from "./shiftEnforcement.js";
import { operationsClock } from "./shiftPlans.js";
import { riderSlotIsCurrent } from "./riderSchedulePolicy.js";

export type RiderShiftBlockReason = "jornada_completa" | "plan_invalido" | "sin_plan" | "fuera_de_tramo";
export type RiderShiftPermission = {
  allowed: boolean;
  blockReason: RiderShiftBlockReason | null;
  blockMessage: string | null;
  weeklyHours: number | null;
  workedMinutesThisWeek: number;
  remainingMinutes: number | null;
};

type SlotInput = Omit<WorkedSlot, "riderId"> & { riderId: unknown };

/** Contract-only preflight: planned slots are eligible; GPS/auth remain route guards. */
export async function riderShiftPermission(
  rider: { _id: unknown; tenantId?: unknown },
  slot: SlotInput | null | undefined,
  now = new Date(),
): Promise<RiderShiftPermission> {
  const blocked = (blockReason: RiderShiftBlockReason, blockMessage: string, values: Partial<RiderShiftPermission> = {}): RiderShiftPermission => ({
    allowed: false, blockReason, blockMessage,
    weeklyHours: null, workedMinutesThisWeek: 0, remainingMinutes: null,
    ...values,
  });
  const riderId = String(rider._id);
  const tenantId = rider.tenantId == null ? null : String(rider.tenantId);
  if (!mongoose.isValidObjectId(riderId) || !mongoose.isValidObjectId(tenantId)) {
    return blocked("plan_invalido", "Jornada bloqueada: el Rider necesita un contrato válido de su organización. Contacta con tu flota.");
  }
  const [plan, workedByRider] = await Promise.all([
    loadShiftPlan(riderId),
    computeWorkedMinutesThisWeek([riderId], now),
  ]);
  const workedMinutesThisWeek = workedByRider.get(riderId) ?? 0;
  if (!plan) return blocked("sin_plan", "Jornada bloqueada: tu flota debe asignarte un contrato de jornada antes de empezar.", { workedMinutesThisWeek });
  // Never inherit a contract from another tenant, including legacy unbound plans.
  if (String(plan.riderId) !== riderId || plan.tenantId !== tenantId) {
    return blocked("plan_invalido", "Jornada bloqueada: el contrato no pertenece a tu organización. Contacta con tu flota.", { workedMinutesThisWeek });
  }
  const contract: RiderShiftPlan = plan;
  if (!Array.isArray(contract.shifts) || !contract.shifts.every((shift) => shift && typeof shift.start === "string" && typeof shift.end === "string")
    || !isValidPlan(contract) || !planFitsContract(contract)) {
    return blocked("plan_invalido", "Jornada bloqueada: tu contrato o sus tramos no son válidos. Contacta con tu flota.", { workedMinutesThisWeek });
  }
  const values = {
    weeklyHours: contract.weeklyHours,
    workedMinutesThisWeek,
    remainingMinutes: Math.max(0, contract.weeklyHours * 60 - workedMinutesThisWeek),
  };
  const ownedSlot: WorkedSlot | null = slot && String(slot.riderId) === riderId && String(slot.tenantId ?? "") === tenantId
    ? { ...slot, riderId } : null;
  const decision = evaluateShift(shiftPlanForSweep(contract, ownedSlot ? [ownedSlot] : [], now, tenantId), workedMinutesThisWeek, now);
  if (decision.reason === "jornada_completa") {
    return blocked("jornada_completa", `Has alcanzado las ${contract.weeklyHours} horas de tu contrato semanal. No puedes iniciar otra jornada hasta la próxima semana.`, values);
  }
  if (!ownedSlot || !["planned", "active"].includes(ownedSlot.status) || !riderSlotIsCurrent(ownedSlot, operationsClock(now)) || !decision.onlineAllowed) {
    return blocked("fuera_de_tramo", "Jornada bloqueada: solo puedes empezar dentro de tu turno asignado vigente.", values);
  }
  return { allowed: true, blockReason: null, blockMessage: null, ...values };
}

export function riderShiftPermissionError(permission: RiderShiftPermission): string {
  if (permission.blockReason === "jornada_completa") return "SHIFT_WEEKLY_LIMIT_REACHED";
  if (permission.blockReason === "sin_plan") return "SHIFT_PLAN_REQUIRED";
  if (permission.blockReason === "plan_invalido") return "SHIFT_PLAN_INVALID";
  return "SHIFT_OUTSIDE_SCHEDULE";
}
