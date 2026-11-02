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
 */
import mongoose from "mongoose";

export type CodHoldStatus = "authorized" | "captured" | "released" | "failed";

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
}

const codHoldSchema = new mongoose.Schema<CodHoldDocument>(
  {
    reference: { type: String, required: true, unique: true, index: true },
    amountCents: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["authorized", "captured", "released", "failed"],
      default: "authorized",
      index: true,
    },
    paymentIntentId: { type: String, required: true, index: true },
    clientSecret: { type: String, default: null },
    expiresAt: { type: Date, required: true, index: true },
    capturedCents: { type: Number, default: null },
    resolvedAt: { type: Date, default: null },
    reason: { type: String, default: null },
  },
  { timestamps: true },
);

export const CodHold =
  (mongoose.models.CodHold as mongoose.Model<CodHoldDocument>) ||
  mongoose.model<CodHoldDocument>("CodHold", codHoldSchema);

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
