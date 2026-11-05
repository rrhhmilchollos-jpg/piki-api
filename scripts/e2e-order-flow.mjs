#!/usr/bin/env node
/**
 * Prueba de humo de extremo a extremo del circuito de pedido.
 *
 * Usa el escenario QA oficial del backend (POST /api/v1/admin/qa/dispatch-orders),
 * que crea un pedido aislado con un rider QA y lo encola en dispatch_outbox. No
 * toca clientes, riders ni cobros reales, y se borra al terminar.
 *
 * Uso:
 *   PIKI_E2E_ADMIN_TOKEN=... node scripts/e2e-order-flow.mjs --apply
 *   node scripts/e2e-order-flow.mjs                 # solo plan, sin llamadas
 *
 * Variables:
 *   PIKI_API_ORIGIN           (por defecto https://api.pikidelivery.com)
 *   PIKI_E2E_ADMIN_TOKEN      token de una cuenta admin (obligatorio con --apply)
 *   PIKI_E2E_RESTAURANT_SLUG  opcional, para forzar un restaurante concreto
 */

const APPLY = process.argv.includes("--apply");
const ORIGIN = (process.env.PIKI_API_ORIGIN || "https://api.pikidelivery.com").replace(/\/$/, "");
const ADMIN_TOKEN = String(process.env.PIKI_E2E_ADMIN_TOKEN || "").trim();
const RESTAURANT_SLUG = String(process.env.PIKI_E2E_RESTAURANT_SLUG || "").trim();

const steps = [];
function step(name, detail) {
  steps.push({ name, detail });
  console.log(`\n[${steps.length}] ${name}`);
  if (detail) console.log(`    ${detail}`);
}

async function api(path, options = {}) {
  const response = await fetch(`${ORIGIN}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      "X-PIKI-SURFACE": "admin",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 400) }; }
  return { status: response.status, body };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(APPLY ? "MODO REAL: se creará y borrará un pedido QA" : "MODO SIMULACIÓN: no se escribe nada");
  step("Comprobar salud de la API", `${ORIGIN}/health`);
  step("Crear pedido QA y encolarlo en dispatch_outbox", RESTAURANT_SLUG ? `restaurante ${RESTAURANT_SLUG}` : "primer restaurante aprobado");
  step("Verificar asignación de rider QA en la respuesta");
  step("Esperar a que el worker procese el outbox (máx. 30 s)");
  step("Comprobar que el pedido tiene riderId y estado coherente");
  step("Borrar el pedido QA y su rider de simulación");

  if (!APPLY) {
    console.log("\nPlan validado. Ejecuta con --apply y un token admin para lanzarlo.");
    return;
  }
  assert(ADMIN_TOKEN, "Falta PIKI_E2E_ADMIN_TOKEN");

  const health = await api("/health");
  assert(health.status === 200, `Health devolvió ${health.status}`);

  const created = await api("/api/v1/admin/qa/dispatch-orders", {
    method: "POST",
    body: JSON.stringify(RESTAURANT_SLUG ? { restaurantSlug: RESTAURANT_SLUG } : {}),
  });
  if (created.status !== 201) {
    console.error("Respuesta del escenario QA:", created.status, created.body);
    throw new Error("No se pudo crear el pedido QA");
  }
  const orderId = String(created.body?.order?._id || created.body?.order?.id || "");
  const publicCode = created.body?.order?.publicCode || "(sin código)";
  assert(orderId, "La respuesta no incluye el id del pedido");
  console.log(`    pedido ${publicCode} · ${orderId}`);

  let order = created.body?.order || {};
  let assigned = Boolean(order.riderId);
  const deadline = Date.now() + 30_000;
  while (!assigned && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const refreshed = await api(`/api/v1/admin/orders/${orderId}`);
    if (refreshed.status === 200) {
      order = refreshed.body?.order || refreshed.body || order;
      assigned = Boolean(order.riderId);
    }
    console.log(`    esperando asignación… riderId=${assigned ? "sí" : "no"}`);
  }

  const dispatch = created.body?.dispatch || null;
  console.log(`    dispatch: ${JSON.stringify(dispatch)}`);
  console.log(`    estado: ${order.status || "(desconocido)"} · rider: ${order.riderId || "sin asignar"}`);

  const removed = await api(`/api/v1/admin/qa/dispatch-orders/${orderId}`, { method: "DELETE" });
  console.log(`    limpieza: HTTP ${removed.status}`);

  assert(assigned, "El pedido QA no llegó a asignarse a un rider en 30 s");
  console.log("\nResultado: circuito pedido → outbox → asignación verificado.");
}

main().catch((error) => {
  console.error(`\nFallo de la prueba: ${error.message}`);
  process.exitCode = 1;
});
