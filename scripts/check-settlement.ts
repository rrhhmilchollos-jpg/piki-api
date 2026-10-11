import assert from "node:assert/strict";
import { calculateSettlement } from "../src/settlements.js";

const result = calculateSettlement([{ publicCode: "PIKI-DEMO", subtotalCents: 2000, deliveryFeeCents: 250, serviceFeeCents: 299, distanceKm: 3, tipCents: 100 }]);
assert.equal(result.formulaVersion, "piki-partner-23-customer-fee-299-2026-10");
assert.equal(result.lines[0]?.partnerCommissionCents, 460);
assert.equal(result.lines[0]?.partnerNetCents, 1540);
assert.equal(result.lines[0]?.riderTotalCents, 530);
console.log(JSON.stringify({ ok: true, result }, null, 2));
