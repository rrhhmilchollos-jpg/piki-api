import mongoose from "mongoose";
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CustomerAccount, EmployeeAccount, Fleet, Restaurant, Rider, RiderSlot, Tenant, TenantMembership } from "../src/models.js";
import { hashPassword } from "../src/employeeAuth.js";

if (process.env.NODE_ENV !== "staging") throw new Error("NODE_ENV must be staging");
if (process.env.ALLOW_QA_SEED !== "true") throw new Error("Set ALLOW_QA_SEED=true explicitly for staging QA seed");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
if (!process.env.QA_PASSWORD || process.env.QA_PASSWORD.length < 12) throw new Error("QA_PASSWORD must be set and contain at least 12 characters");

const runId = String(process.env.E2E_RUN_ID || "").trim();
if (!/^qa-[a-z0-9-]{8,64}$/.test(runId)) throw new Error("E2E_RUN_ID must have format qa-... and be unique");
const dbName = process.env.MONGODB_DB;
if (!dbName || !/staging|qa|test/i.test(dbName)) throw new Error("MONGODB_DB must explicitly name a staging/QA/test database");

const now = new Date();
const runSuffix = runId.slice(3);
const tenantSlug = `piki-qa-${runSuffix}`;
const restaurantSlug = `piki-qa-kitchen-${runSuffix}`;
const riderEmail = `qa-rider-${runSuffix}@pikidelivery.test`;
const customerEmail = `qa-customer-${runSuffix}@pikidelivery.test`;
const partnerEmail = `qa-partner-${runSuffix}@pikidelivery.test`;
const fleetEmail = `qa-fleet-${runSuffix}@pikidelivery.test`;
const adminEmail = `qa-admin-${runSuffix}@pikidelivery.test`;

const drinks = [["coca-cola", "Coca-Cola Original", 0], ["coca-cola-zero", "Coca-Cola Zero", 0], ["fanta-naranja", "Fanta Naranja", 0], ["nestea-limon", "Nestea Limón", 0], ["aquarius-limon", "Aquarius Limón", 0]] as const;
const sauces = [["salsa-yogur", "Salsa de yogur", 0], ["salsa-picante", "Salsa picante", 0], ["salsa-barbacoa", "Salsa barbacoa", 0.5]] as const;
const meatExtras = [["extra-queso", "Queso", 1], ["extra-carne", "Carne extra", 2], ["extra-gratinado", "Gratinado", 1.9]] as const;

function options(prefix: string, rows: readonly (readonly [string, string, number])[]) {
  return rows.map(([id, name, price]) => ({ id: `alibaba-${prefix}-${id}`, name, price }));
}

function alibabaModifierGroups(item: any) {
  const name = String(item?.name || "").toLocaleLowerCase("es-ES");
  const groups: any[] = [];
  if (name.includes("menú") || name.includes("menu")) groups.push({ id: `alibaba-${item.id}-bebida`, name: "Elige tu bebida", description: "Incluida en el menú", minSelections: 1, maxSelections: 1, options: options("bebida", drinks) });
  if (name.includes("doner") || name.includes("kebab") || name.includes("carne")) groups.push({ id: `alibaba-${item.id}-salsa`, name: "Elige tu salsa", description: "Puedes escoger una salsa", minSelections: 0, maxSelections: 1, options: options("salsa", sauces) });
  if (name.includes("doner") || name.includes("kebab") || name.includes("carne") || name.includes("plato")) groups.push({ id: `alibaba-${item.id}-extras`, name: "¿Quieres añadir extras?", description: "Extras opcionales para tu pedido", minSelections: 0, maxSelections: 3, options: options("extra", meatExtras) });
  return groups;
}

function madridDateAndTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const read = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  return { date: `${read("year")}-${read("month")}-${read("day")}`, time: `${read("hour")}:${read("minute")}` };
}

