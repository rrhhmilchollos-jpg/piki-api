import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

export const riderPersonnelFields = [
  "homeAddress",
  "identityDocumentNumber",
  "bankName",
  "bankAccountHolder",
  "iban",
] as const;

export type RiderPersonnelField = (typeof riderPersonnelFields)[number];

export const riderPersonnelPatchSchema = z.object({
  homeAddress: z.string().trim().max(500).optional(),
  identityDocumentNumber: z.string().trim().max(40).optional(),
  bankName: z.string().trim().max(120).optional(),
  bankAccountHolder: z.string().trim().max(180).optional(),
  iban: z.string().trim().max(34).refine((value) => !value || validRiderIban(value), {
    message: "INVALID_IBAN",
  }).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "At least one personnel field is required",
});

export type RiderPersonnelPatch = z.infer<typeof riderPersonnelPatchSchema>;

export function validRiderIban(value: string): boolean {
  const iban = value.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = character >= "A" && character <= "Z"
      ? String(character.charCodeAt(0) - 55)
      : character;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

export function riderPersonnelEncryptionKey(environment: NodeJS.ProcessEnv = process.env): Buffer {
  const encoded = String(environment.PIKI_RIDER_PII_ENCRYPTION_KEY || "").trim();
  if (!encoded) throw new Error("RIDER_PII_ENCRYPTION_KEY_REQUIRED");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("RIDER_PII_ENCRYPTION_KEY_INVALID");
  }
  return key;
}

export function riderPersonnelEncryptionConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  try {
    riderPersonnelEncryptionKey(environment);
    return true;
  } catch {
    return false;
  }
}

function aad(riderId: string, field: RiderPersonnelField): Buffer {
  return Buffer.from(`piki:rider-personnel:v1:${riderId}:${field}`, "utf8");
}

export function encryptRiderPersonnelField(
  value: string,
  riderId: string,
  field: RiderPersonnelField,
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", riderPersonnelEncryptionKey(environment), iv);
  cipher.setAAD(aad(riderId, field));
  const encrypted = Buffer.concat([cipher.update(normalized, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptRiderPersonnelField(
  value: string | null | undefined,
  riderId: string,
  field: RiderPersonnelField,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!value) return "";
  const [version, ivRaw, tagRaw, encryptedRaw, extra] = value.split(".");
  if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw || extra) {
    throw new Error("RIDER_PII_CIPHERTEXT_INVALID");
  }
  const decipher = createDecipheriv("aes-256-gcm", riderPersonnelEncryptionKey(environment), Buffer.from(ivRaw, "base64url"));
  decipher.setAAD(aad(riderId, field));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}

export function riderPersonnelCompleteness(record: Record<string, unknown> | null | undefined) {
  return {
    hasAddress: Boolean(record?.homeAddressEncrypted),
    hasIdentityDocument: Boolean(record?.identityDocumentNumberEncrypted),
    hasBankDetails: Boolean(record?.bankNameEncrypted || record?.bankAccountHolderEncrypted || record?.ibanEncrypted),
  };
}
