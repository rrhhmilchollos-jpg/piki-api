import assert from "node:assert/strict";
import test from "node:test";
import { modifierGroupsForItem, quoteMenuItem } from "./menuModifiers.js";

const bucket = { id: "kfc-bucket", name: "Bucket de pollo crujiente", price: 14.95, modifiers: [] };

test("expone la configuración de referencia para los cuatro productos operativos", () => {
  const groups = modifierGroupsForItem(bucket, true);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.id), ["side", "drink"]);
});

test("recalcula el importe de complementos y bebidas en servidor", () => {
  const quote = quoteMenuItem(bucket, [
    { groupId: "side", optionIds: ["fries"] },
    { groupId: "drink", optionIds: ["coca-cola"] },
  ], true);
  assert.equal(quote.unitPriceCents, 1975);
  assert.equal(quote.name, "Bucket de pollo crujiente · Patatas fritas con salsa · Coca-Cola");
  assert.equal(quote.selectedOptions.length, 2);
});

test("rechaza opciones inyectadas por el cliente", () => {
  assert.throws(() => quoteMenuItem(bucket, [{ groupId: "drink", optionIds: ["bebida-inventada"] }], true), /Opción no válida/);
  assert.throws(() => quoteMenuItem(bucket, [{ groupId: "side", optionIds: ["fries", "bravas"] }], true), /hasta 1 opción/);
});
