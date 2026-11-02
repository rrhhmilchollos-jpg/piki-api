/**
 * Importación de garantías que solo existen en Stripe.
 *
 * Una retención puede quedarse en el banco sin registro local si la petición
 * murió entre la creación del pago y el guardado en Mongo, o si el pedido no se
 * pudo resolver. Esas retenciones son invisibles para el barrido, para Fleet y
 * para contabilidad: dinero comprometido del cliente que nadie mira.
 *
 * Esta pasada lee lo que hay en Stripe, da de alta lo que falte y corrige la
 * referencia de lo que se importó sin poder atribuirlo a un pedido.
 */
import mongoose from "mongoose";
import { CodHold, normalizeReference } from "./codHolds.js";
import { listGuaranteeIntents, stripeConfigured } from "./stripePayments.js";
import { findOrderByReference } from "./orderReferences.js";

const IMPORTABLE_STATUSES = ["requires_capture", "requires_confirmation", "requires_action", "requires_payment_method"];
const SYNTHETIC_PREFIX = "STRIPE-";

export interface CodHoldImportReport {
  scanned: number;
  imported: number;
  renamed: number;
  skipped: number;
  errors: string[];
}

export async function importStripeGuarantees(limit = 100): Promise<CodHoldImportReport> {
  const report: CodHoldImportReport = { scanned: 0, imported: 0, renamed: 0, skipped: 0, errors: [] };
  if (!stripeConfigured()) return report;
  let snapshots: Awaited<ReturnType<typeof listGuaranteeIntents>>;
  try {
    snapshots = await listGuaranteeIntents(limit);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    return report;
  }
  report.scanned = snapshots.length;
  for (const snapshot of snapshots) {
    if (!IMPORTABLE_STATUSES.includes(snapshot.status)) {
      report.skipped += 1;
      continue;
    }
    try {
      // La referencia puede venir en su propio metadato o, en pagos creados por
      // la ruta antigua, dentro de orderId como código visible (PIKI-XXXX).
      const rawReference =
        snapshot.reference ||
        (snapshot.orderId && !mongoose.isValidObjectId(snapshot.orderId) ? snapshot.orderId : null);
      const reference = rawReference
        ? normalizeReference(rawReference)
        : `${SYNTHETIC_PREFIX}${snapshot.paymentIntentId.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase()}`;
      const order = await findOrderByReference(reference).catch(() => null);
      const orderId = order?.orderId
        ? new mongoose.Types.ObjectId(String(order.orderId))
        : snapshot.orderId && mongoose.isValidObjectId(snapshot.orderId)
          ? new mongoose.Types.ObjectId(snapshot.orderId)
          : null;

      const known = (await CodHold.findOne({ paymentIntentId: snapshot.paymentIntentId })
        .select("_id reference")
        .lean()
        .exec()) as { _id: mongoose.Types.ObjectId; reference: string } | null;
      if (known) {
        const attributable = reference && !reference.startsWith(SYNTHETIC_PREFIX);
        if (known.reference.startsWith(SYNTHETIC_PREFIX) && attributable) {
          // Se importó sin poder enlazarla con su pedido; ahora sí se puede.
          await CodHold.updateOne({ _id: known._id }, { $set: { reference, orderId } });
          report.renamed += 1;
          continue;
        }
        report.skipped += 1;
        continue;
      }

      const result = await CodHold.updateOne(
        { reference },
        {
          $setOnInsert: {
            reference,
            amountCents: snapshot.amountCents,
            status: snapshot.status === "requires_capture" ? "authorized" : "failed",
            paymentIntentId: snapshot.paymentIntentId,
            clientSecret: null,
            expiresAt: snapshot.expiresAt,
            orderId,
            stripeStatus: snapshot.status,
            reason: "importada_desde_stripe",
          },
        },
        { upsert: true },
      );
      if (result.upsertedCount > 0) report.imported += 1;
      else report.skipped += 1;
    } catch (error) {
      report.errors.push(`${snapshot.paymentIntentId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}
