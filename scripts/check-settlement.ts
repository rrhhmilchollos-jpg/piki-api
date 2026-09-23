import assert from "node:assert/strict";
import { calculateSettlement } from "../src/settlements.js";

const result = calculateSettlement([{ publicCode: "PIKI-DEMO", subtotalCents: 2000, deliveryFeeCents: 250, serviceFeeCents: 79, distanceKm: 3, tipCents: 100 }]);
assert.equal(result.formulaVersion, "piki-phase1-2026-09");
assert.equal(result.lines[0]?.partnerCommissionCents, 360);
assert.equal(result.lines[0]?.partnerNetCents, 1640);
assert.equal(result.lines[0]?.riderTotalCents, 530);
console.log(JSON.stringify({ ok: true, result }, null, 2));
