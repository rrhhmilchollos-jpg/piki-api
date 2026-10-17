import assert from "node:assert/strict";
import test from "node:test";
import { customerDisplayStatus, parseCustomerTrpcInput } from "./customerCompat.js";

test("obtiene el pedido de una petición tRPC GET por lotes", () => {
  const input = parseCustomerTrpcInput({ "0": { json: { id: "PIKI-MVBP4EQA" } } });
  assert.deepEqual(input, { id: "PIKI-MVBP4EQA" });
});

test("conserva el formato tRPC no agrupado", () => {
  const input = parseCustomerTrpcInput({ json: { id: "PIKI-ABC123" } });
  assert.deepEqual(input, { id: "PIKI-ABC123" });
});

test("conserva un cuerpo directo de Customer", () => {
  const input = parseCustomerTrpcInput({ id: "PIKI-DIRECTO" });
  assert.deepEqual(input, { id: "PIKI-DIRECTO" });
});

test("expone el pedido listo como ready a los bundles Android anteriores", () => {
  assert.equal(customerDisplayStatus("ready_for_pickup"), "ready");
  assert.equal(customerDisplayStatus("on_the_way"), "on_the_way");
});
