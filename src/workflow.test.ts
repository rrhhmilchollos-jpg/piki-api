import assert from "node:assert/strict";
import test from "node:test";
import { assertTransition, canTransition } from "./workflow.js";

test("Partner puede avanzar solo la preparación en orden", () => {
  assert.equal(canTransition("pending", "accepted", "partner"), true);
  assert.equal(canTransition("accepted", "preparing", "partner"), true);
  assert.equal(canTransition("preparing", "ready_for_pickup", "partner"), true);
  assert.equal(canTransition("pending", "ready_for_pickup", "partner"), false);
  assert.equal(canTransition("ready_for_pickup", "preparing", "partner"), false);
});

test("los cambios de Rider no pueden saltar a entrega ni terminar un pedido por transición genérica", () => {
  assert.equal(canTransition("picked_up", "on_the_way", "rider"), true);
  assert.equal(canTransition("on_the_way", "delivered", "rider"), true);
  assert.equal(canTransition("pending", "delivered", "rider"), false);
  assert.equal(canTransition("delivered", "on_the_way", "rider"), false);
  assert.equal(canTransition("cancelled", "accepted", "partner"), false);
});

test("cancelación y estados terminales tienen permisos definidos", () => {
  assert.equal(canTransition("pending", "cancelled", "customer"), true);
  assert.equal(canTransition("preparing", "cancelled", "partner"), true);
  assert.equal(canTransition("delivered", "cancelled", "admin"), false);
  assert.throws(() => assertTransition("pending", "delivered", "partner"), /INVALID_ORDER_TRANSITION/);
});
