#!/usr/bin/env node
/**
 * Prueba segura de SMTP contra Nominalia.
 * Solo verifica autenticación por defecto; no envía correo.
 *
 * Variables requeridas:
 *   SMTP_HOST=smtp.nominalia.com
 *   SMTP_PORT=465
 *   SMTP_USER=cuenta@dominio.tld
 *   SMTP_PASSWORD=...
 *
 * Opcional para enviar un mensaje real de prueba:
 *   SMTP_TEST_TO=destinatario@dominio.tld node scripts/test-smtp-nominalia.mjs --send
 */
import nodemailer from "nodemailer";

const host = process.env.SMTP_HOST || "smtp.nominalia.com";
const port = Number(process.env.SMTP_PORT || 465);
const user = String(process.env.SMTP_USER || "").trim();
const pass = process.env.SMTP_PASSWORD || process.env.SMTP_PASS || "";
const send = process.argv.includes("--send");
const to = String(process.env.SMTP_TEST_TO || "").trim();

if (!user || !pass) {
  console.error("Faltan SMTP_USER y/o SMTP_PASSWORD (no se muestran valores secretos).\nEjemplo: SMTP_HOST=smtp.nominalia.com SMTP_PORT=465 node scripts/test-smtp-nominalia.mjs");
  process.exitCode = 2;
  process.exit();
}
if (send && !to) {
  console.error("Para --send debes definir SMTP_TEST_TO.");
  process.exitCode = 2;
  process.exit();
}
if (port !== 465) {
  console.error(`Configuración rechazada: SMTP_PORT=${port}. Este script exige el puerto 465 con SSL implícito.`);
  process.exitCode = 2;
  process.exit();
}

const transport = nodemailer.createTransport({
  host,
  port: 465,
  secure: true,
  auth: { user, pass },
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 15_000,
  tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
});

try {
  await transport.verify();
  console.log(JSON.stringify({ ok: true, verified: true, host, port: 465, secure: true, user, sent: false }));

  if (send) {
    const from = process.env.SMTP_TEST_FROM || user;
    const result = await transport.sendMail({
      from,
      to,
      subject: "PIKI · Prueba SMTP Nominalia",
      text: "Prueba de conexión SMTP desde el servidor Render. No contiene credenciales.",
      headers: { "X-PIKI-SMTP-Test": "nominalia" },
    });
    console.log(JSON.stringify({ ok: true, verified: true, host, port: 465, secure: true, user, sent: true, messageId: result.messageId, accepted: result.accepted }));
  }
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({ ok: false, verified: false, host, port: 465, secure: true, user, code: err.code || "SMTP_TEST_FAILED", message: err.message }));
  process.exitCode = 1;
} finally {
  transport.close();
}
