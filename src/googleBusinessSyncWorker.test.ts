import assert from "node:assert/strict";
import test from "node:test";
import { googleBusinessHoursChanged, googleBusinessSyncBackoffMs, googleBusinessSyncSettings } from "./googleBusinessSyncWorker.js";

test("worker Google queda deshabilitado salvo opt-in y aplica cadencia mínima de cinco minutos", () => {
  const disabled = googleBusinessSyncSettings({ GOOGLE_BUSINESS_SYNC_ENABLED: "false", GOOGLE_BUSINESS_SYNC_CADENCE_MINUTES: "2" });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.cadenceMinutes, 5);
  assert.equal(googleBusinessSyncSettings({ GOOGLE_BUSINESS_SYNC_ENABLED: "false" }).cadenceMinutes, 15);
  const enabled = googleBusinessSyncSettings({ GOOGLE_BUSINESS_SYNC_ENABLED: "true", GOOGLE_BUSINESS_CLIENT_ID: "test-client", GOOGLE_BUSINESS_CLIENT_SECRET: "test-secret", GOOGLE_BUSINESS_REDIRECT_URI: "https://example.test/callback", GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY: "test-key" });
  assert.equal(enabled.enabled, true);
});

test("worker Google aplica backoff exponencial acotado", () => {
  assert.equal(googleBusinessSyncBackoffMs(1), 5 * 60_000);
  assert.equal(googleBusinessSyncBackoffMs(2), 10 * 60_000);
  assert.equal(googleBusinessSyncBackoffMs(20), 6 * 60 * 60_000);
});

test("worker compara horas efectivas e ignora timestamps de sincronización", () => {
  const first = {
    timeZone: "Europe/Madrid",
    regular: { lunes: [{ open: "19:00", close: "02:00", endsNextDay: true }] },
    overrides: [{ date: "2026-12-25", closed: true, intervals: [] }],
    source: { mode: "google", locationName: "locations/1", syncedAt: new Date("2026-10-27T10:00:00.000Z") },
  };
  const sameHoursLater = { ...first, source: { ...first.source, syncedAt: new Date("2026-10-27T11:00:00.000Z") } };
  const changedHours = { ...sameHoursLater, overrides: [{ date: "2026-12-25", closed: false, intervals: [{ open: "12:00", close: "15:00" }] }] };
  assert.equal(googleBusinessHoursChanged(first, sameHoursLater), false);
  assert.equal(googleBusinessHoursChanged(first, changedHours), true);
});
