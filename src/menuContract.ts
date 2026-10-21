import { z } from "zod";

const menuModifierOptionObjectSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  price: z.number().min(0).max(1000),
  available: z.boolean().default(true),
  description: z.string().max(240).default(""),
});

export const menuModifierOptionSchema = z.union([
  z.string().max(120),
  menuModifierOptionObjectSchema,
]);

export const menuModifierSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  description: z.string().max(240).default(""),
  price: z.number().min(0).max(1000).default(0),
  required: z.boolean().default(false),
  minSelections: z.number().int().min(0).max(30).default(0),
  maxSelections: z.number().int().min(1).max(30).default(1),
  // `options` is the legacy/public-compatible representation.
  options: z.array(menuModifierOptionSchema).max(30).default([]),
  // `optionItems` is the Partner editor representation with per-option state.
  optionItems: z.array(menuModifierOptionObjectSchema).max(30).default([]),
});

export const partnerMenuItemSchema = z.object({
  id: z.string().min(1).max(80),
  name: z.string().min(1).max(160),
  description: z.string().max(500).default(""),
  price: z.number().min(0).max(1000),
  category: z.string().max(100).default("General"),
  image: z.string().max(1200).refine((value) => value === "" || value.startsWith("https://api.pikidelivery.com/api/v1/catalog/assets/"), "La imagen debe proceder del almacenamiento de PIKI").default(""),
  allergens: z.array(z.string().max(80)).max(30).default([]),
  modifiers: z.array(menuModifierSchema).max(20).default([]),
  available: z.boolean().default(true),
  vegetarian: z.boolean().default(false),
  popular: z.boolean().default(false),
});

export const partnerMenuItemsSchema = z.array(partnerMenuItemSchema).max(500);
export type PartnerMenuItem = z.infer<typeof partnerMenuItemSchema>;

type ModifierOption = { id: string; name: string; price: number; available: boolean; description: string };

function canonicalOptions(group: PartnerMenuItem["modifiers"][number]): ModifierOption[] {
  if (group.optionItems.length) return group.optionItems;
  return group.options.map((option, index) => typeof option === "string"
    ? { id: `${group.id}-opt-${index + 1}`, name: option, price: group.price, available: true, description: "" }
    : option);
}

/**
 * Keep both menu representations in storage during the migration. This makes
 * old menus readable while ensuring Partner's per-option prices and switches
 * survive the next save and reach Customer unchanged.
 */
export function normalizePartnerMenuItems(items: PartnerMenuItem[]): PartnerMenuItem[] {
  return items.map((item) => ({
    ...item,
    modifiers: item.modifiers.map((group) => {
      const optionItems = canonicalOptions(group);
      const availableOptions = optionItems.filter((option) => option.available);
      return {
        ...group,
        optionItems,
        options: availableOptions,
        price: availableOptions.length ? Math.min(...availableOptions.map((option) => option.price)) : 0,
        minSelections: Math.min(group.minSelections, availableOptions.length),
        maxSelections: Math.min(Math.max(group.minSelections, group.maxSelections), Math.max(1, availableOptions.length)),
      };
    }),
  }));
}
