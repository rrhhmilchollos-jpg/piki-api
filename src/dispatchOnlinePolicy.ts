import { EmployeeAccount, Order, Rider, RiderAssignmentReservation, RiderSlot, Tenant } from "./models.js";
import { EmployeeSession, frozenTenantId, sessionRole, sessionTenantMatchesEmployee } from "./employeeSessions.js";
import { dispatchableOrderStatuses, dispatchablePaymentFilter, isDispatchableOrderStatus, isDispatchablePayment } from "./dispatchEligibility.js";
import { riderSlotIsCurrent } from "./riderSchedulePolicy.js";
import { addDays, operationsClock, RiderShiftPlanModel, shiftPlanForSweep, weekStart, workedMinutesFromSlots } from "./shiftPlans.js";
import { evaluateShift, isValidPlan, planFitsContract } from "./shiftEnforcement.js";

export type DispatchPrincipal = { employeeId: string; tenantId: string; tokenHash: string };
type Phase = "new" | "reserved" | "accept" | "release";
type Options = { now?: Date; phase?: Phase; orderId?: unknown; principal?: DispatchPrincipal; sessionId?: unknown };
export type DispatchOnlineGuard = {
  rider: any; employee: any; session: any; slot: any; plan: any;
  tenantId: any; capacity: number; phase: Phase; orderId?: unknown;
  principal?: DispatchPrincipal;
};

function instant(value: unknown): number {
  return value == null ? NaN : new Date(value as string).getTime();
}
export function hasFreshDispatchGps(rider: any, now = new Date()): boolean {
  const age = now.getTime() - instant(rider?.lastLocationAt);
  const point = rider?.location?.coordinates;
  return Number.isFinite(age) && age >= 0 && age <= 90_000
    && Array.isArray(point) && point.length === 2
    && typeof point[0] === "number" && Number.isFinite(point[0]) && Math.abs(point[0]) <= 180
    && typeof point[1] === "number" && Number.isFinite(point[1]) && Math.abs(point[1]) <= 90;
}

export function dispatchOrderIsOperational(order: any): boolean {
  return Boolean(frozenTenantId(order?.tenantId) && isDispatchableOrderStatus(order?.status)
    && isDispatchablePayment(order?.paymentState));
}
export function dispatchOfferIsCurrent(order: any, now = new Date()): boolean {
  return dispatchOrderIsOperational(order) && order.assignmentState === "offered"
    && Boolean(order.riderId && order.offerId) && instant(order.assignmentExpiresAt) > now.getTime();
}
export function dispatchOrderCas(order: any, accept = false, now = new Date()) {
  return {
    _id: order._id, tenantId: order.tenantId, version: order.version,
    status: { $in: [...dispatchableOrderStatuses] }, ...dispatchablePaymentFilter,
    ...(accept ? { riderId: order.riderId, assignmentState: "offered", offerId: order.offerId,
      assignmentExpiresAt: { $gt: now } } : {
      riderId: null, assignmentState: { $in: ["unassigned", "expired", "rejected"] },
    }),
  };
}

/** Identity-only guard permits assigned-order GPS after slot end, not new offers. */
export async function loadDispatchIdentityGuard(riderId: unknown, tenantId: unknown, options: Options = {}) {
  if (!frozenTenantId(tenantId)) return null;
  const now = options.now ?? new Date();
  const rider = await Rider.findOne({ _id: riderId, tenantId }).lean().exec() as any;
  if (!rider || !sessionTenantMatchesEmployee(tenantId, rider.tenantId)
    || rider.lifecycleStatus !== "active" || !rider.email) return null;
  const tenant = await Tenant.findOne({ _id: tenantId, status: "active" }).select("_id").lean().exec();
  if (!tenant) return null;
  const employee = await EmployeeAccount.findOne({ email: rider.email, tenantId, active: true,
    authorizationStatus: "approved", mustChangePassword: false,
    ...(options.principal ? { _id: options.principal.employeeId } : {}),
  }).lean().exec() as any;
  if (!employee || employee.active !== true || employee.authorizationStatus !== "approved"
    || employee.mustChangePassword !== false || employee.email !== rider.email
    || !sessionTenantMatchesEmployee(tenantId, employee.tenantId)) return null;
  if (options.principal && !sessionTenantMatchesEmployee(tenantId, options.principal.tenantId)) return null;
  const sessions = await EmployeeSession.find({ employeeId: employee._id, tenantId, role: "rider",
    expiresAt: { $gt: now }, issuedAt: { $lte: now },
    ...(options.sessionId ? { _id: options.sessionId } : {}),
    ...(options.principal ? { tokenHash: options.principal.tokenHash } : {}),
  }).lean().exec() as any[];
  const session = sessions.find((candidate) => candidate.role === "rider"
    && String(candidate.employeeId) === String(employee._id)
    && sessionTenantMatchesEmployee(candidate.tenantId, employee.tenantId)
    && instant(candidate.expiresAt) > now.getTime() && instant(candidate.issuedAt) <= now.getTime()
    && (!employee.passwordChangedAt || instant(employee.passwordChangedAt) <= instant(candidate.issuedAt))
    && sessionRole(employee, candidate.surface, candidate.role) === "rider"
    && (!options.sessionId || String(candidate._id) === String(options.sessionId))
    && (!options.principal || candidate.tokenHash === options.principal.tokenHash));
  if (!session) return null;
  return { rider, employee, session };
}

