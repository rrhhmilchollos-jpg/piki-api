import "dotenv/config";

type SseEvent = { id?: string; type: string; data: any };
type SseProbe = { name: string; events: SseEvent[]; stop: () => void; failure: Promise<void> };

const baseUrl = String(process.env.PIKI_E2E_BASE_URL || "https://piki-api-staging-v2.onrender.com").replace(/\/$/, "");
const runId = String(process.env.E2E_RUN_ID || "").trim();
const password = String(process.env.QA_PASSWORD || "").trim();
const confirm = process.env.PIKI_E2E_CONFIRM === "YES";
const timeoutMs = Number(process.env.PIKI_E2E_TIMEOUT_MS || 90_000);
const runSuffix = runId.slice(3);
const restaurantSlug = String(process.env.PIKI_E2E_RESTAURANT_SLUG || `piki-qa-kitchen-${runSuffix}`).trim().toLowerCase();

if (/production|api\.pikidelivery\.com/i.test(baseUrl)) throw new Error("E2E solo permite un endpoint de staging/QA");
if (!/^qa-[a-z0-9-]{8,64}$/.test(runId)) throw new Error("E2E_RUN_ID debe tener formato qa-... y ser único");
if (!password || password.length < 12) throw new Error("QA_PASSWORD es obligatoria para el circuito aislado");
if (!confirm) throw new Error("Para crear y avanzar el pedido QA usa PIKI_E2E_CONFIRM=YES");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path: string, init: RequestInit = {}, token?: string, headers: Record<string, string> = {}) {
  const requestHeaders = new Headers(init.headers);
  if (init.body !== undefined && !requestHeaders.has("content-type")) requestHeaders.set("content-type", "application/json");
  for (const [key, value] of Object.entries(headers)) requestHeaders.set(key, value);
  if (token) requestHeaders.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: requestHeaders });
  const text = await response.text();
  let body: any = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* Preserve an unexpected text response for diagnostics. */ }
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`);
  return { body, headers: response.headers, status: response.status };
}

async function employeeLogin(surface: "admin" | "partner" | "rider" | "fleet", email: string) {
  const { body } = await request("/api/v1/auth/employee/login", {
    method: "POST",
    body: JSON.stringify({ email, password, role: surface }),
  }, undefined, { "x-piki-surface": surface });
  assert(body?.accessToken, `La cuenta ${surface} QA no emitió un token de sesión`);
  return String(body.accessToken);
}

async function customerLogin(email: string) {
  const { body, headers } = await request("/api/trpc/auth.login", {
    method: "POST",
    body: JSON.stringify({ json: { email, password } }),
  });
  assert(body?.result?.data?.json?.user?.id, "La cuenta Customer QA no pudo iniciar sesión");
  const cookie = headers.get("set-cookie")?.split(";")[0];
  assert(cookie?.startsWith("piki_customer_session="), "El login Customer QA no devolvió su sesión");
  return cookie;
}

function startSse(name: string, headers: Record<string, string>, since?: string): SseProbe {
  const controller = new AbortController();
  const events: SseEvent[] = [];
  const streamUrl = new URL(`${baseUrl}/api/v1/realtime/events`);
  if (since) streamUrl.searchParams.set("since", since);
  const failure = (async () => {
    const response = await fetch(streamUrl, { headers, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`${name} SSE -> ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let current: Partial<SseEvent> = {};
    const flush = () => {
      if (!current.type || current.type === "ready") { current = {}; return; }
      let data: any = null;
      try { data = current.data ? JSON.parse(String(current.data)) : null; } catch { data = current.data; }
      events.push({ id: current.id, type: current.type, data });
      current = {};
    };
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line) { flush(); continue; }
          if (line.startsWith(":")) continue;
          const separator = line.indexOf(":");
          const key = separator >= 0 ? line.slice(0, separator) : line;
          const valueText = (separator >= 0 ? line.slice(separator + 1) : "").replace(/^ /, "");
          if (key === "id") current.id = valueText;
          if (key === "event") current.type = valueText;
          if (key === "data") current.data = `${current.data || ""}${valueText}`;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return { name, events, stop: () => controller.abort(), failure };
}

