import test from "node:test";
import assert from "node:assert/strict";
import { fromGoogleRegularHours, toGoogleRegularHours } from "./googleBusinessProfile.js";
import type { LegacyOpeningHours } from "./openingHours.js";

test("publica franjas nocturnas que cruzan medianoche en el día siguiente", () => {
  const payload = toGoogleRegularHours({ lunes: { morning: { open: "12:00", close: "16:00", closed: false }, evening: { open: "19:00", close: "00:00", closed: false }, closed: false } });
  assert.deepEqual(payload.periods[1], { openDay: "MONDAY", openTime: { hours: 19, minutes: 0 }, closeDay: "TUESDAY", closeTime: { hours: 0, minutes: 0 } });
});

test("importa una franja regular de Google al formato evening de PIKI", () => {
  const result = fromGoogleRegularHours({ periods: [{ openDay: "FRIDAY", openTime: { hours: 19, minutes: 0 }, closeDay: "FRIDAY", closeTime: { hours: 23, minutes: 30 } }] }) as LegacyOpeningHours;
  const evening = result.viernes.evening;
  assert.ok(evening);
  assert.equal(evening.open, "19:00");
  assert.equal(evening.close, "23:30");
  assert.equal(result.viernes.closed, false);
});
