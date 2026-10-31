import test from "node:test";
import assert from "node:assert/strict";
import { VEHICLE_CATALOG_VERSION, VEHICLE_TYPES, incompatibleVehicles, uniqueVehicles } from "./vehicleCatalog.js";

test("vehicle catalog is versioned and removes duplicates", () => {
  assert.equal(VEHICLE_CATALOG_VERSION, 1);
  assert.deepEqual(uniqueVehicles(["bike", "bike", "car"]), ["bike", "car"]);
  assert.equal(VEHICLE_TYPES.length, 6);
});

test("vehicle compatibility rejects types disabled by a zone", () => {
  assert.deepEqual(incompatibleVehicles(["bike", "car", "car"], ["car"]), ["bike"]);
  assert.deepEqual(incompatibleVehicles(["bike", "car"], VEHICLE_TYPES), []);
});
