/**
 * Registro de retenciones por referencia de pedido.
 *
 * El pedido del cliente nace en la base de datos del servidor de Customer, y su
 * copia en Mongo puede no existir todavía cuando el cliente confirma la tarjeta.
 * Para que la garantía no dependa de esa copia, la retención se guarda aquí
 * con la referencia visible del pedido (PIKI-XXXX) como clave.
 *
 * Así el cobro funciona igual si el pedido ya está sincronizado o si aún no lo
 * está, que es exactamente el caso que rompía la versión anterior.
 *
 * El ciclo de vida es cerrado, sin estados imposibles:
 *
 *   authorized ──► released   (el cliente pagó en efectivo, o el banco la soltó)
 *              ──► captured   (se cobró porque el cliente no pagó)
 *              ──► expired    (caducó en el banco sin llegar a cobrarse)
 *              ──► failed     (el cliente nunca completó la confirmación)
 *
 * Solo `authorized` es dinero comprometido del cliente. Todo lo demás es
 * historial contable, y por eso el barrido automático se centra en vaciar ese
 * estado: una garantía que nadie resuelve acaba desapareciendo sola en el banco
 * y deja el pedido sin cobertura.
 */
import mongoose from "mongoose";

export type CodHoldStatus = "authorized" | "captured" | "released" | "expired" | "failed";

export interface CodHoldDocument extends mongoose.Document {
  reference: string;
  amountCents: number;
  status: CodHoldStatus;
  paymentIntentId: string;
  clientSecret: string | null;
  expiresAt: Date;
  capturedCents: number | null;
  resolvedAt: Date | null;
  reason: string | null;
  orderId: mongoose.Types.ObjectId | null;
  stripeStatus: string | null;
  sweepAttempts: number;
  lastSweepAt: Date | null;
  lastSweepReason: string | null;
  sweepClaimedUntil: Date | null;
}

const codHoldSchema = new mongoose.Schema<CodHoldDocument>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    amountCents: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["authorized", "captured", "released", "expired", "failed"],
      default: "authorized",
      index: true,
    },
    paymentIntentId: { type: String, required: true, index: true },
    clientSecret: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: true },
    capturedCents: { type: Number, default: null },
    resolvedAt: { type: Date, default: null, index: true },
    reason: { type: String, default: null },
    // Pedido local con el que se pudo conciliar la retención, si existe.
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null, index: true },
    // Último estado que devolvió Stripe: es la verdad del dinero.
    stripeStatus: { type: String, default: null },
    sweepAttempts: { type: Number, default: 0, min: 0 },
    lastSweepAt: { type: Date, default: null },
    lastSweepReason: { type: String, default: null },
    // Reserva temporal para que dos instancias no liberen la misma retención.
    sweepClaimedUntil: { type: Date, default: null, index: true },
  },
  { timestamps: true, collection: "cod_holds" },
);

// El barrido busca siempre lo mismo: retenciones vivas ordenadas por caducidad.
codHoldSchema.index({ status: 1, expiresAt: 1 });

export const CodHold =
  (mongoose.models.CodHold as mongoose.Model<CodHoldDocument>) ||
  mongoose.model<CodHoldDocument>("CodHold", codHoldSchema);

/** Estados en los que la retención todavía puede moverse. */
export const OPEN_COD_HOLD_STATUSES: CodHoldStatus[] = ["authorized"];

/** Normaliza la referencia para que PIKI-abc y pikidelivery-abc sean lo mismo. */
export function normalizeReference(reference: string): string {
  return String(reference).trim().toUpperCase().replace(/^PIKI-?/i, "");
}

export async function findHoldByReference(reference: string) {
  return CodHold.findOne({ reference: normalizeReference(reference) });
}

/** Retenciones activas a punto de caducar, para liberarlas con margen. */
export async function findExpiringHolds(from: Date, to: Date) {
  return CodHold.find({
    status: "authorized",
    expiresAt: { $lte: to, $gte: from },
  })
    .limit(200)
    .lean();
}

export interface CodHoldLiability {
  activeHolds: number;
  activeCents: number;
  expiringIn24h: number;
  expiringCents: number;
  alreadyExpired: number;
  oldestCreatedAt: Date | null;
}

/**
 * Foto del dinero comprometido: lo que PIKI tiene retenido a clientes y aún no
 * ha conciliado. Es la cifra que contabilidad necesita ver a cero (o explicada)
 * antes de abrir.
 */
export async function codHoldLiability(now: Date = new Date()): Promise<CodHoldLiability> {
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const rows = (await CodHold.aggregate([
    { $match: { status: "authorized" } },
    {
      $group: {
        _id: null,
        activeHolds: { $sum: 1 },
        activeCents: { $sum: "$amountCents" },
        expiringIn24h: { $sum: { $cond: [{ $lte: ["$expiresAt", in24h] }, 1, 0] } },
        expiringCents: { $sum: { $cond: [{ $lte: ["$expiresAt", in24h] }, "$amountCents", 0] } },
        alreadyExpired: { $sum: { $cond: [{ $lte: ["$expiresAt", now] }, 1, 0] } },
        oldestCreatedAt: { $min: "$createdAt" },
      },
    },
  ]).exec()) as Array<Record<string, unknown>>;

  const aggregate = rows[0];
  if (!aggregate) {
    return { activeHolds: 0, activeCents: 0, expiringIn24h: 0, expiringCents: 0, alreadyExpired: 0, oldestCreatedAt: null };
  }
  return {
    activeHolds: Number(aggregate.activeHolds ?? 0),
    activeCents: Number(aggregate.activeCents ?? 0),
    expiringIn24h: Number(aggregate.expiringIn24h ?? 0),
    expiringCents: Number(aggregate.expiringCents ?? 0),
    alreadyExpired: Number(aggregate.alreadyExpired ?? 0),
    oldestCreatedAt: aggregate.oldestCreatedAt ? new Date(aggregate.oldestCreatedAt as string) : null,
  };
}
