import mongoose from "mongoose";
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Restaurant } from "../src/models.js";

if (process.env.NODE_ENV !== "staging") throw new Error("NODE_ENV must be staging");
if (process.env.RUN_ALIBABA_STAGING_SEED !== "true") throw new Error("RUN_ALIBABA_STAGING_SEED must be true");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
const dbName = process.env.MONGODB_DB;
if (!dbName || !/staging|qa|test/i.test(dbName)) throw new Error("MONGODB_DB must explicitly name a staging/QA/test database");

const rows = {
  drinks: [
    ["coca-cola", "Coca-Cola Original", 0], ["coca-cola-zero", "Coca-Cola Zero", 0],
    ["fanta-naranja", "Fanta Naranja", 0], ["nestea-limon", "Nestea Limón", 0], ["aquarius-limon", "Aquarius Limón", 0],
  ],
  sauces: [["salsa-yogur", "Salsa de yogur", 0], ["salsa-picante", "Salsa picante", 0], ["salsa-barbacoa", "Salsa barbacoa", 0.5]],
  extras: [["extra-queso", "Queso", 1], ["extra-carne", "Carne extra", 2], ["extra-gratinado", "Gratinado", 1.9]],
} as const;

function options(prefix: string, values: readonly (readonly [string, string, number])[]) {
  return values.map(([id, name, price]) => ({ id: `alibaba-${prefix}-${id}`, name, price }));
}

function groupsFor(item: any) {
  const name = String(item?.name || "").toLocaleLowerCase("es-ES");
  const groups: any[] = [];
  if (name.includes("menú") || name.includes("menu")) groups.push({ id: `${item.id}-bebida`, name: "Elige tu bebida", description: "Incluida en el menú", minSelections: 1, maxSelections: 1, options: options("bebida", rows.drinks) });
  if (name.includes("doner") || name.includes("kebab") || name.includes("carne")) groups.push({ id: `${item.id}-salsa`, name: "Elige tu salsa", description: "Puedes escoger una salsa", minSelections: 0, maxSelections: 1, options: options("salsa", rows.sauces) });
  if (name.includes("doner") || name.includes("kebab") || name.includes("carne") || name.includes("plato")) groups.push({ id: `${item.id}-extras`, name: "¿Quieres añadir extras?", description: "Extras opcionales para tu pedido", minSelections: 0, maxSelections: 3, options: options("extra", rows.extras) });
  return groups;
}

const fixturePath = resolve(process.cwd(), "dist/fixtures/alibaba-staging-menu.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as any;
const menu = (fixture.menu || []).map((item: any) => ({ ...item, modifiers: groupsFor(item), modifierGroups: groupsFor(item) }));
await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10_000 });
try {
  const restaurant = await Restaurant.findOneAndUpdate(
    { slug: "alibaba-kebab-xativa" },
    { $set: { ...fixture, menu, onboardingStatus: "approved", availabilityStatus: "available", isActive: true, "partnerProfile.commissionRateBps": 1500 } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).select("_id menu").lean() as any;
  console.log(JSON.stringify({ ok: true, environment: "staging", restaurantId: restaurant?._id, products: menu.length, configurableProducts: menu.filter((item: any) => item.modifierGroups.length).length }));
} finally {
  await mongoose.disconnect();
}
