import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { DEFAULT_PARTNER_TIME_ZONE, legacyOpeningHoursProjection, normalizeOpeningHours, type CanonicalOpeningHours, type OpeningHours, type OpeningInterval, type WeekdayKey, WEEKDAY_KEYS } from "./openingHours.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const BUSINESS_INFORMATION = "https://mybusinessbusinessinformation.googleapis.com/v1";
const SCOPES = ["https://www.googleapis.com/auth/business.manage"];
const dayMap: Record<string, WeekdayKey> = { MONDAY: "lunes", TUESDAY: "martes", WEDNESDAY: "miércoles", THURSDAY: "jueves", FRIDAY: "viernes", SATURDAY: "sábado", SUNDAY: "domingo" };
const googleDayMap = Object.fromEntries(Object.entries(dayMap).map(([google, local]) => [local, google])) as Record<WeekdayKey, string>;

function config(name: string, environment: NodeJS.ProcessEnv = process.env): string { return String(environment[name] || "").trim(); }
function tokenEncryptionKey(): string { return config("GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY"); }

/** Configuration is deliberately explicit so missing token encryption disables sync safely. */
export function googleBusinessConfiguration(environment: NodeJS.ProcessEnv = process.env) {
  const missing = ["GOOGLE_BUSINESS_CLIENT_ID", "GOOGLE_BUSINESS_CLIENT_SECRET", "GOOGLE_BUSINESS_REDIRECT_URI", "GOOGLE_BUSINESS_TOKEN_ENCRYPTION_KEY"].filter((name) => !config(name, environment));
  return { configured: missing.length === 0, missing };
}

function key(): Buffer {
  const configured = tokenEncryptionKey();
  if (configured) return createHash("sha256").update(configured).digest();
  // Existing development fixtures keep working locally. Production never uses a
  // known fallback key: Google operations remain disabled until a key is set.
  if (process.env.NODE_ENV !== "production") return createHash("sha256").update("piki-google-business-local-key").digest();
  throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY_REQUIRED");
}

export function encryptGoogleSecret(value: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}
export function decryptGoogleSecret(value: string): string {
  const [ivRaw, tagRaw, encryptedRaw] = String(value).split(".");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivRaw, "base64url")); decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedRaw, "base64url")), decipher.final()]).toString("utf8");
}
export function googleBusinessConfigured(environment: NodeJS.ProcessEnv = process.env): boolean { return googleBusinessConfiguration(environment).configured; }
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
export async function listGoogleLocations(connection: any, accountName: string): Promise<any[]> { const payload = await googleRequest(connection, `/${accountName}/locations?readMask=name,title,storeCode,regularHours,specialHours,metadata`); return Array.isArray(payload.locations) ? payload.locations : []; }
export async function readGoogleLocation(connection: any, locationName: string): Promise<any> { return googleRequest(connection, `/${locationName}?readMask=name,title,storeCode,regularHours,specialHours,metadata`); }
export async function updateGoogleLocationHours(connection: any, locationName: string, hours: { regularHours: any; specialHours: any }): Promise<any> { return googleRequest(connection, `/${locationName}?updateMask=regularHours,specialHours`, { method: "PATCH", body: JSON.stringify(hours) }); }

function timeValue(value: any) { return `${String(Number(value?.hours || 0)).padStart(2, "0")}:${String(Number(value?.minutes || 0)).padStart(2, "0")}`; }
function googleTime(value: string) { return { hours: Number(value.slice(0, 2)), minutes: Number(value.slice(3, 5)) }; }
function googleDate(value: string) { const [year, month, day] = value.split("-").map(Number); return { year, month, day }; }
function localDate(value: any) { return `${String(Number(value?.year || 0)).padStart(4, "0")}-${String(Number(value?.month || 0)).padStart(2, "0")}-${String(Number(value?.day || 0)).padStart(2, "0")}`; }
function overnight(interval: OpeningInterval) { return interval.endsNextDay === true || interval.close <= interval.open; }
function canonicalFrom(value: unknown): CanonicalOpeningHours {
  return normalizeOpeningHours(value) || { timeZone: DEFAULT_PARTNER_TIME_ZONE, regular: {}, overrides: [] };
}

