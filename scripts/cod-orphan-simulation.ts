/**
 * ¿Qué hace el barrido con una garantía huérfana?
 *
 * Huérfana = retención viva cuya referencia no tiene pedido en Mongo (el pedido
 * se creó en el servidor de Customer y no llegó a sincronizarse, o se borró).
 * Son las que antes se quedaban colgadas en la contabilidad para siempre.
 *
 * Simula cuatro edades distintas con las dos políticas posibles y comprueba que
 * ni se libera demasiado pronto ni se queda dinero retenido de más.
 *
 * Uso:
 *   MONGODB_URI=mongodb://127.0.0.1:27018/piki_cod_orphans npx tsx scripts/cod-orphan-simulation.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { CodHold } from "../src/codHolds.js";
import { CodHoldSweepRun, runCodHoldSweep, type CodHoldStripeAdapter } from "../src/codHoldSweep.js";
import { Order } from "../src/models.js";

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27018/piki_cod_orphans";
const now = new Date("2026-11-02T10:00:00.000Z");
const HOUR = 36e5;
const DAY = 24 * HOUR;

/** Stripe falso: todas las retenciones siguen vivas en el banco. */
function fakeStripe(): CodHoldStripeAdapter & { cancelled: string[] } {
  const cancelled: string[] = [];
  const statuses = new Map<string, string>();
  return {
    configured: true,
    cancelled,
    async retrieve(paymentIntentId: string) {
      return { paymentIntentId, status: statuses.get(paymentIntentId) ?? "requires_capture", amountCents: 498, capturedCents: 0 };
    },
    async release(paymentIntentId: string) {
      cancelled.push(paymentIntentId);
      statuses.set(paymentIntentId, "canceled");
      return { status: "canceled" };
    },
  };
}

type Scenario = { reference: string; ageHours: number };

async function seed(holds: Scenario[]) {
  await Promise.all([CodHold.deleteMany({}), CodHoldSweepRun.deleteMany({}), Order.deleteMany({})]);
  for (const hold of holds) {
    await CodHold.create({
      reference: hold.reference,
      amountCents: 498,
      status: "authorized",
      paymentIntentId: `pi_${hold.reference.toLowerCase()}`,
      expiresAt: new Date(now.getTime() + (7 * 24 - hold.ageHours) * HOUR),
      createdAt: new Date(now.getTime() - hold.ageHours * HOUR),
    });
  }
}

const SCENARIOS: Scenario[] = [
  { reference: "ORF2H", ageHours: 2 },
  { reference: "ORF8H", ageHours: 8 },
  { reference: "ORF30H", ageHours: 30 },
  { reference: "ORF7D", ageHours: 7 * 24 + 2 },
];

function describe(report: { decisions: Array<{ reference: string; action: string; reason: string }> }) {
  return report.decisions.map((decision) => `${decision.reference}: ${decision.action} (${decision.reason})`);
}

async function main() {
  await mongoose.connect(URI, { dbName: "piki_cod_orphans" });

  console.log("Política por defecto: PIKI_COD_ORPHAN_RELEASE_HOURS=0 (solo el plazo)");
  await seed(SCENARIOS);
  const strict = fakeStripe();
  const strictReport = await runCodHoldSweep({ apply: true, source: "worker", now, stripe: strict, orphanReleaseHours: 0, reconcileAfterHours: 6 });
  for (const line of describe(strictReport)) console.log(`  ${line}`);
  console.log(`  liberadas=${strictReport.released} revisadas=${strictReport.inspected} retenido=${(strictReport.liability.activeCents / 100).toFixed(2)} €`);
  assert.equal(strictReport.released, 1, "solo la que ya pasó de plazo");
  assert.deepEqual(strict.cancelled, ["pi_orf7d"], "no se toca ninguna garantía con plazo por delante");
  assert.equal(strictReport.liability.activeHolds, 3, "las tres jóvenes siguen vivas y contabilizadas");

  console.log("\nPolítica agresiva: PIKI_COD_ORPHAN_RELEASE_HOURS=24");
  await seed(SCENARIOS);
  const aggressive = fakeStripe();
  const aggressiveReport = await runCodHoldSweep({ apply: true, source: "worker", now, stripe: aggressive, orphanReleaseHours: 24, reconcileAfterHours: 6 });
  for (const line of describe(aggressiveReport)) console.log(`  ${line}`);
  console.log(`  liberadas=${aggressiveReport.released} revisadas=${aggressiveReport.inspected} retenido=${(aggressiveReport.liability.activeCents / 100).toFixed(2)} €`);
  assert.equal(aggressiveReport.released, 2, "la de 30 h y la vencida");
  assert.deepEqual(aggressive.cancelled.sort(), ["pi_orf30h", "pi_orf7d"].sort());
  assert.equal(aggressiveReport.liability.activeHolds, 2, "las de 2 h y 8 h se respetan: pueden ser un pedido en curso");

  console.log("\nRepetición: el barrido no vuelve a tocar lo ya resuelto");
  const repeat = await runCodHoldSweep({ apply: true, source: "worker", now, stripe: aggressive, orphanReleaseHours: 24, reconcileAfterHours: 6 });
  assert.equal(repeat.released, 0);
  assert.equal(aggressive.cancelled.length, 2, "no se repiten cancelaciones en Stripe");

  console.log("\nResumen");
  console.log("- 2 h y 8 h: se esperan (podrían ser una entrega en curso), nunca se adelantan");
  console.log("- 30 h sin pedido: con política 24 h se liberan; con la de defecto, esperan al plazo");
  console.log("- 7 días: siempre se liberan, marque lo que marque la política");
  console.log("- Ninguna se cobra automáticamente: solo se liberan o se dejan pasar");

  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("fallo:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
