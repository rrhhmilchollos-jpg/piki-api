import assert from "node:assert/strict";
import test from "node:test";
import { isDispatchablePayment } from "./dispatchEligibility.js";
import { MAX_CASH_ORDER_CENTS, cashOrderLimitError, isCashOrderWithinLimit, isCashPaymentEnabledForRestaurant } from "./paymentPolicy.js";

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

test("sin retención viva ningún pedido sale a reparto, tampoco el efectivo", () => {
  // El efectivo ya no se reparte con la promesa de cobrar en la puerta: primero
  // el cliente deja la tarjeta retenida y después el pedido sale al rider.
  assert.equal(isDispatchablePayment("pending", "cash", 4_899), false);
  assert.equal(isDispatchablePayment("pending", "cash", 4_900), false);
  assert.equal(isDispatchablePayment("authorized", "cash", 4_899), true);
  assert.equal(isDispatchablePayment("authorized", "stripe", 50_000), true);
  assert.equal(isDispatchablePayment("paid", "stripe", 50_000), true);
});

test("el efectivo se acepta en todos los comercios, Alibaba incluido", () => {
  assert.equal(isCashPaymentEnabledForRestaurant({ name: "Alibaba", slug: "alibaba-kebab-xativa", cashPaymentsEnabled: false }), true);
  assert.equal(isCashPaymentEnabledForRestaurant({ name: "Cualquiera", slug: "otro-local" }), true);
});

test("Mr Rooster Xàtiva queda habilitado para contrareembolso con su slug operativo", () => {
  assert.equal(isCashPaymentEnabledForRestaurant({ slug: "rooster-kebab-xativa", name: "Mr Rooster Xàtiva", cashPaymentsEnabled: true }), true);
});