function eventMatches(event: SseEvent, orderId: string, publicCode: string, type?: string) {
  const payload = event.data?.payload || event.data || {};
  return (!type || event.type === type) && (String(payload.orderId || "") === orderId || String(payload.publicCode || "") === publicCode);
}

async function waitForEvent(probe: SseProbe, orderId: string, publicCode: string, type?: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = probe.events.find((entry) => eventMatches(entry, orderId, publicCode, type));
    if (event) return event;
    await sleep(250);
  }
  throw new Error(`${probe.name} no recibió el evento esperado${type ? ` (${type})` : ""} en ${timeoutMs} ms`);
}

async function waitForOffer(riderId: string, riderToken: string, orderId: string, publicCode: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { body } = await request(`/api/v1/riders/${encodeURIComponent(riderId)}/offers`, {}, riderToken, { "x-piki-surface": "rider" });
    const offer = (body?.offers || []).find((entry: any) => String(entry._id) === orderId || entry.publicCode === publicCode);
    if (offer) return offer;
    await sleep(1_000);
  }
  throw new Error(`El dispatch no entregó una oferta al Rider QA dentro de ${timeoutMs} ms`);
}

async function trpcCustomer(procedure: string, input: any, cookie: string) {
  const { body } = await request(`/api/trpc/${procedure}`, { method: "POST", body: JSON.stringify({ json: input }) }, undefined, { cookie, "x-piki-surface": "customer" });
  return body?.result?.data?.json;
}

const qaHeaders = (token: string, surface: string) => ({ authorization: `Bearer ${token}`, "x-piki-surface": surface });
const controllerProbes: SseProbe[] = [];
let cleanup: any = null;
let cleanupAttempted = false;

