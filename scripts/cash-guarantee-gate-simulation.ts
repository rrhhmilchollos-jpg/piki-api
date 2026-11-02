/**
 * Prueba de punta a punta de la regla nueva: un pedido en efectivo no sale a
 * reparto hasta que el cliente deja la tarjeta retenida.
 *
 *  1. Pedido en efectivo recién creado, sin retención -> no sale a reparto.
 *  2. Se autoriza la tarjeta (paymentState "authorized" + CodHold viva) -> sale.
 *  3. El barrido, mientras el pedido sigue vivo, no suelta la garantía.
 *  4. El rider confirma el cobro en efectivo -> el barrido libera y el pedido
 *     queda pagado, sin cargo en la tarjeta.
 *
 * Stripe se sustituye por un adaptador falso: aquí se prueba la lógica, no la red.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Order, Restaurant } from "../src/models.js";
import { CodHold } from "../src/codHolds.js";
import { dispatchablePaymentFilter, isDispatchablePayment } from "../src/dispatchEligibility.js";
import { runCodHoldSweep, type CodHoldStripeAdapter } from "../src/codHoldSweep.js";

const uri = process.env.MONGODB_URI || "mongodb://127.0.0.1:27018/piki_cash_gate";
const results: Array<[string, boolean, string]> = [];
function check(label: string, ok: boolean, detail = "") {
  results.push([label, ok, detail]);
  console.log(`${ok ? "OK   " : "FALLO"} ${label}${detail ? ` · ${detail}` : ""}`);
}

const released: string[] = [];
const fakeStripe: CodHoldStripeAdapter = {
  configured: true,
  async retrieve() {
    return { status: "requires_capture", amountCents: 498, amountCapturedCents: 0, currency: "eur" } as any;
  },
  async release(paymentIntentId, reason) {
    released.push(`${paymentIntentId}:${reason}`);
    return { status: "canceled" };
  },
};

async function main() {
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();

  const restaurant = await Restaurant.create({
    name: "Mr Rooster Xàtiva",
    slug: "rooster-kebab-xativa",
    address: "Carrer de la Pau 8",
    locality: "Xàtiva",
    city: "Xàtiva",
    zoneSlug: "xativa",
    cuisine: "Pollo",
    category: "Pollo",
    phone: "600000001",
    isActive: true,
  } as any);

  const base = {
    restaurantId: restaurant._id,
    customerName: "Cliente Prueba",
    customerPhone: "600111222",
    deliveryAddress: "Avinguda Jaume I 10, Xàtiva",
    items: [{ itemId: new mongoose.Types.ObjectId(), name: "Pollo", quantity: 1, unitPriceCents: 498, totalCents: 498 }],
    subtotalCents: 498,
    deliveryFeeCents: 0,
    totalCents: 498,
    paymentMethod: "cash",
    zoneSlug: "xativa",
  } as const;

  // 1. Pedido en efectivo sin garantía.
  const order = await Order.create({ ...base, publicCode: "PIKI-GATE001", status: "pending", paymentState: "pending" } as any);
  const withoutHold = await Order.exists({ _id: order._id, status: "pending", ...dispatchablePaymentFilter });
  check("sin retención el pedido no es elegible para reparto", !withoutHold);
  check("el guardián de pago también lo rechaza", !isDispatchablePayment("pending", "cash", 498));

  // 2. El cliente autoriza la tarjeta: retención viva y estado authorized.
  const hold = await CodHold.create({
    orderId: order._id,
    reference: "PIKI-GATE001",
    paymentIntentId: "pi_simulado_gate_001",
    amountCents: 498,
    currency: "eur",
    status: "authorized",
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 6 * 3600 * 1000),
  } as any);
  await Order.updateOne({ _id: order._id }, { $set: { paymentState: "authorized", paymentIntentId: "pi_simulado_gate_001" } }).exec();
  const withHold = await Order.exists({ _id: order._id, status: "pending", ...dispatchablePaymentFilter });
  check("con retención viva el pedido sí sale a reparto", Boolean(withHold));
  check("el guardián de pago lo acepta", isDispatchablePayment("authorized", "cash", 498));

  // 3. El barrido no suelta una garantía de un pedido vivo.
  const first = await runCodHoldSweep({ apply: true, source: "manual", stripe: fakeStripe });
  check("el barrido no libera la garantía con el pedido vivo", released.length === 0, `liberadas ${released.length}`);
  const stillHeld = await CodHold.findById(hold._id).lean().exec() as any;
  check("la retención sigue autorizada", stillHeld?.status === "authorized", stillHeld?.status ?? "sin registro");

  // 4. El rider confirma el cobro en efectivo y el barrido concilia.
  await Order.updateOne(
    { _id: order._id },
    { $set: { paymentState: "paid", cashCollectedAt: new Date(), status: "delivered", deliveredAt: new Date() } },
  ).exec();
  const second = await runCodHoldSweep({ apply: true, source: "manual", stripe: fakeStripe });
  check("el barrido libera al constar el pedido cobrado en efectivo", released.length === 1, released[0] ?? "sin liberación");
  const after = await CodHold.findById(hold._id).lean().exec() as any;
  check("la retención queda liberada", ["released", "expired"].includes(after?.status ?? ""), after?.status ?? "sin registro");
  const paidOrder = await Order.findById(order._id).lean().exec() as any;
  check("el pedido queda pagado, sin cargo en la tarjeta", paidOrder.paymentState === "paid", paidOrder.paymentState);

  console.log(`\nresumen barridos: inspected=${first.inspected}/${second.inspected} released=${second.released} reports=${first.decisions.length}/${second.decisions.length}`);
  const failed = results.filter(([, ok]) => !ok);
  console.log(`${results.length - failed.length}/${results.length} comprobaciones correctas`);
  await mongoose.disconnect();
  process.exit(failed.length ? 1 : 0);
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
