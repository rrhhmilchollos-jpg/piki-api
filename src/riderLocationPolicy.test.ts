import assert from "node:assert/strict";
import test from "node:test";
import { prepareTrackingBatch } from "./riderLocationPolicy.js";

const now = new Date("2026-10-28T10:00:00.000Z");

test("GPS descarta coordenadas inválidas y futuras antes de persistir", () => {
  const result = prepareTrackingBatch([
    { sampleId: "valid-sample", latitude: 38.99, longitude: -0.52, accuracyMeters: 12, recordedAt: new Date("2026-10-28T09:59:59.000Z") },
    { sampleId: "invalid-lat", latitude: 91, longitude: -0.52, accuracyMeters: 12, recordedAt: now },
    { sampleId: "future-sample", latitude: 38.99, longitude: -0.52, accuracyMeters: 12, recordedAt: new Date("2026-10-28T10:01:01.000Z") },
  ], now);

  assert.deepEqual(result.candidates.map((sample) => sample.sampleId), ["valid-sample"]);
  assert.deepEqual(result.rejected, ["invalid-lat", "future-sample"]);
  assert.deepEqual(result.duplicates, []);
});

test("GPS conserva una única muestra por sampleId y usa el orden temporal para la última posición", () => {
  const result = prepareTrackingBatch([
    { sampleId: "later-sample", latitude: 39, longitude: -0.51, accuracyMeters: 8, recordedAt: new Date("2026-10-28T09:59:58.000Z") },
    { sampleId: "first-sample", latitude: 38.99, longitude: -0.52, accuracyMeters: 10, recordedAt: new Date("2026-10-28T09:59:57.000Z") },
    { sampleId: "later-sample", latitude: 39.1, longitude: -0.5, accuracyMeters: 5, recordedAt: new Date("2026-10-28T09:59:59.000Z") },
  ], now);

  assert.deepEqual(result.candidates.map((sample) => sample.sampleId), ["first-sample", "later-sample"]);
  assert.deepEqual(result.duplicates, ["later-sample"]);
  assert.equal(result.candidates.at(-1)?.latitude, 39);
});
