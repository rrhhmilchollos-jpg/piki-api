import { createHash } from "node:crypto";

export type SignatureRequestInput = {
  subject: string;
  signerName: string;
  signerEmail: string;
  documentName: string;
  documentBase64: string;
  callbackUrl?: string;
};

export function signaturitConfigured() {
  return Boolean(process.env.SIGNATURIT_ACCESS_TOKEN);
}

export function signaturitBaseUrl() {
  return (process.env.SIGNATURIT_API_BASE_URL || "https://api.sandbox.signaturit.com/v3").replace(/\/$/, "");
}

export function signaturitMode() {
  return process.env.SIGNATURIT_API_BASE_URL?.includes("sandbox") || !process.env.SIGNATURIT_API_BASE_URL ? "sandbox" : "production";
}

export function signatureWebhookUrl() {
  return process.env.SIGNATURIT_EVENTS_URL || "https://api.pikidelivery.com/api/v1/signatures/signaturit/events";
}

export async function createSignaturitSignature(input: SignatureRequestInput) {
  if (!signaturitConfigured()) throw new Error("SIGNATURIT_NOT_CONFIGURED");
  const payload = {
    name: input.subject,
    recipients: [{ name: input.signerName, email: input.signerEmail }],
    files: [{ name: input.documentName, content: input.documentBase64 }],
    events_url: input.callbackUrl || signatureWebhookUrl(),
  };
  const response = await fetch(`${signaturitBaseUrl()}/signatures.json`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.SIGNATURIT_ACCESS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`SIGNATURIT_${response.status}`);
  return body;
}

export function webhookDigest(rawBody: string) {
  return createHash("sha256").update(rawBody).digest("hex");
}
