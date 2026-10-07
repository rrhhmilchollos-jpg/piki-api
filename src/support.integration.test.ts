import assert from "node:assert/strict";
import { test } from "node:test";
import { SupportTicket } from "./models.js";

test("support tickets persist rating and definitive-close fields", () => {
  const paths = SupportTicket.schema.paths;
  assert.equal(paths.agentRating.options.min, 1);
  assert.equal(paths.agentRating.options.max, 5);
  assert.equal(paths.agentRatingComment.options.maxlength, 500);
  assert.ok(paths.agentRatedAt);
  assert.ok(paths.closedByRiderAt);
});

test("support message contract keeps chat content bounded", () => {
  const messagePath = SupportTicket.schema.path("messages");
  assert.ok(messagePath);
  const messageSchema = (messagePath as any).schema;
  assert.equal(messageSchema.path("body").options.maxlength, 2000);
  assert.deepEqual(messageSchema.path("senderRole").options.enum, ["support", "rider", "system"]);
});
