import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import webpush from "web-push";
import { PushSubscription } from "./models.js";
import type { PikiSurface } from "./appVersion.js";

type SubscriptionPayload = {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
};

type PushPayload = { title: string; body: string; url: string; tag?: string; renotify?: boolean };

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

export function pushConfigured(): boolean {
  return Boolean(vapid.subject && vapid.publicKey && vapid.privateKey && encryptionKey());
}

export function publicPushConfig() {
  return pushConfigured() ? { enabled: true, vapidPublicKey: vapid.publicKey } : { enabled: false };
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
        endpoint: encrypt(input.subscription.endpoint),
        endpointHash: hash,
        "keys.p256dh": encrypt(input.subscription.keys.p256dh),
        "keys.auth": encrypt(input.subscription.keys.auth),
        expirationTime: input.subscription.expirationTime ?? null,
        status: "active",
        failureCount: 0,
        lastFailureAt: null,
      },
      $setOnInsert: { surface: input.surface, ownerType: input.ownerType, ownerId: input.ownerId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).exec();
  return { id: String(saved._id), status: saved.status };
}

export async function revokePushSubscription(input: { surface: PikiSurface; ownerType: "customer" | "employee"; ownerId: string; endpoint?: string }) {
  const query: Record<string, unknown> = { surface: input.surface, ownerType: input.ownerType, ownerId: input.ownerId };
  if (input.endpoint) query.endpointHash = endpointHash(input.endpoint);
  await PushSubscription.updateMany(query, { $set: { status: "revoked" } }).exec();
}

export async function sendPushToOwner(input: { surface: PikiSurface; ownerType: "customer" | "employee"; ownerId: string; tenantId?: string | null; payload: PushPayload }) {
  if (!configureVapid()) return { attempted: 0, delivered: 0, failed: 0 };
  const subscriptions = await PushSubscription.find({ surface: input.surface, ownerType: input.ownerType, ownerId: input.ownerId, tenantId: input.tenantId || null, status: "active" }).select("+endpoint +keys.p256dh +keys.auth").exec();
  let delivered = 0;
  let failed = 0;
  await Promise.all(subscriptions.map(async (subscription: any) => {
    try {
      await webpush.sendNotification({ endpoint: decrypt(subscription.endpoint), keys: { p256dh: decrypt(subscription.keys.p256dh), auth: decrypt(subscription.keys.auth) } }, JSON.stringify(input.payload), { TTL: 180, urgency: "high" });
      delivered += 1;
      await PushSubscription.updateOne({ _id: subscription._id }, { $set: { lastSuccessAt: new Date(), failureCount: 0 } }).exec();
    } catch (error: any) {
      const statusCode = Number(error?.statusCode || 0);
      const terminal = statusCode === 404 || statusCode === 410;
      if (!terminal) failed += 1;
      await PushSubscription.updateOne({ _id: subscription._id }, {
        $set: { status: terminal ? "expired" : "active", lastFailureAt: new Date() },
        $inc: { failureCount: 1 },
      }).exec();
      console.warn("Web Push delivery failed", { surface: input.surface, statusCode: statusCode || undefined });
    }
  }));
  return { attempted: subscriptions.length, delivered, failed };
}
