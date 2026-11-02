/**
 * Simulación de extremo a extremo del contra­rreembolso asegurado.
 *
 * Levanta un Stripe falso que responde igual que el real y ejecuta el ciclo
 * completo: retención -> captura -> liberación. Sirve para verificar el flujo
 * sin claves reales; con STRIPE_SECRET_KEY de test apunta a Stripe de verdad.
 */
import http from "node:http";
import { authorizeCodOrder, captureCodOrder, releaseCodOrder } from "../src/stripePayments.js";

const PORT = 12111;
const intents = new Map<string, { amount: number; status: string; received: number }>();

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const url = req.url ?? "";
    const json = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "POST" && url.startsWith("/v1/payment_intents") && !url.includes("/capture") && !url.includes("/cancel")) {
      const params = new URLSearchParams(body);
      const amount = Number(params.get("amount") ?? 0);
      const id = `pi_sim_${intents.size + 1}`;
      intents.set(id, { amount, status: "requires_capture", received: 0 });
      return json(200, {
        id,
        object: "payment_intent",
        amount,
        amount_received: 0,
        client_secret: `${id}_secret_sim`,
        status: "requires_capture",
        currency: params.get("currency") ?? "eur",
        metadata: { orderId: params.get("metadata[orderId]") ?? null },
      });
    }
    const capture = url.match(/\/v1\/payment_intents\/([^/]+)\/capture/);
    if (req.method === "POST" && capture) {
      const intent = intents.get(capture[1]);
      if (!intent) return json(404, { error: { message: "no existe" } });
      intent.status = "succeeded";
      intent.received = intent.amount;
      return json(200, { id: capture[1], object: "payment_intent", status: "succeeded", amount: intent.amount, amount_received: intent.received });
    }
    const cancel = url.match(/\/v1\/payment_intents\/([^/]+)\/cancel/);
    if (req.method === "POST" && cancel) {
      const intent = intents.get(cancel[1]);
      if (!intent) return json(404, { error: { message: "no existe" } });
      intent.status = "canceled";
      return json(200, { id: cancel[1], object: "payment_intent", status: "canceled", amount: intent.amount, amount_received: 0 });
    }
    return json(404, { error: { message: `sin ruta ${url}` } });
  });
});

async function main() {
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  process.env.STRIPE_SECRET_KEY = "sk_test_simulada";
  process.env.STRIPE_API_BASE = `http://127.0.0.1:${PORT}`;

  console.log("1) El cliente confirma el pedido COD por 18,78 €");
  const auth = await authorizeCodOrder({ orderId: "pedido_simulado", amountCents: 1878 });
  console.log(`   retención ${auth.paymentIntentId} estado=${auth.status} requiere3DS=${auth.requiresAction}`);
  console.log(`   caduca el ${auth.expiresAt.toISOString()}`);

  console.log("2) El rider no puede cobrar: se captura la retención");
  const captured = await captureCodOrder(auth.paymentIntentId);
  console.log(`   estado=${captured.status} cobrado=${(captured.capturedCents / 100).toFixed(2)} €`);

  console.log("3) Segundo pedido: el cliente paga en efectivo y se libera");
  const second = await authorizeCodOrder({ orderId: "pedido_simulado_2", amountCents: 1158 });
  const released = await releaseCodOrder(second.paymentIntentId, "paid_in_cash");
  console.log(`   retención ${second.paymentIntentId} estado=${released.status}`);

  server.close();
}

main().catch((error) => {
  console.error("fallo:", (error as Error).message);
  server.close();
  process.exit(1);
});