export function toGoogleRegularHours(hours: unknown): any {
  const schedule = canonicalFrom(hours); const periods: any[] = [];
  for (const day of WEEKDAY_KEYS) for (const interval of schedule.regular[day] || []) {
    const dayIndex = WEEKDAY_KEYS.indexOf(day);
    const closeDay = overnight(interval) ? WEEKDAY_KEYS[(dayIndex + 1) % WEEKDAY_KEYS.length] : day;
    periods.push({ openDay: googleDayMap[day], openTime: googleTime(interval.open), closeDay: googleDayMap[closeDay], closeTime: googleTime(interval.close) });
  }
  return { periods };
}

function toGoogleSpecialHours(hours: unknown): any {
  const schedule = canonicalFrom(hours);
  const specialHourPeriods: any[] = [];
  for (const override of schedule.overrides) {
    if (override.closed) {
      specialHourPeriods.push({ startDate: googleDate(override.date), endDate: googleDate(override.endDate || override.date), closed: true });
      continue;
    }
    for (const interval of override.intervals) specialHourPeriods.push({
      startDate: googleDate(override.date),
      endDate: googleDate(override.endDate || override.date),
      openTime: googleTime(interval.open),
      closeTime: googleTime(interval.close),
    });
  }
  return { specialHourPeriods };
}

export function toGoogleLocationHours(hours: unknown) {
  return { regularHours: toGoogleRegularHours(hours), specialHours: toGoogleSpecialHours(hours) };
}

/** Import every Google period. Legacy day fields are an additive two-slot projection only. */
export function fromGoogleLocationHours(input: any, existing?: unknown): OpeningHours {
  const prior = normalizeOpeningHours(existing);
  const regular: Partial<Record<WeekdayKey, OpeningInterval[]>> = {};
  for (const period of input?.regularHours?.periods || input?.periods || []) {
    const day = dayMap[period.openDay]; if (!day) continue;
    const open = timeValue(period.openTime); const close = timeValue(period.closeTime);
    const endsNextDay = Boolean(period.closeDay && period.closeDay !== period.openDay) || close <= open;
    (regular[day] ||= []).push({ open, close, ...(endsNextDay ? { endsNextDay: true } : {}) });
  }
  const grouped = new Map<string, { date: string; endDate?: string; closed: boolean; intervals: OpeningInterval[] }>();
  for (const period of input?.specialHours?.specialHourPeriods || []) {
    const date = localDate(period.startDate); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith("0000")) continue;
    const endDate = period.endDate ? localDate(period.endDate) : undefined;
    const closed = period.closed === true;
    const key = `${date}:${endDate || date}:${closed}`;
    const group = grouped.get(key) || { date, ...(endDate && endDate !== date ? { endDate } : {}), closed, intervals: [] };
    if (!closed) group.intervals.push({ open: timeValue(period.openTime), close: timeValue(period.closeTime) });
    grouped.set(key, group);
  }
  const schedule: CanonicalOpeningHours = {
    timeZone: prior?.timeZone || DEFAULT_PARTNER_TIME_ZONE,
    regular,
    overrides: [...grouped.values()],
    source: { mode: "google", locationName: input?.name || prior?.source?.locationName || null, revision: input?.metadata?.updateTime || input?.metadata?.mapsUri || null, syncedAt: new Date() },
  };
  return { ...legacyOpeningHoursProjection(schedule), ...schedule };
}

/** Retained export for clients/tests using the prior regular-hours-only helper. */
export function fromGoogleRegularHours(input: any): OpeningHours { return fromGoogleLocationHours({ regularHours: input }); }
