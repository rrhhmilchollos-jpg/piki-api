/**
 * Liquidación del contra reembolso con bloqueo en tarjeta.
 *
 * Regla de negocio:
 *  - El rider pulsa «he cobrado» en su app  ->  se LIBERA el bloqueo. El dinero
 *    vuelve a estar disponible para el cliente y PIKI no cobra nada.
 *  - El pedido se cancela y el rider NO confirma la entrega  ->  se CAPTURA el
 *    importe bloqueado, porque el rider ya había comprado la mercancía.
 *
 * Matiz que protege a PIKI y al cliente a la vez: si la cancelación ocurre
 * ANTES de que el rider compre, no hay gasto y se libera. Cobrar sin gasto sería
 * un abuso y nos expondría a reclamaciones con razón.
 */

export type CashOutcome =
  | "cash_collected"          // el rider confirma que cobró en efectivo
  | "delivered_no_cash"       // entregado pero el cliente no pagó
  | "cancelled_after_purchase" // cancelado cuando el rider ya había comprado
  | "cancelled_before_purchase" // cancelado antes de comprar: no hay gasto
  | "no_show";                // el cliente no aparece en el domicilio

export type Settlement = {
  release: boolean;
  capture: boolean;
  reason: string;
};

export function decideSettlement(outcome: CashOutcome): Settlement {
  switch (outcome) {
    case "cash_collected":
      return { release: true, capture: false, reason: "cobrado_en_efectivo" };
    case "cancelled_before_purchase":
      return { release: true, capture: false, reason: "cancelado_sin_compra" };
    case "delivered_no_cash":
      return { release: false, capture: true, reason: "entregado_sin_pago" };
    case "cancelled_after_purchase":
      return { release: false, capture: true, reason: "cancelado_con_compra" };
    case "no_show":
      return { release: false, capture: true, reason: "cliente_no_presentado" };
    default:
      return { release: false, capture: false, reason: "pendiente_de_confirmacion" };
  }
}

/**
 * Ventana de seguridad. Las autorizaciones de tarjeta caducan (7 días en la
 * mayoría de emisores). Si el pedido sigue abierto al acercarse el limite, hay
 * que resolverlo antes o el dinero se desbloquea solo y perdemos la garantía.
 */
export const HOLD_SAFETY_HOURS = 120; // 5 días

export function holdExpiresSoon(holdCreatedAt: Date, now = new Date()): boolean {
  const hours = (now.getTime() - holdCreatedAt.getTime()) / 36e5;
  return hours >= HOLD_SAFETY_HOURS;
}

/**
 * Un pedido en efectivo solo se puede aceptar si la tarjeta es válida y admite
 * autorización. Las tarjetas de débito españolas suelen admitirlo, pero no
 * todas: si el emisor lo rechaza no hay garantía y el pedido no debe salir.
 */
export function canAcceptCashOrder(input: {
  holdCreated: boolean;
  holdState?: string | null;
}): { ok: boolean; reason?: string } {
  if (!input.holdCreated) return { ok: false, reason: "sin_bloqueo" };
  if (input.holdState !== "requires_capture") return { ok: false, reason: `estado_${input.holdState || "desconocido"}` };
  return { ok: true };
}
