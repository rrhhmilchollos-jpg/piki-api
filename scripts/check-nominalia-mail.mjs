#!/usr/bin/env node
/**
 * Nominalia no documenta una API pública de tracking de entrega para el email
 * estándar. Este script usa el acceso IMAP oficial para revisar las carpetas
 * del servidor y localizar copias enviadas o rebotes.
 *
 * Variables necesarias:
 *   SMTP_IMAP_USER=rrhh@pikidelivery.com
 *   SMTP_IMAP_PASSWORD='...'
 * Opcionales:
 *   SMTP_IMAP_HOST=pop.securemail.pro SMTP_IMAP_PORT=993
 *   SMTP_SENT_FOLDER=INBOX.Sent RECIPIENTS='a@x.test,b@y.test'
 *
 * Ejemplo:
 *   SMTP_IMAP_USER='rrhh@pikidelivery.com' SMTP_IMAP_PASSWORD='...' \
 *   RECIPIENTS='costerahome@gmail.com,danielreyes17@outlook.es' \
 *   node scripts/check-nominalia-mail.mjs
 */
import { ImapFlow } from "imapflow";

const user = (process.env.SMTP_IMAP_USER || process.env.SMTP_USER || "").trim();
const password = process.env.SMTP_IMAP_PASSWORD || process.env.SMTP_PASSWORD || process.env.SMTP_PASS || "";
const host = (process.env.SMTP_IMAP_HOST || "pop.securemail.pro").trim();
const port = Number(process.env.SMTP_IMAP_PORT || 993);
const recipients = (process.env.RECIPIENTS || "costerahome@gmail.com,danielreyes17@outlook.es")
  .split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
const sinceDays = Number(process.env.SINCE_DAYS || 7);

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(2);
}
if (!user || !password) fail("Faltan SMTP_IMAP_USER y SMTP_IMAP_PASSWORD.");
if (port !== 993) fail(`SMTP_IMAP_PORT debe ser 993 con SSL; recibido ${port}.`);

const client = new ImapFlow({
  host, port: 993, secure: true,
  auth: { user, pass: password },
  connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
  tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
});

const addressList = (addresses = []) => addresses.map(address => `${address.name || ""} <${address.address || ""}>`.trim());
const normalized = value => String(value || "").toLowerCase();
const isBounce = message => {
  const subject = normalized(message.envelope?.subject);
  const from = normalized(addressList(message.envelope?.from).join(" "));
  return /undelivered|delivery status|returned mail|mail delivery subsystem|delivery failure|failure notice|mailer-daemon/.test(`${subject} ${from}`);
};
const summarize = message => ({
  uid: message.uid,
  date: message.internalDate || message.envelope?.date || null,
  subject: message.envelope?.subject || "",
  from: addressList(message.envelope?.from),
  to: addressList(message.envelope?.to),
  messageId: message.envelope?.messageId || null,
  flags: message.flags ? [...message.flags] : [],
});

async function readFolder(folder, since) {
  const lock = await client.getMailboxLock(folder);
  try {
    const uids = await client.search({ since }, { uid: true });
    if (!uids.length) return [];
    return await client.fetchAll(uids.slice(-100), { envelope: true, internalDate: true, flags: true }, { uid: true });
  } finally {
    lock.release();
  }
}

try {
  await client.connect();
  const folders = await client.list();
  const sentFolder = folders.find(folder => folder.specialUse?.toLowerCase() === "\\sent")?.path || process.env.SMTP_SENT_FOLDER || "INBOX.Sent";
  const inboxFolder = folders.find(folder => folder.specialUse?.toLowerCase() === "\\inbox")?.path || "INBOX";
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
  const [sent, inbox] = await Promise.all([readFolder(sentFolder, since), readFolder(inboxFolder, since)]);
  const sentSummaries = sent.map(summarize).filter(message => message.to.some(address => recipients.some(recipient => normalized(address).includes(recipient))));
  const bounces = inbox.map(summarize).filter(isBounce);
  console.log(JSON.stringify({
    ok: true,
    trackingApi: { available: false, note: "No se encontró una API pública documentada para tracking del email estándar; se usa IMAP." },
    imap: { host, port: 993, secure: true, user, since: since.toISOString(), sentFolder, inboxFolder },
    recipients,
    sentMatches: sentSummaries,
    bounceMatches: bounces,
  }, null, 2));
} catch (error) {
  const err = error instanceof Error ? error : new Error(String(error));
  console.error(JSON.stringify({ ok: false, code: err.code || "IMAP_CHECK_FAILED", message: err.message }));
  process.exitCode = 1;
} finally {
  await client.logout().catch(() => undefined);
}
