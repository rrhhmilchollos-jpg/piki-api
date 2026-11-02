/**
 * Simulación de extremo a extremo del barrido de garantías.
 *
 * Levanta un Stripe falso (sin red) y ejecuta el barrido real contra una base de
 * datos de usar y tirar. Comprueba los casos que en producción cuestan dinero:
 * la retención que caduca, la que el banco ya soltó, la que se cobró por otra
 * vía, la que quedó huérfana y la que el cliente nunca confirmó.
 *
 * Uso:
 *   MONGODB_URI=mongodb://127.0.0.1:27018/piki_sweep_sim npx tsx scripts/cod-hold-sweep-simulation.ts
 */
import "dotenv/config";
import assert from "node:assert/strict";
import http from "node:http";
import mongoose from "mongoose";
import { CodHold } from "../src/codHolds.js";
import { CodHoldSweepRun, runCodHoldSweep, type CodHoldStripeAdapter } from "../src/codHoldSweep.js";
import { Order } from "../src/models.js";
import { sweepExpiringCodAuthorizations } from "../src/stripePayments.js";

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27018/piki_sweep_sim";
const now = new Date("2026-11-02T10:00:00.000Z");
/** Stripe falso por HTTP para el camino que usa el cliente de verdad. */
const FAKE_STRIPE_PORT = 12112;
process.env.STRIPE_SECRET_KEY = "sk_test_simulada";
process.env.STRIPE_API_BASE = `http://127.0.0.1:${FAKE_STRIPE_PORT}`;
const HOUR = 36e5;
const DAY = 24 * HOUR;

/** Stripe falso: guarda los estados y cuenta cuántas veces se le llama. */
function fakeStripe(statuses: Record<string, string>): CodHoldStripeAdapter & { done: string[]; reads: number } {
  const done: string[] = [];
  let reads = 0;
  return {
    configured: true,
    done,
    get reads() {
      return reads;
    },
    async retrieve(paymentIntentId: string) {
      reads += 1;
      const status = statuses[paymentIntentId];
      if (!status) throw new Error(`PaymentIntent inexistente: ${paymentIntentId}`);
      return {
        paymentIntentId,
        status,
        amountCents: 498,
        capturedCents: status === "succeeded" ? 498 : 0,
      };
    },
    async release(paymentIntentId: string) {
      done.push(paymentIntentId);
      statuses[paymentIntentId] = "canceled";
      return { status: "canceled" };
    },
  };
}

