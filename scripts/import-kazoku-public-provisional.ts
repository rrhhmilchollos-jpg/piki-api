import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { z } from "zod";
import { Restaurant } from "../src/models.js";
import { preflightRestaurantCatalogIndexes } from "../src/catalogImportPreflight.js";
import { normalizePartnerMenuItems } from "../src/menuContract.js";

/**
 * Importa únicamente una ficha pública provisional de Kazoku.
 *
 * Seguridad: dry-run por defecto; --apply escribe pending_review + inactive +
 * coming_soon. No crea documentos legales, no activa pedidos y no importa una
 * carta de terceros sin autorización expresa del propietario.
 */
const storeSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  name: z.string().min(2).max(160),
  cuisine: z.string().min(2).max(80),
  category: z.string().min(2).max(100),
  locality: z.enum(["Xàtiva", "Algemesí"]),
  postalCode: z.string().regex(/^\d{5}$/),
  address: z.string().min(5).max(240),
  phone: z.string().max(40),
  image: z.string().url().max(1200).or(z.literal("")),
  menu: z.array(z.record(z.string(), z.unknown())).max(500),
});
const inputSchema = z.object({
  source: z.string().min(2).max(500),
  sourceUrls: z.array(z.string().url()).min(1).max(10),
  provisionalOnly: z.literal(true),
  legalStatus: z.literal("pending_owner_documents"),
  commissionRateBps: z.literal(1800),
  stores: z.array(storeSchema).length(2),
});

const inputArg = process.argv.indexOf("--input");
const inputFile = inputArg >= 0 ? process.argv[inputArg + 1] : "scripts/fixtures/kazoku-provisional-public.json";
if (!inputFile || inputFile.startsWith("--")) throw new Error("Usa --input <fichero.json>");
const apply = process.argv.includes("--apply");
const input = inputSchema.parse(JSON.parse(await fs.readFile(path.resolve(process.cwd(), inputFile), "utf8")));
const slugs = new Set<string>();
for (const store of input.stores) {
  if (slugs.has(store.slug)) throw new Error(`Slug duplicado: ${store.slug}`);
  slugs.add(store.slug);
}
const plan = input.stores.map((store) => ({
  slug: store.slug,
  name: store.name,
  locality: store.locality,
  address: store.address,
  phone: store.phone,
  commissionRate: "18.00%",
  menuItems: store.menu.length,
  resultingStatus: "pending_review + inactive + coming_soon",
  legalStatus: input.legalStatus,
}));
console.log(JSON.stringify({ mode: apply ? "apply-provisional" : "dry-run", source: input.source, sourceUrls: input.sourceUrls, writeEnabled: apply, stores: plan }, null, 2));
if (!apply) {
  console.log("Dry-run completado; no se ha escrito nada.");
  process.exit(0);
}
const uri = String(process.env.MONGODB_URI || "").trim();
if (!uri) throw new Error("MONGODB_URI es obligatorio para --apply");
await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || undefined, serverSelectionTimeoutMS: 10_000, autoIndex: false, autoCreate: false });
try {
  await preflightRestaurantCatalogIndexes(Restaurant.collection);
  const results = [];
  for (const store of input.stores) {
    const menu = normalizePartnerMenuItems(store.menu as never[]);
    const saved = await Restaurant.findOneAndUpdate(
      { slug: store.slug },
      {
        $set: {
          name: store.name,
          cuisine: store.cuisine,
          category: store.category,
          locality: store.locality,
          address: store.address,
          phone: store.phone,
          image: store.image,
          menu,
          partnerGroupKey: "kazoku-founder",
          goldFounder: true,
          listingType: "official_partner",
          fulfillmentMode: "partner_delivery",
          deliveryFeeCents: 299,
          availabilityStatus: "coming_soon",
          isActive: false,
          onboardingStatus: "pending_review",
          onboardingStage: "review",
          internalDemo: false,
          upcomingMessage: "Disponible tras completar la documentación del partner",
          "partnerProfile.commissionRateBps": input.commissionRateBps,
          "marketplaceCompliance.pikiStatus": "pending",
          "partnerProfile.postalCode": store.postalCode,
          "partnerProfile.city": store.locality,
          "partnerProfile.province": "Valencia",
          "partnerProfile.operatingAddress": store.address,
        },
        $setOnInsert: { slug: store.slug },
        $inc: { menuRevision: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).select("_id slug name locality availabilityStatus onboardingStatus isActive menu").lean().exec() as any;
    results.push({ slug: saved.slug, id: String(saved._id), menuItems: saved.menu?.length || 0, status: `${saved.onboardingStatus}/${saved.availabilityStatus}/${saved.isActive ? "active" : "inactive"}` });
  }
  console.log(JSON.stringify({ applied: true, results }, null, 2));
} finally {
  await mongoose.disconnect();
}
