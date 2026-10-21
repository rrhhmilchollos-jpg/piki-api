import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Aprueba comercios locales de Xàtiva a través de la API de Admin.
 *
 * Controles:
 * - dry-run por defecto;
 * - --apply individual exige --confirm; lote exige --confirm-bulk;
 * - --activate exige --confirm-activate y solo se ejecuta después de aprobar;
 * - token exclusivamente en PIKI_ADMIN_TOKEN;
 * - host de API protegido por PIKI_ADMIN_ALLOWED_HOSTS;
 * - timeout de red de 15 s y máximo de 50 comercios por lote;
 * - filtra Xàtiva + pending_review + comercio inactivo antes de modificar.
 *
 * Dry-run contra API:
 *   PIKI_ADMIN_TOKEN='...' pnpm catalog:approve:xativa -- --all-pending
 * Aprobación individual:
 *   PIKI_ADMIN_TOKEN='...' pnpm catalog:approve:xativa -- --slug tienda-real --apply --confirm
 * Lote aprobado:
 *   PIKI_ADMIN_TOKEN='...' pnpm catalog:approve:xativa -- --all-pending --apply --confirm-bulk
 * Activación separada:
 *   ... --slug tienda-real --apply --confirm --activate --confirm-activate
 * Simulación offline de candidatos reales (no consulta ni escribe API):
 *   pnpm catalog:approve:xativa -- --manifest scripts/fixtures/xativa-supermarkets.real-dry-run.json
 */

const argv = process.argv.slice(2);
const slugIndex = argv.indexOf("--slug");
const slug = slugIndex >= 0 ? String(argv[slugIndex + 1] || "") : "";
const manifestIndex = argv.indexOf("--manifest");
const manifestPath = manifestIndex >= 0 ? String(argv[manifestIndex + 1] || "") : "";
const allPending = argv.includes("--all-pending");
const apply = argv.includes("--apply");
const activate = argv.includes("--activate");
const confirmed = argv.includes("--confirm");
const confirmedBulk = argv.includes("--confirm-bulk");
const confirmedActivate = argv.includes("--confirm-activate");
const maxIndex = argv.indexOf("--max");
const maxBatch = maxIndex >= 0 ? Number(argv[maxIndex + 1]) : 50;
const isXativa = (value: unknown) => /^(xàtiva|xativa)(\s+casco\s+urbano)?$/i.test(String(value || "").trim());

if (![Boolean(slug), allPending, Boolean(manifestPath)].filter(Boolean).length || [Boolean(slug), allPending, Boolean(manifestPath)].filter(Boolean).length > 1) {
  throw new Error("Usa exactamente uno de: --slug <slug>, --all-pending o --manifest <fichero.json>");
}
if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 50) throw new Error("--max debe ser un entero entre 1 y 50");
if (activate && !apply) throw new Error("--activate requiere --apply");
if (apply && ((slug && !confirmed) || (allPending && !confirmedBulk))) throw new Error("La aplicación requiere --confirm para un comercio o --confirm-bulk para un lote");
if (activate && !confirmedActivate) throw new Error("La activación requiere --confirm-activate además de la confirmación de aprobación");

if (manifestPath) {
  const manifest = JSON.parse(await fs.readFile(path.resolve(process.cwd(), manifestPath), "utf8"));
  const stores = Array.isArray(manifest.stores) ? manifest.stores : [];
  const candidates = stores.filter((store: any) => isXativa(store.locality));
  console.log(JSON.stringify({ mode: "manifest-dry-run", writes: false, apiCalls: false, source: manifest.source || "unspecified", candidates: candidates.slice(0, maxBatch).map((store: any) => ({ name: store.name, slug: store.slug, locality: store.locality, address: store.address, sourceUrls: store.sourceUrls || [], pikiStatus: "not_imported_or_not_matched" })), excludedOutsideXativa: stores.length - candidates.length, truncated: candidates.length > maxBatch, nextStep: "Confirmar el partner y cargar catálogo real antes de importar o aprobar." }, null, 2));
  process.exit(0);
}

const API = String(process.env.PIKI_ADMIN_API_URL || process.env.PIKI_API_URL || "https://api.pikidelivery.com").replace(/\/$/, "");
const token = String(process.env.PIKI_ADMIN_TOKEN || "").trim();
if (!token) throw new Error("PIKI_ADMIN_TOKEN es obligatorio; no introduzcas tokens en el código ni en el chat.");
const apiUrl = new URL(API);
const allowedHosts = new Set(String(process.env.PIKI_ADMIN_ALLOWED_HOSTS || "api.pikidelivery.com").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean));
if (!allowedHosts.has(apiUrl.hostname.toLowerCase())) throw new Error(`Host de API no permitido: ${apiUrl.hostname}. Configura PIKI_ADMIN_ALLOWED_HOSTS explícitamente para un entorno autorizado.`);
if (apiUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(apiUrl.hostname)) throw new Error("La API debe utilizar HTTPS fuera de localhost.");

async function api(pathname: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${API}${pathname}`, {
      ...init,
      signal: controller.signal,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
    });
    const text = await response.text();
    let body: any = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
    if (!response.ok) throw new Error(`${init.method || "GET"} ${pathname} -> HTTP ${response.status}: ${JSON.stringify(body)}`);
    return body;
  } finally { clearTimeout(timer); }
}

const listing = await api("/api/v1/admin/restaurants?status=pending_review");
const allRestaurants = Array.isArray(listing.restaurants) ? listing.restaurants : [];
const matchingSlug = slug ? allRestaurants.filter((restaurant: any) => restaurant.slug === slug) : allRestaurants;
if (slug && matchingSlug.length && !matchingSlug.every((restaurant: any) => isXativa(restaurant.locality) && restaurant.onboardingStatus === "pending_review")) {
  throw new Error(`El slug ${slug} existe, pero no es un comercio pending_review elegible de Xàtiva.`);
}
const candidates = matchingSlug.filter((restaurant: any) => isXativa(restaurant.locality) && restaurant.onboardingStatus === "pending_review" && restaurant.isActive !== true && restaurant.availabilityStatus !== "available");
if (slug && !candidates.length) throw new Error(`No existe un comercio pending_review elegible de Xàtiva con slug ${slug}`);
if (candidates.length > maxBatch) throw new Error(`El lote contiene ${candidates.length} comercios; supera el máximo ${maxBatch}. Usa --max con un valor menor y revisa por lotes.`);

console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", activate, apiHost: apiUrl.hostname, writes: apply, candidates: candidates.map((restaurant: any) => ({ id: restaurant._id || restaurant.id, slug: restaurant.slug, name: restaurant.name, locality: restaurant.locality, onboardingStatus: restaurant.onboardingStatus, availabilityStatus: restaurant.availabilityStatus, isActive: restaurant.isActive, documents: restaurant.partnerProfile?.documents?.length || 0 })) }, null, 2));
if (!apply || !candidates.length) process.exit(0);

const results: any[] = [];
for (const restaurant of candidates) {
  const id = String(restaurant._id || restaurant.id || "");
  const statusResult = await api(`/api/v1/admin/restaurants/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
  let activationResult = null;
  if (activate) activationResult = await api(`/api/v1/admin/restaurants/${encodeURIComponent(id)}/configuration`, { method: "PATCH", body: JSON.stringify({ availabilityStatus: "available", isActive: true }) });
  results.push({ slug: restaurant.slug, approved: true, activated: Boolean(activationResult), statusResult, activationResult });
}
console.log(JSON.stringify({ applied: true, results }, null, 2));
