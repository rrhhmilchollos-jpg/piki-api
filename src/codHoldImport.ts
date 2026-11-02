/**
 * Importación de garantías que solo existen en Stripe.
 *
 * Una retención puede quedarse en el banco sin registro local si la petición
 * murió entre la creación del pago y el guardado en Mongo, o si el pedido no se
 * pudo resolver. Esas retenciones son invisibles para el barrido, para Fleet y
 * para contabilidad: dinero comprometido del cliente que nadie mira.
 *
 * Esta pasada lee lo que hay en Stripe y da de alta lo que falte, sin tocar
 * nada de lo que ya está registrado.
 */
import mongoose from "mongoose";
import { CodHold, normalizeReference } from "./codHolds.js";
import { listGuaranteeIntents, stripeConfigured } from "./stripePayments.js";

const IMPORTABLE_STATUSES = ["requires_capture", "requires_confirmation", "requires_action", "requires_payment_method"];

export interface CodHoldImportReport {
  scanned: number;
  imported: number;
  skipped: number;
  errors: string[];
}

export async function importStripeGuarantees(limit = 100): Promise<CodHoldImportReport> {
  const report: CodHoldImportReport = { scanned: 0, imported: 0, skipped: 0, errors: [] };
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
      const known = await CodHold.findOne({ paymentIntentId: snapshot.paymentIntentId }).select("_id").lean().exec();
      if (known) {
        report.skipped += 1;
        continue;
      }
      const reference = snapshot.reference
        ? normalizeReference(snapshot.reference)
        : `STRIPE-${snapshot.paymentIntentId.replace(/[^A-Za-z0-9]/g, "").slice(-8).toUpperCase()}`;
      const orderId = snapshot.orderId && mongoose.isValidObjectId(snapshot.orderId)
        ? new mongoose.Types.ObjectId(snapshot.orderId)
        : null;
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
