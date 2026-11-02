import { model, Schema } from "mongoose";
import { isCashPaymentEnabledForRestaurant } from "./paymentPolicy.js";

/**
 * Modelo de cumplimiento por comercio.
 *
 * - `partner_managed`: el local recibe la comanda y la prepara (flujo clásico).
 * - `rider_purchase`: nadie en el local gestiona pedidos; el rider compra con
 *   la tarjeta virtual de PIKI y entrega. El importe se carga contra el
 *   presupuesto de la tarjeta, nunca contra dinero propio del rider.
 */
export type FulfillmentModel = "partner_managed" | "rider_purchase";
export type PaymentMethod = "stripe" | "cash" | "bizum";

export type FulfillmentRestaurant = {
  name?: string | null;
  slug?: string | null;
  fulfillmentModel?: string | null;
  paymentMethods?: string[] | null;
  bizumOnly?: boolean | null;
  cashPaymentsEnabled?: boolean | null;
};

const METHODS: PaymentMethod[] = ["stripe", "cash", "bizum"];
const isMethod = (value: unknown): value is PaymentMethod => METHODS.includes(value as PaymentMethod);

export const DEFAULT_PAYMENT_METHODS: PaymentMethod[] = ["stripe", "cash"];

/** Métodos permitidos según la configuración del local. `bizumOnly` gana siempre. */
export function allowedPaymentMethods(restaurant: FulfillmentRestaurant | null | undefined): PaymentMethod[] {
  if (!restaurant) return DEFAULT_PAYMENT_METHODS;
  if (restaurant.bizumOnly === true) return ["bizum"];
  const configured = Array.isArray(restaurant.paymentMethods) ? restaurant.paymentMethods.filter(isMethod) : [];
  return configured.length ? configured : DEFAULT_PAYMENT_METHODS;
}

export function isRiderPurchase(restaurant: FulfillmentRestaurant | null | undefined): boolean {
  return restaurant?.fulfillmentModel === "rider_purchase";
}

export type PaymentDecision =
  | { ok: true; method: PaymentMethod; paymentState: string; requiresPrepayment: boolean; riderPurchase: boolean; allowed: PaymentMethod[] }
  | { ok: false; status: number; error: string; message: string; allowed: PaymentMethod[] };

/** Decide si el método pedido por el cliente es aceptable para este local. */
export function paymentDecision(restaurant: FulfillmentRestaurant | null | undefined, requested: unknown): PaymentDecision {
  const allowed = allowedPaymentMethods(restaurant);
  const name = restaurant?.name || "Este establecimiento";
  if (!isMethod(requested)) {
    return {
      ok: false,
      status: 409,
      error: "PAYMENT_METHOD_UNAVAILABLE",
      message: `${name} solo acepta: ${allowed.join(", ")}.`,
      allowed,
    };
  }
  if (!allowed.includes(requested)) {
    return {
      ok: false,
      status: 409,
      error: "PAYMENT_METHOD_NOT_ALLOWED",
      message: `${name} solo acepta: ${allowed.join(", ")}.`,
      allowed,
    };
  }
  if (requested === "cash" && !isCashPaymentEnabledForRestaurant(restaurant ?? {})) {
    return {
      ok: false,
      status: 409,
      error: "CASH_PAYMENT_NOT_ENABLED_FOR_PARTNER",
      message: `${name} no acepta efectivo. Elige otro método de pago.`,
      allowed,
    };
  }
  const paymentState =
    requested === "bizum" ? "pending_bizum_confirmation" : requested === "cash" ? "pending_cash_collection" : "pending_card";
  return {
    ok: true,
    method: requested,
    paymentState,
    requiresPrepayment: requested !== "cash",
    riderPurchase: isRiderPurchase(restaurant),
    allowed,
  };
}

/**
 * Referencia legible para conciliar un Bizum entrante con su pedido.
 * Va en el concepto de la transferencia, así que debe ser corta y única.
 */
