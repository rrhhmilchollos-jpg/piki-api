import assert from "node:assert/strict";
import test from "node:test";
import { openingHoursSchema, type LegacyOpeningHours } from "./openingHours.js";

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
