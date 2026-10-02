import assert from "node:assert/strict";
import { test } from "node:test";
import { calculateHourlyGuaranteeTopUp, getRecruitmentAwards, isAcceptanceRateEligible } from "./settlements.js";

test("garantía: paga solo el complemento hasta 7 €/h al completar cuatro horas", () => {
  assert.equal(calculateHourlyGuaranteeTopUp({ eligible: true, scheduledHours: 4, completedHours: 4, deliveryEarningsCents: 0 }), 2800);
  assert.equal(calculateHourlyGuaranteeTopUp({ eligible: true, scheduledHours: 4, completedHours: 4, deliveryEarningsCents: 1800 }), 1000);
  assert.equal(calculateHourlyGuaranteeTopUp({ eligible: true, scheduledHours: 4, completedHours: 4, deliveryEarningsCents: 3200 }), 0);
  assert.equal(calculateHourlyGuaranteeTopUp({ eligible: true, scheduledHours: 4, completedHours: 3.99, deliveryEarningsCents: 0 }), 0);
  assert.equal(calculateHourlyGuaranteeTopUp({ eligible: false, scheduledHours: 4, completedHours: 4, deliveryEarningsCents: 0 }), 0);
});

test("aceptación: requiere 95 %; no penaliza un turno sin ofertas", () => {
  assert.equal(isAcceptanceRateEligible(95, 100), true);
  assert.equal(isAcceptanceRateEligible(94, 100), false);
  assert.equal(isAcceptanceRateEligible(0, 0), true);
  assert.equal(isAcceptanceRateEligible(4, 3), false);
});

test("captación: 20 entregas activan 20 € al nuevo y 15 € para cada parte referida", () => {
  assert.deepEqual(getRecruitmentAwards(4, true), { acquisitionBonusCents: 0, referredRiderBonusCents: 0, inviterBonusCents: 0 });
  assert.deepEqual(getRecruitmentAwards(5, true), { acquisitionBonusCents: 2000, referredRiderBonusCents: 0, inviterBonusCents: 0 });
  assert.deepEqual(getRecruitmentAwards(20, true), { acquisitionBonusCents: 2000, referredRiderBonusCents: 1500, inviterBonusCents: 1500 });
  assert.deepEqual(getRecruitmentAwards(20, false), { acquisitionBonusCents: 2000, referredRiderBonusCents: 0, inviterBonusCents: 0 });
});
