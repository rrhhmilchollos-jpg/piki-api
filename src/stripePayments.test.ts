import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizationAmountCents,
  authorizationExpiry,
  COD_AUTHORIZATION_TTL_MS,
  shouldReleaseAuthorization,
} from "./stripePayments.js";

test("la retención dura siete días", () => {
  const from = new Date("2026-11-02T10:00:00.000Z");
  const expiry = authorizationExpiry(from);
  assert.equal(expiry.getTime() - from.getTime(), COD_AUTHORIZATION_TTL_MS);
  assert.equal(expiry.toISOString(), "2026-11-09T10:00:00.000Z");
});

test("se retiene el total del pedido, no el subtotal", () => {
  assert.equal(
    authorizationAmountCents({ totalCents: 1878, subtotalCents: 1500, deliveryFeeCents: 299 }),
    1878,
  );
});

test("sin total se suma lo que hay", () => {
  assert.equal(
    authorizationAmountCents({ totalCents: 0, subtotalCents: 780, deliveryFeeCents: 299, serviceFeeCents: 79 }),
    1158,
  );
});

test("se libera doce horas antes de caducar", () => {
  const expiry = new Date("2026-11-09T10:00:00.000Z");
  assert.equal(shouldReleaseAuthorization(expiry, new Date("2026-11-08T21:00:00.000Z")), false);
  assert.equal(shouldReleaseAuthorization(expiry, new Date("2026-11-08T23:00:00.000Z")), true);
  assert.equal(shouldReleaseAuthorization(null), false);
});
