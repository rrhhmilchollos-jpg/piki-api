#!/usr/bin/env node
/**
 * Reenvía un correo de restablecimiento usando Nodemailer y SMTP Nominalia.
 *
 * Importante: este script NO crea ni adivina tokens. RESET_URL debe ser un
 * enlace de un solo uso generado por PIKI y todavía válido.
 *
 * Ejemplo de verificación sin envío:
 *   SMTP_HOST=smtp.nominalia.com SMTP_PORT=465 \
 *   SMTP_USER='cuenta@pikidelivery.com' SMTP_PASSWORD='...' \
 *   node scripts/force-smtp-password-reset.mjs --verify
 *
 * Ejemplo de envío:
 *   TO='destinatario@dominio.tld' RESET_URL='https://admin.pikidelivery.com/...' \
 *   SMTP_HOST=smtp.nominalia.com SMTP_PORT=465 \
 *   SMTP_USER='cuenta@pikidelivery.com' SMTP_PASSWORD='...' \
 *   node scripts/force-smtp-password-reset.mjs
 */
import nodemailer from "nodemailer";

const argValue = (name) => {
  const prefix = `${name}=`;
  const item = process.argv.find((value) => value.startsWith(prefix));
  return item ? item.slice(prefix.length) : "";
};
const to = process.env.TO || argValue("--to");
const resetUrl = process.env.RESET_URL || argValue("--reset-url");
const host = process.env.SMTP_HOST || "smtp.nominalia.com";
const port = Number(process.env.SMTP_PORT || 465);
const user = String(process.env.SMTP_USER || "").trim();
const password = process.env.SMTP_PASSWORD || process.env.SMTP_PASS || "";
const from = process.env.SMTP_FROM || process.env.PIKI_EMAIL_FROM_SUPPORT || user;
const replyTo = process.env.SMTP_REPLY_TO || from;
const verifyOnly = process.argv.includes("--verify");

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(2);
}

if (!user || !password) fail("Faltan SMTP_USER y SMTP_PASSWORD.");
if (port !== 465) fail(`SMTP_PORT debe ser 465; recibido ${port}.`);
if (!verifyOnly && !to) fail("Falta TO o --to=destinatario@dominio.tld.");
if (!verifyOnly && !resetUrl) fail("Falta RESET_URL o --reset-url=https://...; usa un enlace PIKI de un solo uso.");
if (!verifyOnly) {
  try { new URL(resetUrl); } catch { fail("RESET_URL no es una URL válida."); }
}

const transport = nodemailer.createTransport({
  host,
  port: 465,
  secure: true,
  auth: { user, pass: password },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
  tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
});

try {
  await transport.verify();
  if (verifyOnly) {
    console.log(JSON.stringify({ ok: true, verified: true, host, port: 465, secure: true, user }));
  } else {
    const result = await transport.sendMail({
      from,
      sender: user,
      envelope: { from: user, to },
      replyTo,
      to,
      subject: "PIKI · Restablecimiento de tu primera contraseña",
      text: `Hola,\n\nUsa este enlace de un solo uso para crear o restablecer tu contraseña de PIKI:\n${resetUrl}\n\nSi no solicitaste este correo, ignóralo.`,
      html: `<p>Hola,</p><p>Usa este enlace de un solo uso para crear o restablecer tu contraseña de PIKI:</p><p><a href="${resetUrl}">Crear o restablecer contraseña</a></p><p>Si no solicitaste este correo, ignóralo.</p>`,
      headers: { "X-PIKI-Password-Reset": "one-time" },
    });
    console.log(JSON.stringify({ ok: true, verified: true, sent: true, host, port: 465, secure: true, messageId: result.messageId, envelope: result.envelope, accepted: result.accepted, rejected: result.rejected, response: result.response }));
  }
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({ ok: false, verified: false, sent: false, host, port: 465, secure: true, code: err.code || "SMTP_SEND_FAILED", message: err.message, responseCode: err.responseCode || null, response: err.response || null, command: err.command || null }));
  process.exitCode = 1;
} finally {
  transport.close();
}
