import "dotenv/config";

const baseUrl = String(process.env.PIKI_E2E_BASE_URL || "https://piki-api-staging-v2.onrender.com").replace(/\/$/, "");
const riderToken = String(process.env.PIKI_E2E_RIDER_TOKEN || "").trim();
const riderId = String(process.env.PIKI_E2E_RIDER_ID || "").trim();
const partnerToken = String(process.env.PIKI_E2E_PARTNER_TOKEN || "").trim();
const runId = String(process.env.E2E_RUN_ID || "").trim();
const restaurantSlug = String(process.env.PIKI_E2E_RESTAURANT_SLUG || `piki-qa-kitchen-${runId.slice(3)}`).trim().toLowerCase();
const confirm = process.env.PIKI_E2E_CONFIRM === "YES";
const timeoutMs = Number(process.env.PIKI_E2E_TIMEOUT_MS || 90_000);

if (/production|api\.pikidelivery\.com/i.test(baseUrl)) throw new Error("E2E solo permite un endpoint de staging/QA");
if (!riderToken || !riderId) throw new Error("PIKI_E2E_RIDER_TOKEN y PIKI_E2E_RIDER_ID son obligatorios");
if (!/^qa-[a-z0-9-]{8,64}$/.test(runId)) throw new Error("E2E_RUN_ID debe tener formato qa-... y ser único");
if (!confirm) throw new Error("Para crear y avanzar un pedido usa PIKI_E2E_CONFIRM=YES");

async function request(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return body as any;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const catalog = await request("/api/v1/catalog/restaurants");
const restaurant = (catalog.restaurants || []).find((entry: any) => entry.slug === restaurantSlug);
assert(restaurant, `La cocina QA ${restaurantSlug} no está publicada en el catálogo de staging`);
const item = (restaurant.menu || []).find((entry: any) => entry.available !== false);
assert(item, "La cocina QA no tiene productos disponibles en staging");

const subtotalCents = Math.round(Number(item.price) * 100);
const orderResult = await request("/api/v1/orders", {
  method: "POST",
  body: JSON.stringify({
    restaurantId: restaurant.id || restaurant._id,
    items: [{ itemId: item.id, quantity: 1 }],
    deliveryAddress: "Plaça de la Bassa, Xàtiva, Valencia",
    deliveryNote: `E2E staging ${runId}`,
    deliveryLocation: { latitude: 38.9904, longitude: -0.5186 },
    paymentMethod: "cash",
    qaRunId: runId,
    qaRiderId: riderId,
  }),
});
const order = orderResult.order;
assert(order?.id && order.publicCode, "La API no devolvió un pedido E2E válido");
assert(order.marketplace?.commissionRateBps === 1500, `Comisión inesperada: ${order.marketplace?.commissionRateBps}; se esperaba 1500 (15 %)`);

const deadline = Date.now() + timeoutMs;
let offer: any = null;
while (Date.now() < deadline) {
  const offers = await request(`/api/v1/riders/${encodeURIComponent(riderId)}/offers`, {}, riderToken);
  offer = (offers.offers || []).find((entry: any) => String(entry._id) === String(order.id) || entry.publicCode === order.publicCode);
  if (offer) break;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
assert(offer, `El dispatch no entregó la oferta al Rider dentro de ${timeoutMs} ms`);

await request(`/api/v1/riders/${riderId}/orders/${order.id}/accept-offer`, { method: "POST", body: "{}" }, riderToken);

if (partnerToken) {
  for (const status of ["accepted", "preparing", "ready_for_pickup"] as const) {
    await request(`/api/v1/partners/kitchen/orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, partnerToken);
  }
}

console.log(JSON.stringify({
  ok: true,
  environment: "staging",
  runId,
  restaurant: { id: restaurant.id || restaurant._id, slug: restaurant.slug, name: restaurant.name },
  item: { id: item.id, name: item.name, priceCents: subtotalCents },
  order: { id: order.id, publicCode: order.publicCode, paymentMethod: order.paymentMethod, commissionRateBps: order.marketplace.commissionRateBps },
  rider: { id: riderId, offerReceived: true, accepted: true },
  partner: { automatedToReadyForPickup: Boolean(partnerToken) },
  next: partnerToken ? "Actualiza ubicación del Rider, confirma llegada/recogida y finaliza con el PIN de entrega; ejecuta después cleanup-staging-qa con el mismo runId." : "Define PIKI_E2E_PARTNER_TOKEN para automatizar los estados del Partner."
}, null, 2));
