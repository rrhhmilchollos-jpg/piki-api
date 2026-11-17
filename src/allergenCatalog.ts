export const PIKI_ALLERGENS = [
  { code: "gluten", label: "Cereales con gluten", aliases: ["gluten", "cereales con gluten", "wheat", "cereals containing gluten"] },
  { code: "crustaceos", label: "Crustáceos", aliases: ["crustaceos", "crustaceans", "shrimp", "prawns"] },
  { code: "huevo", label: "Huevos", aliases: ["huevo", "huevos", "egg", "eggs"] },
  { code: "pescado", label: "Pescado", aliases: ["pescado", "fish"] },
  { code: "cacahuete", label: "Cacahuetes", aliases: ["cacahuete", "cacahuetes", "peanut", "peanuts", "groundnut"] },
  { code: "soja", label: "Soja", aliases: ["soja", "soya", "soy", "soybean", "soybeans"] },
  { code: "leche", label: "Leche y derivados", aliases: ["leche", "lacteo", "lacteos", "milk", "dairy"] },
  { code: "frutos_de_cascara", label: "Frutos de cáscara", aliases: ["frutos de cascara", "tree nuts", "almond", "almonds", "hazelnut", "walnut", "cashew", "pistachio"] },
  { code: "apio", label: "Apio", aliases: ["apio", "celery"] },
  { code: "mostaza", label: "Mostaza", aliases: ["mostaza", "mustard"] },
  { code: "sesamo", label: "Sésamo", aliases: ["sesamo", "sesame", "sesame seeds"] },
  { code: "sulfitos", label: "Dióxido de azufre y sulfitos", aliases: ["sulfitos", "sulfites", "sulphites", "sulfur dioxide", "sulphur dioxide", "dioxido de azufre"] },
  { code: "altramuces", label: "Altramuces", aliases: ["altramuz", "altramuces", "lupin", "lupins"] },
  { code: "moluscos", label: "Moluscos", aliases: ["molusco", "moluscos", "mollusc", "molluscs", "mollusk", "mollusks", "squid", "octopus", "clams", "mussels", "oysters"] },
] as const;

export type PikiAllergenCode = (typeof PIKI_ALLERGENS)[number]["code"];

function allergenKey(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

const allergenCodeByAlias = new Map<string, PikiAllergenCode>(
  PIKI_ALLERGENS.flatMap(({ code, aliases }) => [code, ...aliases].map(alias => [allergenKey(alias), code] as const)),
);

/** Returns a stable PIKI code for known labels/codes; unknown legacy text is not guessed. */
export function canonicalPikiAllergenCode(value: unknown): PikiAllergenCode | null {
  return typeof value === "string" ? allergenCodeByAlias.get(allergenKey(value)) ?? null : null;
}

/** Normalizes known historical labels while preserving unknown legacy strings verbatim. */
export function normalizePikiAllergenList(value: string[] | null): string[] | null {
  if (value === null) return null;
  return value.map(entry => canonicalPikiAllergenCode(entry) ?? entry);
}
