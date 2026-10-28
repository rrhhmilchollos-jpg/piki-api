import test from "node:test";
import assert from "node:assert/strict";
import { encryptGoogleSecret, fromGoogleRegularHours, listGoogleAccounts, toGoogleRegularHours } from "./googleBusinessProfile.js";
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

test("lista las cuentas por Account Management, no por Business Information", async () => {
  const originalFetch = globalThis.fetch;
  const originalEncryptionKey = process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY;
  process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY = "test-only-encryption-key";
  let requestedUrl = "";
  let authorization = "";
  const connection = {
    accessTokenEncrypted: encryptGoogleSecret("test-access-token"),
    tokenExpiryAt: new Date(Date.now() + 60 * 60 * 1000),
  };
  globalThis.fetch = (async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("Authorization") || "";
    return new Response(JSON.stringify({ accounts: [{ name: "accounts/123" }] }), { status: 200 });
  }) as typeof fetch;
  try {
    assert.deepEqual(await listGoogleAccounts(connection), [{ name: "accounts/123" }]);
    assert.equal(requestedUrl, "https://mybusinessaccountmanagement.googleapis.com/v1/accounts");
    assert.equal(authorization, "Bearer test-access-token");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEncryptionKey === undefined) delete process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY;
    else process.env.GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY = originalEncryptionKey;
  }
});
