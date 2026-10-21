import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";
import { z } from "zod";
import { Restaurant, ensureIndexes } from "../src/models.js";
import { normalizePartnerMenuItems, partnerMenuItemsSchema, type PartnerMenuItem } from "../src/menuContract.js";

/**
 * Importador controlado de supermercados y tiendas locales de Xàtiva.
 *
 * Seguridad operativa:
 * - dry-run por defecto; nunca escribe sin --apply;
 * - exige localidad Xàtiva y slugs únicos;
 * - importa como pending_review + coming_soon + inactive;
 * - nunca activa un comercio ni lo marca como aprobado; esa decisión queda en Admin;
 * - actualiza por slug, sin borrar campos operativos ajenos al importador.
 *
 * Uso:
 *   pnpm catalog:import:xativa -- --input scripts/fixtures/xativa-local-catalog.json
 *   pnpm catalog:import:xativa -- --input ./catalogo.json --apply
 *   Después del --apply, revisa y aprueba cada comercio desde Admin antes de activarlo.
 */

const XATIVA_ALIASES = new Set(["xativa", "xàtiva", "xativa casco urbano", "xàtiva casco urbano"]);
const slugSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "slug inválido: usa minúsculas y guiones");
const localItemSchema = partnerMenuItemsSchema.element.extend({
  id: z.string().min(1).max(80),
});
const storeSchema = z.object({
  slug: slugSchema,
  name: z.string().trim().min(2).max(160),
  cuisine: z.string().trim().min(2).max(80),
  category: z.string().trim().min(2).max(100),
  locality: z.string().trim().min(2).max(80),
  address: z.string().trim().min(5).max(240),
  phone: z.string().trim().max(40).default(""),
  email: z.string().trim().email().max(200).optional(),
  partnerCode: z.string().trim().min(2).max(80).optional(),
  fulfillmentMode: z.enum(["partner_delivery", "assisted_purchase"]).default("partner_delivery"),
  deliveryFeeCents: z.number().int().min(0).max(100_000).default(299),
  commissionRateBps: z.number().int().min(0).max(10_000).default(2_000),
  image: z.string().url().max(1_200).optional(),
  tagline: z.string().trim().max(240).default(""),
  menu: z.array(localItemSchema).min(1).max(500),
});
const inputSchema = z.object({
  source: z.string().trim().min(2).max(240),
  sourceContact: z.string().trim().max(240).default(""),
  stores: z.array(storeSchema).max(100),
});
type StoreInput = z.infer<typeof storeSchema>;

type Args = { input: string; apply: boolean };
function argsFrom(argv: string[]): Args {
  const index = argv.indexOf("--input");
  const input = index >= 0 ? argv[index + 1] : undefined;
  if (!input || input.startsWith("--")) throw new Error("Falta --input <fichero.json>");
  if (argv.includes("--activate-live")) throw new Error("La activación live se realiza después desde Admin; este importador solo crea borradores pendientes de revisión.");
  return { input, apply: argv.includes("--apply") };
}
function normalizedLocality(value: string) {
  return value.trim().toLocaleLowerCase("es-ES").replace(/\s+/g, " ");
}
function centsToEuro(cents: number) { return (cents / 100).toFixed(2); }
function assertBusinessRules(stores: StoreInput[]) {
  const slugs = new Set<string>();
  for (const store of stores) {
    if (!XATIVA_ALIASES.has(normalizedLocality(store.locality))) {
      throw new Error(`${store.slug}: localidad fuera de Xàtiva Casco Urbano: ${store.locality}`);
    }
    if (slugs.has(store.slug)) throw new Error(`slug duplicado: ${store.slug}`);
    slugs.add(store.slug);
    const itemIds = new Set<string>();
    for (const item of store.menu) {
      if (itemIds.has(item.id)) throw new Error(`${store.slug}: producto duplicado: ${item.id}`);
      itemIds.add(item.id);
      if (item.price > 1000) throw new Error(`${store.slug}/${item.id}: precio superior a 1.000 €`);
    }
  }
}
function printPlan(stores: StoreInput[], args: Args) {
  console.log(JSON.stringify({
    mode: args.apply ? (args.activateLive ? "apply-live" : "apply-pending-review") : "dry-run",
    source: "input-file",
    stores: stores.map((store) => ({
      slug: store.slug,
      name: store.name,
      category: store.category,
      locality: store.locality,
      products: store.menu.length,
      deliveryFee: `${centsToEuro(store.deliveryFeeCents)} EUR`,
      commissionRate: `${(store.commissionRateBps / 100).toFixed(2)}%`,
      resultingStatus: "coming_soon + inactive + pending_review",
    })),
    writeEnabled: args.apply,
  }, null, 2));
}
async function main() {
  const args = argsFrom(process.argv.slice(2));
  const inputPath = path.resolve(process.cwd(), args.input);
  const input = inputSchema.parse(JSON.parse(await fs.readFile(inputPath, "utf8")));
  assertBusinessRules(input.stores);
  printPlan(input.stores, args);
  if (!args.apply || input.stores.length === 0) {
    console.log(input.stores.length === 0 ? "No hay comercios: añade datos reales al fichero antes de --apply." : "Dry-run completado; no se ha escrito nada.");
    return;
  }

  const uri = String(process.env.MONGODB_URI || "").trim();
  if (!uri) throw new Error("MONGODB_URI es obligatorio para --apply");
  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || undefined, serverSelectionTimeoutMS: 10_000 });
  await ensureIndexes();
  const results: Array<{ slug: string; id: string; products: number; status: string }> = [];
  try {
    for (const store of input.stores) {
      const menu: PartnerMenuItem[] = normalizePartnerMenuItems(store.menu);
      const status = "coming_soon" as const;
      const update = {
        $set: {
          name: store.name,
          cuisine: store.cuisine,
          category: store.category,
          locality: "Xàtiva",
          address: store.address,
          phone: store.phone,
          ...(store.email ? { email: store.email } : {}),
          ...(store.partnerCode ? { partnerCode: store.partnerCode } : {}),
          fulfillmentMode: store.fulfillmentMode,
          deliveryFeeCents: store.deliveryFeeCents,
          "partnerProfile.commissionRateBps": store.commissionRateBps,
          ...(store.image ? { image: store.image } : {}),
          tagline: store.tagline,
          menu,
          availabilityStatus: status,
          isActive: args.activateLive,
          onboardingStatus: "pending_review",
          listingType: "official_partner",
          internalDemo: false,
          "marketplaceCompliance.pikiStatus": "pending",
        },
        $setOnInsert: { slug: store.slug },
      };
      const saved = await Restaurant.findOneAndUpdate({ slug: store.slug }, update, { upsert: true, new: true, setDefaultsOnInsert: true }).select("_id slug menu availabilityStatus isActive").lean().exec() as any;
      results.push({ slug: store.slug, id: String(saved._id), products: menu.length, status: `${saved.availabilityStatus}/${saved.isActive ? "active" : "inactive"}` });
    }
    console.log(JSON.stringify({ applied: true, results }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
