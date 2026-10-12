import assert from "node:assert/strict";
import test from "node:test";
import { resolvePasskeyConfiguration } from "./passkeys.js";

test("la configuración de passkeys incluye los orígenes públicos de cliente y el RP PIKI", () => {
  const configuration = resolvePasskeyConfiguration({});
  assert.equal(configuration.rpID, "pikidelivery.com");
  assert.deepEqual(configuration.origins, [
    "https://pikidelivery.com",
    "https://www.pikidelivery.com",
    "https://app.pikidelivery.com",
  ]);
});

test("la configuración elimina orígenes inseguros y duplicados", () => {
  const configuration = resolvePasskeyConfiguration({
    PASSKEY_RP_ID: "auth.pikidelivery.com",
    PASSKEY_ORIGINS: "https://app.pikidelivery.com, http://localhost:5173, https://app.pikidelivery.com,invalid",
  });
  assert.equal(configuration.rpID, "auth.pikidelivery.com");
  assert.deepEqual(configuration.origins, ["https://app.pikidelivery.com"]);
});

test("la configuración falla cerrada sin un origen WebAuthn válido", () => {
  assert.throws(
    () => resolvePasskeyConfiguration({ PASSKEY_RP_ID: "pikidelivery.com", PASSKEY_ORIGINS: "http://localhost:5173" }),
    /PASSKEY_CONFIGURATION_INVALID/,
  );
});