/** Stripe mínimo por HTTP: solo lo que usa la liberación del pedido. */
function fakeStripeServer() {
  const server = http.createServer((request, response) => {
    const match = (request.url ?? "").match(/\/v1\/payment_intents\/([^/]+)\/cancel/);
    response.writeHead(match ? 200 : 404, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify(
        match
          ? { id: match[1], object: "payment_intent", status: "canceled", amount: 498, amount_received: 0 }
          : { error: { message: "sin ruta" } },
      ),
    );
  });
  return new Promise<http.Server>((resolve) => server.listen(FAKE_STRIPE_PORT, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const stripeServer = await fakeStripeServer();
  await mongoose.connect(URI, { dbName: "piki_sweep_sim" });
  await Promise.all([CodHold.deleteMany({}), CodHoldSweepRun.deleteMany({}), Order.deleteMany({})]);

  const restaurantId = new mongoose.Types.ObjectId();
  const baseOrder = {
    restaurantId,
    subtotalCents: 400,
    deliveryFeeCents: 98,
    totalCents: 498,
    paymentMethod: "cash" as const,
  };

  // 1) Retención sana, recién creada: no se toca.
  await CodHold.create({
    reference: "SANA01",
    amountCents: 498,
    status: "authorized",
    paymentIntentId: "pi_sana",
    expiresAt: new Date(now.getTime() + 6 * DAY),
    createdAt: new Date(now.getTime() - 1 * HOUR),
  });

  // 2) Retención a punto de caducar, viva en el banco: se libera.
  await CodHold.create({
    reference: "CADUCA",
    amountCents: 498,
    status: "authorized",
    paymentIntentId: "pi_caduca",
    expiresAt: new Date(now.getTime() + 2 * HOUR),
    createdAt: new Date(now.getTime() - 6.9 * DAY),
  });

  // 3) Pedido cobrado en efectivo: la garantía sobra y se libera ya.
  const paidOrder = await Order.create({
    ...baseOrder,
    publicCode: "PIKI-COBRADO",
    displayCode: "PIKI-COBRADO",
    status: "delivered",
    paymentState: "paid",
    cashCollectedAt: new Date(now.getTime() - 2 * HOUR),
    deliveredAt: new Date(now.getTime() - 2 * HOUR),
  });
  await CodHold.create({
    reference: "COBRADO",
    amountCents: 498,
    status: "authorized",
    paymentIntentId: "pi_cobrado",
    expiresAt: new Date(now.getTime() + 5 * DAY),
    createdAt: new Date(now.getTime() - 2 * DAY),
  });

  // 4) El banco ya soltó la autorización: se concilia como caducada, sin cancelar.
  await CodHold.create({
    reference: "SUELTA",
    amountCents: 498,
    status: "authorized",
    paymentIntentId: "pi_suelta",
    expiresAt: new Date(now.getTime() - 1 * HOUR),
    createdAt: new Date(now.getTime() - 7.1 * DAY),
  });

  // 5) Se cobró por otra vía: el registro debe reflejarlo.
  const capturedOrder = await Order.create({
    ...baseOrder,
    publicCode: "PIKI-COBRADA2",
    displayCode: "PIKI-COBRADA2",
    status: "delivered",
    paymentState: "pending",
    deliveredAt: new Date(now.getTime() - 3 * HOUR),
  });
  await CodHold.create({
    reference: "COBRADA2",
    amountCents: 498,
    status: "authorized",
    paymentIntentId: "pi_cobrada",
    expiresAt: new Date(now.getTime() - 2 * HOUR),
    createdAt: new Date(now.getTime() - 7.2 * DAY),
  });

  // 6) Garantía huérfana: referencia sin pedido, con antelación activada.
  await CodHold.create({
    reference: "HUERFANA",
    amountCents: 498,
    status: "authorized",
    paymentIntentId: "pi_huerfana",
    expiresAt: new Date(now.getTime() + 4 * DAY),
    createdAt: new Date(now.getTime() - 30 * HOUR),
  });

  // 7) El cliente abandonó el 3DS: la retención no llegó a existir.
  await CodHold.create({
    reference: "SIN3DS",
    amountCents: 498,
    status: "authorized",
    paymentIntentId: "pi_sin3ds",
    expiresAt: new Date(now.getTime() + 6 * DAY),
    createdAt: new Date(now.getTime() - 30 * HOUR),
  });

  const statuses: Record<string, string> = {
    pi_sana: "requires_capture",
    pi_caduca: "requires_capture",
    pi_cobrado: "requires_capture",
    pi_suelta: "canceled",
    pi_cobrada: "succeeded",
    pi_huerfana: "requires_capture",
    pi_sin3ds: "requires_action",
  };
  const stripe = fakeStripe(statuses);

  console.log("1) Simulación en seco (no debe escribir ni llamar a Stripe)");
  const dry = await runCodHoldSweep({ apply: false, now, stripe, orphanReleaseHours: 24 });
  assert.equal(stripe.reads, 0, "la simulación no debe consultar Stripe");
  assert.equal(dry.inspected, 6, `esperaba 6 candidatas, vi ${dry.inspected}`);
  assert.equal(dry.released, 6, "en seco debe planificar las seis resoluciones");
  assert.equal(dry.liability.activeHolds, 7);
  console.log(`   candidatas=${dry.inspected} planificadas=${dry.decisions.filter((d) => d.action === "release").length} revisión=${dry.needsReview}`);

  console.log("2) Pasada real");
  const applied = await runCodHoldSweep({ apply: true, source: "worker", now, stripe, orphanReleaseHours: 24 });
  console.log(
    `   liberadas=${applied.released} caducadas=${applied.expired} cobradas=${applied.captured} fallidas=${applied.failed} revisión=${applied.needsReview} importe=${(applied.releasedCents / 100).toFixed(2)} €`,
  );
  assert.equal(applied.expired, 1, "la que el banco ya soltó debe quedar caducada");
  assert.equal(applied.captured, 1, "la cobrada en Stripe debe quedar cobrada");
  assert.equal(applied.released, 3, "caduca, cobrado en efectivo y huérfana");
  assert.equal(applied.failed, 1, "el 3DS abandonado debe quedar fallido");
  assert.equal(applied.errors.length, 0, `sin errores: ${applied.errors.join(", ")}`);

  const byReference = async (reference: string) => CodHold.findOne({ reference }).lean();
  assert.equal((await byReference("CADUCA"))?.status, "released");
  assert.equal((await byReference("COBRADO"))?.status, "released");
  assert.equal((await byReference("HUERFANA"))?.status, "released");
  assert.equal((await byReference("SUELTA"))?.status, "expired");
  assert.equal((await byReference("COBRADA2"))?.status, "captured");
  assert.equal((await byReference("SIN3DS"))?.status, "failed");
  assert.equal((await byReference("SANA01"))?.status, "authorized");
  assert.ok(!stripe.done.includes("pi_suelta"), "no se debe cancelar lo que el banco ya soltó");
  assert.ok(stripe.done.includes("pi_caduca"), "sí se debe cancelar la que sigue viva");

  const paid = await Order.findById(paidOrder._id).lean();
  assert.equal((paid as unknown as { paymentState: string }).paymentState, "paid", "un pedido cobrado no puede quedar como caducado");
  const captured = await Order.findById(capturedOrder._id).lean();
  assert.equal((captured as unknown as { paymentState: string }).paymentState, "paid");
  assert.equal((captured as unknown as { paymentCapturedCents: number }).paymentCapturedCents, 498);

  console.log("3) Segunda pasada: no debe repetir nada (idempotencia)");
  const readsBefore = stripe.reads;
  const second = await runCodHoldSweep({ apply: true, source: "worker", now, stripe, orphanReleaseHours: 24 });
  assert.equal(second.released, 0);
  assert.equal(second.expired, 0);
  assert.equal(second.captured, 0);
  assert.equal(stripe.reads, readsBefore, "no debe volver a consultar lo ya resuelto");
  assert.equal((await CodHold.countDocuments({ status: "authorized" })), 1, "solo queda la retención sana");

  const liability = second.liability;
  assert.equal(liability.activeHolds, 1);
  assert.equal(liability.activeCents, 498);

  console.log("4) Retención ligada a un pedido (camino del Order), con Stripe simulado");
  const orderHold = await Order.create({
    ...baseOrder,
    publicCode: "PIKI-PEDIDO9",
    displayCode: "PIKI-PEDIDO9",
    status: "on_the_way",
    paymentState: "authorized",
    stripePaymentIntentId: "pi_pedido9",
    paymentAuthorizationExpiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    paymentHoldCents: 498,
  });
  const orderSweep = await sweepExpiringCodAuthorizations(now, { apply: true });
  assert.equal(orderSweep.released, 1, "el pedido con retención debe liberarse por plazo");
  const releasedOrder = await Order.findById(orderHold._id).lean();
  assert.equal((releasedOrder as unknown as { paymentState: string }).paymentState, "expired");

  const runs = await CodHoldSweepRun.countDocuments({});
  assert.equal(runs, 3, `debe haber tres pasadas registradas, hay ${runs}`);

  console.log("\nTodo correcto:");
  console.log(`- ${applied.inspected} candidatas revisadas, ${applied.released + applied.expired + applied.captured + applied.failed} resueltas`);
  console.log(`- 1 retención viva y conciliada (${(liability.activeCents / 100).toFixed(2)} €)`);
  console.log(`- ${runs} pasadas registradas en el historial`);
  console.log("- 1 pedido con retención liberado por plazo y conciliado");

  stripeServer.close();
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error("fallo:", error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
