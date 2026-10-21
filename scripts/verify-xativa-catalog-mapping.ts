import fs from "node:fs/promises";
import path from "node:path";
import { normalizePartnerMenuItems, partnerMenuItemsSchema } from "../src/menuContract.js";

const inputArg = process.argv.indexOf("--input");
const inputFile = inputArg >= 0 ? process.argv[inputArg + 1] : "scripts/fixtures/xativa-local-catalog.sample.json";
if (!inputFile || inputFile.startsWith("--")) throw new Error("Uso: pnpm catalog:verify:xativa -- --input <fichero.json>");

const data = JSON.parse(await fs.readFile(path.resolve(process.cwd(), inputFile), "utf8"));
const failures: string[] = [];
const report: any[] = [];
for (const store of data.stores || []) {
  const parsed = partnerMenuItemsSchema.safeParse(store.menu);
  if (!parsed.success) throw new Error(`${store.slug}: menú inválido: ${JSON.stringify(parsed.error.flatten())}`);
  const normalized = normalizePartnerMenuItems(parsed.data);
  for (const item of normalized) {
    for (const group of item.modifiers) {
      const optionItems = group.optionItems || [];
      const unavailable = optionItems.filter((option) => option.available === false);
      const availableOptions = optionItems.filter((option) => option.available !== false);
      const minPrice = availableOptions.length ? Math.min(...availableOptions.map((option) => option.price)) : 0;
      if (group.price !== minPrice) failures.push(`${store.slug}/${item.id}/${group.id}: price del grupo no coincide con la opción mínima`);
      if (group.options.length !== availableOptions.length) failures.push(`${store.slug}/${item.id}/${group.id}: options públicas no filtran correctamente las opciones agotadas`);
      report.push({ store: store.slug, item: item.id, group: group.id, optionPrices: optionItems.map((option) => ({ id: option.id, price: option.price, available: option.available })), publicOptionCount: group.options.length, unavailableCount: unavailable.length });
    }
  }
}
if (failures.length) {
  console.error(JSON.stringify({ ok: false, failures }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, stores: (data.stores || []).length, report, assertion: "Los precios individuales y los estados available se conservan entre Partner y Customer." }, null, 2));
