import assert from "node:assert/strict";
import test from "node:test";
import { buildStripePricing, CUSTOMER_SERVICE_FEE_CENTS } from "./stripe.js";

test("Stripe checkout applies 2.99 EUR customer fee and 23% Partner commission", () => {
  const pricing = buildStripePricing({ items: [{ quantity: 2, unitPriceCents: 1250 }], deliveryFeeCents: 299 });
  assert.equal(CUSTOMER_SERVICE_FEE_CENTS, 299);
  assert.deepEqual(pricing, {
    subtotalCents: 2500,
    deliveryFeeCents: 299,
    serviceFeeCents: 299,
    totalCents: 3098,
    partnerCommissionCents: 575,
    partnerNetCents: 1925,
  });
});