export function bizumReferenceFor(publicCode: string): string {
  const clean = String(publicCode || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
  const body = clean.startsWith("PIKI") ? clean.slice(4) : clean;
  return `PIKI${body.slice(-6)}`;
}

const virtualCardSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: "Order", required: true, unique: true, index: true },
    publicCode: { type: String, default: null, index: true },
    restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", default: null, index: true },
    riderId: { type: Schema.Types.ObjectId, ref: "Rider", default: null, index: true },
    budgetCents: { type: Number, required: true, min: 0 },
    spentCents: { type: Number, default: 0, min: 0 },
    currency: { type: String, default: "EUR" },
    status: { type: String, enum: ["issued", "captured", "settled", "cancelled"], default: "issued", index: true },
    cardLast4: { type: String, default: null },
    transactions: [
      {
        _id: false,
        amountCents: { type: Number, required: true, min: 1 },
        receiptUrl: { type: String, default: null },
        note: { type: String, default: null },
        at: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true, collection: "rider_virtual_cards" },
);

export const RiderVirtualCard = model("RiderVirtualCard", virtualCardSchema);

/** Emite (o recupera) la tarjeta de un pedido. Idempotente por `orderId`. */
export async function issueVirtualCard(input: {
  orderId: unknown;
  publicCode?: string | null;
  restaurantId?: unknown;
  budgetCents: number;
}) {
  const budgetCents = Math.max(0, Math.round(Number(input.budgetCents) || 0));
  try {
    return await RiderVirtualCard.findOneAndUpdate(
      { orderId: input.orderId },
      {
        $setOnInsert: {
          orderId: input.orderId,
          publicCode: input.publicCode ?? null,
          restaurantId: input.restaurantId ?? null,
          budgetCents,
          spentCents: 0,
          status: "issued",
        },
      },
      { new: true, upsert: true },
    ).lean().exec();
  } catch (error) {
    const code = (error as { code?: number })?.code;
    if (code === 11000) return RiderVirtualCard.findOne({ orderId: input.orderId }).lean().exec();
    throw error;
  }
}

export function remainingCardCents(card: { budgetCents?: number; spentCents?: number } | null | undefined): number {
  if (!card) return 0;
  return Math.max(0, Number(card.budgetCents || 0) - Number(card.spentCents || 0));
}

export function canChargeCard(card: { status?: string; budgetCents?: number; spentCents?: number } | null | undefined, amountCents: number): boolean {
  if (!card || card.status !== "issued") return false;
  if (!Number.isInteger(amountCents) || amountCents <= 0) return false;
  return Number(card.spentCents || 0) + amountCents <= Number(card.budgetCents || 0);
}

/**
 * Carga un gasto contra la tarjeta de forma atómica: si dos capturas llegan a
 * la vez, la condición `$expr` impide superar el presupuesto.
 */
export async function chargeVirtualCard(input: {
  orderId: unknown;
  amountCents: number;
  receiptUrl?: string | null;
  note?: string | null;
}) {
  const amountCents = Math.round(Number(input.amountCents) || 0);
  if (!Number.isInteger(amountCents) || amountCents <= 0) return { ok: false as const, reason: "INVALID_AMOUNT" };
  const updated = await RiderVirtualCard.findOneAndUpdate(
    {
      orderId: input.orderId,
      status: "issued",
      $expr: { $lte: [{ $add: ["$spentCents", amountCents] }, "$budgetCents"] },
    },
    {
      $inc: { spentCents: amountCents },
      $push: { transactions: { amountCents, receiptUrl: input.receiptUrl ?? null, note: input.note ?? null, at: new Date() } },
    },
    { new: true },
  ).lean().exec();
  if (!updated) return { ok: false as const, reason: "INSUFFICIENT_BUDGET_OR_CARD_CLOSED" };
  return { ok: true as const, card: updated, remainingCents: remainingCardCents(updated as any) };
}
