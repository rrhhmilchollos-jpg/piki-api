import assert from "node:assert/strict";
import test from "node:test";
import { normalizePartnerMenuItems, partnerMenuItemsSchema } from "./menuContract.js";

test("conserva optionItems, precios propios y disponibilidad del editor Partner", () => {
  const parsed = partnerMenuItemsSchema.parse([{
    id: "dish-1", name: "Menú", price: 10, category: "Menús",
    modifiers: [{
      id: "drink", name: "Bebida", minSelections: 1, maxSelections: 1,
      options: ["Coca-Cola"],
      optionItems: [
        { id: "cola", name: "Coca-Cola", price: 0, available: true },
        { id: "fanta", name: "Fanta", price: 0.5, available: false },
      ],
    }],
  }]);
  const [item] = normalizePartnerMenuItems(parsed);
  assert.deepEqual(item.modifiers[0].optionItems.map((option) => [option.id, option.available]), [["cola", true], ["fanta", false]]);
  assert.equal(item.modifiers[0].options.length, 1);
  assert.equal((item.modifiers[0].options[0] as { id: string }).id, "cola");
});

test("migra un menú antiguo que solo tenía options de texto", () => {
  const parsed = partnerMenuItemsSchema.parse([{
    id: "dish-2", name: "Kebab", price: 7, modifiers: [{ id: "salsa", name: "Salsa", price: 0.5, options: ["Yogur", "Picante"] }],
  }]);
  const [item] = normalizePartnerMenuItems(parsed);
  assert.deepEqual(item.modifiers[0].optionItems.map((option) => option.name), ["Yogur", "Picante"]);
  assert.deepEqual(item.modifiers[0].options.map((option) => (option as { price: number }).price), [0.5, 0.5]);
});
