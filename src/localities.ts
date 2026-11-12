import { z } from "zod";
import dataset from "./data/spain-localities.json" with { type: "json" };

const querySchema = z.object({
  q: z.string().trim().max(120).default(""),
  limit: z.string().regex(/^\d{1,3}$/).transform(Number).pipe(z.number().int().min(1).max(50)).default(50),
});
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-ES").replace(/\s+/g, " ").trim();
const indexed = dataset.municipalities.map((item, index) => ({ item, index, names: [item.name, ...item.aliases].map(normalize), text: normalize([item.code, item.name, item.province, ...item.aliases].join(" ")) }));
export const LOCALITIES_SOURCE = {
  provider: "INE",
  sourceUrl: dataset.sourceUrl,
  populationSourceUrl: "https://www.ine.es/pob_xls/pobmun.zip",
  populationYear: dataset.populationYear,
  referenceDate: "2026-01-01",
  namesUpdatedThrough: "2026-11-11",
  count: dataset.municipalities.length,
  scope: "municipalities",
  caveats: ["Catálogo municipal, no nomenclátor de aldeas, barrios o entidades de población.", "No acredita oferta de partners ni cobertura comercial o de reparto.", "Alias limitados a variantes oficiales trazables; población oficial de 2025."],
};

export function searchLocalities(query: unknown) {
  const parsed = querySchema.safeParse(query);
  if (!parsed.success) return { ok: false as const, details: parsed.error.flatten() };
  const normalizedQuery = normalize(parsed.data.q);
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  const matches = indexed.filter(({ text }) => tokens.every((token) => text.includes(token)));
  if (normalizedQuery) {
    const rank = (row: typeof indexed[number]) => row.item.code === normalizedQuery || row.names.includes(normalizedQuery) ? 0
      : row.names.some((name) => name.startsWith(normalizedQuery)) ? 1
      : row.names.some((name) => name.includes(normalizedQuery)) ? 2 : 3;
    matches.sort((left, right) => rank(left) - rank(right) || left.index - right.index);
  }
  return { ok: true as const, body: { items: matches.slice(0, parsed.data.limit).map(({ item }) => item), total: matches.length, source: LOCALITIES_SOURCE } };
}
