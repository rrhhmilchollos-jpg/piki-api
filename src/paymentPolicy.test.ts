import assert from "node:assert/strict";
import test from "node:test";
import { isDispatchablePayment } from "./dispatchEligibility.js";
import { CASH_PAYMENTS_ENABLED, MAX_CASH_ORDER_CENTS, cashOrderLimitError, isCashOrderWithinLimit, isCashPaymentEnabledForRestaurant, setCashPaymentsEnabled } from "./paymentPolicy.js";

test("el límite de efectivo se aplica al total final, incluyendo los bordes 4.899/4.900", () => {
  assert.equal(MAX_CASH_ORDER_CENTS, 4_899);
  assert.equal(isCashOrderWithinLimit("cash", 4_899), true);
  assert.equal(isCashOrderWithinLimit("cash", 4_900), false);
  assert.equal(isCashOrderWithinLimit("stripe", 50_000), true);
  assert.deepEqual(cashOrderLimitError(4_900), {
    error: "CASH_ORDER_TOTAL_EXCEEDS_LIMIT",
    message: "Los pedidos en efectivo no pueden superar 4899 céntimos (€48,99) sobre el total final. Selecciona pago online.",
    maxCashOrderCents: 4_899,
    totalCents: 4_900,
  });
});

test("cash pendiente por defecto sigue bloqueado sin garantía o snapshot servidor explícito", () => {
  // No hay aprobación implícita por elegir cash ni por afirmar su importe.
  // El rollout opt-in tiene tests separados con el snapshot completo.
  assert.equal(isDispatchablePayment("pending", "cash", 4_899), false);
  assert.equal(isDispatchablePayment("pending", "cash", 4_900), false);
  assert.equal(isDispatchablePayment("authorized", "cash", 4_899), true);
  assert.equal(isDispatchablePayment("authorized", "stripe", 50_000), true);
  assert.equal(isDispatchablePayment("paid", "stripe", 50_000), true);
});

test("el interruptor global de efectivo controla los comercios independientemente de sus datos antiguos", () => {
  const previous = CASH_PAYMENTS_ENABLED;
  try {
    setCashPaymentsEnabled(false);
    assert.equal(isCashPaymentEnabledForRestaurant({ name: "Alibaba", slug: "alibaba-kebab-xativa", cashPaymentsEnabled: true }), false);
    assert.equal(isCashPaymentEnabledForRestaurant({ name: "Cualquiera", slug: "otro-local" }), false);
    setCashPaymentsEnabled(true);
    assert.equal(isCashPaymentEnabledForRestaurant({ name: "Alibaba", slug: "alibaba-kebab-xativa", cashPaymentsEnabled: false }), true);
    assert.equal(isCashPaymentEnabledForRestaurant({ name: "Cualquiera", slug: "otro-local" }), true);
  } finally { setCashPaymentsEnabled(previous); }
});

test("Mr Rooster Xàtiva queda habilitado para contrareembolso con su slug operativo", () => {
  const previous = CASH_PAYMENTS_ENABLED;
  try {
    setCashPaymentsEnabled(true);
    assert.equal(isCashPaymentEnabledForRestaurant({ slug: "rooster-kebab-xativa", name: "Mr Rooster Xàtiva", cashPaymentsEnabled: true }), true);
  } finally { setCashPaymentsEnabled(previous); }
});
