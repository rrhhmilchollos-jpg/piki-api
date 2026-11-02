/**
 * Reparación del estado de reparto que deja pedidos sin rider.
 *
 * Cuando una reserva de plaza o el `activeOrderId` de un Rider se queda colgado
 * de un pedido que ya terminó, el reparto entra en un bucle silencioso: hay
 * riders elegibles, pero la reserva falla siempre y el pedido nunca llega a
 * ofrecerse. En los logs eso aparece como `DISPATCH_RESERVATION_RACE` repetido
 * cientos de veces hasta la carta muerta.
 *
 * Este módulo mira el estado real (pedido terminado o inexistente) y suelta lo
 * que ya no sostiene nada. Es idempotente: se puede ejecutar cada minuto.
 */
import mongoose from "mongoose";
import { Order, Rider, RiderAssignmentReservation } from "./models.js";

/** Una reserva que lleva horas sin corresponder a un pedido vivo es basura. */
export const STALE_RESERVATION_HOURS = 6;
/**
 * Margen para una reserva recién creada: entre reservar la plaza y marcar el
 * pedido como ofrecido pasan milisegundos, y soltarla en ese hueco dejaría al
 * reparto sin plaza justo cuando iba a usarla.
 */
export const FRESH_RESERVATION_GRACE_MS = 10 * 60_000;

const TERMINAL_STATUSES = ["delivered", "cancelled"];
/** Estados de pedido en los que el rider sí debe tener la plaza ocupada. */
const SLOT_HOLDING_ASSIGNMENTS = ["offered", "assigned"];

export type DispatchReconciliationReport = {
  inspectedReservations: number;
  releasedOrphanReservations: number;
  releasedStaleReservations: number;
  clearedRiderLocks: number;
  reopenedOffers: number;
};

type OrderSnapshot = {
  _id: unknown;
  status?: string;
  assignmentState?: string;
  riderId?: unknown;
};

function orderHoldsSlot(order?: OrderSnapshot | null) {
  if (!order) return false;
  if (TERMINAL_STATUSES.includes(String(order.status))) return false;
  return SLOT_HOLDING_ASSIGNMENTS.includes(String(order.assignmentState));
}

/**
 * Suelta reservas y bloqueos que ya no corresponden a ningún pedido vivo.
 * `dryRun` cuenta lo que haría sin tocar nada.
 */
