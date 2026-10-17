import assert from "node:assert/strict";
import { test } from "node:test";
import { configuredPartnerRestaurantUpsert } from "./partnerRepairPolicy.js";

test("partner restaurant upsert has no conflicting paths between Mongo operators", () => {
  for (const slug of ["kfc-xativa-qa", "kfc-xativa-test", "partner-test"]) {
    const update = configuredPartnerRestaurantUpsert("tenant-1", "owner@example.com", slug);
    const conflicts = Object.keys(update.$set).filter((path) => path in update.$setOnInsert);
    assert.deepEqual(conflicts, []);
    assert.equal(update.$setOnInsert.address, "Calle Sor Isabel de Villena 88, bajo, Novetlè, Valencia");
    assert.equal(update.$set.locality, "Novetlè");
    assert.deepEqual(update.$set.location.coordinates, [-0.5468067, 38.9817572]);
    assert.equal(update.$setOnInsert.slug, slug);
  }
});
