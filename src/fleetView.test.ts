import test from "node:test";
import assert from "node:assert/strict";
import { fleetPublicView } from "./fleetView.js";
test("legacy fleet uses geographic zones instead of a personal name", () => {
  const view = fleetPublicView({ _id: "fleet-1", name: "Jackson", serviceZones: ["xativa", "novetle"] }, { xativa: "Xàtiva", novetle: "Novetlè" });
  assert.equal(view.displayName, "Flota Xàtiva / Novetlè");
  assert.equal(view.name, "Jackson", "legacy identifier remains compatible but must not be used as the geographic UI label");
});
test("fleet without geographic evidence does not invent a city", () => {
  assert.equal(fleetPublicView({ _id: "fleet-1", name: "Personal Name", serviceZones: [] }, {}).displayName, "Flota sin localidad asignada");
});
test("test fleet retains its test warning and counts extra geographic zones", () => {
  const view = fleetPublicView({ _id: "fleet-1", name: "Fleet QA", serviceZones: ["a", "b", "c", "d", "a"] }, { a: "Xàtiva", b: "Novetlè", c: "Cerdà", d: "Torrella" });
  assert.equal(view.displayName, "Flota Xàtiva / Novetlè / Cerdà (+1 zonas) · Pruebas");
  assert.equal(view.serviceZoneNames.length, 4);
});