try {
  const emails = {
    customer: `qa-customer-${runSuffix}@pikidelivery.test`,
    rider: `qa-rider-${runSuffix}@pikidelivery.test`,
    partner: `qa-partner-${runSuffix}@pikidelivery.test`,
    fleet: `qa-fleet-${runSuffix}@pikidelivery.test`,
    admin: `qa-admin-${runSuffix}@pikidelivery.test`,
  };
  const [customerCookie, riderToken, partnerToken, fleetToken, adminToken] = await Promise.all([
    customerLogin(emails.customer),
    employeeLogin("rider", emails.rider),
    employeeLogin("partner", emails.partner),
    employeeLogin("fleet", emails.fleet),
    employeeLogin("admin", emails.admin),
  ]);

  const catalog = (await request("/api/v1/catalog/restaurants")).body;
  const restaurant = (catalog?.restaurants || []).find((entry: any) => entry.slug === restaurantSlug);
  assert(restaurant, `La cocina QA ${restaurantSlug} no está publicada en el catálogo de Staging`);
  const item = (restaurant.menu || []).find((entry: any) => entry.available !== false);
  assert(item, "La cocina QA no tiene productos disponibles");

  const riderMe = (await request("/api/v1/auth/employee/me", {}, riderToken, { "x-piki-surface": "rider" })).body;
  const offersBefore = (await request(`/api/v1/riders/overview`, {}, fleetToken, { "x-piki-surface": "fleet" })).body;
  assert(riderMe?.employee?.email === emails.rider, "La sesión Rider QA no está vinculada a la cuenta temporal correcta");
  assert(offersBefore?.service === "piki-api", "Fleet QA no puede consultar la API operativa");

  const riderProfile = (await request("/api/v1/riders/statistics", {}, riderToken, { "x-piki-surface": "rider" })).body;
  assert(riderProfile?.statistics, "La superficie Rider QA no responde con estadísticas");
  const riderMap = (await request("/api/v1/riders/operational-map", {}, riderToken, { "x-piki-surface": "rider" })).body;
  assert(Array.isArray(riderMap?.zones), "La superficie Rider QA no recibe su mapa operativo");
  // Fleet may only see its own active slot, so this lookup cannot cross tenants or fleets.
  const fleetLive = (await request("/api/v1/fleet/operations/live", {}, fleetToken, { "x-piki-surface": "fleet" })).body;
  const activeRider = (fleetLive?.riders || []).find((entry: any) => entry.name === "PIKI QA Rider");
  assert(activeRider?.id || activeRider?._id, "Fleet QA no muestra el Rider temporal con turno y GPS activos");
  const activeRiderId = String(activeRider.id || activeRider._id);

  controllerProbes.push(
    startSse("Customer", { cookie: customerCookie, "x-piki-surface": "customer" }),
    startSse("Partner", qaHeaders(partnerToken, "partner")),
    startSse("Rider", qaHeaders(riderToken, "rider")),
    startSse("Fleet", qaHeaders(fleetToken, "fleet")),
    startSse("Admin", qaHeaders(adminToken, "admin")),
  );
  await sleep(750);

  const blockedCash = await fetch(`${baseUrl}/api/v1/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: customerCookie },
    body: JSON.stringify({ restaurantId: restaurant.id || restaurant._id, items: [{ itemId: item.id, quantity: 20 }], deliveryAddress: "Carrer de la Prova 2, Xàtiva", deliveryLocation: { latitude: 38.9903, longitude: -0.5187 }, paymentMethod: "cash", qaRunId: runId, qaRiderId: activeRiderId }),
  });
  assert(blockedCash.status === 422, `El límite de efectivo 48,99 € no bloqueó el pedido QA sobredimensionado (HTTP ${blockedCash.status})`);

  const created = await request("/api/v1/orders", {
    method: "POST",
    body: JSON.stringify({ restaurantId: restaurant.id || restaurant._id, items: [{ itemId: item.id, quantity: 1 }], deliveryAddress: "Carrer de la Prova 2, Xàtiva", deliveryNote: `E2E aislado ${runId}`, deliveryLocation: { latitude: 38.9903, longitude: -0.5187 }, paymentMethod: "cash", qaRunId: runId, qaRiderId: activeRiderId }),
  }, undefined, { cookie: customerCookie });
  const order = created.body?.order;
  assert(order?.id && order.publicCode, "La API no devolvió un pedido QA válido");
  assert(order.marketplace?.commissionRateBps === 1500, `Comisión inesperada: ${order.marketplace?.commissionRateBps}; se esperaba 1500 (15 %)`);

  const [customerIntake, partnerIntake, fleetIntake, adminIntake] = await Promise.all([
    waitForEvent(controllerProbes[0], String(order.id), String(order.publicCode), "order.processing"),
    waitForEvent(controllerProbes[1], String(order.id), String(order.publicCode), "order.awaiting_partner_acceptance"),
    waitForEvent(controllerProbes[3], String(order.id), String(order.publicCode), "order.awaiting_partner_acceptance"),
    waitForEvent(controllerProbes[4], String(order.id), String(order.publicCode), "order.cash_due"),
  ]);
  const riderOffer = await waitForOffer(activeRiderId, riderToken, String(order.id), String(order.publicCode));
  await waitForEvent(controllerProbes[2], String(order.id), String(order.publicCode), "order.rider_offer");

  const partnerQueue = (await request("/api/v1/partners/kitchen/orders", {}, partnerToken, { "x-piki-surface": "partner" })).body;
  assert((partnerQueue?.orders || []).some((entry: any) => String(entry._id) === String(order.id)), "Partner QA no muestra el pedido recién creado");
  const adminOverview = (await request("/api/v1/admin/overview", {}, adminToken, { "x-piki-surface": "admin" })).body;
  assert(Number(adminOverview?.overview?.open_orders || 0) >= 1, "Admin QA no contabiliza el pedido activo");

  await request(`/api/v1/riders/${activeRiderId}/orders/${order.id}/accept-offer`, { method: "POST", body: "{}" }, riderToken, { "x-piki-surface": "rider" });
  const initialCustomerId = customerIntake.id;
  assert(initialCustomerId, "Customer SSE no devolvió un identificador para reanudación");
  controllerProbes[0].stop();
  const customerResumed = startSse("Customer reconectado", { cookie: customerCookie, "x-piki-surface": "customer" }, initialCustomerId);
  controllerProbes.push(customerResumed);

  for (const status of ["accepted", "preparing", "ready_for_pickup"] as const) {
    await request(`/api/v1/partners/kitchen/orders/${order.id}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, partnerToken, { "x-piki-surface": "partner" });
  }
  await waitForEvent(customerResumed, String(order.id), String(order.publicCode), "order.status_changed");

  await request(`/api/v1/riders/${activeRiderId}/location`, { method: "POST", body: JSON.stringify({ latitude: 38.9904, longitude: -0.5186, accuracy: 5 }) }, riderToken, { "x-piki-surface": "rider" });
  await request(`/api/v1/riders/${activeRiderId}/orders/${order.id}/confirm-arrival`, { method: "POST", body: "{}" }, riderToken, { "x-piki-surface": "rider" });
  const pickupQueue = (await request("/api/v1/partners/kitchen/orders", {}, partnerToken, { "x-piki-surface": "partner" })).body;
  const pickupOrder = (pickupQueue?.orders || []).find((entry: any) => String(entry._id) === String(order.id));
  assert(pickupOrder?.pickupPin, "Partner QA no expone el PIN de recogida al pedido listo");
  await request(`/api/v1/riders/${activeRiderId}/orders/${order.id}/confirm-pickup`, { method: "POST", body: JSON.stringify({ pickupPin: pickupOrder.pickupPin }) }, riderToken, { "x-piki-surface": "rider" });
  await request(`/api/v1/orders/${order.id}/transitions`, { method: "POST", body: JSON.stringify({ status: "on_the_way", actorRole: "rider", reason: "Salida QA hacia cliente" }) }, riderToken, { "x-piki-surface": "rider" });

  const deliveryCredentials = await trpcCustomer("order.deliveryCredentials", { id: order.publicCode }, customerCookie);
  assert(deliveryCredentials?.pin, "Customer QA no recibe el PIN de entrega en ruta");
  await request(`/api/v1/riders/${activeRiderId}/location`, { method: "POST", body: JSON.stringify({ latitude: 38.9903, longitude: -0.5187, accuracy: 5 }) }, riderToken, { "x-piki-surface": "rider" });
  const delivery = await request(`/api/v1/riders/${activeRiderId}/orders/${order.id}/confirm-delivery`, { method: "POST", body: JSON.stringify({ deliveryQr: deliveryCredentials.pin }) }, riderToken, { "x-piki-surface": "rider" });
  assert(delivery.body?.order?.status === "delivered", "El pedido QA no terminó en estado delivered");

  const wallet = (await request(`/api/v1/riders/${activeRiderId}/cash-wallet`, {}, riderToken, { "x-piki-surface": "rider" })).body;
  assert(Number(wallet?.wallet?.availableCents || 0) === Number(order.totalCents), "La cartera QA no registró exactamente el efectivo del pedido de prueba");
  const deliveredCustomer = await trpcCustomer("order.get", { id: order.publicCode }, customerCookie);
  assert(deliveredCustomer?.status === "delivered", "Customer QA no refleja la entrega finalizada");

  const results = {
    ok: true,
    environment: "staging",
    runId,
    isolation: "tenant QA temporal independiente",
    commissionRateBps: 1500,
    cashLimitVerified: true,
    order: { id: order.id, publicCode: order.publicCode, totalCents: order.totalCents, status: delivery.body.order.status },
    realtime: { customer: Boolean(customerIntake), partner: Boolean(partnerIntake), rider: Boolean(riderOffer), fleet: Boolean(fleetIntake), admin: Boolean(adminIntake), customerReconnect: true },
    surfaces: { customer: true, partner: true, rider: true, fleet: true, admin: true },
    ledger: { cashCollectionCents: Number(wallet.wallet.availableCents) },
  };
  console.log(JSON.stringify(results, null, 2));
} finally {
  for (const probe of controllerProbes) probe.stop();
  await Promise.allSettled(controllerProbes.map((probe) => probe.failure));
  if (!cleanupAttempted) {
    cleanupAttempted = true;
    try {
      const result = await request("/api/v1/internal/qa/cleanup", { method: "POST", body: JSON.stringify({ runId }) }, undefined, { "x-piki-qa-secret": password });
      cleanup = result.body;
      console.log(JSON.stringify({ qaCleanup: cleanup }, null, 2));
    } catch (error) {
      console.error("QA_CLEANUP_FAILED", error instanceof Error ? error.message : error);
      process.exitCode = 1;
    }
  }
}
