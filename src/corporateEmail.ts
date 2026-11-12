import nodemailer from "nodemailer";
import type { SendMailOptions } from "nodemailer";
import { ImapFlow } from "imapflow";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { createHash } from "node:crypto";
export type CorporateEmailDepartment = "support" | "hr" | "admin" | "finance" | "operations";
type CorporateEmail = { recipientEmail: string; subject: string; text: string; html: string; idempotencyKey: string; fromEmail?: string; department?: CorporateEmailDepartment };
export type CorporateEmailResult = { sent: boolean; error?: string; providerId?: string; sentCopySaved?: boolean };
const senderDefaults: Record<CorporateEmailDepartment, string> = { support: "support@pikidelivery.com", hr: "rrhh@pikidelivery.com", admin: "administracion@pikidelivery.com", finance: "finanzas@pikidelivery.com", operations: "operaciones@pikidelivery.com" };
const senderEnvironmentKeys: Record<CorporateEmailDepartment, string> = { support: "PIKI_EMAIL_FROM_SUPPORT", hr: "PIKI_EMAIL_FROM_HR", admin: "PIKI_EMAIL_FROM_ADMIN", finance: "PIKI_EMAIL_FROM_FINANCE", operations: "PIKI_EMAIL_FROM_OPERATIONS" };
export function corporateEmailSender(department: CorporateEmailDepartment = "support") {
  if (department === "support" && process.env.PIKI_EMAIL_FROM?.trim()) return process.env.PIKI_EMAIL_FROM.trim();
  return String(process.env[senderEnvironmentKeys[department]] || senderDefaults[department]).trim();
}
export function corporateEmailDepartmentForRole(role: unknown): CorporateEmailDepartment {
  const normalized = String(role || "").trim().toLowerCase();
  if (normalized === "admin") return "admin";
  if (normalized === "finance") return "finance";
  if (normalized === "support") return "support";
  if (["rider", "fleet", "commercial", "gerente_comercial_zona"].includes(normalized)) return "operations";
  return "admin";
}
export function corporateEmailConfiguration() {
  const smtp = Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim() && (process.env.SMTP_PASSWORD || process.env.SMTP_PASS));
  const resend = Boolean(process.env.RESEND_API_KEY?.trim());
  return { configured: smtp || resend, provider: smtp ? "smtp" : resend ? "resend" : "none", from: String(process.env.PIKI_EMAIL_FROM || corporateEmailSender("support")).trim(), replyTo: corporateEmailSender("support") };
}
export async function verifyCorporateEmailConnection(): Promise<{ provider: string; configured: boolean; authenticated: boolean; port?: number; secure?: boolean; error?: string }> {
  const configuration = corporateEmailConfiguration();
  if (!configuration.configured) return { provider: "none", configured: false, authenticated: false, error: "CORPORATE_EMAIL_NOT_CONFIGURED" };
  if (configuration.provider !== "smtp") return { provider: configuration.provider, configured: true, authenticated: false, error: "VERIFICATION_REQUIRES_SMTP" };
  const port = Number(process.env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST!.trim(), port, secure: port === 465, requireTLS: port !== 465, auth: { user: process.env.SMTP_USER!.trim(), pass: process.env.SMTP_PASSWORD || process.env.SMTP_PASS }, connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true } });
  try { await transport.verify(); return { provider: "smtp", configured: true, authenticated: true, port, secure: port === 465 }; }
  catch (error) { return { provider: "smtp", configured: true, authenticated: false, port, secure: port === 465, error: (error as { code?: string }).code || "SMTP_VERIFICATION_FAILED" }; }
  finally { transport.close(); }
}

