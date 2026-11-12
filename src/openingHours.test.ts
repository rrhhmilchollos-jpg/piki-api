import assert from "node:assert/strict";
import test from "node:test";
import { openingHoursSchema, normalizeOpeningHours, evaluateOpeningHours, legacyOpeningHoursProjection, type LegacyOpeningHours } from "./openingHours.js";

test("acepta el formato del panel con franja evening y normaliza la hora 00:00", () => {
  const result = openingHoursSchema.safeParse({
    lunes: {
      morning: { open: "12:00", close: "16:00", closed: false },
      evening: { open: "19:00", close: "00:00", closed: false },
      closed: false,
    },
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual((result.data as LegacyOpeningHours).lunes.evening, { open: "19:00", close: "00:00", closed: false });
  }
});

test("acepta datos antiguos con afternoon y los devuelve como evening", () => {
  const result = openingHoursSchema.safeParse({
    martes: {
      morning: { open: "10:00", close: "14:00" },
      afternoon: { open: "18:00", close: "23:30" },
      closed: false,
    },
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual((result.data as LegacyOpeningHours).martes.evening, { open: "18:00", close: "23:30", closed: false });
  }
});

test("rechaza horas imposibles en lugar de persistir datos inválidos", () => {
  const result = openingHoursSchema.safeParse({
    miércoles: {
      morning: { open: "25:00", close: "14:00", closed: false },
      evening: { open: "18:00", close: "23:00", closed: false },
      closed: false,
    },
  });

  assert.equal(result.success, false);
});

test("legacy continuo conserva un único intervalo y un solo periodo activo al normalizar", () => {
  const input = { lunes: { open: "10:00", close: "00:00", closed: false } };
  const parsed = openingHoursSchema.parse(input) as LegacyOpeningHours;
  assert.equal(parsed.lunes.morning?.open, "10:00");
  assert.equal(parsed.lunes.evening?.closed, true);
  const canonical = normalizeOpeningHours(parsed)!;
  assert.deepEqual(canonical.regular.lunes, [{ open: "10:00", close: "00:00", endsNextDay: true }]);
  const projected = normalizeOpeningHours(legacyOpeningHoursProjection(canonical))!;
  assert.deepEqual(projected.regular.lunes, canonical.regular.lunes);
  assert.equal(projected.timeZone, canonical.timeZone);
  assert.deepEqual(projected.regular.domingo, []);
});

test("horario partido roundtrip conserva pausa de mediodía, cierres individuales y medianoche", () => {
  const input = { lunes: { morning: { open: "12:00", close: "16:00", closed: false }, evening: { open: "19:00", close: "00:00", closed: false }, closed: false } };
  const parsed = openingHoursSchema.parse(JSON.parse(JSON.stringify(input)));
  const schedule = normalizeOpeningHours(parsed)!;
  assert.equal(schedule.timeZone, "Europe/Madrid");
  assert.deepEqual(schedule.regular.lunes, [{ open: "12:00", close: "16:00", endsNextDay: false }, { open: "19:00", close: "00:00", endsNextDay: true }]);
  // Monday in November, CET: 13:00, 17:00, 23:59 and Tuesday midnight.
  assert.equal(evaluateOpeningHours(parsed, new Date("2026-11-09T12:00:00Z")).open, true);
  assert.equal(evaluateOpeningHours(parsed, new Date("2026-11-09T16:00:00Z")).open, false);
  assert.equal(evaluateOpeningHours(parsed, new Date("2026-11-09T22:59:00Z")).open, true);
  assert.equal(evaluateOpeningHours(parsed, new Date("2026-11-09T23:00:00Z")).open, false);
  assert.equal(normalizeOpeningHours({ lunes: { ...input.lunes, morning: { ...input.lunes.morning, closed: true } } })!.regular.lunes!.length, 1);
  assert.deepEqual(normalizeOpeningHours({ lunes: { ...input.lunes, closed: true } })!.regular.lunes, []);
});

test("00:00 apertura y turno nocturno anterior siguen siendo horarios válidos", () => {
  const input = { lunes: { morning: { open: "00:00", close: "03:00", closed: false }, evening: { open: "22:00", close: "02:00", closed: false }, closed: false } };
  assert(openingHoursSchema.safeParse(input).success);
  assert.equal(evaluateOpeningHours(input, new Date("2026-11-09T00:00:00Z")).open, true);
  assert.equal(evaluateOpeningHours(input, new Date("2026-11-10T00:30:00Z")).open, true);
  assert.equal(evaluateOpeningHours(input, new Date("2026-11-10T01:00:00Z")).open, false);
});
