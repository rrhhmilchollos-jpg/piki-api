/**
 * Página mínima para confirmar un cargo de prueba con la tarjeta del titular.
 *
 * No guarda datos de tarjeta: el formulario lo pinta Stripe Elements y el número
 * nunca pasa por PIKI. Solo acepta el `client_secret` de un intent ya creado por
 * un administrador, así que no puede generar cargos por sí sola.
 */
export function stripeChargeTestPage(publishableKey: string): string {
  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PIKI · prueba de cobro</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7ef;font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:#15233d}
main{width:min(420px,92vw);background:#fff;border-radius:18px;padding:24px;box-shadow:0 18px 40px rgba(21,35,61,.12)}
h1{margin:0 0 6px;font-size:1.15rem}
p{font-size:.86rem;color:#5d6b57;line-height:1.45;margin:0 0 14px}
#card{border:1.5px solid #dfe6d8;border-radius:12px;padding:12px;margin:0 0 14px}
button{width:100%;border:0;border-radius:12px;padding:13px;font-weight:800;font-size:.95rem;background:#84cc16;color:#1b2a12;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#out{font-size:.86rem;margin-top:12px;min-height:1.2em}
.ok{color:#2f7d1f}.bad{color:#a12a2a}
</style></head>
<body><main>
<h1>Prueba de cobro PIKI</h1>
<p>Cargo real de 0,50 € con captura automática, igual que cuando un cliente elige «Tarjeta ahora». Se devuelve cuando lo pidas.</p>
<div id="card"></div>
<button id="pay">Pagar 0,50 €</button>
<div id="out"></div>
</main>
<script src="https://js.stripe.com/v3/"></script>
<script>
const stripe = Stripe(${JSON.stringify(publishableKey)});
const elements = stripe.elements();
const card = elements.create("card", { hidePostalCode: true });
card.mount("#card");
const params = new URLSearchParams(location.search);
const clientSecret = params.get("cs") || "";
const out = document.getElementById("out");
const btn = document.getElementById("pay");
if (!clientSecret) { out.textContent = "Falta el identificador del cobro (?cs=...)."; btn.disabled = true; }
btn.addEventListener("click", async () => {
  btn.disabled = true; out.className = ""; out.textContent = "Contactando con el banco…";
  const result = await stripe.confirmCardPayment(clientSecret, { payment_method: { card } });
  if (result.error) { out.className = "bad"; out.textContent = "Rechazado: " + result.error.message; btn.disabled = false; return; }
  const intent = result.paymentIntent;
  if (intent && intent.status === "succeeded") {
    out.className = "ok";
    out.textContent = "Cobrado " + (intent.amount / 100).toFixed(2) + " € · estado " + intent.status + " · " + intent.id;
  } else {
    out.className = "bad";
    out.textContent = "Estado inesperado: " + (intent && intent.status);
  }
});
</script>
</body></html>`;
}