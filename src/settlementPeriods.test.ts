import assert from "node:assert/strict";
import test from "node:test";
import {
  madridDateKey,
  partnerSettlementPeriodForLocalDate,
  riderPeriodPaidOnFirstOfMonth,
  riderSettlementPeriodForLocalDate,
} from "./settlementPeriods.js";

test("rider: el tramo actual 1–14 se paga el día 15 en Europe/Madrid", () => {
  assert.deepEqual(riderSettlementPeriodForLocalDate("2026-10-09"), {
    party: "rider",
    startsOn: "2026-10-01",
    endsBefore: "2026-10-15",
    paymentDate: "2026-10-15",
    paymentStatus: "scheduled",
    timeZone: "Europe/Madrid",
  });
});

test("rider: el tramo 15–fin de mes se paga el día 1 del mes siguiente", () => {
  assert.deepEqual(riderSettlementPeriodForLocalDate("2026-10-15"), {
    party: "rider",
    startsOn: "2026-10-15",
    endsBefore: "2026-11-01",
    paymentDate: "2026-11-01",
    paymentStatus: "scheduled",
    timeZone: "Europe/Madrid",
  });
  assert.deepEqual(riderPeriodPaidOnFirstOfMonth("2026-11-01"), riderSettlementPeriodForLocalDate("2026-10-15"));
});

test("partner: mes natural con día de pago explícitamente pendiente", () => {
  assert.deepEqual(partnerSettlementPeriodForLocalDate("2026-02-28"), {
    party: "partner",
    startsOn: "2026-02-01",
    endsBefore: "2026-03-01",
    paymentDate: null,
    paymentStatus: "pending_configuration",
    timeZone: "Europe/Madrid",
  });
});

test("la conversión usa la fecha civil de Madrid, incluido el cambio horario", () => {
  assert.equal(madridDateKey(new Date("2026-03-29T22:30:00.000Z")), "2026-03-30");
});
