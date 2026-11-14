import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decryptRiderPersonnelField,
  encryptRiderPersonnelField,
  riderPersonnelCompleteness,
  riderPersonnelEncryptionConfigured,
  riderPersonnelPatchSchema,
  validRiderIban,
} from "./riderPersonnel.js";

const testEnvironment = {
  PIKI_RIDER_PII_ENCRYPTION_KEY: Buffer.alloc(32, 0x42).toString("base64"),
} as NodeJS.ProcessEnv;

describe("rider personnel privacy policy", () => {
  it("encrypts with AES-GCM and only decrypts for the bound rider and field", () => {
    const plaintext = "Calle de prueba 123, 46000 Valencia";
    const encrypted = encryptRiderPersonnelField(plaintext, "rider-a", "homeAddress", testEnvironment);
    assert.ok(encrypted);
    assert.match(encrypted, /^v1\./);
    assert.ok(!encrypted.includes(plaintext));
    assert.equal(decryptRiderPersonnelField(encrypted, "rider-a", "homeAddress", testEnvironment), plaintext);
    assert.throws(() => decryptRiderPersonnelField(encrypted, "rider-b", "homeAddress", testEnvironment));
    assert.throws(() => decryptRiderPersonnelField(encrypted, "rider-a", "iban", testEnvironment));
  });

  it("fails closed when the dedicated production encryption key is absent or malformed", () => {
    assert.equal(riderPersonnelEncryptionConfigured({} as NodeJS.ProcessEnv), false);
    assert.throws(() => encryptRiderPersonnelField("value", "rider-a", "bankName", {} as NodeJS.ProcessEnv), /RIDER_PII_ENCRYPTION_KEY_REQUIRED/);
    assert.equal(riderPersonnelEncryptionConfigured({ PIKI_RIDER_PII_ENCRYPTION_KEY: "not-a-key" } as NodeJS.ProcessEnv), false);
  });

  it("validates IBAN checksums and allows an explicit empty value to clear a field", () => {
    assert.equal(validRiderIban("DE89 3704 0044 0532 0130 00"), true);
    assert.equal(validRiderIban("DE89 3704 0044 0532 0130 01"), false);
    assert.equal(riderPersonnelPatchSchema.safeParse({ iban: "DE89 3704 0044 0532 0130 00" }).success, true);
    assert.equal(riderPersonnelPatchSchema.safeParse({ iban: "DE89 3704 0044 0532 0130 01" }).success, false);
    assert.equal(riderPersonnelPatchSchema.safeParse({ iban: "" }).success, true);
    assert.equal(riderPersonnelPatchSchema.safeParse({ unknown: "ignored" }).success, false);
    assert.equal(riderPersonnelPatchSchema.safeParse({}).success, false);
  });

  it("exposes only completeness booleans to the directory projection", () => {
    const summary = riderPersonnelCompleteness({
      homeAddressEncrypted: "cipher-address",
      identityDocumentNumberEncrypted: null,
      bankNameEncrypted: "cipher-bank",
      ibanEncrypted: "cipher-iban",
    });
    assert.deepEqual(summary, { hasAddress: true, hasIdentityDocument: false, hasBankDetails: true });
    assert.equal(Object.values(summary).some((value) => typeof value === "string"), false);
  });
});
