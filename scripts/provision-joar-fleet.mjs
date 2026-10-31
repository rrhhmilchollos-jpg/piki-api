import "dotenv/config";

const api = String(process.env.PIKI_API_ORIGIN || "https://piki-api-37nr.onrender.com").replace(/\/$/, "");
const token = String(process.env.PIKI_ADMIN_TOKEN || "").trim();
const confirm = process.env.PIKI_CONFIRM === "CREATE";
const managerEmail = "paduanyjoar9@gmail.com";
const managerName = "Joar Daniel Paduany Reyes";
const zoneSlugs = [
  "xativa-casco-urbano-fase-1",
  "la-llosa-de-ranes",
  "novetle",
  "el-genoves",
  "la-granja-de-la-costera",
  "llanera-de-ranes",
  "cerda",
  "torrella",
  "alboi",
  "bixquert",
];
const vehicleTypes = ["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"];

if (!token) throw new Error("Falta PIKI_ADMIN_TOKEN. Usa un token Bearer de RRHH superadmin; nunca lo guardes en el repositorio.");
const headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
async function request(path, options = {}) {
  const response = await fetch(`${api}${path}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${options.method || "GET"} ${path} -> ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

const operational = await request("/api/v1/admin/coverage/operational-areas");
const areas = (operational.areas || []).filter((area) => zoneSlugs.includes(area.slug));
if (areas.length !== zoneSlugs.length) throw new Error(`Faltan geometrías operativas: ${zoneSlugs.filter((slug) => !areas.some((area) => area.slug === slug)).join(", ")}`);
const existingPayload = await request("/api/v1/zones");
const existing = new Map((existingPayload.zones || []).map((zone) => [zone.slug, zone]));
const missing = areas.filter((area) => !existing.has(area.slug));
const summary = {
  api,
  dryRun: !confirm,
  zonesToCreate: missing.map((area) => ({ slug: area.slug, name: area.name })),
  zonesAlreadyPresent: areas.filter((area) => existing.has(area.slug)).map((area) => area.slug),
  fleet: {
    name: "Fleet Joar Daniel Paduany",
    managerName,
    managerEmail,
    contactPhone: "689900229",
    address: "Calle San Frances N10",
    postalCode: "46800",
    city: "Xàtiva",
    maxRiders: 30,
    vehicleTypes,
    serviceZones: zoneSlugs,
  },
};
console.log(JSON.stringify(summary, null, 2));
if (!confirm) {
  console.log("DRY RUN: no se ha escrito nada. Repite con PIKI_CONFIRM=CREATE para aplicar exactamente este resumen.");
  process.exit(0);
}

for (const area of missing) {
  await request("/api/v1/zones", { method: "POST", body: JSON.stringify({
    name: area.name,
    slug: area.slug,
    isActive: true,
    serviceFeeCents: 0,
    maxEtaMinutes: 60,
    polygon: area.geometry,
  }) });
}

const fleetInput = {
  name: "Fleet Joar Daniel Paduany",
  managerName,
  managerEmail,
  contactEmail: managerEmail,
  contactPhone: "689900229",
  address: "Calle San Frances N10",
  postalCode: "46800",
  city: "Xàtiva",
  localityCode: "46145",
  localityName: "Xàtiva",
  provinceCode: "46",
  provinceName: "Valencia",
  vehicleTypes,
  maxRiders: 30,
  serviceZones: zoneSlugs,
  notes: "Fleet operativa Xàtiva y corona territorial validada por PIKI.",
};
let fleetResponse;
try {
  fleetResponse = await request("/api/v1/fleets", { method: "POST", body: JSON.stringify(fleetInput) });
} catch (error) {
  if (!String(error).includes("FLEET_NAME_ALREADY_EXISTS")) throw error;
  const fleetsPayload = await request("/api/v1/fleets");
  const existingFleet = (fleetsPayload.fleets || []).find((fleet) => fleet.name === fleetInput.name);
  if (!existingFleet) throw new Error("La API indicó que la Fleet existe, pero no se pudo localizar con el mismo nombre.");
  fleetResponse = { fleet: existingFleet, reused: true };
}
const fleetId = fleetResponse.fleet?.id || fleetResponse.fleet?._id;
if (!fleetId) throw new Error("La API creó la Fleet pero no devolvió su id.");

const employees = await request("/api/v1/admin/employees");
const manager = (employees.employees || []).find((employee) => String(employee.email || "").toLowerCase() === managerEmail);
if (!manager?._id) throw new Error("No se encontró la cuenta del gestor después de crear la Fleet.");
await request(`/api/v1/admin/employees/${manager._id}/authorization`, { method: "PATCH", body: JSON.stringify({
  status: "approved",
  apiRole: "fleet",
  jobRole: "fleet",
  roles: ["fleet", "finance"],
  primaryRole: "fleet",
  fleetId: String(fleetId),
  zoneSlugs,
  reason: "Alta aprobada de Fleet Manager Joar Daniel Paduany; alcance Xàtiva y corona territorial.",
}) });
console.log(JSON.stringify({ applied: true, fleetId: String(fleetId), managerId: String(manager._id), email: managerEmail, roles: ["fleet", "finance"], zones: zoneSlugs }, null, 2));
