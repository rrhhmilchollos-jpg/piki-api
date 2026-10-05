import nodemailer from "nodemailer";
import { createHash } from "node:crypto";
type CorporateEmail = { recipientEmail: string; subject: string; text: string; html: string; idempotencyKey: string };
export type CorporateEmailResult = { sent: boolean; error?: string; providerId?: string };
export function corporateEmailConfiguration() {
  const smtp = Boolean(process.env.SMTP_HOST?.trim() && process.env.SMTP_USER?.trim() && (process.env.SMTP_PASSWORD || process.env.SMTP_PASS));
  const resend = Boolean(process.env.RESEND_API_KEY?.trim());
  return { configured: smtp || resend, provider: smtp ? "smtp" : resend ? "resend" : "none", from: String(process.env.PIKI_EMAIL_FROM || "PIKI · Recursos Humanos <rrhh@pikidelivery.com>").trim(), replyTo: "rrhh@pikidelivery.com" };
}
export async function verifyCorporateEmailConnection(): Promise<{ provider: string; configured: boolean; authenticated: boolean; error?: string }> {
  const configuration = corporateEmailConfiguration();
  if (!configuration.configured) return { provider: "none", configured: false, authenticated: false, error: "CORPORATE_EMAIL_NOT_CONFIGURED" };
  if (configuration.provider !== "smtp") return { provider: configuration.provider, configured: true, authenticated: false, error: "VERIFICATION_REQUIRES_SMTP" };
  const port = Number(process.env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({ host: process.env.SMTP_HOST!.trim(), port, secure: port === 465, requireTLS: port !== 465, auth: { user: process.env.SMTP_USER!.trim(), pass: process.env.SMTP_PASSWORD || process.env.SMTP_PASS }, connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 12_000, tls: { minVersion: "TLSv1.2", rejectUnauthorized: true } });
  try { await transport.verify(); return { provider: "smtp", configured: true, authenticated: true }; }
  catch (error) { return { provider: "smtp", configured: true, authenticated: false, error: (error as { code?: string }).code || "SMTP_VERIFICATION_FAILED" }; }
  finally { transport.close(); }
}

export function escapeCorporateHtml(value: string) {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c);
}
export async function sendCorporateEmail(input: CorporateEmail): Promise<CorporateEmailResult> {
  const configuration = corporateEmailConfiguration();
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
      const result = await transport.sendMail({ from: configuration.from, replyTo: configuration.replyTo, to: input.recipientEmail, subject: input.subject, text: input.text, html: input.html, messageId: `<${deliveryKey}@pikidelivery.com>`, headers: { "X-PIKI-Delivery-Key": deliveryKey } });
      if (!(result.accepted || []).some(address => String(address).toLowerCase() === input.recipientEmail.toLowerCase())) return { sent: false, error: "CORPORATE_EMAIL_RECIPIENT_REJECTED" };
      return { sent: true, providerId: String(result.messageId) };
    } catch (error) {
      const code = (error as { code?: string }).code || "UNKNOWN";
      console.warn("Corporate SMTP delivery unavailable", { code });
      return { sent: false, error: code === "EAUTH" ? "CORPORATE_EMAIL_CONFIGURATION_REJECTED" : "CORPORATE_EMAIL_UNAVAILABLE" };
    } finally { transport.close(); }
  }
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY!.trim()}`, "Content-Type": "application/json", "Idempotency-Key": deliveryKey },
      body: JSON.stringify({ from: configuration.from, reply_to: configuration.replyTo, to: [input.recipientEmail], subject: input.subject, text: input.text, html: input.html }), signal: AbortSignal.timeout(8_000),
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
  return sendCorporateEmail({ recipientEmail: input.recipientEmail, subject: input.subject, idempotencyKey: `piki-lead-contact-${input.leadId}-${input.key}`, text: `Hola ${input.recipientName},\n\n${input.message}\n\nEquipo de RRHH · PIKI Delivery\nrrhh@pikidelivery.com`, html: `<div style="background:#f4f6f8;padding:24px;font-family:Arial,sans-serif;color:#172238"><div style="max-width:620px;margin:auto;background:white;border-radius:16px;overflow:hidden"><div style="background:#d2ff59;padding:24px"><strong style="font-size:24px">PIKI DELIVERY</strong><p>${input.kind === "rider" ? "PIKI Riders" : "PIKI Partner Orders"} · Tu solicitud de alta</p></div><div style="padding:28px;line-height:1.6"><h2>Hola ${name}</h2><p>${body}</p><p>Si necesitas ayuda, responde a este correo. Para enviar documentación sensible utiliza exclusivamente el enlace individual de tu expediente.</p><p><strong>Equipo de RRHH · PIKI Delivery</strong><br>rrhh@pikidelivery.com</p></div></div></div>` });
}
