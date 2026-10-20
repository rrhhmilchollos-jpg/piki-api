import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { OpeningHours } from "./openingHours.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const BUSINESS_INFORMATION = "https://mybusinessbusinessinformation.googleapis.com/v1";
const SCOPES = ["https://www.googleapis.com/auth/business.manage"];

function config(name: string): string { return String(process.env[name] || "").trim(); }
function key(): Buffer { return createHash("sha256").update(config("GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY") || "piki-google-business-local-key").digest(); }
export function encryptGoogleSecret(value: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
export function decryptGoogleSecret(value: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = String(value).split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url")); decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}
export function googleBusinessConfigured(): boolean { return Boolean(config("GOOGLE_BUSINESS_CLIENT_ID") && config("GOOGLE_BUSINESS_CLIENT_SECRET") && config("GOOGLE_BUSINESS_REDIRECT_URI")); }
export function googleBusinessScopes(): string[] { return [...SCOPES]; }
export function googleAuthorizationUrl(state: string): string {
  const url = new URL(GOOGLE_AUTH); url.searchParams.set("client_id", config("GOOGLE_BUSINESS_CLIENT_ID")); url.searchParams.set("redirect_uri", config("GOOGLE_BUSINESS_REDIRECT_URI")); url.searchParams.set("response_type", "code"); url.searchParams.set("access_type", "offline"); url.searchParams.set("prompt", "consent"); url.searchParams.set("scope", SCOPES.join(" ")); url.searchParams.set("state", state); return url.toString();
}
export async function exchangeGoogleCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope: string }> {
  const response = await fetch(GOOGLE_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ code, client_id: config("GOOGLE_BUSINESS_CLIENT_ID"), client_secret: config("GOOGLE_BUSINESS_CLIENT_SECRET"), redirect_uri: config("GOOGLE_BUSINESS_REDIRECT_URI"), grant_type: "authorization_code" }) });
  const payload = await response.json().catch(() => ({})) as any; if (!response.ok || !payload.access_token) throw new Error(payload.error_description || payload.error || `Google token HTTP ${response.status}`);
  return { accessToken: payload.access_token, refreshToken: payload.refresh_token || "", expiresAt: new Date(Date.now() + Number(payload.expires_in || 3600) * 1000), scope: String(payload.scope || SCOPES.join(" ")) };
}
async function accessToken(connection: any): Promise<string> {
  if (connection.accessTokenEncrypted && connection.tokenExpiryAt && new Date(connection.tokenExpiryAt).getTime() > Date.now() + 60_000) return decryptGoogleSecret(connection.accessTokenEncrypted);
  if (!connection.refreshTokenEncrypted) throw new Error("GOOGLE_REAUTH_REQUIRED");
  const response = await fetch(GOOGLE_TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config("GOOGLE_BUSINESS_CLIENT_ID"), client_secret: config("GOOGLE_BUSINESS_CLIENT_SECRET"), refresh_token: decryptGoogleSecret(connection.refreshTokenEncrypted), grant_type: "refresh_token" }) });
  const payload = await response.json().catch(() => ({})) as any; if (!response.ok || !payload.access_token) throw new Error(payload.error || "GOOGLE_TOKEN_REFRESH_FAILED");
  connection.accessTokenEncrypted = encryptGoogleSecret(payload.access_token); connection.tokenExpiryAt = new Date(Date.now() + Number(payload.expires_in || 3600) * 1000); await connection.save(); return payload.access_token;
}
async function googleRequest(connection: any, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${BUSINESS_INFORMATION}${path}`, { ...init, headers: { Authorization: `Bearer ${await accessToken(connection)}`, "Content-Type": "application/json", ...(init.headers || {}) } });
  const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error?.message || `Google Business HTTP ${response.status}`); return payload;
}
export async function listGoogleAccounts(connection: any): Promise<any> { const token = await accessToken(connection); const response = await fetch(`${BUSINESS_INFORMATION}/accounts`, { headers: { Authorization: `Bearer ${token}` } }); const payload = await response.json().catch(() => ({})); if (!response.ok) throw new Error(payload.error?.message || `Google accounts HTTP ${response.status}`); return payload.accounts || []; }
export async function listGoogleLocations(connection: any, accountName: string): Promise<any[]> { const payload = await googleRequest(connection, `/${accountName}/locations?readMask=name,title,storeCode,regularHours,metadata`); return Array.isArray(payload.locations) ? payload.locations : []; }
export async function readGoogleLocation(connection: any, locationName: string): Promise<any> { return googleRequest(connection, `/${locationName}?readMask=name,title,storeCode,regularHours,metadata`); }
export async function updateGoogleLocationHours(connection: any, locationName: string, regularHours: any): Promise<any> { return googleRequest(connection, `/${locationName}?updateMask=regularHours`, { method: "PATCH", body: JSON.stringify({ regularHours }) }); }
export function toGoogleRegularHours(hours: OpeningHours): any {
  const dayMap: Record<string, string> = { lunes: "MONDAY", martes: "TUESDAY", miércoles: "WEDNESDAY", jueves: "THURSDAY", viernes: "FRIDAY", sábado: "SATURDAY", domingo: "SUNDAY" };
  const orderedDays = Object.keys(dayMap);
  const periods: any[] = [];
  for (const [day, value] of Object.entries(hours)) { if (value.closed || !dayMap[day]) continue; for (const slot of [value.morning, value.evening]) { if (slot.closed) continue; const nextDay = Number(slot.close.replace(":", "")) <= Number(slot.open.replace(":", "")) ? orderedDays[(orderedDays.indexOf(day) + 1) % orderedDays.length] : day; periods.push({ openDay: dayMap[day], openTime: { hours: Number(slot.open.slice(0, 2)), minutes: Number(slot.open.slice(3, 5)) }, closeDay: dayMap[nextDay], closeTime: { hours: Number(slot.close.slice(0, 2)), minutes: Number(slot.close.slice(3, 5)) } }); } }
  return { periods };
}
export function fromGoogleRegularHours(input: any): OpeningHours {
  const dayMap: Record<string, string> = { MONDAY: "lunes", TUESDAY: "martes", WEDNESDAY: "miércoles", THURSDAY: "jueves", FRIDAY: "viernes", SATURDAY: "sábado", SUNDAY: "domingo" };
  const result: any = {}; for (const day of Object.values(dayMap)) result[day] = { morning: { open: "10:00", close: "14:00", closed: true }, evening: { open: "18:00", close: "23:00", closed: true }, closed: true };
  for (const period of input?.periods || []) { const day = dayMap[period.openDay]; if (!day) continue; const open = `${String(period.openTime?.hours || 0).padStart(2, "0")}:${String(period.openTime?.minutes || 0).padStart(2, "0")}`; const close = `${String(period.closeTime?.hours || 0).padStart(2, "0")}:${String(period.closeTime?.minutes || 0).padStart(2, "0")}`; const target = Number(period.openTime?.hours || 0) >= 17 ? result[day].evening : result[day].morning; Object.assign(target, { open, close, closed: false }); result[day].closed = false; }
  return result as OpeningHours;
}
