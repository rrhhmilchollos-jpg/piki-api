import assert from "node:assert/strict";
import { test } from "node:test";
import { SupportTicket } from "./models.js";
import { canRiderOpenSupportCase, supportWaitingMessage } from "./supportPolicy.js";

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

test("offline Rider without assigned order cannot open support assistance", () => {
  const order = { orderId: "order-1", riderId: "rider-1", assignmentState: "assigned", status: "picked_up" };
  assert.equal(canRiderOpenSupportCase({ riderStatus: "offline", order, requestedOrderId: "order-1" }), false);
  assert.equal(canRiderOpenSupportCase({ riderStatus: "available", order: null, requestedOrderId: null }), false);
  assert.equal(canRiderOpenSupportCase({ riderStatus: "available", order: { ...order, status: "delivered" }, requestedOrderId: "order-1" }), false);
});

test("real-time support simulation follows waiting, assignment and response states", () => {
  const states = ["open", "in_progress", "in_progress"];
  assert.match(supportWaitingMessage(states[0]), /próximo agente disponible/);
  assert.equal(canRiderOpenSupportCase({ riderStatus: "busy", order: { orderId: "order-2", riderId: "rider-2", assignmentState: "assigned", status: "on_the_way" }, requestedOrderId: "order-2" }), true);
  assert.equal(states[1], "in_progress");
  assert.equal(states[2], "in_progress");
});
