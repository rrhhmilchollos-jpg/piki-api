import assert from "node:assert/strict";
import test from "node:test";
import { PARTNER_DEMO_MENU_VERSION, partnerDemoMenu } from "./partnerDemoMenu.js";

test("la carta de demostración Partner conserva categorías, alérgenos y extras configurables", () => {
  assert.equal(PARTNER_DEMO_MENU_VERSION, 1);
  assert.ok(partnerDemoMenu.length >= 18);
  assert.ok(partnerDemoMenu.some((item) => item.category === "Postres y helados" && item.name.includes("Polo")));
  assert.ok(partnerDemoMenu.some((item) => item.category === "Bebidas"));
  assert.ok(partnerDemoMenu.every((item) => item.allergens.length >= 0));
  assert.ok(partnerDemoMenu.some((item) => item.modifiers.some((modifier) => modifier.options.length > 0)));
});
