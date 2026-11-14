export type SupportRiderStatus = "offline" | "available" | "busy" | "paused" | string;

export type ActiveRiderSupportOrder = {
  orderId: string;
  riderId: string;
  assignmentState?: string | null;
  status?: string | null;
};

const terminalOrderStatuses = new Set(["delivered", "cancelled"]);

export function canRiderOpenSupportCase(input: { riderStatus: SupportRiderStatus; order: ActiveRiderSupportOrder | null | undefined; requestedOrderId?: string | null }): boolean {
  if (!["available", "busy"].includes(input.riderStatus)) return false;
  if (!input.order || !input.requestedOrderId) return false;
  if (String(input.order.orderId) !== String(input.requestedOrderId)) return false;
  if (input.order.assignmentState !== "assigned") return false;
  if (!input.order.status || terminalOrderStatuses.has(input.order.status)) return false;
  return true;
}

export function supportWaitingMessage(status: string | null | undefined): string {
  return ["open", "waiting"].includes(String(status || ""))
    ? "El próximo agente disponible te atenderá en breve. Quédate a la espera de su respuesta."
    : "El caso está siendo atendido por Soporte PIKI.";
}
