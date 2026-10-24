import { quoteMenuItem, type SelectedMenuOption } from "./menuModifiers.js";

export type RequestedModifierSelection = { groupId: string; optionIds: string[] };
export type RequestedSelectedOption = { groupId: string; optionId: string };

export type RequestedOrderItemSnapshot = {
  itemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  totalCents?: number;
  selections?: RequestedModifierSelection[];
  selectedOptions?: RequestedSelectedOption[];
};

export type CanonicalOrderItemSnapshot = {
  itemId: string;
  name: string;
  quantity: number;
  unitPriceCents: number;
  selectedOptions: SelectedMenuOption[];
};

export class OrderSnapshotError extends Error {
  constructor(readonly code: "INVALID_MENU_ITEM" | "INVALID_MENU_SELECTION") {
    super(code);
    this.name = "OrderSnapshotError";
  }
}

function selectionsFromSelectedOptions(selectedOptions: RequestedSelectedOption[]): RequestedModifierSelection[] {
  const optionsByGroup = new Map<string, string[]>();
  for (const option of selectedOptions) {
    if (!option.groupId || !option.optionId) throw new OrderSnapshotError("INVALID_MENU_SELECTION");
    const group = optionsByGroup.get(option.groupId) || [];
    group.push(option.optionId);
    optionsByGroup.set(option.groupId, group);
  }
  return [...optionsByGroup].map(([groupId, optionIds]) => ({ groupId, optionIds }));
}

function normalizedSelections(item: RequestedOrderItemSnapshot): RequestedModifierSelection[] {
  if (item.selections !== undefined) return item.selections;
  if (item.selectedOptions !== undefined) return selectionsFromSelectedOptions(item.selectedOptions);
  // Older Customer clients did not send the selection structure. They remain
  // compatible for products without required modifiers; quoteMenuItem rejects
  // omitted required options instead of accepting a client-provided price.
  return [];
}

/**
 * Requotes each line against the current server menu. Names, modifiers and
 * amounts in the returned snapshot are all server-derived. `pricesMatchInput`
 * lets the caller send a price-conflict response before any write.
 */
export function buildCanonicalOrderSnapshot(input: {
  menu: unknown[];
  items: RequestedOrderItemSnapshot[];
  useReferenceAddOns?: boolean;
}) {
  const menuById = new Map(input.menu.map((item: any) => [String(item?.id), item]));
  let pricesMatchInput = true;
  const items = input.items.map((requested) => {
    const catalogItem = menuById.get(String(requested.itemId));
    if (!catalogItem) throw new OrderSnapshotError("INVALID_MENU_ITEM");
    try {
      const quote = quoteMenuItem(catalogItem, normalizedSelections(requested), input.useReferenceAddOns);
      const canonical: CanonicalOrderItemSnapshot = {
        itemId: String(catalogItem.id),
        name: quote.name,
        quantity: requested.quantity,
        unitPriceCents: quote.unitPriceCents,
        selectedOptions: quote.selectedOptions,
      };
      if (requested.unitPriceCents !== canonical.unitPriceCents) pricesMatchInput = false;
      if (requested.totalCents !== undefined && requested.totalCents !== canonical.unitPriceCents * canonical.quantity) pricesMatchInput = false;
      return canonical;
    } catch (error) {
      if (error instanceof OrderSnapshotError) throw error;
      throw new OrderSnapshotError("INVALID_MENU_SELECTION");
    }
  });
  const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  return { items, subtotalCents, pricesMatchInput };
}
