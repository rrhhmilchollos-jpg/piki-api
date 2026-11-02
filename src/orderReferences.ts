/**
 * Localización de pedidos por su referencia visible.
 *
 * El cliente ve un código corto (PIKI-XXXX) y es lo que viaja en la garantía de
 * tarjeta, en el manifiesto del rider y en los avisos de soporte. En la base de
 * datos ese mismo pedido puede estar guardado como `publicCode`, `displayCode`,
 * `orderCode` e incluso sin el prefijo. Este módulo concentra esa traducción
 * para que el cobro y el barrido de garantías no la reimplementen cada uno a su
 * manera.
 */
import mongoose from "mongoose";
import { normalizeReference } from "./codHolds.js";
import { Order } from "./models.js";

/** Campos del pedido que pueden llevar la referencia visible. */
export const ORDER_REFERENCE_FIELDS = ["displayCode", "publicCode", "orderCode", "shortOrderNumber", "code"] as const;

/** Variantes con las que puede aparecer escrita una misma referencia. */
export function referenceCandidates(...values: Array<string | null | undefined>): string[] {
  const candidates = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const raw = String(value).trim();
    if (!raw) continue;
    candidates.add(raw);
    candidates.add(raw.toUpperCase());
    const bare = normalizeReference(raw);
    if (!bare) continue;
    candidates.add(bare);
    candidates.add(`PIKI-${bare}`);
    candidates.add(`PIKI${bare}`);
  }
  return [...candidates];
}

/** Claves normalizadas de un pedido, para cruzarlo con una retención. */
export function orderReferenceKeys(order: Record<string, unknown>): string[] {
  const keys = new Set<string>();
  for (const field of ORDER_REFERENCE_FIELDS) {
    const value = order[field];
    if (typeof value !== "string" || !value.trim()) continue;
    keys.add(normalizeReference(value));
  }
  return [...keys].filter(Boolean);
}

export interface OrderSnapshot {
  orderId: string;
  reference: string;
  paymentState: string;
  status: string;
  cashCollectedAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  createdAt: Date | null;
}

const SNAPSHOT_FIELDS = [
  "displayCode",
  "publicCode",
  "orderCode",
  "shortOrderNumber",
  "code",
  "paymentState",
  "paymentStatus",
  "status",
  "cashCollectedAt",
  "deliveredAt",
  "cancelledAt",
  "createdAt",
].join(" ");

function toSnapshot(order: Record<string, any>): OrderSnapshot {
  return {
    orderId: String(order._id),
    reference: String(order.displayCode || order.publicCode || order.orderCode || order._id),
    // `paymentState` es el campo real del esquema; `paymentStatus` se llegó a
    // escribir en versiones anteriores y puede quedar en documentos viejos.
    paymentState: String(order.paymentState || order.paymentStatus || "pending"),
    status: String(order.status || "pending"),
    cashCollectedAt: order.cashCollectedAt ? new Date(order.cashCollectedAt) : null,
    deliveredAt: order.deliveredAt ? new Date(order.deliveredAt) : null,
    cancelledAt: order.cancelledAt ? new Date(order.cancelledAt) : null,
    createdAt: order.createdAt ? new Date(order.createdAt) : null,
  };
}

/**
 * Busca el pedido de una referencia. Acepta ObjectId, código visible, código
 * corto y cualquier variante de mayúsculas o prefijo.
 */
export async function findOrderByReference(reference: string, extraCode?: string | null) {
  if (mongoose.isValidObjectId(reference)) {
    const byId = await Order.findById(reference);
    if (byId) return byId;
  }
  const candidates = referenceCandidates(reference, extraCode);
  const exact = await Order.findOne({
    $or: ORDER_REFERENCE_FIELDS.map((field) => ({ [field]: { $in: candidates } })),
  });
  if (exact) return exact;

  // Último recurso: comparación sin distinguir mayúsculas ni el prefijo PIKI-.
  const bare = String(reference).trim().replace(/^PIKI-?/i, "");
  if (!bare) return null;
  const pattern = new RegExp(`^\\s*(PIKI-?)?${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  return Order.findOne({
    $or: ORDER_REFERENCE_FIELDS.map((field) => ({ [field]: pattern })),
  });
}

/**
 * Resuelve en una sola consulta los pedidos de un lote de referencias.
 *
 * El barrido de garantías tiene que saber si el pedido existe para no liberar
 * una retención que aún sostiene una entrega. Hacerlo de uno en uno serían
 * cientos de consultas por pasada; esto lo deja en una.
 */
export async function mapOrdersByReference(references: string[]): Promise<Map<string, OrderSnapshot>> {
  const wanted = new Set(references.map((reference) => normalizeReference(reference)).filter(Boolean));
  const found = new Map<string, OrderSnapshot>();
  if (!wanted.size) return found;

  const candidates = referenceCandidates(...references);
  const docs = (await Order.find({
    $or: ORDER_REFERENCE_FIELDS.map((field) => ({ [field]: { $in: candidates } })),
  })
    .select(SNAPSHOT_FIELDS)
    .limit(Math.min(500, Math.max(50, wanted.size * 2)))
    .lean()
    .exec()) as Record<string, any>[];

  for (const doc of docs) {
    const snapshot = toSnapshot(doc);
    for (const key of orderReferenceKeys(doc)) {
      if (!wanted.has(key) || found.has(key)) continue;
      found.set(key, snapshot);
    }
  }
  return found;
}
