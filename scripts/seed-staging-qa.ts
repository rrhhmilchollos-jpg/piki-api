import mongoose from "mongoose";
import "dotenv/config";
import { Restaurant, Rider } from "../src/models.ts";

if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed when NODE_ENV=production");
if (process.env.ALLOW_QA_SEED !== "true") throw new Error("Set ALLOW_QA_SEED=true explicitly for staging QA seed");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

const dbName = process.env.MONGODB_DB || "piki-staging";
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
          price: 899, category: "QA", image: "", allergens: [], modifiers: [], available: true,
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

  console.log(JSON.stringify({ ok: true, dbName, restaurantId: restaurant._id, restaurantSlug, menuItemId: "qa-burger-001", riderId: rider._id, riderEmail, riderCode: rider.riderCode }, null, 2));
} finally {
  await mongoose.disconnect();
}
