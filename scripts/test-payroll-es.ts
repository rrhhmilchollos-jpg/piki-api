import assert from "node:assert/strict";
import { calculatePayroll, payrollGap } from "../src/payroll.js";

const payroll = calculatePayroll({ weeklyHours: 30, tipsCents: 2_500 });
assert.equal(payroll.monthlyGrossCents, 134_000);
assert.equal(payroll.socialSecurityCents, 8_670);
assert.equal(payroll.irpfCents, 7_330);
assert.equal(payroll.netCents, 118_000);
assert.equal(payroll.totalToRiderCents, 120_500);
assert.equal(Math.round(payroll.effectiveDeductionRate * 100) / 100, 11.94);

const custom = calculatePayroll({
  weeklyHours: 30,
  monthlyGrossCents: 2_000_00,
  rates: { socialSecurityRate: 0.0647, irpfRate: 0.15 },
});
assert.equal(custom.socialSecurityCents, 12_940);
assert.equal(custom.irpfCents, 30_000);
assert.equal(custom.netCents, 157_060);

const gap = payrollGap({ weeklyHours: 30 }, 118_000);
assert.equal(gap.deltaCents, 0);

console.log(JSON.stringify({ ok: true, cases: { default30h: payroll, customIrpf15: custom, targetGap: gap } }, null, 2));
