import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const MIN_RECOVERY_TOKEN_BYTES = 32;
const MAX_RECOVERY_TOKEN_BYTES = 1_024;
const MAX_RECOVERY_WINDOW_MS = 6 * 60 * 60 * 1_000;

export function ownerRecoveryWindowIsOpen(expiresAt: string | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > now && expiresAtMs <= now + MAX_RECOVERY_WINDOW_MS;
}

export function ownerRecoveryTokenMatches(provided: string, expected: string): boolean {
  const providedBytes = Buffer.byteLength(provided, "utf8");
  const expectedBytes = Buffer.byteLength(expected, "utf8");
  if (providedBytes < MIN_RECOVERY_TOKEN_BYTES || providedBytes > MAX_RECOVERY_TOKEN_BYTES) return false;
  if (expectedBytes < MIN_RECOVERY_TOKEN_BYTES || expectedBytes > MAX_RECOVERY_TOKEN_BYTES) return false;
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function hashOwnerRecoveryToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function generateOwnerRecoveryTemporaryPassword(): string {
  return `PIKI-${randomBytes(32).toString("base64url")}`;
}
