import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getMessaging } from "firebase-admin/messaging";
import webpush from "web-push";
import { PushSubscription } from "./models.js";
import type { PikiSurface } from "./appVersion.js";

type SubscriptionPayload = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

type PushPayload = { title: string; body: string; url: string; tag?: string; renotify?: boolean; sound?: string; soundUrl?: string };
type FirebaseServiceAccount = { project_id: string; client_email: string; private_key: string };

const vapid = {
  subject: process.env.WEB_PUSH_VAPID_SUBJECT,
  publicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
  privateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
};

function encryptionKey(): Buffer | null {
  const value = process.env.WEB_PUSH_SUBSCRIPTION_ENCRYPTION_KEY;
  if (!value) return null;
  try {
    const key = Buffer.from(value, "base64");
    return key.length === 32 ? key : null;
  } catch { return null; }
}

function firebaseServiceAccount(): FirebaseServiceAccount | null {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<FirebaseServiceAccount>;
    if (!value.project_id || !value.client_email || !value.private_key) return null;
    return { project_id: value.project_id, client_email: value.client_email, private_key: value.private_key };
  } catch {
    return null;
  }
}

function fcmMessaging() {
  const account = firebaseServiceAccount();
  if (!account || !encryptionKey()) throw new Error("FCM_NOT_CONFIGURED");
  const existing = getApps().find((app) => app.name === "piki-fcm");
  const app = existing || initializeApp({
    credential: cert({ projectId: account.project_id, clientEmail: account.client_email, privateKey: account.private_key }),
    projectId: account.project_id,
  }, "piki-fcm");
  return getMessaging(app);
}

export function pushConfigured(): boolean {
  return Boolean(vapid.subject && vapid.publicKey && vapid.privateKey && encryptionKey());
}

export function fcmPushConfigured(): boolean {
  return Boolean(firebaseServiceAccount() && encryptionKey());
}

export function publicPushConfig() {
  const webPushEnabled = pushConfigured();
  return {
    enabled: webPushEnabled,
    ...(webPushEnabled ? { vapidPublicKey: vapid.publicKey } : {}),
    nativeFcmEnabled: fcmPushConfigured(),
  };
}

function configureVapid(): boolean {
  if (!pushConfigured()) return false;
  webpush.setVapidDetails(vapid.subject!, vapid.publicKey!, vapid.privateKey!);
  return true;
}

