/**
 * Asigna Miguel Martos Montoya y Orelbys Cabrera Martínez a una Fleet existente
 * y crea slots diarios 18:00–24:00 en la zona xativa.
 *
 * Por seguridad no modifica nada salvo que se ejecute con APPLY=true y un token
 * administrativo explícito. El endpoint de slots hace upsert idempotente.
 * Maria Deseada Solas debe ser la responsable de la Fleet ya creada en Admin;
 * este script no crea una segunda Fleet ni cambia su cuenta.
 */
const API = (process.env.PIKI_API_URL || "https://api.pikidelivery.com").replace(/\/$/, "");
const TOKEN = String(process.env.PIKI_ADMIN_TOKEN || "").trim();
const APPLY = process.env.APPLY === "true";
const FLEET_ID = String(process.env.XATIVA_FLEET_ID || "").trim();
const ZONE = process.env.XATIVA_ZONE_SLUG || "xativa";
const RIDERS = ["Miguel Martos Montoya", "Orelbys Cabrera Martínez"];
const dates = Array.from({ length: 12 }, (_, i) => { const d = new Date(Date.UTC(2026, 10, 18 + i)); return d.toISOString().slice(0, 10); });

if (!TOKEN) throw new Error("Falta PIKI_ADMIN_TOKEN; no se aceptan credenciales por argumentos del script.");
if (!FLEET_ID) throw new Error("Falta XATIVA_FLEET_ID; primero selecciona la Fleet de Maria Deseada Solas en Admin.");
const headers = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-ES");
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${path}: ${JSON.stringify(body)}`);
  return body as any;
}
const directory = await request("/api/v1/admin/governance/directory");
const riders = RIDERS.map((name) => {
  const rider = (directory.riders || []).find((candidate: any) => normalize(candidate.name || "") === normalize(name));
  if (!rider) throw new Error(`No se encontró el Rider exacto: ${name}`);
  return rider;
});
console.log(JSON.stringify({ mode: APPLY ? "APPLY" : "DRY_RUN", fleetId: FLEET_ID, zone: ZONE, dates, riders: riders.map((r: any) => ({ id: r.id, name: r.name, currentFleetId: r.fleetId || null, currentZone: r.zoneSlug || null })) }, null, 2));
if (!APPLY) process.exit(0);
for (const rider of riders) {
  await request(`/api/v1/admin/riders/${rider.id}/profile`, { method: "PATCH", body: JSON.stringify({ fleetId: FLEET_ID, city: "Xàtiva", zoneSlug: ZONE }) });
  for (const date of dates) {
    await request("/api/v1/rider-slots", { method: "POST", body: JSON.stringify({ riderId: rider.id, zoneSlug: ZONE, date, startTime: "18:00", endTime: "00:00", status: "planned", notes: "Fleet Xàtiva · horario operativo 18:00–24:00" }) });
  }
}
console.log(JSON.stringify({ applied: true, riderCount: riders.length, slotCount: riders.length * dates.length }));
