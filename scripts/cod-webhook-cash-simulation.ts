/**
 * Comprueba que el webhook de Stripe no estropea el cobro en efectivo.
 *
 * Secuencia real: el rider pulsa "Cobrado en efectivo" → la API cancela la
 * retención → Stripe manda `payment_intent.canceled` unos segundos después.
 * Ese evento llegaba con el pedido ya cobrado y lo devolvía a "expired".
 */
import "dotenv/config";
import mongoose from "mongoose";
import { Order } from "../src/models.js";
import { handleStripeEvent } from "../src/stripePayments.js";

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27018/piki_cod_webhook";

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`FALLO: ${message}`);
  console.log(`ok  ${message}`);
}

async function main() {
  await mongoose.connect(uri);
  await Order.deleteMany({ publicCode: { $in: ["PIKI-WHPAID1", "PIKI-WHEXPIR2"] } }).exec();

  // Caso 1: el cliente pagó en efectivo y la retención se cancela después.
  const paid = await Order.create({
    publicCode: "PIKI-WHPAID1",
    status: "delivered",
    paymentMethod: "cash",
    paymentState: "paid",
    totalCents: 2178,
    cashCollectedAt: new Date(),
    stripePaymentIntentId: "pi_sim_cash_paid",
    tenantId: new mongoose.Types.ObjectId(),
    restaurantId: new mongoose.Types.ObjectId(),
  });

  const released = await handleStripeEvent({
    type: "payment_intent.canceled",
    data: { object: { id: "pi_sim_cash_paid", metadata: { orderId: String(paid._id) } } },
  });
  const afterPaid = await Order.findById(paid._id).lean().exec() as any;
  assert(released.handled, "el evento de cancelación se procesa");
  assert(afterPaid.paymentState === "paid", "el pedido cobrado en efectivo sigue como pagado");
  assert(Boolean(afterPaid.cashCollectedAt), "el cobro en efectivo no se borra");

  // Caso 2: nadie pagó y la retención caduca o se cancela.
  const expired = await Order.create({
    publicCode: "PIKI-WHEXPIR2",
    status: "pending",
    paymentMethod: "cash",
    paymentState: "authorized",
    totalCents: 1878,
    stripePaymentIntentId: "pi_sim_cash_expired",
    tenantId: new mongoose.Types.ObjectId(),
    restaurantId: new mongoose.Types.ObjectId(),
  });
  await handleStripeEvent({
    type: "payment_intent.canceled",
    data: { object: { id: "pi_sim_cash_expired", metadata: { orderId: String(expired._id) } } },
  });
  const afterExpired = await Order.findById(expired._id).lean().exec() as any;
  assert(afterExpired.paymentState === "expired", "la retención caducada deja el pedido como expirado");
  assert(!afterExpired.cashCollectedAt, "no se inventa un cobro en efectivo");

  await Order.deleteMany({ publicCode: { $in: ["PIKI-WHPAID1", "PIKI-WHEXPIR2"] } }).exec();
  await mongoose.disconnect();
  console.log("\nWebhook verificado en los dos sentidos.");
}

main().catch(async (error) => {
  console.error(error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