/** Read only: never refresh a session, open a slot, change a plan or reconstruct a punch. */
export async function loadDispatchOnlineGuard(
  riderId: unknown, tenantId: unknown, maxOrders = 1, options: Options = {},
): Promise<DispatchOnlineGuard | null> {
  const now = options.now ?? new Date();
  const phase = options.phase ?? "new";
  const capacity = Math.min(2, Math.max(1, maxOrders));
  const identity = await loadDispatchIdentityGuard(riderId, tenantId, options);
  if (!identity) return null;
  const { rider, employee, session } = identity;
  if (!["available", "busy"].includes(rider.status) || !hasFreshDispatchGps(rider, now)) return null;
  const clock = operationsClock(now);
  const start = weekStart(clock.date);
  const slots = await RiderSlot.find({ riderId: rider._id, tenantId,
    date: { $gte: addDays(start, -1), $lte: addDays(start, 6) },
    status: { $in: ["active", "completed"] },
  }).lean().exec() as any[];
  const ownedSlots = slots.filter((candidate) => String(candidate.riderId) === String(rider._id)
    && sessionTenantMatchesEmployee(candidate.tenantId, tenantId));
  const slot = ownedSlots.find((candidate) => candidate.status === "active"
    && candidate.stoppedAt == null && instant(candidate.startedAt) <= now.getTime()
    && riderSlotIsCurrent(candidate, clock));
  if (!slot) return null; // planned 12:00–00:00 is not an open working day.
  const plan = await RiderShiftPlanModel.findOne({ riderId: rider._id, tenantId }).lean().exec() as any;
  if (!plan || String(plan.riderId) !== String(rider._id) || !sessionTenantMatchesEmployee(plan.tenantId, tenantId)) return null;
  // Invalid persisted structures fail closed rather than throwing inside pure helpers.
  if (!Array.isArray(plan.shifts) || !plan.shifts.every((shift: any) => typeof shift.start === "string" && typeof shift.end === "string")) return null;
  const contract = { ...plan, riderId: String(rider._id) };
  const worked = workedMinutesFromSlots(ownedSlots, now, String(rider._id));
  // The assigned, actually punched ACTIVE slot is the time-window authority.
  // Retain the persisted contract/quota; do not restore a recurrent-plan cut
  // at 20:00 when Fleet's current assigned slot is 12:00–00:00.
  if (!isValidPlan(contract) || !planFitsContract(contract)
    || !evaluateShift(shiftPlanForSweep(contract, [slot], now, tenantId), worked, now).onlineAllowed) return null;
  const [reservations, orders] = await Promise.all([
    RiderAssignmentReservation.find({ riderId: rider._id, status: "reserved" }).lean().exec() as Promise<any[]>,
    Order.find({ riderId: rider._id, assignmentState: { $in: ["offered", "assigned"] },
      status: { $nin: ["delivered", "cancelled"] } }).select("_id tenantId").lean().exec() as Promise<any[]>,
  ]);
  if ([...reservations, ...orders].some((item) => !sessionTenantMatchesEmployee(item.tenantId, tenantId))) return null;
  const occupied = new Set([...reservations.map((item) => String(item.orderId)), ...orders.map((item) => String(item._id))]);
  if (phase === "new" ? occupied.size >= capacity : occupied.size > capacity) return null;
  if (phase !== "release" && rider.status === "available" && occupied.size > 0) return null;
  if (phase !== "release" && rider.activeOrderId && !occupied.has(String(rider.activeOrderId))) return null;
  if (phase === "new" && rider.status === "busy" && !occupied.size) return null;
  if ((phase === "accept" || phase === "reserved") && !reservations.some((item) =>
    String(item.orderId) === String(options.orderId) && (item.expiresAt == null || instant(item.expiresAt) > now.getTime()))) return null;
  return { rider, employee, session, slot, plan, tenantId, capacity, phase, orderId: options.orderId, principal: options.principal };
}

/** Snapshot CAS on the Rider document, including identity, lifecycle, GPS and capacity link. */
export function dispatchRiderCas(guard: DispatchOnlineGuard) {
  const rider = guard.rider;
  return { _id: rider._id, tenantId: guard.tenantId, email: rider.email, status: rider.status,
    lifecycleStatus: "active", activeOrderId: rider.activeOrderId ?? null,
    lastLocationAt: rider.lastLocationAt, location: rider.location, vehicle: rider.vehicle,
    updatedAt: rider.updatedAt ?? null };
}

/**
 * Re-read the same frozen session and contract immediately before the Rider CAS.
 * This narrows TOCTOU; it is not an atomic transaction across these documents.
 */
export async function confirmDispatchOnlineGuard(guard: DispatchOnlineGuard) {
  const now = new Date();
  const current = await loadDispatchOnlineGuard(guard.rider._id, guard.tenantId, guard.capacity, {
    now, phase: guard.phase, orderId: guard.orderId, principal: guard.principal, sessionId: guard.session._id,
  });
  if (!current) return null;
  const session = await EmployeeSession.exists({ _id: guard.session._id, employeeId: guard.employee._id,
    tenantId: guard.tenantId, tokenHash: guard.session.tokenHash, role: "rider", surface: guard.session.surface,
    issuedAt: guard.session.issuedAt, expiresAt: { $gt: new Date() } });
  if (!session) return null;
  // Match the original Rider snapshot, not a later disconnect/rebind/GPS update.
  const confirmedAt = new Date();
  if (!hasFreshDispatchGps(guard.rider, confirmedAt) || !riderSlotIsCurrent(current.slot, operationsClock(confirmedAt))) return null;
  return await Rider.findOneAndUpdate(dispatchRiderCas(guard), { $set: { status: guard.rider.status } }, { new: true }).lean().exec() as any;
}
