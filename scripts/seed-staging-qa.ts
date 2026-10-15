import mongoose from "mongoose";
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { CustomerAccount, EmployeeAccount, Restaurant, Rider } from "../src/models.js";
import { hashPassword } from "../src/employeeAuth.js";

if (process.env.NODE_ENV !== "staging") throw new Error("NODE_ENV must be staging");
if (process.env.ALLOW_QA_SEED !== "true") throw new Error("Set ALLOW_QA_SEED=true explicitly for staging QA seed");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
if (!process.env.QA_PASSWORD || process.env.QA_PASSWORD.length < 12) throw new Error("QA_PASSWORD must be set and contain at least 12 characters");

const dbName = process.env.MONGODB_DB;
if (!dbName || !/staging|qa|test/i.test(dbName)) throw new Error("MONGODB_DB must explicitly name a staging/QA/test database");
const now = new Date();
const restaurantSlug = "piki-qa-kitchen";
const riderEmail = "qa-rider@pikidelivery.test";

await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10_000 });
try {
  const restaurant = await Restaurant.findOneAndUpdate(
    { slug: restaurantSlug },
    {
      $set: {
        name: "PIKI QA Kitchen",
        cuisine: "Test",
        category: "QA",
        locality: "Xàtiva",
        partnerGroupKey: "piki-qa",
        tagline: "Restaurante de pruebas de staging",
        etaMinutes: [15, 25],
        deliveryFeeCents: 199,
        rating: 5,
        reviews: 1,
        promoted: false,
        accent: "#c8ff35",
        onboardingStatus: "approved",
        isActive: true,
        email: "qa-partner@pikidelivery.test",
        phone: "+34960000001",
        address: "Carrer de la Prova 1, Xàtiva",
        location: { type: "Point", coordinates: [-0.5186, 38.9904] },
        partnerProfile: {
          legalName: "PIKI QA Kitchen S.L.", taxId: "B00000001", legalForm: "sl",
          representativeName: "PIKI QA", representativeRole: "QA", representativeDocument: "QA-00000001",
          fiscalAddress: "Carrer de la Prova 1", operatingAddress: "Carrer de la Prova 1",
          postalCode: "46800", city: "Xàtiva", province: "Valencia", iban: "ES0000000000000000000000",
          bankAccountHolder: "PIKI QA Kitchen S.L.", cuisine: "Test", vatRate: 10,
          commissionAccepted: true, termsAcceptedAt: now, contractAcceptedAt: now,
          privacyAcceptedAt: now, dataProcessingAcceptedAt: now, pdaUnits: 1,
          pdaUnitCostCents: 30000, pdaCostAcceptedAt: now,
          openingHours: { monday: { open: "00:00", close: "23:59" } }, documents: [],
        },
        menu: [{
          id: "qa-burger-001", name: "QA Burger", description: "Producto exclusivo para pruebas E2E",
          price: 8.99, category: "QA", image: "", allergens: [], modifiers: [], available: true,
          vegetarian: false, popular: true,
        }],
      },
      $setOnInsert: { slug: restaurantSlug },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  const rider = await Rider.findOneAndUpdate(
    { email: riderEmail },
    {
      $set: {
        isTestRider: true, name: "PIKI QA Rider", phone: "+34600000001", city: "Xàtiva",
        availability: "Todos los días · QA staging", zoneSlug: "xativa", status: "available",
        vehicle: "electric_scooter", location: { type: "Point", coordinates: [-0.5188, 38.9905] },
        lastLocationAt: now, reliabilityScore: 1,
      },
      $setOnInsert: { email: riderEmail, riderCode: "PIKI-QA-RIDER-001" },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();

  if (!restaurant || Array.isArray(restaurant) || !rider || Array.isArray(rider)) {
    throw new Error("QA seed did not return the expected restaurant and rider");
  }
  const passwordHash = hashPassword(process.env.QA_PASSWORD);
  const employeeSeeds = [
    ["qa-admin@pikidelivery.test", "QA Admin", "admin"],
    ["qa-partner@pikidelivery.test", "QA Partner", "partner"],
    [riderEmail, "PIKI QA Rider", "rider"],
    ["qa-fleet@pikidelivery.test", "QA Fleet", "fleet"],
    ["qa-support@pikidelivery.test", "QA Support", "support"],
  ] as const;
  const employees: Record<string, string> = {};
  for (const [email, name, role] of employeeSeeds) {
    const employee = await EmployeeAccount.findOneAndUpdate(
      { email },
      { $set: { name, jobRole: role, apiRole: role, roles: [role], accessLevel: "subadmin", authorizationStatus: "approved", authorizedAt: now, passwordHash, mustChangePassword: false, active: true, restaurantId: role === "partner" ? restaurant._id : null, restaurantIds: role === "partner" ? [restaurant._id] : [] }, $setOnInsert: { portfolioId: `qa_${role}` } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select("_id email").lean();
    if (employee) employees[role] = String(employee._id);
  }
  const customer = await CustomerAccount.findOneAndUpdate(
    { email: "qa-customer@pikidelivery.test" },
    { $set: { name: "PIKI QA Customer", passwordHash, deliveryAddress: "Carrer de la Prova 2, Xàtiva", deliveryLocation: { type: "Point", coordinates: [-0.5187, 38.9903] }, lastSignedIn: now } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).select("_id email").lean();
  const runId = process.env.E2E_RUN_ID;
  const manifestPath = process.env.E2E_FIXTURE_MANIFEST;
  if (runId && manifestPath) {
    const manifest = { schemaVersion: 1, runId, surfaces: Object.fromEntries(["CUSTOMER", "RIDER", "PARTNER", "FLEET", "ADMIN", "SUPPORT"].map((surface) => [surface, { fixtures: [`Cuenta QA y datos staging preparados para ${runId}`], cleanup: [`Eliminar datos QA etiquetados con ${runId}`] }])) };
    const target = resolve(manifestPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({ ok: true, dbName, runId, restaurantId: restaurant._id, restaurantSlug, menuItemId: "qa-burger-001", riderId: rider._id, riderEmail, riderCode: rider.riderCode, customerEmail: customer?.email, employees }, null, 2));
} finally {
  await mongoose.disconnect();
}
