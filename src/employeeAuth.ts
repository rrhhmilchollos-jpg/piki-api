import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password: string, stored: string) {
  const [scheme, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}

export function generateTemporaryPassword() {
  return `PIKI-${randomBytes(6).toString("base64url")}`;
}

export function createSessionToken() {
  return `piki_session_${randomBytes(32).toString("base64url")}`;
}

export function hashSessionToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
