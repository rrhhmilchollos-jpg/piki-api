import test from "node:test";
import assert from "node:assert/strict";
import { ZOMBIE_ORDER_MAX_AGE_MS, isZombieOrder } from "./zombieOrders.js";

const now = new Date("2026-11-01T18:00:00.000Z");
const oldEnough = new Date(now.getTime() - ZOMBIE_ORDER_MAX_AGE_MS - 60_000);

test("un pedido en cocina sin rider y caducado es zombi", () => {
  assert.equal(isZombieOrder({ status: "preparing", createdAt: oldEnough, riderId: null }, now), true);
  assert.equal(isZombieOrder({ status: "ready_for_pickup", createdAt: oldEnough, riderId: null }, now), true);
  assert.equal(isZombieOrder({ status: "pending", createdAt: oldEnough, riderId: null }, now), true);
});

test("un pedido reciente todavía no es zombi", () => {
  assert.equal(isZombieOrder({ status: "preparing", createdAt: new Date(now.getTime() - 5 * 60_000), riderId: null }, now), false);
});

test("un pedido con rider asignado nunca se cierra automáticamente", () => {
  assert.equal(isZombieOrder({ status: "ready_for_pickup", createdAt: oldEnough, riderId: "rider-1" }, now), false);
});

test("los estados terminales y los pedidos de QA quedan fuera", () => {
  assert.equal(isZombieOrder({ status: "delivered", createdAt: oldEnough, riderId: null }, now), false);
  assert.equal(isZombieOrder({ status: "cancelled", createdAt: oldEnough, riderId: null }, now), false);
  assert.equal(isZombieOrder({ status: "on_the_way", createdAt: oldEnough, riderId: null }, now), false);
  assert.equal(isZombieOrder({ status: "preparing", createdAt: oldEnough, riderId: null, isTestOrder: true }, now), false);
});

test("un pedido ya archivado no se reprocesa", () => {
  assert.equal(isZombieOrder({ status: "preparing", createdAt: oldEnough, riderId: null, archivedAt: oldEnough }, now), false);
});

test("una fecha de creación inválida no habilita el cierre", () => {
  assert.equal(isZombieOrder({ status: "preparing", createdAt: null, riderId: null }, now), false);
});