export async function reconcileDispatchState(
  options: { now?: Date; dryRun?: boolean; limit?: number } = {},
): Promise<DispatchReconciliationReport> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const limit = Math.max(1, Math.min(1000, options.limit ?? 300));
  const report: DispatchReconciliationReport = {
    inspectedReservations: 0,
    releasedOrphanReservations: 0,
    releasedStaleReservations: 0,
    clearedRiderLocks: 0,
    reopenedOffers: 0,
  };

  const reservations = (await RiderAssignmentReservation.find({ status: "reserved" })
    .select("_id orderId riderId slot updatedAt createdAt")
    .sort({ updatedAt: 1 })
    .limit(limit)
    .lean()
    .exec()) as unknown as Array<{
    _id: unknown;
    orderId: unknown;
    riderId?: unknown;
    slot?: number;
    updatedAt?: Date;
    createdAt?: Date;
  }>;
  report.inspectedReservations = reservations.length;

  const orderIds = [...new Set(reservations.map((row) => String(row.orderId)))].filter((id) => mongoose.isValidObjectId(id));
  const orders = (await Order.find({ _id: { $in: orderIds } })
    .select("_id status assignmentState riderId")
    .lean()
    .exec()) as unknown as OrderSnapshot[];
  const ordersById = new Map(orders.map((order) => [String(order._id), order]));

  for (const reservation of reservations) {
    const order = ordersById.get(String(reservation.orderId));
    const ageMs = now.getTime() - new Date(reservation.updatedAt ?? reservation.createdAt ?? now).getTime();
    const stale = ageMs > STALE_RESERVATION_HOURS * 36e5;
    const terminalOrMissing = !order || TERMINAL_STATUSES.includes(String(order.status));
    if (!terminalOrMissing && (orderHoldsSlot(order) || ageMs < FRESH_RESERVATION_GRACE_MS)) {
      // El pedido sigue vivo y la plaza se está usando: solo se toca si es muy vieja.
      if (!stale) continue;
      report.releasedStaleReservations += 1;
    } else if (!terminalOrMissing && stale) {
      report.releasedStaleReservations += 1;
    } else {
      report.releasedOrphanReservations += 1;
    }
    if (dryRun) continue;

    const released = await RiderAssignmentReservation.findOneAndUpdate(
      { _id: reservation._id, status: "reserved" },
      { $set: { status: "released", expiresAt: null } },
      { new: true },
    )
      .lean()
      .exec() as unknown as { riderId?: unknown; orderId?: unknown } | null;
    const riderId = released?.riderId ?? reservation.riderId;
    if (!riderId) continue;
    await releaseRiderIfIdle(String(riderId), String(reservation.orderId), dryRun);
  }

  // Bloqueos de Rider que apuntan a un pedido ya cerrado o desaparecido.
  const lockedRiders = (await Rider.find({ activeOrderId: { $ne: null }, isTestRider: { $ne: true } })
    .select("_id activeOrderId status")
    .limit(limit)
    .lean()
    .exec()) as unknown as Array<{ _id: unknown; activeOrderId?: unknown; status?: string }>;
  if (lockedRiders.length) {
    const activeOrders = (await Order.find({ _id: { $in: lockedRiders.map((rider) => rider.activeOrderId) } })
      .select("_id status assignmentState riderId")
      .lean()
      .exec()) as unknown as OrderSnapshot[];
    const activeById = new Map(activeOrders.map((order) => [String(order._id), order]));
    // Una reserva recién creada significa que el reparto está a mitad de la
    // asignación: el pedido todavía no dice «ofrecido» pero la plaza es legítima.
    const graceStart = new Date(now.getTime() - FRESH_RESERVATION_GRACE_MS);
    const inFlight = (await RiderAssignmentReservation.find({
      riderId: { $in: lockedRiders.map((rider) => rider._id) },
      status: "reserved",
      $or: [{ updatedAt: { $gt: graceStart } }, { createdAt: { $gt: graceStart } }],
    })
      .select("riderId")
      .lean()
      .exec()) as unknown as Array<{ riderId: unknown }>;
    const assigningRiders = new Set(inFlight.map((row) => String(row.riderId)));
    for (const rider of lockedRiders) {
      if (assigningRiders.has(String(rider._id))) continue;
      const order = activeById.get(String(rider.activeOrderId));
      if (orderHoldsSlot(order)) continue;
      report.clearedRiderLocks += 1;
      if (dryRun) continue;
      await releaseRiderIfIdle(String(rider._id), String(rider.activeOrderId), dryRun);
    }
  }

  // Ofertas imposibles: el pedido dice "ofrecido" pero ya no tiene rider.
  const brokenOffers = (await Order.find({ assignmentState: "offered", riderId: null, status: { $nin: TERMINAL_STATUSES } })
    .select("_id")
    .limit(limit)
    .lean()
    .exec()) as unknown as Array<{ _id: unknown }>;
  if (brokenOffers.length) {
    report.reopenedOffers = brokenOffers.length;
    if (!dryRun) {
      await Order.updateMany(
        { _id: { $in: brokenOffers.map((order) => order._id) }, assignmentState: "offered", riderId: null },
        { $set: { assignmentState: "unassigned", assignmentExpiresAt: null, offerId: null }, $inc: { dispatchAttempts: 1 } },
      ).exec();
    }
  }

  return report;
}

/** Deja al Rider libre solo si de verdad no le queda ninguna plaza ocupada. */
async function releaseRiderIfIdle(riderId: string, orderId: string, dryRun: boolean) {
  if (!mongoose.isValidObjectId(riderId)) return;
  const remaining = await RiderAssignmentReservation.countDocuments({ riderId, status: "reserved" }).exec();
  const update: Record<string, unknown> = remaining ? { status: "busy" } : { status: "available", activeOrderId: null };
  if (dryRun) return;
  await Rider.updateOne({ _id: riderId }, { $set: update }).exec();
  // Si la reserva apuntaba a este pedido y el pedido seguía creyendo que tenía
  // rider, se libera también el pedido para que vuelva a la cola.
  if (!remaining) {
    await Order.updateOne(
      { _id: orderId, assignmentState: "offered", riderId: null },
      { $set: { assignmentState: "unassigned", assignmentExpiresAt: null, offerId: null } },
    ).exec();
  }
}
