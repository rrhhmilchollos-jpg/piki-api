export const TEST_ORDER_PURGE_SCOPE = "test-markers-plus-exact-kfc-xativa-qa" as const;
export const TEST_ORDER_PURGE_SCOPE_VERSION = 1;
export const TEST_ORDER_PURGE_MAX_CANDIDATES = 250;
export const TEST_ORDER_PURGE_TTL_MS = 10 * 60_000;
export const SAFE_TEST_ORDER_PAYMENT_STATES = ["pending", "failed", "expired"] as const;
export const SAFE_ISOLATED_QA_ORDER_STATUSES = ["pending", "accepted", "preparing", "ready_for_pickup"] as const;

export type PurgeOrderLike = {
  _id?: unknown;
  restaurantId?: unknown;
  qaRiderId?: unknown;
  isTestOrder?: boolean;
  status?: string;
  paymentState?: string;
  paymentMethod?: string;
  cashCollectedAt?: unknown;
  cashCollectedByRiderId?: unknown;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
};

const asId = (value: unknown) => value === null || value === undefined ? "" : String(value);

export function normalizeRestaurantName(value: unknown): string {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleUpperCase("es-ES");
}

/** Exact full-name match only; never a substring/prefix match. */
export function isExactQaRestaurantName(value: unknown): boolean {
  return normalizeRestaurantName(value) === "KFC XATIVA QA";
}

export function isPartnerTestOrderCandidate(order: Pick<PurgeOrderLike, "isTestOrder" | "qaRiderId">, restaurantName: unknown): boolean {
  return order.isTestOrder === true || Boolean(asId(order.qaRiderId)) || isExactQaRestaurantName(restaurantName);
}

export function getTestOrderMarkers(order: PurgeOrderLike, qaRestaurantIds: ReadonlySet<string>): string[] {
  const markers: string[] = [];
  if (order.isTestOrder === true) markers.push("isTestOrder:true");
  if (asId(order.qaRiderId)) markers.push("qaRiderId");
  if (qaRestaurantIds.has(asId(order.restaurantId))) markers.push("restaurant:KFC XATIVA QA exact");
  return markers;
}

/**
 * Hard deletion is limited to cancelled unpaid orders, or the API's isolated QA
 * dispatch simulation before pickup. Settled/unknown money states fail closed.
 */
export function getStaticPurgeBlockReasons(order: PurgeOrderLike, isolatedQaSimulation: boolean): string[] {
  const reasons: string[] = [];
  if (!(SAFE_TEST_ORDER_PAYMENT_STATES as readonly string[]).includes(String(order.paymentState || ""))) reasons.push("PAYMENT_STATE_NOT_SAFE");
  if (order.stripeCheckoutSessionId || order.stripePaymentIntentId) reasons.push("STRIPE_PAYMENT_REFERENCE");
  if (order.cashCollectedAt || order.cashCollectedByRiderId) reasons.push("CASH_COLLECTION_REFERENCE");

  if (order.status !== "cancelled") {
    const qaSimulationMayBeActive = isolatedQaSimulation && (SAFE_ISOLATED_QA_ORDER_STATUSES as readonly string[]).includes(String(order.status || ""));
    if (!qaSimulationMayBeActive) {
      reasons.push(["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"].includes(String(order.status || "")) ? "ORDER_ACTIVE" : "ORDER_NOT_CANCELLED");
    }
  }

  return [...new Set(reasons)];
}

export function isKnownQaSupportTicket(ticket: { sourceRole?: unknown; ticketNumber?: unknown }): boolean {
  return String(ticket.sourceRole || "").toLowerCase() === "qa" && /^SUP-QA-[A-Z0-9-]+$/i.test(String(ticket.ticketNumber || ""));
}

export function buildPurgeConfirmationPhrase(count: number): string {
  return `ELIMINAR ${count} PEDIDOS DE PRUEBA`;
}