await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10_000 });
try {
  const tenant = await Tenant.findOneAndUpdate(
    { slug: tenantSlug },
    { $set: { name: `PIKI QA · ${runSuffix}`, status: "active", isPlatformTenant: false, settings: { limits: { maxRiders: 10, maxDailySlots: 10, maxSlotsPerRiderPerDay: 3 } } } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean() as any;
  if (!tenant?._id) throw new Error("QA tenant could not be created");

  const fleet = await Fleet.findOneAndUpdate(
    { tenantId: tenant._id, name: `PIKI QA Fleet ${runSuffix}` },
    { $set: { tenantId: tenant._id, name: `PIKI QA Fleet ${runSuffix}`, managerName: "PIKI QA", managerDni: "QA000000A", contactEmail: fleetEmail, contactPhone: "+34960000002", address: "Carrer de la Prova 1", postalCode: "46800", city: "Xàtiva", vehicleTypes: ["electric_scooter"], maxRiders: 10, serviceZones: ["xativa"], isActive: true } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean() as any;
  if (!fleet?._id) throw new Error("QA fleet could not be created");

  const restaurant = await Restaurant.findOneAndUpdate(
    { slug: restaurantSlug },
    { $set: { tenantId: tenant._id, name: "PIKI QA Kitchen", cuisine: "Test", category: "QA", locality: "Xàtiva", partnerGroupKey: `piki-qa-${runId}`, qaRunId: runId, tagline: "Restaurante de pruebas de staging", etaMinutes: [15, 25], deliveryFeeCents: 199, rating: 5, reviews: 1, promoted: false, accent: "#c8ff35", onboardingStatus: "approved", isActive: true, email: partnerEmail, phone: "+34960000001", address: "Carrer de la Prova 1, Xàtiva", location: { type: "Point", coordinates: [-0.5186, 38.9904] }, partnerProfile: { legalName: "PIKI QA Kitchen S.L.", taxId: "B00000001", legalForm: "sl", representativeName: "PIKI QA", representativeRole: "QA", representativeDocument: "QA-00000001", fiscalAddress: "Carrer de la Prova 1", operatingAddress: "Carrer de la Prova 1", postalCode: "46800", city: "Xàtiva", province: "Valencia", iban: "ES0000000000000000000000", bankAccountHolder: "PIKI QA Kitchen S.L.", cuisine: "Test", vatRate: 10, commissionAccepted: true, termsAcceptedAt: now, contractAcceptedAt: now, privacyAcceptedAt: now, dataProcessingAcceptedAt: now, pdaUnits: 1, pdaUnitCostCents: 30000, pdaCostAcceptedAt: now, openingHours: { monday: { open: "00:00", close: "23:59" }, tuesday: { open: "00:00", close: "23:59" }, wednesday: { open: "00:00", close: "23:59" }, thursday: { open: "00:00", close: "23:59" }, friday: { open: "00:00", close: "23:59" }, saturday: { open: "00:00", close: "23:59" }, sunday: { open: "00:00", close: "23:59" } }, documents: [] } } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean() as any;
  if (!restaurant?._id) throw new Error("QA restaurant could not be created");

  const fixtureCandidates = [resolve(process.cwd(), "scripts/fixtures/alibaba-staging-menu.json"), resolve(process.cwd(), "dist/fixtures/alibaba-staging-menu.json")];
  let fixtureText = "";
  for (const fixturePath of fixtureCandidates) {
    try { fixtureText = await readFile(fixturePath, "utf8"); break; } catch { /* Try the next container/runtime path. */ }
  }
  if (!fixtureText) throw new Error("Alibaba staging fixture is not available in this build");
  const alibabaFixture = JSON.parse(fixtureText) as any;
  const sourceMenu = Array.isArray(alibabaFixture.menu) && alibabaFixture.menu.length ? alibabaFixture.menu : [];
  if (!sourceMenu.length) throw new Error("Alibaba staging fixture has no menu items");
  const qaMenu = sourceMenu.map((item: any) => ({ ...item, modifiers: alibabaModifierGroups(item), modifierGroups: alibabaModifierGroups(item) }));
  await Restaurant.updateOne({ _id: restaurant._id, tenantId: tenant._id, qaRunId: runId }, { $set: { menu: qaMenu, "partnerProfile.commissionRateBps": 1500 } }).exec();

  const rider = await Rider.findOneAndUpdate(
    { email: riderEmail },
    { $set: { tenantId: tenant._id, fleetId: fleet._id, isTestRider: true, qaRunId: runId, name: "PIKI QA Rider", phone: "+34600000001", city: "Xàtiva", availability: "Todos los días · QA staging", zoneSlug: "xativa", status: "available", lifecycleStatus: "active", vehicle: "electric_scooter", location: { type: "Point", coordinates: [-0.5188, 38.9905] }, lastLocationAt: now, reliabilityScore: 1, ratingScore: 1, ratingCount: 10 }, $setOnInsert: { email: riderEmail, riderCode: `PIKI-QA-${runSuffix.slice(-8).toUpperCase()}` } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean() as any;
  if (!rider?._id) throw new Error("QA rider could not be created");

  const slot = madridDateAndTime(now);
  await RiderSlot.findOneAndUpdate(
    { tenantId: tenant._id, riderId: rider._id, date: slot.date, startTime: "00:00" },
    { $set: { tenantId: tenant._id, riderId: rider._id, zoneSlug: "xativa", date: slot.date, startTime: "00:00", endTime: "23:59", status: "active", notes: `Turno QA aislado ${runId}` } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();

  const passwordHash = hashPassword(process.env.QA_PASSWORD);
  const employeeSeeds = [
    [adminEmail, "QA Admin", "admin"],
    [partnerEmail, "QA Partner", "partner"],
    [riderEmail, "PIKI QA Rider", "rider"],
    [fleetEmail, "QA Fleet", "fleet"],
    [`qa-support-${runSuffix}@pikidelivery.test`, "QA Support", "support"],
  ] as const;
  const employees: Record<string, string> = {};
  for (const [email, name, role] of employeeSeeds) {
    const employee = await EmployeeAccount.findOneAndUpdate(
      { email },
      { $set: { tenantId: tenant._id, qaRunId: runId, name, jobRole: role, apiRole: role, roles: [role], primaryRole: role, partnerRoles: role === "partner" ? ["partner_admin"] : [], accessLevel: "subadmin", authorizationStatus: "approved", authorizedAt: now, passwordHash, mustChangePassword: false, active: true, fleetId: role === "fleet" ? fleet._id : null, zoneSlugs: role === "fleet" || role === "rider" ? ["xativa"] : [], restaurantId: role === "partner" ? restaurant._id : null, restaurantIds: role === "partner" ? [restaurant._id] : [] }, $setOnInsert: { portfolioId: `qa_${role}_${runSuffix}` } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select("_id email").lean() as any;
    if (!employee?._id) throw new Error(`QA employee ${role} could not be created`);
    employees[role] = String(employee._id);
    await TenantMembership.findOneAndUpdate({ tenantId: tenant._id, employeeId: employee._id }, { $set: { tenantId: tenant._id, employeeId: employee._id, role: role === "support" ? "admin" : role, status: "active", scopes: ["qa:e2e"] } }, { upsert: true, new: true, setDefaultsOnInsert: true }).exec();
  }

  const customer = await CustomerAccount.findOneAndUpdate(
    { email: customerEmail },
    { $set: { tenantId: tenant._id, qaRunId: runId, name: "PIKI QA Customer", passwordHash, deliveryAddress: "Carrer de la Prova 2, Xàtiva", deliveryLocation: { type: "Point", coordinates: [-0.5187, 38.9903] }, lastSignedIn: now } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).select("_id email").lean() as any;
  if (!customer?._id) throw new Error("QA customer could not be created");

  const manifestPath = process.env.E2E_FIXTURE_MANIFEST;
  if (manifestPath) {
    const manifest = { schemaVersion: 3, runId, tenant: { id: String(tenant._id), slug: tenantSlug }, entities: { fleetId: String(fleet._id), restaurantId: String(restaurant._id), riderId: String(rider._id), customerId: String(customer._id), employeeIds: employees }, surfaces: Object.fromEntries(["CUSTOMER", "RIDER", "PARTNER", "FLEET", "ADMIN"].map((surface) => [surface, { fixtures: [`Cuenta y entidades QA aisladas para ${runId}`], cleanup: [`Eliminar únicamente documentos vinculados al runId y tenant QA`] }])) };
    const target = resolve(manifestPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ok: true, dbName, runId, tenant: { id: tenant._id, slug: tenantSlug }, fleetId: fleet._id, restaurantId: restaurant._id, restaurantSlug, commissionRateBps: 1500, menuItemId: qaMenu[0]?.id || null, riderId: rider._id, riderEmail, customerEmail: customer.email, employees }, null, 2));
} finally {
  await mongoose.disconnect();
}
