import assert from "node:assert/strict";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { buildOnboardingScope } from "../src/onboardingScope.js";
import { DocumentRequest } from "../src/models.js";
import { sendLeadContactEmail, verifyCorporateEmailConnection } from "../src/corporateEmail.js";
const platformId = "111111111111111111111111";
const tenantId = "222222222222222222222222";
assert.deepEqual(buildOnboardingScope(platformId, true), { $or: [{ tenantId: new mongoose.Types.ObjectId(platformId) }, { tenantId: null }] });
assert.deepEqual(buildOnboardingScope(tenantId, false), { tenantId: new mongoose.Types.ObjectId(tenantId) });
assert.deepEqual(buildOnboardingScope("invalid", true), { _id: null });
assert.deepEqual(buildOnboardingScope(undefined, true), { _id: null });
console.log("PASS: leads públicos sin tenant disponibles solo para la plataforma, sin abrir otros tenants.");
for (const subjectType of ["rider_lead", "partner_lead"] as const) {
 const document = new DocumentRequest({ tenantId: platformId, subjectType, subjectId: tenantId, recipientName: "QA PIKI", recipientEmail: "qa@example.test", createdBy: platformId, message: "Solicitud documental de prueba local.", requirements: [{ type: "identity", label: "Identidad", description: "Prueba" }], expiresAt: new Date(Date.now() + 86400000), tokenHash: "abc123", tokenPrefix: "abc123" });
 assert.equal(document.validateSync(), undefined);
}
console.log("PASS: expedientes Rider y Partner válidos en el modelo MongoDB.");
const previousKey = process.env.RESEND_API_KEY;
const previousFrom = process.env.PIKI_EMAIL_FROM;
const originalFetch = globalThis.fetch;
const smtpKeys = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_PASS"];
const savedSmtp = Object.fromEntries(smtpKeys.map(key => [key, process.env[key]]));
const transportFactory = nodemailer.createTransport;
for (const key of smtpKeys) delete process.env[key];
try {
 delete process.env.RESEND_API_KEY;
 let requests = 0;
 globalThis.fetch = async () => { requests++; throw new Error("Unexpected network call"); };
 const input = { leadId: platformId, recipientEmail: "aspirante@example.test", recipientName: "QA <Rider>", kind: "rider" as const, subject: "PIKI · Solicitud QA", message: "Confirma tu disponibilidad. <script>no</script>", key: "qa-regression-001" };
 assert.deepEqual(await sendLeadContactEmail(input), { sent: false, error: "CORPORATE_EMAIL_NOT_CONFIGURED" });
 assert.equal(requests, 0);
 process.env.RESEND_API_KEY = "test-mock-not-a-real-key";
 process.env.PIKI_EMAIL_FROM = "PIKI · RRHH <rrhh@pikidelivery.com>";
 globalThis.fetch = async (_url, init) => {
  requests++;
  const body = JSON.parse(String(init?.body));
  assert.deepEqual(body.to, [input.recipientEmail]);
  assert.equal(body.reply_to, "rrhh@pikidelivery.com");
  assert.match(body.from, /rrhh@pikidelivery.com/);
  assert.ok(body.html.includes("&lt;script&gt;"));
  assert.ok(!body.html.includes("<script>"));
  return new Response(JSON.stringify({ id: "mock-message-id" }), { status: 200 });
 };
 assert.deepEqual(await sendLeadContactEmail(input), { sent: true, providerId: "mock-message-id" });
 assert.equal(requests, 1);
 globalThis.fetch = async () => new Response(JSON.stringify({ message: "Sender rejected" }), { status: 403 });
 assert.deepEqual(await sendLeadContactEmail(input), { sent: false, error: "CORPORATE_EMAIL_CONFIGURATION_REJECTED" });
 console.log("PASS: destinatario exacto, remitente y respuesta RRHH, HTML escapado y fallos de proveedor explícitos.");
 process.env.SMTP_HOST = "smtp.example.test";
 process.env.SMTP_USER = "rrhh@pikidelivery.com";
 process.env.SMTP_PASSWORD = "test-mock-not-a-real-password";
 let smtpMessages = 0;
 (nodemailer as any).createTransport = (options: any) => {
  assert.equal(options.port, 465); assert.equal(options.secure, true);
  assert.equal(options.auth.user, "rrhh@pikidelivery.com");
  return { verify: async () => true, sendMail: async (mail: any) => { smtpMessages++; assert.equal(mail.to, input.recipientEmail); assert.equal(mail.replyTo, "rrhh@pikidelivery.com"); return { accepted: [input.recipientEmail], messageId: "mock-smtp-message" }; }, close: () => {} };
 };
 assert.deepEqual(await sendLeadContactEmail(input), { sent: true, providerId: "mock-smtp-message" });
 assert.equal(smtpMessages, 1);
 assert.deepEqual(await verifyCorporateEmailConnection(), { provider: "smtp", configured: true, authenticated: true });
 assert.equal(smtpMessages, 1);
 console.log("PASS: SMTP autenticado y cifrado, remitente RRHH y destinatario fijo (transporte simulado).");
} finally {
 globalThis.fetch = originalFetch;
 nodemailer.createTransport = transportFactory;
 for (const key of smtpKeys) { if (savedSmtp[key] === undefined) delete process.env[key]; else process.env[key] = savedSmtp[key]; }
 if (previousKey === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = previousKey;
 if (previousFrom === undefined) delete process.env.PIKI_EMAIL_FROM; else process.env.PIKI_EMAIL_FROM = previousFrom;
}
console.log("Pruebas locales terminadas; no se ha enviado correo real ni modificado ninguna base de datos.");