function encrypt(value: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("PUSH_NOT_CONFIGURED");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decrypt(value: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("PUSH_NOT_CONFIGURED");
  const [ivValue, tagValue, ciphertext] = value.split(".");
  if (!ivValue || !tagValue || !ciphertext) throw new Error("PUSH_CIPHERTEXT_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
}

function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

export async function savePushSubscription(input: { surface: PikiSurface; ownerType: "customer" | "employee"; ownerId: string; tenantId?: string | null; subscription: SubscriptionPayload }) {
  if (!pushConfigured()) throw new Error("PUSH_NOT_CONFIGURED");
  const hash = endpointHash(input.subscription.endpoint);
  const saved = await PushSubscription.findOneAndUpdate(
    { ownerType: input.ownerType, ownerId: input.ownerId, surface: input.surface, endpointHash: hash },
    {
      $set: {
        tenantId: input.tenantId || null,
        provider: "webpush",
        platform: "web",
        endpoint: encrypt(input.subscription.endpoint),
        endpointHash: hash,
        "keys.p256dh": encrypt(input.subscription.keys.p256dh),
        "keys.auth": encrypt(input.subscription.keys.auth),
        fcmToken: null,
        expirationTime: input.subscription.expirationTime ?? null,
        status: "active",
        failureCount: 0,
        lastFailureAt: null,
      },
      $setOnInsert: { surface: input.surface, ownerType: input.ownerType, ownerId: input.ownerId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();
  return { id: String(saved._id), status: saved.status, provider: "webpush" as const };
}

export async function saveFcmSubscription(input: { surface: "customer" | "rider"; ownerType: "customer" | "employee"; ownerId: string; tenantId?: string | null; token: string; platform: "android" | "ios" }) {
  if (!fcmPushConfigured()) throw new Error("FCM_NOT_CONFIGURED");
  const hash = endpointHash(`fcm:${input.token}`);
  const saved = await PushSubscription.findOneAndUpdate(
    { ownerType: input.ownerType, ownerId: input.ownerId, surface: input.surface, endpointHash: hash },
    {
      $set: {
        tenantId: input.tenantId || null,
        provider: "fcm",
        platform: input.platform,
        endpoint: null,
        endpointHash: hash,
        "keys.p256dh": null,
        "keys.auth": null,
        fcmToken: encrypt(input.token),
        expirationTime: null,
        status: "active",
        failureCount: 0,
        lastFailureAt: null,
      },
      $setOnInsert: { surface: input.surface, ownerType: input.ownerType, ownerId: input.ownerId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();
  return { id: String(saved._id), status: saved.status, provider: "fcm" as const };
}

export async function revokePushSubscription(input: { surface: PikiSurface; ownerType: "customer" | "employee"; ownerId: string; endpoint?: string }) {
  const query: Record<string, unknown> = { surface: input.surface, ownerType: input.ownerType, ownerId: input.ownerId };
  if (input.endpoint) query.endpointHash = endpointHash(input.endpoint);
  await PushSubscription.updateMany(query, { $set: { status: "revoked" } }).exec();
}

async function sendWebPush(subscription: any, payload: PushPayload) {
  if (!configureVapid()) throw new Error("PUSH_NOT_CONFIGURED");
  await webpush.sendNotification({ endpoint: decrypt(subscription.endpoint), keys: { p256dh: decrypt(subscription.keys.p256dh), auth: decrypt(subscription.keys.auth) } }, JSON.stringify(payload), { TTL: 180, urgency: "high" });
}

async function sendFcmPush(subscription: any, payload: PushPayload, surface: PikiSurface) {
  const token = decrypt(subscription.fcmToken);
  await fcmMessaging().send({
    token,
    notification: { title: payload.title, body: payload.body },
    data: {
      url: payload.url,
      tag: payload.tag || "piki-order",
      surface,
      ...(payload.sound ? { sound: payload.sound } : {}),
      ...(payload.soundUrl ? { soundUrl: payload.soundUrl } : {}),
    },
    android: {
      priority: "high",
      notification: {
        channelId: payload.sound === "start_shift" ? "piki_shift_start" : "piki_orders",
        sound: payload.sound || "default",
        visibility: "public",
      },
    },
  });
}

/**
 * Clasifica un fallo de entrega para no confundir un token caducado con una
 * caída temporal del proveedor:
 * - invalid: el token ya no sirve y debe pedirse uno nuevo al abrir la app.
 * - failed: fallo transitorio, tiene sentido reintentar.
 * - config: credenciales o cifrado mal configurados en el servidor.
 */
export type PushFailureKind = "invalid" | "failed" | "config";

export function classifyPushFailure(error: any, provider: "webpush" | "fcm"): PushFailureKind {
  const message = String(error?.message || "");
  if (message === "FCM_NOT_CONFIGURED" || message === "PUSH_NOT_CONFIGURED" || message === "PUSH_CIPHERTEXT_INVALID") return "config";
  if (provider === "webpush") {
    const statusCode = Number(error?.statusCode || 0);
    if (statusCode === 404 || statusCode === 410) return "invalid";
    if (statusCode === 401 || statusCode === 403) return "config";
    return "failed";
  }
  const code = String(error?.code || "");
  if (code.includes("registration-token-not-registered")) return "invalid";
  if (code.includes("invalid-registration-token")) return "invalid";
  // El token tiene forma válida pero no fue emitido para estas credenciales
  // (otra app u otro proyecto Firebase). El dispositivo no está caducado: el
  // fallo es de configuración, así que no se marca la suscripción como expirada.
  if (code.includes("mismatched-credential") || code.includes("sender-id-mismatch")) return "config";
  // Argumento inválido en FCM: token corrupto o cuerpo mal formado.
  if (code === "messaging/invalid-argument") return "invalid";
  if (code.includes("authentication-error") || code.includes("third-party-auth-error")) return "config";
  return "failed";
}

export type PushDeliveryOutcome = {
  provider: "fcm" | "webpush";
  status: "delivered" | PushFailureKind;
  code?: string;
};

export type PushDeliveryReport = {
  attempted: number;
  delivered: number;
  failed: number;
  invalid: number;
  results: PushDeliveryOutcome[];
};


export async function sendPushToOwner(input: { surface: PikiSurface; ownerType: "customer" | "employee"; ownerId: string; tenantId?: string | null; payload: PushPayload }) {
  const subscriptions = await PushSubscription.find({ surface: input.surface, ownerType: input.ownerType, ownerId: input.ownerId, tenantId: input.tenantId || null, status: "active" }).select("+endpoint +keys.p256dh +keys.auth +fcmToken provider").exec();
  let delivered = 0;
  let failed = 0;
  let invalid = 0;
  const results: PushDeliveryOutcome[] = [];
  await Promise.all(subscriptions.map(async (subscription: any) => {
    const provider: "fcm" | "webpush" = subscription.provider === "fcm" ? "fcm" : "webpush";
    try {
      if (provider === "fcm") await sendFcmPush(subscription, input.payload, input.surface);
      else await sendWebPush(subscription, input.payload);
      delivered += 1;
      results.push({ provider, status: "delivered" });
      await PushSubscription.updateOne({ _id: subscription._id }, { $set: { lastSuccessAt: new Date(), failureCount: 0 } }).exec();
    } catch (error: any) {
      const kind = classifyPushFailure(error, provider);
      if (kind === "invalid") invalid += 1;
      else if (kind === "failed") failed += 1;
      results.push({
        provider,
        status: kind,
        ...(error?.code ? { code: String(error.code) } : error?.statusCode ? { code: String(error.statusCode) } : {}),
      });
      await PushSubscription.updateOne({ _id: subscription._id }, {
        $set: { status: kind === "invalid" ? "expired" : "active", lastFailureAt: new Date() },
        ...(kind === "config" ? {} : { $inc: { failureCount: 1 } }),
      }).exec();
      console.warn(`${provider === "fcm" ? "FCM" : "Web Push"} delivery failed`, { surface: input.surface, code: error?.code, statusCode: error?.statusCode });
    }
  }));
  return { attempted: subscriptions.length, delivered, failed, invalid, results };
}
