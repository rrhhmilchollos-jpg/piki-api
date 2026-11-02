import assert from "node:assert/strict";
import test from "node:test";
import { decideSettlement, holdExpiresSoon, canAcceptCashOrder } from "./cashSettlement.js";

test("si el rider confirma el cobro se libera el bloqueo", () => {
  const s = decideSettlement("cash_collected");
  assert.equal(s.release, true);
  assert.equal(s.capture, false);
});

test("entregado sin pagar se captura", () => {
  const s = decideSettlement("delivered_no_cash");
  assert.equal(s.capture, true);
  assert.equal(s.release, false);
});

test("cancelado despues de comprar se captura", () => {
  assert.equal(decideSettlement("cancelled_after_purchase").capture, true);
});

test("cancelado antes de comprar se libera: no hay gasto", () => {
  const s = decideSettlement("cancelled_before_purchase");
  assert.equal(s.release, true);
  assert.equal(s.capture, false);
});

test("cliente que no aparece: se captura", () => {
  assert.equal(decideSettlement("no_show").capture, true);
});

test("el bloqueo avisa cuando se acerca su caducidad", () => {
  const now = new Date("2026-11-10T12:00:00Z");
  assert.equal(holdExpiresSoon(new Date("2026-11-09T12:00:00Z"), now), false);
  assert.equal(holdExpiresSoon(new Date("2026-11-04T12:00:00Z"), now), true);
});

test("sin bloqueo activo no se acepta un pedido en efectivo", () => {
  assert.equal(canAcceptCashOrder({ holdCreated: false }).ok, false);
  assert.equal(canAcceptCashOrder({ holdCreated: true, holdState: "canceled" }).ok, false);
  assert.equal(canAcceptCashOrder({ holdCreated: true, holdState: "requires_capture" }).ok, true);
});
