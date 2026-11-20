import assert from "node:assert/strict";
import test from "node:test";
import { partnerTicketContactEnabled } from "./partnerTicketContactPolicy.js";

test("ticket contact is enabled only for the three requested restaurants", () => {
  assert.equal(partnerTicketContactEnabled({ slug: "kazoku-xativa" }), true);
  assert.equal(partnerTicketContactEnabled({ name: "Kazoku Algemesí" }), true);
  assert.equal(partnerTicketContactEnabled({ slug: "alibaba-kebab-xativa" }), true);
  assert.equal(partnerTicketContactEnabled({ name: "Otro restaurante" }), false);
  assert.equal(partnerTicketContactEnabled(null), false);
});
