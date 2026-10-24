import assert from "node:assert/strict";
import test from "node:test";
import { buildCanonicalOrderSnapshot, OrderSnapshotError } from "./orderSnapshot.js";

const menu = [{
  id: "burger", name: "Burger", price: 10,
  modifiers: [{ id: "extra", name: "Extra", minSelections: 0, maxSelections: 1, options: [{ id: "cheese", name: "Queso", price: 2 }] }],
}];

test("el snapshot re-cotiza modificadores y sustituye nombre e importes enviados por cliente", () => {
  const snapshot = buildCanonicalOrderSnapshot({
    menu,
    items: [{ itemId: "burger", name: "Precio manipulado", quantity: 2, unitPriceCents: 1200, totalCents: 2400, selections: [{ groupId: "extra", optionIds: ["cheese"] }] }],
  });
  assert.equal(snapshot.pricesMatchInput, true);
  assert.equal(snapshot.subtotalCents, 2400);
  assert.deepEqual(snapshot.items[0], {
    itemId: "burger", name: "Burger · Queso", quantity: 2, unitPriceCents: 1200,
    selectedOptions: [{ groupId: "extra", groupName: "Extra", optionId: "cheese", optionName: "Queso", unitPriceCents: 200 }],
  });
});

test("el snapshot marca el precio o total de línea manipulados antes de persistir", () => {
  const snapshot = buildCanonicalOrderSnapshot({
    menu,
    items: [{ itemId: "burger", name: "Burger", quantity: 1, unitPriceCents: 1, totalCents: 1, selections: [{ groupId: "extra", optionIds: ["cheese"] }] }],
  });
  assert.equal(snapshot.pricesMatchInput, false);
  assert.equal(snapshot.subtotalCents, 1200);
});

test("el snapshot rechaza opciones de modificador inyectadas", () => {
  assert.throws(() => buildCanonicalOrderSnapshot({
    menu,
    items: [{ itemId: "burger", name: "Burger", quantity: 1, unitPriceCents: 1000, selectedOptions: [{ groupId: "extra", optionId: "inventada" }] }],
  }), (error: unknown) => error instanceof OrderSnapshotError && error.code === "INVALID_MENU_SELECTION");
});
