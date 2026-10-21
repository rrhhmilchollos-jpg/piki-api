import "dotenv/config";

/**
 * Aprueba comercios locales de Xàtiva a través de la API de Admin.
 * Nunca guarda tokens en el repositorio.
 *
 * Dry-run:
 *   PIKI_ADMIN_TOKEN='...' pnpm catalog:approve:xativa -- --all-pending
 * Individual:
 *   PIKI_ADMIN_TOKEN='...' pnpm catalog:approve:xativa -- --slug demo-tienda --apply
 * Activación comercial separada:
 *   ... --slug tienda-real --apply --activate
 */

const API = String(process.env.PIKI_ADMIN_API_URL || process.env.PIKI_API_URL || "https://api.pikidelivery.com").replace(/\/$/, "");
const token = String(process.env.PIKI_ADMIN_TOKEN || "").trim();
const argv = process.argv.slice(2);
const slugIndex = argv.indexOf("--slug");
const slug = slugIndex >= 0 ? argv[slugIndex + 1] : "";
const allPending = argv.includes("--all-pending");
const apply = argv.includes("--apply");
const activate = argv.includes("--activate");
const isXativa = (value: unknown) => /^(xàtiva|xativa)(\s+casco\s+urbano)?$/i.test(String(value || "").trim());
if ((!slug && !allPending) || (slug && allPending)) throw new Error("Usa exactamente uno de: --slug <slug> o --all-pending");
if (activate && !apply) throw new Error("--activate requiere --apply");
if (!token) throw new Error("PIKI_ADMIN_TOKEN es obligatorio; no introduzcas tokens en el código ni en el chat.");

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
  });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) throw new Error(`${init.method || "GET"} ${path} -> HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const listing = await api("/api/v1/admin/restaurants?status=pending_review");
const candidates = (listing.restaurants || []).filter((restaurant: any) => isXativa(restaurant.locality) && (!slug || restaurant.slug === slug));
if (slug && !candidates.length) throw new Error(`No existe un comercio pending_review de Xàtiva con slug ${slug}`);
if (!candidates.length) {
  console.log(JSON.stringify({ mode: "dry-run", candidates: [], message: "No hay comercios pendientes que coincidan." }, null, 2));
  process.exit(0);
}
console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", activate, candidates: candidates.map((r: any) => ({ id: r._id || r.id, slug: r.slug, name: r.name, locality: r.locality, onboardingStatus: r.onboardingStatus, availabilityStatus: r.availabilityStatus, isActive: r.isActive, documents: r.partnerProfile?.documents?.length || 0 })) }, null, 2));
if (!apply) process.exit(0);

const results: any[] = [];
for (const restaurant of candidates) {
  const id = String(restaurant._id || restaurant.id || "");
  const statusResult = await api(`/api/v1/admin/restaurants/${encodeURIComponent(id)}/status`, { method: "PATCH", body: JSON.stringify({ status: "approved" }) });
  let activationResult = null;
  if (activate) {
    activationResult = await api(`/api/v1/admin/restaurants/${encodeURIComponent(id)}/configuration`, { method: "PATCH", body: JSON.stringify({ availabilityStatus: "available", isActive: true }) });
  }
  results.push({ slug: restaurant.slug, approved: true, activated: Boolean(activationResult), statusResult, activationResult });
}
console.log(JSON.stringify({ applied: true, results }, null, 2));