export function escapeCorporateHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
}
export function corporateRecipientAccepted(accepted: ReadonlyArray<string | { address: string; name?: string }>, recipient: string): boolean {
  return accepted.some(value => (typeof value === "string" ? value : value.address).toLowerCase() === recipient.toLowerCase());
}
type CorporateMailComposerConstructor = new (options: SendMailOptions) => { compile(): { build(): Promise<Buffer> } };
export async function composeCorporateMime(options: SendMailOptions): Promise<Buffer> {
  const imported: unknown = MailComposer;
  const candidate = typeof imported === "function" ? imported : imported && typeof imported === "object" && "default" in imported ? imported.default : null;
  if (typeof candidate !== "function") throw new Error("MAIL_COMPOSER_UNAVAILABLE");
  const Constructor = candidate as CorporateMailComposerConstructor;
  return new Constructor(options).compile().build();
}
async function saveCorporateSentCopy(mailOptions: SendMailOptions) {
  if (process.env.SMTP_IMAP_SAVE_SENT !== "true") return false;
  const imap = new ImapFlow({
    host: (process.env.SMTP_IMAP_HOST || "pop.securemail.pro").trim(),
    port: Number(process.env.SMTP_IMAP_PORT || 993),
    secure: true,
    auth: { user: (process.env.SMTP_IMAP_USER || process.env.SMTP_USER || "").trim(), pass: process.env.SMTP_IMAP_PASSWORD || process.env.SMTP_PASSWORD || process.env.SMTP_PASS || "" },
    connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
  });
  try {
    const raw = await composeCorporateMime(mailOptions);
    await imap.connect();
    const folders = await imap.list();
    const sentFolder = folders.find(folder => folder.specialUse?.toLowerCase() === "\\sent")?.path || process.env.SMTP_SENT_FOLDER || "INBOX.Sent";
    await imap.append(sentFolder, raw, ["\\Seen"], new Date());
    console.info("Corporate IMAP sent copy saved", { provider: "imap", folder: sentFolder, messageId: mailOptions.messageId });
    return true;
  } finally {
    await imap.logout().catch(() => undefined);
  }
}
export async function sendCorporateEmail(input: CorporateEmail): Promise<CorporateEmailResult> {
  const configuration = corporateEmailConfiguration();
  const from = input.fromEmail ? input.fromEmail.trim() : corporateEmailSender(input.department || "support");
  const deliveryKey = createHash("sha256").update(input.idempotencyKey).digest("hex");
  if (!configuration.configured) return { sent: false, error: "CORPORATE_EMAIL_NOT_CONFIGURED" };
  if (configuration.provider === "smtp") {
    const port = Number(process.env.SMTP_PORT || 465);
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST!.trim(), port, secure: port === 465,
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER!.trim(), pass: process.env.SMTP_PASSWORD || process.env.SMTP_PASS },
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000,
      tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    });
    try {
      const mailOptions = { from, sender: from, replyTo: configuration.replyTo, to: input.recipientEmail, subject: input.subject, text: input.text, html: input.html, messageId: `<${deliveryKey}@pikidelivery.com>`, headers: { "X-PIKI-Delivery-Key": deliveryKey, "X-Mailer": "PIKI Delivery", "X-Auto-Response-Suppress": "All" }, envelope: { from: process.env.SMTP_USER!.trim(), to: input.recipientEmail } };
      const result = await transport.sendMail(mailOptions);
      const smtpResult = { provider: "smtp", recipient: input.recipientEmail, from, department: input.department || "support", port, secure: port === 465, messageId: result.messageId, envelope: result.envelope, accepted: result.accepted, rejected: result.rejected, response: result.response };
      console.info("Corporate SMTP delivery response", smtpResult);
      if (!corporateRecipientAccepted(result.accepted || [], input.recipientEmail)) return { sent: false, error: "CORPORATE_EMAIL_RECIPIENT_REJECTED" };
      let sentCopySaved = false;
      try { sentCopySaved = await saveCorporateSentCopy(mailOptions); }
      catch (error) { console.warn("Corporate IMAP sent copy unavailable", { code: (error as { code?: string }).code || "IMAP_ARCHIVE_FAILED", message: error instanceof Error ? error.message : "unknown" }); }
      return { sent: true, providerId: String(result.messageId), sentCopySaved };
    } catch (error) {
      const code = (error as { code?: string }).code || "UNKNOWN";
      const smtpError = error as { code?: string; responseCode?: number; response?: string; command?: string };
      console.warn("Corporate SMTP delivery error", { provider: "smtp", recipient: input.recipientEmail, from, department: input.department || "support", port, secure: port === 465, code, responseCode: smtpError.responseCode || null, response: smtpError.response || null, command: smtpError.command || null });
      return { sent: false, error: code === "EAUTH" ? "CORPORATE_EMAIL_CONFIGURATION_REJECTED" : "CORPORATE_EMAIL_UNAVAILABLE" };
    } finally { transport.close(); }
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json", "Idempotency-Key": deliveryKey },
      body: JSON.stringify({ from, reply_to: configuration.replyTo, to: [input.recipientEmail], subject: input.subject, text: input.text, html: input.html }), signal: AbortSignal.timeout(8_000),
    });
    const payload = await response.json().catch(() => ({})) as { id?: string };
    if (!response.ok || !payload.id) {
      console.warn("Corporate email delivery rejected", { status: response.status, key: input.idempotencyKey });
      return { sent: false, error: response.status === 401 || response.status === 403 ? "CORPORATE_EMAIL_CONFIGURATION_REJECTED" : "CORPORATE_EMAIL_PROVIDER_ERROR" };
    }
    return { sent: true, providerId: payload.id };
  } catch (error) {
    console.warn("Corporate email delivery unavailable", error instanceof Error ? error.name : "unknown");
    return { sent: false, error: "CORPORATE_EMAIL_UNAVAILABLE" };
  }
}
export async function sendLeadContactEmail(input: { leadId: string; recipientEmail: string; recipientName: string; kind: "rider" | "partner"; subject: string; message: string; key: string }) {
  const name = escapeCorporateHtml(input.recipientName);
  const body = escapeCorporateHtml(input.message).replace(/\n/g, "<br>");
  return sendCorporateEmail({ department: "hr", recipientEmail: input.recipientEmail, subject: input.subject, idempotencyKey: `piki-lead-contact-${input.leadId}-${input.key}`, text: `Hola ${input.recipientName},\n\n${input.message}\n\nEquipo de RRHH · PIKI Delivery\nrrhh@pikidelivery.com`, html: `<div style="background:#f4f6f8;padding:24px;font-family:Arial,sans-serif;color:#172238"><div style="max-width:620px;margin:auto;background:white;border-radius:16px;overflow:hidden"><div style="background:#d2ff59;padding:24px"><strong style="font-size:24px">PIKI DELIVERY</strong><p>${input.kind === "rider" ? "PIKI Riders" : "PIKI Partner Orders"} · Tu solicitud de alta</p></div><div style="padding:28px;line-height:1.6"><h2>Hola ${name}</h2><p>${body}</p><p>Si necesitas ayuda, responde a este correo. Para enviar documentación sensible utiliza exclusivamente el enlace individual de tu expediente.</p><p><strong>Equipo de RRHH · PIKI Delivery</strong><br>rrhh@pikidelivery.com</p></div></div></div>` });
}
