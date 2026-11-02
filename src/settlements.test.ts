import assert from "node:assert/strict";
import test from "node:test";
import { calculateSettlement } from "./settlements.js";


test("con precio con comision incluida el local cobra el precio base", () => {
  const base = { publicCode: "PIKI-1", subtotalCents: 1800, deliveryFeeCents: 299, serviceFeeCents: 79, distanceKm: 1, tipCents: 0, incentiveCents: 0 };
  const conComision = calculateSettlement([{ ...base, priceIncludesCommission: true } as any], { partnerCommissionRate: 0.2 });
  assert.equal(conComision.lines[0].partnerNetCents, 1500);
  const clasico = calculateSettlement([base as any], { partnerCommissionRate: 0.2 });
  assert.equal(clasico.lines[0].partnerNetCents, 1440);
});
