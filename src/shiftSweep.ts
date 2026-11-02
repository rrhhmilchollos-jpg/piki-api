/**
 * Barrido de jornada.
 *
 * Cada pocos minutos se comprueba qué riders han salido de su tramo o han
 * agotado sus horas. A los que ya no pueden trabajar se les cierra la sesión,
 * se les pone fuera de línea y, si llevan un pedido encima, ese pedido se
 * libera para que otro rider lo recoja. Un pedido colgado no se queda muerto.
 */

import { evaluateShift, type RiderShiftPlan, type ShiftDecision } from "./shiftEnforcement.js";

export type AssignedOrder = {
  orderId: string;
  publicCode: string;
  riderId: string;
  status: string;
  /** Minutos que lleva asignado: si es excesivo, se libera aunque el rider siga en jornada. */
  assignedMinutes: number;
};

export type SweepAction =
  | { kind: "logout"; riderId: string; reason: ShiftDecision["reason"] }
  | { kind: "release_order"; riderId: string; publicCode: string; reason: "fin_de_jornada" | "pedido_abandonado" };

export type SweepResult = {
  checked: number;
  loggedOut: number;
  released: number;
  actions: SweepAction[];
};

/** Un pedido asignado más de 90 minutos sin moverse está claramente atascado. */
export const ABANDONED_AFTER_MINUTES = 90;

/** Estados en los que el rider ya lleva el pedido encima y va de camino. */
export const IN_PROGRESS_STATUSES: string[] = ["picked_up", "on_the_way"];

/**
 * Un pedido recogido que lleva cuatro horas sin entregarse no está «en ruta»:
 * el rider lo abandonó. Se devuelve a la cola para que otro lo recoja.
 */
export const IN_PROGRESS_ABANDON_AFTER_MINUTES = 240;

/**
 * Decide las acciones del barrido sin tocar la base de datos, para poder
 * probarlo con casos concretos.
 */
export function planSweep(input: {
  now: Date;
  riders: Array<{ riderId: string; plan: RiderShiftPlan; workedMinutesThisWeek: number }>;
  orders: AssignedOrder[];
}): SweepResult {
  const ordersByRider = new Map<string, AssignedOrder[]>();
  for (const order of input.orders) {
    const list = ordersByRider.get(order.riderId) ?? [];
    list.push(order);
    ordersByRider.set(order.riderId, list);
  }

  const actions: SweepAction[] = [];
  let loggedOut = 0;
  let released = 0;

  for (const rider of input.riders) {
    const decision = evaluateShift(rider.plan, rider.workedMinutesThisWeek, input.now);
    const suyos = ordersByRider.get(rider.riderId) ?? [];

    if (!decision.onlineAllowed) {
      actions.push({ kind: "logout", riderId: rider.riderId, reason: decision.reason });
      loggedOut += 1;
      for (const order of suyos) {
        actions.push({
          kind: "release_order",
          riderId: rider.riderId,
          publicCode: order.publicCode,
          reason: "fin_de_jornada",
        });
        released += 1;
      }
      continue;
    }

    // Sigue en jornada, pero puede tener un pedido abandonado de antes.
    for (const order of suyos) {
      if (order.assignedMinutes >= ABANDONED_AFTER_MINUTES) {
        actions.push({
          kind: "release_order",
          riderId: rider.riderId,
          publicCode: order.publicCode,
          reason: "pedido_abandonado",
        });
        released += 1;
      }
    }
  }

  return { checked: input.riders.length, loggedOut, released, actions };
}

/** Estados en los que el pedido todavía se puede reasignar sin romper nada. */
export const RELEASABLE_STATUSES = ["assigned", "accepted", "preparing", "ready_for_pickup"] as const;

export function isReleasable(status: string): boolean {
  return (RELEASABLE_STATUSES as readonly string[]).includes(status);
}

/**
 * ¿El pedido lleva demasiado tiempo en ruta? Solo aplica a pedidos ya
 * recogidos: si aún no han salido del local, basta con reasignarlos.
 */
export function isStaleInRoute(
  order: { status?: string | null; riderArrivedAt?: Date | string | null; assignedAt?: Date | string | null; createdAt?: Date | string | null },
  now: Date = new Date(),
  thresholdMinutes: number = IN_PROGRESS_ABANDON_AFTER_MINUTES,
): boolean {
  if (!order || !IN_PROGRESS_STATUSES.includes(String(order.status))) return false;
  const since = order.riderArrivedAt || order.assignedAt || order.createdAt;
  if (!since) return false;
  const startedAt = new Date(since);
  if (Number.isNaN(startedAt.getTime())) return false;
  return (now.getTime() - startedAt.getTime()) / 60_000 >= thresholdMinutes;
}
