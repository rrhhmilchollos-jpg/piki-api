export type CustomerModifierOption = {
  id: string;
  name: string;
  price: number;
};

export type CustomerModifierGroup = {
  id: string;
  name: string;
  description?: string;
  minSelections: number;
  maxSelections: number;
  options: CustomerModifierOption[];
};

export type CustomerModifierSelection = {
  groupId: string;
  optionIds: string[];
};

export type SelectedMenuOption = {
  groupId: string;
  groupName: string;
  optionId: string;
  optionName: string;
  unitPriceCents: number;
};

const referenceAddOns: CustomerModifierGroup[] = [
  {
    id: "side",
    name: "Añade un complemento",
    description: "Opcional · puedes elegir uno",
    minSelections: 0,
    maxSelections: 1,
    options: [
      { id: "fries", name: "Patatas fritas con salsa", price: 2.7 },
      { id: "bravas", name: "Patatas bravas con salsa", price: 3.45 },
      { id: "deluxe", name: "Patatas deluxe con salsa", price: 3.45 },
      { id: "nuggets", name: "Nuggets de pollo (5 uds.)", price: 6.2 },
    ],
  },
  {
    id: "drink",
    name: "Añade una bebida",
    description: "Opcional · puedes elegir una",
    minSelections: 0,
    maxSelections: 1,
    options: [
      { id: "water-small", name: "Agua pequeña", price: 1.35 },
      { id: "coca-cola", name: "Coca-Cola", price: 2.1 },
      { id: "coca-cola-zero", name: "Coca-Cola Zero", price: 2.1 },
      { id: "fanta-orange", name: "Fanta Naranja", price: 2.1 },
      { id: "nestea-lemon", name: "Nestea Limón", price: 2.35 },
      { id: "aquarius", name: "Aquarius", price: 2.35 },
    ],
  },
];

const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const asText = (value: unknown, maxLength = 160) => typeof value === "string" ? value.trim().slice(0, maxLength) : "";
const asPrice = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000 ? value : null;
const asInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 30 ? value : null;
const toCents = (amount: number) => Math.round(amount * 100);

function safeId(value: string, fallback: string) {
  const normalized = value.toLocaleLowerCase("es").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 80);
  return normalized || fallback;
}

function cloneGroups(groups: CustomerModifierGroup[]) {
  return groups.map((group) => ({ ...group, options: group.options.map((option) => ({ ...option })) }));
}

/**
 * Converts persisted partner modifiers to the customer contract. Legacy modifiers
 * with string options remain readable: their group price is applied to each option.
 */
export function modifierGroupsForItem(item: unknown, useReferenceFallback = false): CustomerModifierGroup[] {
  const itemRecord = asRecord(item);
  const rawGroups = Array.isArray(itemRecord?.modifiers) ? itemRecord.modifiers : [];
  const groups = rawGroups.flatMap((rawGroup, groupIndex) => {
    const group = asRecord(rawGroup);
    if (!group) return [];
    const rawOptions = Array.isArray(group.options) ? group.options : [];
    const legacyPrice = asPrice(group.price) ?? 0;
    const options = rawOptions.flatMap((rawOption, optionIndex) => {
      if (typeof rawOption === "string") {
        const name = asText(rawOption, 120);
        return name ? [{ id: safeId(name, `option-${optionIndex + 1}`), name, price: legacyPrice }] : [];
      }
      const option = asRecord(rawOption);
      if (!option) return [];
      const name = asText(option.name, 120);
      const price = asPrice(option.price);
      if (!name || price === null) return [];
      return [{ id: safeId(asText(option.id, 80), `option-${optionIndex + 1}`), name, price }];
    });
    if (!options.length) return [];
    const maximum = Math.min(asInteger(group.maxSelections) ?? options.length, options.length);
    const minimum = Math.min(asInteger(group.minSelections) ?? (group.required === true ? 1 : 0), maximum);
    return [{
      id: safeId(asText(group.id, 80), `group-${groupIndex + 1}`),
      name: asText(group.name, 120) || `Opciones ${groupIndex + 1}`,
      description: asText(group.description, 240) || undefined,
      minSelections: minimum,
      maxSelections: maximum,
      options,
    }];
  });

  return groups.length || !useReferenceFallback ? groups : cloneGroups(referenceAddOns);
}

export function quoteMenuItem(item: unknown, rawSelections: unknown, useReferenceFallback = false) {
  const itemRecord = asRecord(item);
  const itemName = asText(itemRecord?.name) || "Producto";
  const basePrice = asPrice(itemRecord?.price);
  if (basePrice === null) throw new Error("Producto con precio no válido");

  const groups = modifierGroupsForItem(item, useReferenceFallback);
  const selections = Array.isArray(rawSelections) ? rawSelections : [];
  const receivedGroups = new Set<string>();
  const selectedOptions: SelectedMenuOption[] = [];

  for (const rawSelection of selections) {
    const selection = asRecord(rawSelection);
    const groupId = asText(selection?.groupId, 80);
    if (!groupId) throw new Error("Grupo de opciones no válido");
    if (receivedGroups.has(groupId)) throw new Error("Grupo de opciones repetido");
    receivedGroups.add(groupId);

    const group = groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new Error("Grupo de opciones no válido para este producto");
    const optionIds = Array.isArray(selection?.optionIds) ? selection.optionIds.map((id) => asText(id, 80)) : [];
    if (optionIds.some((id) => !id) || new Set(optionIds).size !== optionIds.length) throw new Error("Opción repetida o no válida");
    if (optionIds.length > group.maxSelections) throw new Error(`Puedes elegir hasta ${group.maxSelections} opción${group.maxSelections === 1 ? "" : "es"} en ${group.name}`);

    for (const optionId of optionIds) {
      const option = group.options.find((candidate) => candidate.id === optionId);
      if (!option) throw new Error("Opción no válida para este producto");
      selectedOptions.push({ groupId: group.id, groupName: group.name, optionId: option.id, optionName: option.name, unitPriceCents: toCents(option.price) });
    }
  }

  for (const group of groups) {
    const count = selectedOptions.filter((option) => option.groupId === group.id).length;
    if (count < group.minSelections) throw new Error(`Selecciona al menos ${group.minSelections} opción${group.minSelections === 1 ? "" : "es"} en ${group.name}`);
  }

  const unitPriceCents = toCents(basePrice) + selectedOptions.reduce((sum, option) => sum + option.unitPriceCents, 0);
  const summary = selectedOptions.map((option) => option.optionName).join(" · ");
  return { name: summary ? `${itemName} · ${summary}` : itemName, unitPriceCents, selectedOptions, modifierGroups: groups };
}

/** Temporary reference configuration for the four operational Xàtiva test products. */
export function usesReferenceAddOns(restaurant: { slug?: unknown } | null | undefined) {
  return restaurant?.slug === "piki-prueba";
}
