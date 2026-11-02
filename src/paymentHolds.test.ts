import assert from "node:assert/strict";
import test from "node:test";
import { holdsEnabled, createHold, captureHold, releaseHold } from "./paymentHolds.js";

test("sin clave de Stripe no se intenta bloquear nada", async () => {
  const previous = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  assert.equal(holdsEnabled(), false);
  const result = await createHold({ amountCents: 1158, customerId: "c1", orderId: "o1", paymentMethodId: "pm_1" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "stripe_no_configurado");
  if (previous) process.env.STRIPE_SECRET_KEY = previous;
});

test("un importe por debajo del mínimo no se bloquea", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_falsa";
  const result = await createHold({ amountCents: 10, customerId: "c1", orderId: "o1", paymentMethodId: "pm_1" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "importe_no_valido");
});

test("sin método de pago guardado no hay bloqueo", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_falsa";
  const result = await createHold({ amountCents: 1158, customerId: "c1", orderId: "o1", paymentMethodId: "" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "sin_metodo_de_pago");
});

test("capturar y liberar exigen un identificador de bloqueo", async () => {
  assert.equal((await captureHold("")).reason, "sin_bloqueo");
  assert.equal((await releaseHold("")).reason, "sin_bloqueo");
});
