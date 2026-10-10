import assert from "node:assert/strict";
import { test } from "node:test";
import { generateOwnerRecoveryTemporaryPassword, hashOwnerRecoveryToken, ownerRecoveryTokenMatches, ownerRecoveryWindowIsOpen } from "./ownerRecovery.js";

test("owner recovery window must be future-dated and expire within six hours", () => {
  const now = Date.parse("2026-10-10T04:00:00.000Z");
  assert.equal(ownerRecoveryWindowIsOpen("2026-10-10T04:10:00.000Z", now), true);
  assert.equal(ownerRecoveryWindowIsOpen("2026-10-10T03:59:59.000Z", now), false);
  assert.equal(ownerRecoveryWindowIsOpen("2026-10-10T11:00:01.000Z", now), false);
  assert.equal(ownerRecoveryWindowIsOpen(undefined, now), false);
});

test("owner recovery token comparison rejects missing and weak tokens", () => {
  assert.equal(ownerRecoveryTokenMatches("", "a".repeat(64)), false);
  assert.equal(ownerRecoveryTokenMatches("short", "a".repeat(64)), false);
  assert.equal(ownerRecoveryTokenMatches("a".repeat(64), "short"), false);
});

test("owner recovery token comparison accepts only the exact configured secret", () => {
  const token = "a".repeat(64);
  assert.equal(ownerRecoveryTokenMatches(token, token), true);
  assert.equal(ownerRecoveryTokenMatches(`${token}b`, token), false);
  assert.match(hashOwnerRecoveryToken(token), /^[a-f0-9]{64}$/);
  assert.notEqual(hashOwnerRecoveryToken(token), token);
});

test("owner recovery temporary passwords have high entropy and are distinct", () => {
  const first = generateOwnerRecoveryTemporaryPassword();
  const second = generateOwnerRecoveryTemporaryPassword();
  assert.match(first, /^PIKI-[A-Za-z0-9_-]{43}$/);
  assert.equal(first.length, 48);
  assert.notEqual(first, second);
});
