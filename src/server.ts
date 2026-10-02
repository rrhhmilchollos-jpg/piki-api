import "dotenv/config";
import "express-async-errors";
import { createHash, createHmac, randomInt } from "node:crypto";
import { MalwareDetectedError, MalwareScannerUnavailableError, scanUploadBuffer } from "./fileSecurity.js";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { CashLedgerEntry, CustomerAccount, DispatchDecision, EmployeeAccount, AccessAuthorization, Fleet, Order, Restaurant, PartnerAsset, PartnerLocalityGroup, Rider, RiderApplication, PartnerLead, RiderLead, RiderIncident, RiderOrderMessage, RiderSlot, SignatureRequest, Zone, PushSubscription, RealtimeEvent, Tenant, TenantMembership, RiderAssignmentReservation, SupportTicket, OnboardingRequest, ensureIndexes } from "./models.js";
import { normalizeLeadEmail, partnerLeadSubmissionSchema, riderLeadSubmissionSchema, webLeadReviewSchema, webLeadStatusSchema } from "./webLeads.js";
import { assertTransition, calculateEtaRange, transitionSchema, validateCoordinates } from "./algorithms/index.js";
import { configuredAuthRoles, requireOwner, requireRole, resolveRole } from "./auth.js";
import { EmployeeSession, issueEmployeeSession, revokeEmployeeSessions, sessionRole } from "./employeeSessions.js";
import { processStripeWebhook, stripeConfigured, createSignaturitSignature, signaturitBaseUrl, signaturitConfigured, signaturitMode, signatureWebhookUrl, webhookDigest, handleCustomerTrpc, currentCustomer, setCustomerOrderDispatcher } from "./integrations/index.js";
import { getVersionPolicy, isPikiSurface, requiresUpdate, setVersionPolicy, syncVersionPolicy, versionPolicySchema, type PikiSurface } from "./appVersion.js";
import { publicPushConfig, revokePushSubscription, savePushSubscription } from "./push.js";
import { publishOrderStatusEvents, publishOrderIntakeEvents, publishRiderOfferEvent, publishRealtimeEvent, serveRealtimeEvents, startRealtimeRelay, tenantAudienceKey } from "./realtime.js";
import { listNotifications, markAllNotificationsRead, markNotificationRead, startNotificationWorker, stopNotificationWorker, type NotificationPrincipal } from "./notifications.js";
import { captureStripePaymentIntent, createCheckoutSession } from "./stripe.js";
import { rankDispatchCandidates, computeMobilityAdvice, calculateSanctionDecision, defaultSanctionPolicy } from "./algorithms/index.js";
import { createSessionToken, generateTemporaryPassword, hashPassword, hashSessionToken, verifyPassword } from "./employeeAuth.js";
import { evaluateXativaCoverage } from "./coverage/xativaPolicy.js";
import { quoteDeliveryRoute } from "./coverage/routing.js";
import { runTenantMigration } from "./tenantMigration.js";
import { activeOperationalOrderStatuses, dispatchableOrderStatuses, dispatchablePaymentFilter, isDispatchableOrderStatus } from "./dispatchEligibility.js";
import { canReceivePartnerLocations, partnerCan, partnerPermissions, partnerRolesForEmployee, permissionsForPartnerRoles, type PartnerPermission } from "./partnerAccess.js";
import { buildApprovedRiderOperationalProfile } from "./riderApproval.js";

export const app = express();
app.set("trust proxy", 1);
const port = Number(process.env.PORT || 3000);
const defaultOrigins = ["http://localhost:3000", "http://localhost:5173", "https://pikidelivery.com", "https://www.pikidelivery.com", "https://app.pikidelivery.com", "https://partners.pikidelivery.com", "https://admin.pikidelivery.com", "https://support.pikidelivery.com", "https://piki-admin-live.vercel.app", "https://piki-support.vercel.app", "https://riders.pikidelivery.com", "https://fleet.pikidelivery.com", "https://piki-customer.onrender.com", "https://piki-riders.onrender.com", "https://piki-admin.onrender.com", "https://edpexgfa.manus.space"];
const configuredOrigins = (process.env.CORS_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean);
const allowedOrigins = new Set([...defaultOrigins, ...configuredOrigins]);
const managedPikiVercelOrigin = /^https:\/\/piki-(?:customer|partner|admin|fleet|rider|support)(?:-[a-z0-9-]+)?-rrhhmilchollos-jpgs-projects\.vercel\.app$/i;
const isAllowedCorsOrigin = (origin?: string) => !origin || allowedOrigins.has(origin) || managedPikiVercelOrigin.test(origin);
const corsOptions = { origin: (origin: string | undefined, callback: (error: Error | null, allowed?: boolean) => void) => callback(null, isAllowedCorsOrigin(origin)), credentials: true };
const databaseName = process.env.MONGODB_DB || "piki";
let databaseReady = false;
mongoose.connection.on("connected", () => { databaseReady = true; startRealtimeRelay(); });
mongoose.connection.on("disconnected", () => { databaseReady = false; console.warn("MongoDB disconnected; API entering not-ready state"); });
mongoose.connection.on("error", (error) => { databaseReady = false; console.error("MongoDB connection error", error instanceof Error ? error.message : error); });

app.disable("x-powered-by");
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), payment=(self), usb=()");
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  next();
});
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

const requestBuckets = new Map<string, { startedAt: number; count: number }>();
let mongoRateLimitIndexReady = false;
async function incrementMongoRateLimit(key: string, windowMs: number): Promise<number | null> {
  if (!databaseReady || mongoose.connection.readyState !== 1) return null;
  try {
    const collection = mongoose.connection.collection("piki_rate_limit_buckets") as any;
    if (!mongoRateLimitIndexReady) {
      await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
      mongoRateLimitIndexReady = true;
    }
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const bucketId = `${key}:${windowStart}`;
    const expiresAt = new Date(windowStart + windowMs + 60_000);
    await collection.updateOne({ _id: bucketId }, { $inc: { count: 1 }, $set: { expiresAt } }, { upsert: true });
    const bucket = await collection.findOne({ _id: bucketId }, { projection: { count: 1 } });
    return Number(bucket?.count || 0);
  } catch (error) {
    if (!upstashWarningShown) console.warn("Mongo distributed rate limit unavailable; continuing with fallback", error instanceof Error ? error.message : error);
    return null;
  }
}
const upstashRedisUrl = String(process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const upstashRedisToken = String(process.env.UPSTASH_REDIS_REST_TOKEN || "");
let upstashWarningShown = false;
async function incrementDistributedRateLimit(key: string, windowMs: number): Promise<number | null> {
  if (!upstashRedisUrl || !upstashRedisToken) return null;
  try {
    const response = await fetch(`${upstashRedisUrl}/pipeline`, { method: "POST", headers: { Authorization: `Bearer ${upstashRedisToken}`, "Content-Type": "application/json" }, body: JSON.stringify([["INCR", key], ["PEXPIRE", key, String(windowMs), "NX"]]) });
    if (!response.ok) throw new Error(`Upstash HTTP ${response.status}`);
    const result = await response.json() as Array<{ result?: unknown; error?: string }>;
    if (result[0]?.error) throw new Error(result[0].error);
    const count = Number(result[0]?.result);
    if (!Number.isFinite(count)) throw new Error("Invalid Upstash counter response");
    return count;
  } catch (error) {
    if (!upstashWarningShown) { upstashWarningShown = true; console.warn("Distributed rate limit unavailable; using local fallback", error instanceof Error ? error.message : error); }
    return null;
  }
}
const rateLimit = (limit: number, windowMs: number, keyPrefix: string) => async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const surfaceKey = String(req.header("x-piki-surface") || req.query.surface || "-").toLowerCase();
  const clientIp = String(req.ip || "unknown").trim();
  const key = `piki:ratelimit:${keyPrefix}:${clientIp}:${req.path}:${surfaceKey}`;
  const distributedCount = await incrementDistributedRateLimit(key, windowMs);
  const sharedCount = distributedCount ?? await incrementMongoRateLimit(key, windowMs);
  const now = Date.now();
  const current = requestBuckets.get(key);
  const bucket = !current || now - current.startedAt >= windowMs ? { startedAt: now, count: 0 } : current;
  bucket.count += 1; requestBuckets.set(key, bucket);
  const count = sharedCount ?? bucket.count;
  if (count > limit) {
    const retryAfterSeconds = Math.ceil((windowMs - (now - bucket.startedAt)) / 1000);
    console.warn(`[RATE_LIMITED] ${JSON.stringify({ event: "rate_limit_exceeded", keyPrefix, method: req.method, path: req.path, surface: surfaceKey, limit, retryAfterSeconds, requestId: req.header("x-request-id") || null })}`);
    return res.status(429).json({ error: "RATE_LIMITED", retryAfterSeconds });
  }
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
  return next();
};
setInterval(() => { const cutoff = Date.now() - 15 * 60_000; for (const [key, bucket] of requestBuckets) if (bucket.startedAt < cutoff) requestBuckets.delete(key); }, 15 * 60_000).unref();
app.use("/api/v1/auth", rateLimit(3, 60_000, "auth"));
app.use("/api/v1/internal", rateLimit(10, 60_000, "internal-sync"));
app.use("/api/v1/partners/onboarding", rateLimit(10, 60_000, "partner-onboarding"));
app.use("/api/v1/riders/applications", rateLimit(10, 60_000, "rider-onboarding"));
app.use("/api/v1/public/partner-leads", rateLimit(10, 60_000, "partner-leads"));
app.use("/api/v1/public/rider-leads", rateLimit(10, 60_000, "rider-leads"));
app.use("/api/v1/partners/menu/assets", rateLimit(20, 60_000, "partner-assets"));
app.use("/api/v1/payments/webhook", rateLimit(100, 60_000, "stripe-webhook"));
app.use("/api/webhooks/stripe", rateLimit(100, 60_000, "stripe-webhook"));
const stripeWebhookHandler = async (req: express.Request, res: express.Response) => {
  const signature = req.header("stripe-signature");
  if (!signature || !stripeConfigured()) return res.status(503).json({ error: "STRIPE_WEBHOOK_NOT_CONFIGURED" });
  try {
    const result = await processStripeWebhook(req.body as Buffer, signature);
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    return res.status(400).json({ error: "INVALID_STRIPE_WEBHOOK", message: error instanceof Error ? error.message : "Webhook rejected" });
  }
};
app.post(["/api/v1/payments/webhook", "/api/webhooks/stripe"], express.raw({ type: "application/json" }), stripeWebhookHandler);
app.use(express.json({ limit: "12mb" }));

const objectId = (value: string) => mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;
function tenantScope(req: express.Request): Record<string, unknown> {
  if (!req.auth?.tenantId) return {};
  const tenantId = objectId(req.auth.tenantId);
  return tenantId ? { tenantId } : { _id: null };
}
async function tenantLimits(req: express.Request) {
  if (!req.auth?.tenantId) return { maxRiders: 100000, maxDailySlots: 100000, maxSlotsPerRiderPerDay: 3 };
  const tenantId = objectId(req.auth.tenantId);
  const tenant = tenantId ? await Tenant.findById(tenantId).select("settings").lean().exec() as any : null;
  return { maxRiders: Number(tenant?.settings?.limits?.maxRiders || 100000), maxDailySlots: Number(tenant?.settings?.limits?.maxDailySlots || 100000), maxSlotsPerRiderPerDay: Number(tenant?.settings?.limits?.maxSlotsPerRiderPerDay || 3) };
}
async function employeeScope(req: express.Request) {
  if (!req.auth?.employeeId) return null;
  return await EmployeeAccount.findOne({ _id: req.auth.employeeId, ...tenantScope(req) }).select("email fleetId zoneSlugs restaurantId portfolioId jobRole apiRole tenantId").lean().exec() as any;
}
async function fleetRiderFilter(req: express.Request): Promise<Record<string, unknown>> {
  if (req.auth?.role !== "fleet") return {};
  const employee = await employeeScope(req);
  // Newly enabled rider accounts start unassigned. Fleet must be able to see
  // those accounts so the first slot reservation can link them to this fleet.
  const realRiderFilter = { isTestRider: { $ne: true } };
  return employee?.fleetId
    ? { ...realRiderFilter, $or: [{ fleetId: employee.fleetId }, { fleetId: null }, { fleetId: { $exists: false } }] }
    : { ...realRiderFilter, $or: [{ fleetId: null }, { fleetId: { $exists: false } }] };
}
async function fleetCanAccessRider(req: express.Request, riderId: mongoose.Types.ObjectId | null) {
  if (!riderId) return false;
  if (req.auth?.role !== "fleet") return true;
  const employee = await employeeScope(req);
  return Boolean(employee?.fleetId && await Rider.exists({ _id: riderId, fleetId: employee.fleetId }));
}
const locationSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const orderItemSchema = z.object({ itemId: z.string().min(1), quantity: z.number().int().min(1).max(20) });
const createOrderSchema = z.object({ restaurantId: z.string().min(1), deliveryAddress: z.string().min(5).max(280), deliveryLocation: locationSchema, items: z.array(orderItemSchema).min(1).max(50), paymentMethod: z.string().optional().default("cash") });
const deliveryQrSecret = String(process.env.DELIVERY_QR_SECRET || "").trim();
if (process.env.NODE_ENV === "production" && !deliveryQrSecret) throw new Error("DELIVERY_QR_SECRET is required in production");
const deliveryQrSignature = (orderCode: string) => createHmac("sha256", deliveryQrSecret || "development-only-delivery-qr-secret").update(`delivery:${orderCode}`).digest("hex").slice(0, 24);
const deliveryPin = (orderCode: string) => deliveryQrSignature(orderCode).slice(-6).toUpperCase();
const deliveryQrUrl = (orderCode: string) => `${(process.env.CUSTOMER_APP_URL || "https://pikidelivery.com").replace(/\/$/, "")}/?order_id=${encodeURIComponent(orderCode)}&delivery_token=${deliveryQrSignature(orderCode)}`;
const checkoutTokenSecret = String(process.env.CHECKOUT_TOKEN_SECRET || deliveryQrSecret).trim();
const checkoutToken = (orderCode: string) => createHmac("sha256", checkoutTokenSecret || "development-only-checkout-secret").update(`checkout:${orderCode}`).digest("base64url");
const checkoutTokenIsValid = (orderCode: string, raw: unknown) => typeof raw === "string" && raw.length >= 20 && raw === checkoutToken(orderCode);
const deliveryQrIsValid = (orderCode: string, raw: unknown) => {
  if (String(raw || "").trim().toUpperCase() === deliveryPin(orderCode)) return true;
  try { const url = new URL(String(raw)); return url.searchParams.get("order_id") === orderCode && url.searchParams.get("delivery_token") === deliveryQrSignature(orderCode); } catch { return false; }
};
const pickupQrSecret = String(process.env.PICKUP_QR_SECRET || deliveryQrSecret).trim();
const pickupQrSignature = (orderCode: string) => createHmac("sha256", pickupQrSecret || "development-only-pickup-qr-secret").update(`pickup:${orderCode}`).digest("hex").slice(0, 24);
const pickupPinAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const pickupQrPin = (orderCode: string) => { const digest = createHmac("sha256", pickupQrSecret || "development-only-pickup-qr-secret").update(`pickup-pin:${orderCode}`).digest(); return Array.from({ length: 4 }, (_, index) => pickupPinAlphabet[digest[index] % pickupPinAlphabet.length]).join(""); };
const pickupQrUrl = (orderCode: string) => `${(process.env.PARTNER_APP_URL || "https://partners.pikidelivery.com").replace(/\/$/, "")}/?order_id=${encodeURIComponent(orderCode)}&pickup_token=${pickupQrSignature(orderCode)}`;
const pickupQrIsValid = (orderCode: string, raw: unknown) => {
  const value = String(raw || "").trim();
  if (!value) return false;
  if (value.toUpperCase() === pickupQrPin(orderCode)) return true;
  try { const url = new URL(value); return url.searchParams.get("order_id") === orderCode && url.searchParams.get("pickup_token") === pickupQrSignature(orderCode); } catch { return false; }
};
const riderLocationSchema = locationSchema.extend({ riderId: z.string().min(1) });
const zoneSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), serviceFeeCents: z.number().int().min(0).max(10000).default(0), maxEtaMinutes: z.number().int().min(1).max(240).default(60), polygon: z.object({ coordinates: z.array(z.array(z.array(z.number()))).min(1) }) });
const dispatchSchema = z.object({ preparationMinutes: z.coerce.number().int().min(1).max(180).default(15), offerSeconds: z.coerce.number().int().min(15).max(180).default(60), maxCustomerEtaMinutes: z.coerce.number().int().min(10).max(240).optional() });
const riderIncidentSchema = z.object({ reason: z.enum(["late_acceptance", "late_delivery", "no_show", "unsafe_driving", "fraud_signal", "customer_complaint", "document_expired", "other"]), evidence: z.array(z.string().url()).max(10).default([]), occurredAt: z.coerce.date().optional() });
const riderSlotSchema = z.object({ zoneSlug: z.string().regex(/^[a-z0-9-]+$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), endTime: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), status: z.enum(["planned", "active", "completed", "cancelled"]).default("planned"), notes: z.string().max(500).default("") });
const riderSlotCreateSchema = riderSlotSchema.extend({ riderId: z.string().regex(/^[a-f\d]{24}$/) });
const riderDocumentInputSchema = z.object({ type: z.enum(["identity", "residence_permit", "social_security_number", "bank_certificate", "driving_license", "insurance", "vehicle_registration", "vehicle_technical_sheet", "scooter_responsible_declaration", "dgt_mvp_homologation", "other"]), fileName: z.string().min(1).max(180), mimeType: z.string().min(1).max(120), sizeBytes: z.number().int().min(1).max(2_500_000), sha256: z.string().regex(/^[a-f0-9]{64}$/i), contentBase64: z.string().min(1).max(3_500_000) });
const riderApplicationSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), phone: z.string().min(6).max(40), city: z.string().min(2).max(120), vehicle: z.enum(["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"]), availability: z.string().min(2).max(160), socialSecurityNumber: z.string().min(4).max(40), identityVerificationMethod: z.literal("online_scan"), safetyDeclarationAccepted: z.literal(true), documents: z.array(riderDocumentInputSchema).min(3).max(12), website: z.string().max(0).optional() });
const riderApplicationAttempts = new Map<string, { count: number; resetAt: number }>();
const ownerEmail = "rrhh.milchollos@gmail.com";
const MAX_MENU_IMAGE_BYTES = 200 * 1024;
const MAX_MENU_FILE_BYTES = 4 * 1024 * 1024;
const MENU_IMAGE_MIME_TYPES = ["image/webp", "image/jpeg", "image/png", "image/gif"] as const;
const MENU_FILE_MIME_TYPES = ["application/pdf"] as const;
const MENU_ASSET_MIME_TYPES = [...MENU_IMAGE_MIME_TYPES, ...MENU_FILE_MIME_TYPES] as const;
const MENU_ASSET_KINDS = ["menu_image", "menu_file"] as const;
function localityKey(value: string) { return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "sin-localidad"; }
function organizationFolder(locality: string, restaurantId: string) { return `partners/${localityKey(locality)}/${restaurantId}/menu`; }
function publicAssetUrl(assetId: string) { return `${process.env.PUBLIC_API_URL || "https://api.pikidelivery.com"}/api/v1/catalog/assets/${assetId}`; }

async function nextRiderCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const riderCode = `PIKI-R-${randomInt(100000, 1000000)}`;
    if (!(await Rider.exists({ riderCode }))) return riderCode;
  }
  throw new Error("RIDER_CODE_CAPACITY_REACHED");
}

function allowRiderApplication(ip: string) {
  const now = Date.now(); const current = riderApplicationAttempts.get(ip);
  if (!current || current.resetAt <= now) { riderApplicationAttempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 }); return true; }
  if (current.count >= 5) return false; current.count += 1; return true;
}

async function createDailyDisplayCode() {
  const today = madridNow().date;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const displayCode = String(randomInt(100, 1000));
    if (!(await Order.exists({ displayCodeDate: today, displayCode }))) return { displayCode, displayCodeDate: today };
  }
  throw new Error("DAILY_ORDER_CODE_CAPACITY_REACHED");
}

async function dispatchLoadPolicy() {
  const [queuedOrders, activeRiders] = await Promise.all([
    Order.countDocuments({ riderId: null, ...dispatchablePaymentFilter, status: { $in: [...dispatchableOrderStatuses] } }),
    Rider.countDocuments({ status: { $in: ["available", "busy"] } }),
  ]);
  const saturated = queuedOrders >= Math.max(3, Math.ceil(Math.max(activeRiders, 1) * 1.5));
  return { maxConcurrentOrders: saturated ? 2 as const : 1 as const, saturated, queuedOrders, activeRiders };
}

async function activeOrderCounts(riderIds: mongoose.Types.ObjectId[]) {
  const rows = await Order.aggregate([{ $match: { riderId: { $in: riderIds }, status: { $nin: ["delivered", "cancelled"] }, assignmentState: { $in: ["offered", "assigned"] } } }, { $group: { _id: "$riderId", count: { $sum: 1 } } }]);
  return new Map(rows.map((row: any) => [String(row._id), Number(row.count)]));
}

const MAX_RIDER_ACTIVE_ORDERS = 2;
async function reserveRiderOrderSlot(riderId: mongoose.Types.ObjectId, orderId: mongoose.Types.ObjectId, tenantFilter: Record<string, unknown>, maxOrders = 1) {
  const reserved = await RiderAssignmentReservation.countDocuments({ ...tenantFilter, riderId, status: "reserved" });
  if (reserved >= Math.min(MAX_RIDER_ACTIVE_ORDERS, maxOrders)) return null;
  const slot = reserved + 1;
  try {
    const reservation = await RiderAssignmentReservation.create({ ...tenantFilter, riderId, orderId, slot, mode: reserved ? "saturated" : "normal", status: "reserved", expiresAt: new Date(Date.now() + 180_000) });
    const rider = await Rider.findOneAndUpdate({ ...tenantFilter, _id: riderId, status: { $in: ["available", "busy"] }, ...(reserved === 0 ? { activeOrderId: null } : {}) }, { $set: { status: "busy", ...(reserved === 0 ? { activeOrderId: orderId } : {}) } }, { new: true }).lean().exec() as any;
    if (!rider) { await RiderAssignmentReservation.updateOne({ _id: reservation._id }, { $set: { status: "released" } }).exec(); return null; }
    return { rider, reservation };
  } catch (error: any) {
    if (error?.code === 11000) return null;
    throw error;
  }
}
async function releaseRiderOrderSlot(orderId: mongoose.Types.ObjectId, riderId: mongoose.Types.ObjectId) {
  await RiderAssignmentReservation.updateOne({ orderId, riderId, status: "reserved" }, { $set: { status: "released" } }).exec();
  const remaining = await RiderAssignmentReservation.countDocuments({ riderId, status: "reserved" });
  await Rider.updateOne({ _id: riderId }, remaining ? { $set: { status: "busy" } } : { $set: { status: "available", activeOrderId: null } }).exec();
}

const pikiSplashPath = fileURLToPath(new URL("./assets/piki-splash.webp", import.meta.url));
const pikiFaviconPath = fileURLToPath(new URL("./assets/piki-favicon.webp", import.meta.url));
const sendPikiAsset = (path: string, res: express.Response) => res.type("webp").sendFile(path);
app.get("/piki-splash.webp", (_req, res) => sendPikiAsset(pikiSplashPath, res));
app.get("/favicon.webp", (_req, res) => sendPikiAsset(pikiFaviconPath, res));
app.get("/favicon.ico", (_req, res) => sendPikiAsset(pikiFaviconPath, res));
app.get("/", (_req, res) => {
  res.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  res.type("html").send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="application-name" content="Pikidelivery.com"><link rel="icon" type="image/webp" href="/favicon.webp"><title>PIKI Delivery API</title><style>html,body{margin:0;min-height:100%;background:#ffd72e;font-family:Arial,sans-serif;color:#172238}body{display:grid;place-items:center;min-height:100dvh;overflow:hidden}.splash{text-align:center}.splash img{display:block;width:min(92vw,930px);height:min(74dvh,620px);object-fit:contain}.splash strong{display:block;font-size:clamp(18px,3vw,28px);letter-spacing:.12em;text-transform:uppercase}.api{display:none;margin-top:1rem;font-size:14px}.api a{color:#172238;font-weight:700}</style></head><body><main class="splash" role="status" aria-label="PIKI Delivery API"><img src="/piki-splash.webp" alt="PIKI Delivery"><strong>Pikidelivery.com</strong><p class="api">API activa · <a href="/health">comprobar estado</a></p></main><script>window.setTimeout(()=>{document.querySelector('.api').style.display='block'},5000)</script></body></html>`);
});
app.get("/health", (_req, res) => res.json({ service: "piki-api", status: "ok" }));
app.get("/ready", (_req, res) => {
  if (!databaseReady || mongoose.connection.readyState !== 1) return res.status(503).json({ service: "piki-api", status: "not_ready" });
  return res.json({ service: "piki-api", status: "ready" });
});
app.get("/api/v1", (_req, res) => res.json({ name: "PIKI API", status: databaseReady ? "ready" : "initializing" }));
const releasePolicyToken = process.env.PIKI_RELEASE_POLICY_TOKEN || "";
const pushSubscriptionSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().refine((value) => value.startsWith("https://")),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(16).max(1000), auth: z.string().min(8).max(1000) }).strict(),
  }).strict(),
}).strict();
const employeeSurfaceRoles: Record<Exclude<PikiSurface, "customer">, string[]> = {
  partner: ["partner"], fleet: ["fleet", "commercial", "gerente_comercial_zona"], admin: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona"], rider: ["rider"],
};
function requestedSurface(req: express.Request): PikiSurface | null {
  const value = String(req.header("x-piki-surface") || req.query.surface || "").toLowerCase();
  return isPikiSurface(value) ? value : null;
}
async function currentNotificationPrincipal(req: express.Request): Promise<NotificationPrincipal | null> {
  const surface = requestedSurface(req);
  if (!surface) return null;
  if (surface === "customer") {
    const customer = await currentCustomer(req) as any;
    return customer ? { surface, ownerType: "customer", ownerId: String(customer._id), tenantId: customer.tenantId ? String(customer.tenantId) : null } : null;
  }
  const auth = await resolveRole(req);
  if (!auth?.employeeId || !employeeSurfaceRoles[surface].includes(auth.role)) return null;
  const employee = await EmployeeAccount.findById(auth.employeeId).select("_id tenantId active").lean().exec() as any;
  if (!employee || employee.active === false) return null;
  return { surface, ownerType: "employee", ownerId: String(employee._id), tenantId: employee.tenantId ? String(employee.tenantId) : null };
}
function scheduleCustomerOrderPush(order: any, status: string) {
  void publishOrderStatusEvents(order, status).catch((error) => console.warn("Realtime order status event failed", error instanceof Error ? error.message : error));
}

app.get("/api/v1/app-version", async (req, res) => {
  const surface = requestedSurface(req);
  if (!surface) return res.status(400).json({ error: "INVALID_SURFACE" });
  const policy = await syncVersionPolicy(surface);
  const clientVersion = typeof req.query.clientVersion === "string" ? req.query.clientVersion : undefined;
  const clientBuildId = typeof req.query.clientBuildId === "string" ? req.query.clientBuildId : undefined;
  // The 0.2.1 Customer PWA did not send clientVersion and used a faulty literal
  // comparison: it blocked whenever minimumVersion was *not exactly* "0.2.1".
  // Return that legacy sentinel only for its unversioned request so it can boot,
  // register the recovery worker, and receive the current network shell. All
  // versioned clients continue to receive the real, semver-based policy.
  const responsePolicy = clientVersion
    ? policy
    : surface === "customer"
      ? { ...policy, minimumVersion: "0.2.1", forceUpdate: false }
      : { ...policy, minimumVersion: "0.0.0", forceUpdate: false };
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json({ surface, ...responsePolicy, updateRequired: requiresUpdate(responsePolicy, clientVersion, clientBuildId, surface) });
});
app.post("/api/v1/app-version/policy", rateLimit(20, 60_000, "release-policy"), (req, res) => {
  const expected = releasePolicyToken;
  if (!expected || req.header("authorization") !== `Bearer ${expected}`) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  const surface = typeof req.body?.surface === "string" ? req.body.surface.toLowerCase() : "";
  if (!isPikiSurface(surface)) return res.status(400).json({ error: "INVALID_SURFACE" });
  const { surface: _surface, ...policyInput } = req.body || {};
  const parsed = versionPolicySchema.safeParse(policyInput);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RELEASE_POLICY" });
  const policy = setVersionPolicy(surface, parsed.data);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json({ surface, ...policy });
});
app.use("/api/v1", async (req, res, next) => {
  if (req.path === "/app-version" || req.path === "/app-version/policy" || req.path === "/push/config") return next();
  const surface = requestedSurface(req);
  const clientVersion = req.header("x-piki-client-version") || undefined;
  const clientBuildId = req.header("x-piki-client-build") || undefined;
  if (surface && clientVersion) {
    const policy = await syncVersionPolicy(surface);
    if (requiresUpdate(policy, clientVersion, clientBuildId, surface)) {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      return res.status(426).json({ error: "CLIENT_UPDATE_REQUIRED", surface, ...policy });
    }
  }
  return next();
});
app.get("/api/v1/push/config", (_req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json(publicPushConfig());
});
app.post("/api/v1/push/subscriptions", rateLimit(20, 60_000, "push-subscribe"), async (req, res) => {
  const surface = requestedSurface(req);
  const parsed = pushSubscriptionSchema.safeParse(req.body);
  if (!surface) return res.status(400).json({ error: "INVALID_SURFACE" });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PUSH_SUBSCRIPTION" });
  try {
    if (surface === "customer") {
      const customer = await currentCustomer(req) as any;
      if (!customer) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
      return res.status(201).json(await savePushSubscription({ surface, ownerType: "customer", ownerId: String(customer._id), tenantId: customer.tenantId ? String(customer.tenantId) : null, subscription: parsed.data.subscription }));
    }
    const auth = await resolveRole(req);
    if (!auth?.employeeId || !employeeSurfaceRoles[surface].includes(auth.role)) return res.status(403).json({ error: "FORBIDDEN" });
    const employee = await EmployeeAccount.findById(auth.employeeId).select("tenantId").lean().exec() as any;
    return res.status(201).json(await savePushSubscription({ surface, ownerType: "employee", ownerId: auth.employeeId, tenantId: employee?.tenantId ? String(employee.tenantId) : null, subscription: parsed.data.subscription }));
  } catch (error) {
    return res.status(503).json({ error: error instanceof Error && error.message === "PUSH_NOT_CONFIGURED" ? "PUSH_NOT_CONFIGURED" : "PUSH_SUBSCRIPTION_FAILED" });
  }
});
app.delete("/api/v1/push/subscriptions", rateLimit(20, 60_000, "push-unsubscribe"), async (req, res) => {
  const surface = requestedSurface(req);
  const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : undefined;
  if (!surface) return res.status(400).json({ error: "INVALID_SURFACE" });
  if (surface === "customer") {
    const customer = await currentCustomer(req) as any;
    if (!customer) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
    await revokePushSubscription({ surface, ownerType: "customer", ownerId: String(customer._id), endpoint });
  } else {
    const auth = await resolveRole(req);
    if (!auth?.employeeId || !employeeSurfaceRoles[surface].includes(auth.role)) return res.status(403).json({ error: "FORBIDDEN" });
    await revokePushSubscription({ surface, ownerType: "employee", ownerId: auth.employeeId, endpoint });
  }
  return res.status(204).end();
});
app.get("/api/v1/notifications", rateLimit(90, 60_000, "notifications-list"), async (req, res) => {
  const surface = requestedSurface(req);
  if (!surface) return res.status(400).json({ error: "INVALID_SURFACE" });
  const principal = await currentNotificationPrincipal(req);
  if (!principal) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  const limit = Math.max(1, Math.min(50, Number.parseInt(String(req.query.limit || "20"), 10) || 20));
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : undefined;
  if (cursor && !objectId(cursor)) return res.status(400).json({ error: "INVALID_CURSOR" });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.json(await listNotifications(principal, { limit, cursor }));
});
app.patch("/api/v1/notifications/read-all", rateLimit(30, 60_000, "notifications-read"), async (req, res) => {
  if (!requestedSurface(req)) return res.status(400).json({ error: "INVALID_SURFACE" });
  const principal = await currentNotificationPrincipal(req);
  if (!principal) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  return res.json({ updated: await markAllNotificationsRead(principal) });
});
app.patch("/api/v1/notifications/:id/read", rateLimit(60, 60_000, "notifications-read"), async (req, res) => {
  if (!requestedSurface(req)) return res.status(400).json({ error: "INVALID_SURFACE" });
  const principal = await currentNotificationPrincipal(req);
  if (!principal) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!objectId(id)) return res.status(400).json({ error: "INVALID_NOTIFICATION_ID" });
  if (!await markNotificationRead(principal, id)) return res.status(404).json({ error: "NOTIFICATION_NOT_FOUND" });
  return res.json({ updated: true });
});
app.get("/api/v1/realtime/events", serveRealtimeEvents);
app.use("/api/trpc/auth.login", rateLimit(3, 60_000, "customer-auth"));
app.all("/api/trpc/:procedure", handleCustomerTrpc);

app.get("/api/v1/auth/status", (_req, res) => res.json({ authentication: "bearer" }));
const employeeSessionRoles = ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"] as const;
const partnerOperationalRoles = ["partner_admin", "area_manager", "zone_manager", "store_manager", "manager", "cashier", "cajero", "kitchen", "cocina", "cook", "catalog", "catalogue", "menu_manager", "viewer", "read_only", "solo_lectura"] as const;
const employeeLoginSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(200), role: z.enum(employeeSessionRoles).optional() });
app.post("/api/v1/auth/employee/login", async (req, res) => {
  const parsed = employeeLoginSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_LOGIN" });
  if (String(req.headers["x-piki-surface"] || "").toLowerCase() === "admin" && parsed.data.email.toLowerCase() !== ownerEmail) { /* subadmins are allowed; destructive operations remain superadmin-only */ }
  const employee = await EmployeeAccount.findOne({ email: parsed.data.email.toLowerCase() }).select("+passwordHash").exec() as any;
  if (!employee || !verifyPassword(parsed.data.password, employee.passwordHash)) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  if (!employee.active || (employee.authorizationStatus && employee.authorizationStatus !== "approved")) {
    const isPartner = employee.apiRole === "partner";
    return res.status(403).json({ error: isPartner ? "PARTNER_PENDING_APPROVAL" : "ACCOUNT_NOT_ACTIVE", message: isPartner ? "Tu solicitud está pendiente de revisión por Administración. Podrás iniciar sesión cuando se aprueben el comercio y la documentación." : "Esta cuenta no está activa." });
  }
  const surface = String(req.headers["x-piki-surface"] || "").toLowerCase();
  const requestedRole = parsed.data.role;
  const role = sessionRole(employee, surface, requestedRole);
  if (!role) return res.status(403).json({ error: "SURFACE_ROLE_MISMATCH", message: "Esta cuenta no tiene acceso a esta aplicación." });
  const issued = await issueEmployeeSession(employee, surface, requestedRole);
  if (!issued) return res.status(403).json({ error: "SURFACE_ROLE_MISMATCH" });
  return res.json({ accessToken: issued.token, requiresPasswordChange: Boolean(employee.mustChangePassword), employee: { id: employee.id, name: employee.name, email: employee.email, jobRole: role === "rider" ? "rider" : employee.jobRole, roles: employee.roles?.length ? employee.roles : [employee.apiRole], primaryRole: employee.primaryRole || employee.apiRole, apiRole: issued.role, accessLevel: employee.accessLevel || (employee.email === ownerEmail ? "superadmin" : "subadmin"), authorizationStatus: employee.authorizationStatus || "approved", portfolioId: employee.portfolioId, fleetId: employee.fleetId, zoneSlugs: employee.zoneSlugs } });
});
app.post("/api/v1/auth/employee/switch-role", requireRole("admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"), async (req, res) => {
  const parsed = z.object({ role: z.enum(employeeSessionRoles) }).safeParse(req.body);
  const requestedRole = parsed.success ? parsed.data.role : "";
  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("email apiRole roles primaryRole ownerProtected authorizationStatus").lean().exec() as any : null;
  if (!employee || !requestedRole) return res.status(400).json({ error: "INVALID_ROLE" });
  const surface = String(req.headers["x-piki-surface"] || "admin").toLowerCase();
  const issued = await issueEmployeeSession(employee, surface, requestedRole);
  if (!issued) return res.status(403).json({ error: "ROLE_NOT_ALLOWED" });
  const oldToken = String(req.headers.authorization || "").replace(/^Bearer /i, "").trim();
  if (oldToken) await EmployeeSession.deleteOne({ tokenHash: hashSessionToken(oldToken) }).exec();
  return res.json({ accessToken: issued.token, role: issued.role, roles: employee.roles?.length ? employee.roles : [employee.apiRole] });
});
app.post("/api/v1/auth/employee/logout", requireRole("admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"), async (req, res) => {
  const token = String(req.headers.authorization || "").replace(/^Bearer /i, "").trim();
  if (token) await EmployeeSession.deleteOne({ tokenHash: hashSessionToken(token) }).exec();
  return res.status(204).end();
});
app.get("/api/v1/auth/employee/me", requireRole("admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"), async (req, res) => {
  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("name email ownerProtected accessLevel authorizationStatus jobRole apiRole roles partnerRoles primaryRole zoneSlugs restaurantId restaurantIds").lean().exec() as any : null;
  const roles = partnerRolesForEmployee(employee);
  const permissions = [...permissionsForPartnerRoles(roles)];
  const locations = employee ? await partnerLocationsFor(employee, roles, permissions) : [];
  return res.json({ employee: { id: req.auth?.employeeId, name: employee?.name || null, email: employee?.email || null, role: req.auth?.role, accessLevel: employee?.accessLevel || "subadmin", authorizationStatus: employee?.authorizationStatus || "approved", ownerProtected: Boolean(employee?.ownerProtected), jobRole: employee?.jobRole || null, apiRole: employee?.apiRole || req.auth?.role || null, roles, permissions, primaryRole: employee?.primaryRole || employee?.apiRole || req.auth?.role, zoneSlugs: employee?.zoneSlugs || [], locations, mustChangePassword: Boolean(req.auth?.mustChangePassword) } });
});
app.post("/api/v1/auth/employee/change-password", requireRole("admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"), async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().min(8), newPassword: z.string().min(12).max(200).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/) }).safeParse(req.body);
  if (!parsed.success || !req.auth?.employeeId) return res.status(400).json({ error: "INVALID_PASSWORD_CHANGE", message: "La contraseña debe tener 12 caracteres, mayúscula, minúscula y número." });
  const employee = await EmployeeAccount.findById(req.auth.employeeId).select("+passwordHash").exec() as any;
  if (!employee || !verifyPassword(parsed.data.currentPassword, employee.passwordHash)) return res.status(401).json({ error: "INVALID_CURRENT_PASSWORD" });
  employee.passwordHash = hashPassword(parsed.data.newPassword); employee.mustChangePassword = false; employee.passwordChangedAt = new Date(); employee.sessionHash = null; await employee.save();
  // Keep the current session for the completed mandatory-password gate; revoke others.
  const tokenHash = hashSessionToken(String(req.headers.authorization || "").replace(/^Bearer /i, ""));
  await EmployeeSession.deleteMany({ employeeId: employee._id, tokenHash: { $ne: tokenHash } }).exec();
  await EmployeeSession.updateOne({ tokenHash }, { $set: { issuedAt: employee.passwordChangedAt } }).exec();
  return res.json({ changed: true });
});
const employeeCreateSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), jobRole: z.enum(["admin", "partner", "rider", "fleet", "zone_manager", "commercial", "gerente_comercial_zona", "finance", "support"]), roles: z.array(z.enum(["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"])).min(1).max(8).optional(), primaryRole: z.enum(["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"]).optional(), apiRole: z.enum(["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"]).optional(), restaurantId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional(), fleetId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional(), zoneSlugs: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(100).default([]) });
app.post("/api/v1/admin/employees", requireOwner(), async (req, res) => {
  const parsed = employeeCreateSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_EMPLOYEE", details: parsed.error.flatten() });
  const apiRole = parsed.data.apiRole || (parsed.data.jobRole === "gerente_comercial_zona" ? "gerente_comercial_zona" : parsed.data.jobRole === "commercial" ? "commercial" : parsed.data.jobRole === "zone_manager" ? "fleet" : parsed.data.jobRole);
  const roles = parsed.data.roles?.length ? parsed.data.roles : [apiRole];
  const primaryRole = parsed.data.primaryRole || roles[0];
  const temporaryPassword = generateTemporaryPassword();
  try {
    const employee = await EmployeeAccount.create({ ...parsed.data, roles, primaryRole, accessLevel: "subadmin", authorizationStatus: "approved", authorizedAt: new Date(), authorizedBy: req.auth?.employeeId ? objectId(req.auth.employeeId) : null, restaurantId: parsed.data.restaurantId ? objectId(parsed.data.restaurantId) : null, fleetId: parsed.data.fleetId ? objectId(parsed.data.fleetId) : null, apiRole, passwordHash: hashPassword(temporaryPassword), mustChangePassword: true, active: true });
    await AccessAuthorization.create({ employeeId: employee._id, action: "created", previousStatus: null, nextStatus: "approved", previousRole: null, nextRole: apiRole, accessLevel: "subadmin", actorEmployeeId: objectId(req.auth!.employeeId!), reason: "Cuenta creada y autorizada por RRHH superadmin." });
    return res.status(201).json({ employee: { id: employee.id, name: employee.name, email: employee.email, jobRole: employee.jobRole, apiRole: employee.apiRole, roles: employee.roles?.length ? employee.roles : [employee.apiRole], primaryRole: employee.primaryRole || employee.apiRole, portfolioId: employee.portfolioId, fleetId: employee.fleetId, zoneSlugs: employee.zoneSlugs, active: employee.active }, temporaryPassword, warning: "Mostrar esta contraseña una sola vez y entregarla por un canal seguro." });
  } catch (error) { if ((error as any)?.code === 11000) return res.status(409).json({ error: "EMPLOYEE_EMAIL_ALREADY_EXISTS" }); throw error; }
});
const onboardingRequestSchema = z.object({
  requestType: z.enum(["partner", "fleet", "rider"]),
  payload: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0, "payload_required"),
});
app.post("/api/v1/employee/onboarding-requests", requireRole("gerente_comercial_zona", "commercial"), async (req, res) => {
  const parsed = onboardingRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_ONBOARDING_REQUEST", details: parsed.error.flatten() });
  const employee = await employeeScope(req);
  if (!employee?.jobRole || !["gerente_comercial_zona", "commercial", "zone_manager"].includes(employee.jobRole)) return res.status(403).json({ error: "ROLE_SCOPE_REQUIRED" });
  const zoneSlugs = Array.isArray(employee.zoneSlugs) ? employee.zoneSlugs : [];
  if (!zoneSlugs.includes("valencia")) return res.status(403).json({ error: "ZONE_SCOPE_REQUIRED", requiredZone: "valencia" });
  const request = await OnboardingRequest.create({ ...tenantScope(req), requestedBy: employee._id, requestType: parsed.data.requestType, payload: parsed.data.payload, zoneSlugs, status: "pending" });
  return res.status(201).json({ request: { id: request.id, requestType: request.requestType, status: request.status, zoneSlugs: request.zoneSlugs, createdAt: request.createdAt }, message: "Solicitud enviada al superadmin para aprobación." });
});
app.get("/api/v1/employee/onboarding-requests", requireRole("gerente_comercial_zona", "commercial"), async (req, res) => {
  const requests = await OnboardingRequest.find({ ...tenantScope(req), requestedBy: req.auth?.employeeId }).sort({ createdAt: -1 }).limit(100).lean().exec();
  return res.json({ requests });
});
app.get("/api/v1/admin/onboarding-requests", requireRole("admin"), async (req, res) => {
  const requests = await OnboardingRequest.find(tenantScope(req)).sort({ createdAt: -1 }).limit(200).populate("requestedBy", "name email jobRole zoneSlugs").lean().exec();
  return res.json({ requests });
});
app.patch("/api/v1/admin/onboarding-requests/:id", requireOwner(), async (req, res) => {
  const parsed = z.object({ status: z.enum(["approved", "rejected"]), reason: z.string().trim().max(500).default("") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_ONBOARDING_REVIEW", details: parsed.error.flatten() });
  const rawRequestId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(rawRequestId); if (!id) return res.status(400).json({ error: "INVALID_REQUEST_ID" });
  const request = await OnboardingRequest.findOneAndUpdate({ _id: id, ...tenantScope(req), status: "pending" }, { $set: { status: parsed.data.status, reviewedBy: objectId(String(req.auth?.employeeId || "")), reviewedAt: new Date(), reviewReason: parsed.data.reason } }, { new: true }).lean().exec() as any;
  if (!request) return res.status(404).json({ error: "ONBOARDING_REQUEST_NOT_FOUND_OR_REVIEWED" });
  await AccessAuthorization.create({ employeeId: request.requestedBy, action: parsed.data.status === "approved" ? "approved" : "revoked", previousStatus: "pending", nextStatus: parsed.data.status, previousRole: "gerente_comercial_zona", nextRole: request.requestType, accessLevel: "superadmin", actorEmployeeId: objectId(String(req.auth?.employeeId || "")), reason: `Solicitud de alta ${request.requestType}: ${parsed.data.reason}` });
  return res.json({ request, message: parsed.data.status === "approved" ? "Solicitud aprobada; queda pendiente de ejecución operativa." : "Solicitud rechazada." });
});
app.get("/api/v1/admin/tenants", requireOwner(), async (_req, res) => {
  const tenants = await Tenant.find({}).sort({ createdAt: -1 }).lean().exec();
  return res.json({ tenants });
});
app.post("/api/v1/admin/tenants", requireOwner(), async (req, res) => {
  const parsed = z.object({ slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/), name: z.string().min(2).max(120), limits: z.object({ maxRiders: z.number().int().min(1).max(1_000_000).optional(), maxDailySlots: z.number().int().min(1).max(1_000_000).optional(), maxSlotsPerRiderPerDay: z.number().int().min(1).max(24).optional() }).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_TENANT", details: parsed.error.flatten() });
  try {
    const tenant = await Tenant.create({ slug: parsed.data.slug, name: parsed.data.name, settings: { limits: { maxRiders: parsed.data.limits?.maxRiders || 100000, maxDailySlots: parsed.data.limits?.maxDailySlots || 100000, maxSlotsPerRiderPerDay: parsed.data.limits?.maxSlotsPerRiderPerDay || 3 } } });
    if (req.auth?.employeeId) await TenantMembership.create({ tenantId: tenant._id, employeeId: req.auth.employeeId, role: "owner", status: "active", scopes: ["*"] });
    return res.status(201).json({ tenant });
  } catch (error: any) {
    if (error?.code === 11000) return res.status(409).json({ error: "TENANT_SLUG_ALREADY_EXISTS" });
    throw error;
  }
});
app.post("/api/v1/admin/tenants/:id/memberships", requireOwner(), async (req, res) => {
  const tenantId = objectId(String(req.params.id));
  const employeeId = objectId(String(req.body?.employeeId || ""));
  const role = z.enum(["owner", "admin", "partner", "rider", "fleet", "zone_manager", "commercial"]).safeParse(req.body?.role);
  if (!tenantId || !employeeId || !role.success) return res.status(400).json({ error: "INVALID_TENANT_MEMBERSHIP" });
  const tenant = await Tenant.findOne({ _id: tenantId, status: "active" }).lean().exec();
  const employee = await EmployeeAccount.findById(employeeId).select("_id").lean().exec();
  if (!tenant || !employee) return res.status(404).json({ error: "TENANT_OR_EMPLOYEE_NOT_FOUND" });
  const membership = await TenantMembership.findOneAndUpdate({ tenantId, employeeId }, { $set: { role: role.data, status: "active" }, $setOnInsert: { scopes: [] } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec();
  await EmployeeAccount.updateOne({ _id: employeeId }, { $set: { tenantId } }).exec();
  return res.status(201).json({ membership });
});
app.get("/api/v1/admin/employees", requireRole("admin"), async (_req, res) => res.json({ employees: await EmployeeAccount.find({ email: { $ne: ownerEmail }, hiddenFromAdmin: { $ne: true } }).select("name email jobRole apiRole roles primaryRole accessLevel authorizationStatus authorizedAt authorizedBy authorizationReason portfolioId fleetId zoneSlugs active mustChangePassword lastLoginAt createdAt").sort({ createdAt: -1 }).lean().exec() }));
app.get("/api/v1/admin/authorization-audit", requireOwner(), async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email.toLowerCase() : undefined;
  const employee = email ? await EmployeeAccount.findOne({ email }).select("_id name email jobRole apiRole accessLevel authorizationStatus authorizedAt authorizedBy authorizationReason active").lean().exec() as any : null;
  if (email && !employee) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" });
  const filter = employee ? { employeeId: employee._id } : {};
  const events = await AccessAuthorization.find(filter).select("employeeId action previousStatus nextStatus previousRole nextRole accessLevel actorEmployeeId reason createdAt").sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ employee, events });
});
app.get("/api/v1/admin/customers", requireRole("admin"), async (_req, res) => res.json({ customers: await CustomerAccount.find({}).select("name email lastSignedIn createdAt updatedAt").sort({ createdAt: -1 }).limit(1000).lean().exec() }));
app.post("/api/v1/admin/employees/:id/reset-password", requireOwner(), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_EMPLOYEE_ID" });
  const parsed = z.object({ newPassword: z.string().min(12).max(200).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RESET_PASSWORD", message: "La contraseña debe tener 12 caracteres, mayúscula, minúscula y número." });
  const target = await EmployeeAccount.findById(id).select("email ownerProtected").lean().exec() as any;
  if (!target) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" });
  if (target.ownerProtected || target.email === ownerEmail) return res.status(403).json({ error: "OWNER_ACCOUNT_PROTECTED" });
  const employee = await EmployeeAccount.findByIdAndUpdate(id, { $set: { passwordHash: hashPassword(parsed.data.newPassword), mustChangePassword: true, passwordChangedAt: new Date(), sessionHash: null, active: true } }, { new: true }).select("name email jobRole apiRole active mustChangePassword").lean().exec();
  await revokeEmployeeSessions(id);
  return res.json({ employee, reset: true });
});
app.patch("/api/v1/admin/employees/:id/authorization", requireOwner(), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id); if (!id) return res.status(400).json({ error: "INVALID_EMPLOYEE_ID" });
  const parsed = z.object({
    status: z.enum(["approved", "suspended", "revoked"]),
    apiRole: z.enum(employeeSessionRoles).optional(),
    jobRole: z.enum(["admin", "partner", "rider", "fleet", "zone_manager", "commercial", "gerente_comercial_zona", "finance", "support"]).optional(),
    roles: z.array(z.enum(employeeSessionRoles)).min(1).max(8).optional(),
    primaryRole: z.enum(employeeSessionRoles).optional(),
    partnerRoles: z.array(z.enum(partnerOperationalRoles)).min(1).max(10).optional(),
    restaurantIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(100).optional(),
    fleetId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional(),
    zoneSlugs: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(100).optional(),
    reason: z.string().max(500).default(""),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_AUTHORIZATION", details: parsed.error.flatten() });
  const target = await EmployeeAccount.findById(id).select("email ownerProtected jobRole apiRole roles primaryRole partnerRoles restaurantId restaurantIds accessLevel authorizationStatus").lean().exec() as any;
  if (!target) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" });
  if (target.ownerProtected || target.email === ownerEmail) return res.status(403).json({ error: "OWNER_ACCOUNT_PROTECTED" });
  const effectiveRoles = parsed.data.roles || (target.roles?.length ? target.roles : [parsed.data.apiRole || target.apiRole]);
  const effectivePrimaryRole = parsed.data.primaryRole || target.primaryRole || effectiveRoles[0];
  if (!effectiveRoles.includes(effectivePrimaryRole)) return res.status(400).json({ error: "PRIMARY_ROLE_NOT_ASSIGNED" });
  const update: Record<string, unknown> = { authorizationStatus: parsed.data.status, active: parsed.data.status === "approved", authorizedAt: parsed.data.status === "approved" ? new Date() : null, authorizedBy: objectId(req.auth!.employeeId!), authorizationReason: parsed.data.reason };
  if (parsed.data.apiRole) update.apiRole = parsed.data.apiRole;
  if (parsed.data.jobRole) update.jobRole = parsed.data.jobRole;
  if (parsed.data.roles) update.roles = parsed.data.roles;
  if (parsed.data.primaryRole) update.primaryRole = parsed.data.primaryRole;
  if (parsed.data.partnerRoles) update.partnerRoles = parsed.data.partnerRoles;
  if (parsed.data.restaurantIds) {
    const restaurantIds = [...new Set(parsed.data.restaurantIds)];
    const approvedCount = await Restaurant.countDocuments({ _id: { $in: restaurantIds.map((restaurantId) => objectId(restaurantId)) }, onboardingStatus: "approved" });
    if (approvedCount !== restaurantIds.length) return res.status(409).json({ error: "PARTNER_RESTAURANT_ASSIGNMENT_INVALID", message: "Solo se pueden asignar locales existentes y aprobados." });
    update.restaurantId = objectId(restaurantIds[0]);
    update.restaurantIds = restaurantIds.map((restaurantId) => objectId(restaurantId));
  }
  if (parsed.data.fleetId !== undefined) update.fleetId = parsed.data.fleetId ? objectId(parsed.data.fleetId) : null;
  if (parsed.data.zoneSlugs) update.zoneSlugs = parsed.data.zoneSlugs;
  const accessChanged = Boolean(parsed.data.apiRole || parsed.data.jobRole || parsed.data.roles || parsed.data.primaryRole || parsed.data.partnerRoles || parsed.data.restaurantIds || parsed.data.status !== "approved");
  if (accessChanged) update.sessionHash = null;
  const employee = await EmployeeAccount.findByIdAndUpdate(id, { $set: update }, { new: true }).select("name email jobRole apiRole roles primaryRole partnerRoles restaurantId restaurantIds accessLevel authorizationStatus authorizedAt authorizedBy authorizationReason fleetId zoneSlugs active mustChangePassword").lean().exec() as any;
  await AccessAuthorization.create({ employeeId: id, action: parsed.data.apiRole || parsed.data.jobRole || parsed.data.roles || parsed.data.partnerRoles || parsed.data.restaurantIds ? "role_changed" : parsed.data.status, previousStatus: target.authorizationStatus || null, nextStatus: parsed.data.status, previousRole: JSON.stringify({ apiRole: target.apiRole, roles: target.roles || [], partnerRoles: target.partnerRoles || [], restaurantIds: assignedRestaurantIds(target) }), nextRole: JSON.stringify({ apiRole: employee.apiRole, roles: employee.roles || [], partnerRoles: employee.partnerRoles || [], restaurantIds: assignedRestaurantIds(employee) }), accessLevel: employee.accessLevel || "subadmin", actorEmployeeId: objectId(req.auth!.employeeId!), reason: parsed.data.reason });
  if (accessChanged) await revokeEmployeeSessions(id);
  return res.json({ employee, authorization: { status: parsed.data.status, persisted: true } });
});

app.patch("/api/v1/admin/employees/:id/active", requireOwner(), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id); if (!id) return res.status(400).json({ error: "INVALID_EMPLOYEE_ID" });
  const parsed = z.object({ active: z.boolean(), reason: z.string().max(500).default("") }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_ACTIVE_STATE" });
  const target = await EmployeeAccount.findById(id).select("email ownerProtected jobRole apiRole accessLevel authorizationStatus").lean().exec() as any;
  if (!target) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" });
  if (target.ownerProtected || target.email === ownerEmail) return res.status(403).json({ error: "OWNER_ACCOUNT_PROTECTED" });
  const nextStatus = parsed.data.active ? "approved" : "suspended";
  const employee = await EmployeeAccount.findByIdAndUpdate(id, { $set: { active: parsed.data.active, authorizationStatus: nextStatus, authorizedAt: parsed.data.active ? new Date() : null, authorizedBy: req.auth?.employeeId ? objectId(req.auth.employeeId) : null, authorizationReason: parsed.data.reason, ...(parsed.data.active ? {} : { sessionHash: null }) } }, { new: true }).select("name email jobRole apiRole accessLevel authorizationStatus active mustChangePassword").lean().exec() as any;
  await AccessAuthorization.create({ employeeId: id, action: nextStatus, previousStatus: target.authorizationStatus || null, nextStatus, previousRole: target.apiRole, nextRole: employee?.apiRole || target.apiRole, accessLevel: employee?.accessLevel || target.accessLevel || "subadmin", actorEmployeeId: objectId(req.auth!.employeeId!), reason: parsed.data.reason });
  if (!parsed.data.active) await revokeEmployeeSessions(id);
  return res.json({ employee });
});
app.post("/api/v1/admin/owner/bootstrap", requireOwner(), async (req, res) => {
  const parsed = z.object({ email: z.literal(ownerEmail), password: z.string().min(8).max(200), name: z.string().min(2).max(160).default("Propietario y CEO de PIKI") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_OWNER_BOOTSTRAP" });
  const owner = await EmployeeAccount.findOneAndUpdate({ email: parsed.data.email }, { $set: { name: parsed.data.name, jobRole: "admin", apiRole: "admin", accessLevel: "superadmin", authorizationStatus: "approved", authorizedAt: new Date(), passwordHash: hashPassword(parsed.data.password), active: true, ownerProtected: true, hiddenFromAdmin: true, mustChangePassword: false, passwordChangedAt: new Date() }, $setOnInsert: { portfolioId: "owner_piki_ceo" } }, { upsert: true, new: true, setDefaultsOnInsert: true }).select("_id email name jobRole apiRole ownerProtected hiddenFromAdmin").lean().exec() as any;
  return res.json({ owner: { id: owner?._id, email: owner?.email, name: owner?.name, role: owner?.jobRole }, protected: true, hiddenFromAdmin: true });
});
app.get("/api/v1/payments/status", (_req, res) => res.json({ provider: "stripe" }));
app.get("/api/v1/signatures/status", (_req, res) => res.json({ provider: "signaturit" }));
app.post("/api/v1/admin/signatures", requireRole("admin"), async (req, res) => {
  const parsed = z.object({ entityType: z.enum(["partner", "rider", "employee"]), entityId: z.string().regex(/^[a-f\d]{24}$/), signerName: z.string().min(2).max(160), signerEmail: z.string().email(), subject: z.string().min(2).max(200), documentName: z.string().min(1).max(180), documentBase64: z.string().min(20).max(8_000_000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_SIGNATURE_REQUEST", details: parsed.error.flatten() });
  const entityId = objectId(parsed.data.entityId)!;
  if (!signaturitConfigured()) return res.status(503).json({ error: "SIGNATURIT_NOT_CONFIGURED", message: "Configura SIGNATURIT_ACCESS_TOKEN y SIGNATURIT_API_BASE_URL en Render antes de enviar firmas." });
  const request = await SignatureRequest.create({ provider: "signaturit", entityType: parsed.data.entityType, entityId, status: "pending" });
  try {
    const external = await createSignaturitSignature({ ...parsed.data, callbackUrl: signatureWebhookUrl() }) as any;
    const externalId = String(external?.id || external?.signature?.id || "");
    await SignatureRequest.findByIdAndUpdate(request._id, { $set: { externalId: externalId || null, status: "sent" } }).exec();
    return res.status(201).json({ requestId: request.id, externalId: externalId || null, provider: "signaturit", status: "sent" });
  } catch (error) {
    await SignatureRequest.findByIdAndUpdate(request._id, { $set: { status: "failed" } }).exec();
    return res.status(502).json({ error: "SIGNATURIT_REQUEST_FAILED", message: error instanceof Error ? error.message : "No se pudo crear la solicitud de firma" });
  }
});
app.post("/api/v1/signatures/signaturit/events", rateLimit(100, 60_000, "signaturit-webhook"), async (req, res) => {
  const webhookToken = process.env.SIGNATURIT_WEBHOOK_TOKEN;
  if (!webhookToken || req.query.token !== webhookToken) return res.status(401).json({ error: "INVALID_SIGNATURE_WEBHOOK_TOKEN" });
  const raw = JSON.stringify(req.body || {});
  const payload = req.body as any;
  const externalId = String(payload?.id || payload?.signature?.id || payload?.document?.signature_id || "");
  const eventType = String(payload?.type || payload?.event || "unknown");
  const status = eventType.includes("completed") || eventType.includes("signed") ? "signed" : eventType.includes("reject") ? "rejected" : undefined;
  if (externalId) await SignatureRequest.findOneAndUpdate({ externalId }, { $set: { ...(status ? { status } : {}), eventType, payloadDigest: webhookDigest(raw) } }).exec();
  return res.status(200).json({ received: true });
});

app.get("/api/v1/catalog/restaurants", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const filter: Record<string, unknown> = { isActive: true, onboardingStatus: "approved" };
  if (category && category !== "Todos") filter.category = category;
  if (query) filter.$or = [{ name: { $regex: query, $options: "i" } }, { cuisine: { $regex: query, $options: "i" } }, { category: { $regex: query, $options: "i" } }];
  const restaurants = await Restaurant.find(filter)
    // Explicit inclusion avoids MongoDB path-collision errors caused by
    // partnerProfile.documents having select:false nested fields.
    .select("slug name cuisine category locality partnerGroupKey tagline etaMinutes deliveryFeeCents rating reviews promoted image accent phone address location menu isActive onboardingStatus")
    .sort({ promoted: -1, rating: -1, reviews: -1 }).lean().exec();
  res.json({ restaurants });
});

app.get("/api/v1/locations/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (query.length < 3) return res.status(400).json({ error: "QUERY_TOO_SHORT" });
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", `${query}, Comunitat Valenciana, España`);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "8");
  try {
    const response = await fetch(url, { headers: { "User-Agent": "PIKI-Delivery/0.2 (+https://pikidelivery.com)" } });
    if (!response.ok) return res.status(502).json({ error: "GEOCODER_UNAVAILABLE" });
    const rows = await response.json() as Array<{ place_id: number; display_name: string; lat: string; lon: string; type?: string; address?: Record<string, string> }>;
    return res.json({ results: rows.map((row) => ({ id: row.place_id, label: row.display_name, latitude: Number(row.lat), longitude: Number(row.lon), type: row.type || "address", address: row.address || {} })) });
  } catch (error) {
    return res.status(502).json({ error: "GEOCODER_UNAVAILABLE", message: error instanceof Error ? error.message : "Geocoder unavailable" });
  }
});

app.get("/api/v1/locations/reverse", async (req, res) => {
  const latitude = Number(req.query.latitude); const longitude = Number(req.query.longitude);
  if (!validateCoordinates(latitude, longitude)) return res.status(400).json({ error: "INVALID_COORDINATES" });
  const url = new URL("https://nominatim.openstreetmap.org/reverse");
  url.searchParams.set("lat", String(latitude)); url.searchParams.set("lon", String(longitude));
  url.searchParams.set("format", "jsonv2"); url.searchParams.set("zoom", "18");
  try {
    const response = await fetch(url, { headers: { "User-Agent": "PIKI-Delivery/0.2 (+https://pikidelivery.com)" } });
    if (!response.ok) return res.status(502).json({ error: "GEOCODER_UNAVAILABLE" });
    const row = await response.json() as { display_name?: string };
    return res.json({ label: String(row.display_name || `Ubicación GPS ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`), latitude, longitude });
  } catch { return res.status(502).json({ error: "GEOCODER_UNAVAILABLE" }); }
});

app.get("/api/v1/coverage", async (req, res) => {
  const latitude = Number(req.query.latitude); const longitude = Number(req.query.longitude);
  if (!validateCoordinates(latitude, longitude)) return res.status(400).json({ error: "INVALID_COORDINATES" });
  const coverage = evaluateXativaCoverage([longitude, latitude]);
  let restaurants: unknown[] = [];
  let catalogAvailable = true;
  if (coverage.covered) {
    try {
      restaurants = await Restaurant.find({ isActive: true, onboardingStatus: "approved" })
        // Inclusive projection avoids a MongoDB path collision with the
        // select:false document payload nested under partnerProfile.
        .select("slug name cuisine category locality tagline etaMinutes deliveryFeeCents rating reviews promoted image accent phone address location menu")
        .sort({ promoted: -1, rating: -1, reviews: -1 }).lean().exec();
    } catch (error) {
      // The price decision is deterministic and must never disappear because a
      // catalogue/index query is temporarily unavailable. The storefront has
      // its own catalogue endpoints and can retry them independently.
      catalogAvailable = false;
      console.warn("Coverage catalogue query failed", error instanceof Error ? error.message : error);
    }
  }
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({ ...coverage, catalogAvailable, restaurants });
});

async function notifyOnboarding(input: { channel: "admin" | "fleet"; type: string; entityId: string; tenantId?: unknown; payload?: Record<string, unknown> }) {
  const tenantId = input.tenantId == null ? null : String(input.tenantId);
  try {
    await publishRealtimeEvent({
      channel: input.channel,
      audienceKey: tenantAudienceKey(tenantId, input.channel),
      tenantId,
      type: input.type,
      payload: { entityId: input.entityId, ...(input.payload || {}) },
      dedupeKey: `onboarding:${input.type}:${input.entityId}:${Date.now()}`,
    });
  } catch (error) {
    console.warn("Onboarding notification enqueue failed", error instanceof Error ? error.message : "unknown error");
  }
}

app.post("/api/v1/public/partner-leads", async (req, res) => {
  const parsed = partnerLeadSubmissionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PARTNER_LEAD", details: parsed.error.flatten() });
  if (parsed.data.website) return res.status(400).json({ error: "INVALID_PARTNER_LEAD" });
  const { website: _website, ...data } = parsed.data;
  try {
    const lead = await PartnerLead.create({ ...data, email: normalizeLeadEmail(data.email), privacyNoticeAcceptedAt: new Date(), status: "new", history: [{ status: "new", notes: "Solicitud recibida desde Únete a PIKI." }] });
    await notifyOnboarding({ channel: "admin", type: "onboarding.partner_lead.created", entityId: String(lead._id), tenantId: (lead as any).tenantId });
    return res.status(201).json({ message: "Solicitud recibida. El equipo comercial revisará tus datos.", lead: { id: String(lead._id), status: lead.status } });
  } catch (error) {
    if ((error as any)?.code === 11000) return res.status(409).json({ error: "APPLICATION_ALREADY_EXISTS", message: "Ya existe una solicitud activa con este correo." });
    throw error;
  }
});

app.get("/api/v1/admin/partner-leads", requireRole("admin", "commercial", "gerente_comercial_zona"), async (req, res) => {
  const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
  const parsedStatus = rawStatus && rawStatus !== "all" ? webLeadStatusSchema.safeParse(rawStatus) : null;
  if (parsedStatus && !parsedStatus.success) return res.status(400).json({ error: "INVALID_LEAD_STATUS" });
  const leads = await PartnerLead.find(parsedStatus?.success ? { status: parsedStatus.data } : {}).sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ leads });
});

app.patch("/api/v1/admin/partner-leads/:id", requireRole("admin", "commercial", "gerente_comercial_zona"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam);
  if (!id) return res.status(400).json({ error: "INVALID_LEAD_ID" });
  const parsed = webLeadReviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_LEAD_REVIEW", details: parsed.error.flatten() });
  if (parsed.data.status === "info_requested" && !parsed.data.notes) return res.status(400).json({ error: "INFO_REQUEST_NOTES_REQUIRED" });
  const actor = req.auth?.employeeId ? objectId(req.auth.employeeId) : null;
  const lead = await PartnerLead.findByIdAndUpdate(id, { $set: { status: parsed.data.status, notes: parsed.data.notes, reviewedBy: actor, reviewedAt: new Date() }, $push: { history: { status: parsed.data.status, notes: parsed.data.notes, actorEmployeeId: actor, changedAt: new Date() } } }, { new: true }).lean().exec();
  if (!lead) return res.status(404).json({ error: "PARTNER_LEAD_NOT_FOUND" });
  return res.json({ lead });
});

const partnerDocumentSchema = z.object({ type: z.enum(["tax_id", "bank_certificate", "insurance", "activity_license", "food_sanitary_authorization", "identity", "other"]), fileName: z.string().min(1).max(180), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]), sizeBytes: z.number().int().positive().max(2_500_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentBase64: z.string().min(20).max(3_500_000) });
const openingHoursSchema = z.record(z.string().min(2).max(15), z.object({ open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/), closed: z.boolean() }));
const partnerSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), password: z.string().min(12).max(200).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/), phone: z.string().min(6).max(40), address: z.string().min(5).max(280), legalName: z.string().min(2).max(180), taxId: z.string().regex(/^[A-Za-z0-9-]{5,20}$/), legalForm: z.enum(["autonomo", "sl", "sa", "cooperativa", "otra"]), representativeName: z.string().min(2).max(160), representativeRole: z.string().min(2).max(100), representativeDocument: z.string().min(5).max(30), fiscalAddress: z.string().min(5).max(280), operatingAddress: z.string().min(5).max(280), postalCode: z.string().regex(/^\d{5}$/), city: z.string().min(2).max(100), province: z.string().min(2).max(100), iban: z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/), bankAccountHolder: z.string().min(2).max(180), cuisine: z.string().min(2).max(100), vatRate: z.union([z.literal(4), z.literal(10), z.literal(21)]), commissionAccepted: z.literal(true), termsAcceptedAt: z.coerce.date(), contractAccepted: z.literal(true), privacyAccepted: z.literal(true), dataProcessingAccepted: z.literal(true), pdaUnits: z.number().int().min(1).max(50), pdaUnitCostCents: z.literal(30000), pdaCostAccepted: z.literal(true), pdaCostAcceptedAt: z.coerce.date(), privacyAcceptedAt: z.coerce.date(), dataProcessingAcceptedAt: z.coerce.date(), openingHours: openingHoursSchema, documents: z.array(partnerDocumentSchema).length(5) });
app.post("/api/v1/partners/onboarding", async (req, res) => {
  const parsed = partnerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PARTNER", details: parsed.error.flatten() });
  const requiredDocumentTypes = new Set(["tax_id", "bank_certificate", "activity_license", "insurance", "food_sanitary_authorization"]);
  if (![...requiredDocumentTypes].every((type) => parsed.data.documents.some((document) => document.type === type))) return res.status(400).json({ error: "REQUIRED_PARTNER_DOCUMENTS_MISSING", required: [...requiredDocumentTypes] });
  for (const document of parsed.data.documents) {
    const digest = createHash("sha256").update(Buffer.from(document.contentBase64, "base64")).digest("hex");
    if (digest !== document.sha256) return res.status(400).json({ error: "PARTNER_DOCUMENT_CHECKSUM_MISMATCH", fileName: document.fileName });
  }
  const existingTaxId = await Restaurant.findOne({ "partnerProfile.taxId": parsed.data.taxId.toUpperCase() }).select("_id").lean().exec();
  if (existingTaxId) return res.status(409).json({ error: "PARTNER_TAX_ID_ALREADY_EXISTS" });
  const normalizedEmail = parsed.data.email.toLowerCase();
  if (await EmployeeAccount.exists({ email: normalizedEmail })) return res.status(409).json({ error: "PARTNER_EMAIL_ALREADY_EXISTS", message: "Ya existe una solicitud o cuenta con este correo." });
  const slug = `${parsed.data.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
  const { legalName, taxId, legalForm, representativeName, representativeRole, representativeDocument, fiscalAddress, operatingAddress, postalCode, city, province, iban, bankAccountHolder, cuisine, vatRate, commissionAccepted, termsAcceptedAt, contractAccepted, privacyAccepted, dataProcessingAccepted, pdaUnits, pdaUnitCostCents, pdaCostAccepted, pdaCostAcceptedAt, privacyAcceptedAt, dataProcessingAcceptedAt, openingHours, documents, password: _password, ...contact } = parsed.data;
  const locality = city.trim();
  const groupKey = localityKey(locality);
  const partner = await Restaurant.create({ slug, name: contact.name, cuisine, category: cuisine, locality, partnerGroupKey: groupKey, address: operatingAddress, tagline: "Solicitud recibida por PIKI", onboardingStatus: "pending_review", isActive: false, email: contact.email, phone: contact.phone, partnerProfile: { legalName, taxId: taxId.toUpperCase(), legalForm, representativeName, representativeRole, representativeDocument, fiscalAddress, operatingAddress, postalCode, city, province, iban: iban.toUpperCase(), bankAccountHolder, cuisine, vatRate, commissionAccepted, termsAcceptedAt, contractAcceptedAt: contractAccepted ? termsAcceptedAt : null, privacyAcceptedAt, dataProcessingAcceptedAt, pdaUnits, pdaUnitCostCents, pdaCostAcceptedAt: pdaCostAccepted ? pdaCostAcceptedAt : null, openingHours, documents: documents.map(({ contentBase64, ...metadata }) => ({ ...metadata, contentBase64, status: "received" })) } });
  try {
    await EmployeeAccount.create({ name: contact.name, email: normalizedEmail, jobRole: "partner", apiRole: "partner", roles: ["partner"], partnerRoles: ["partner_admin"], accessLevel: "subadmin", authorizationStatus: "pending", restaurantId: partner._id, restaurantIds: [partner._id], passwordHash: hashPassword(parsed.data.password), mustChangePassword: false, active: false });
  } catch (error) {
    await Restaurant.findByIdAndDelete(partner._id).exec();
    if ((error as any)?.code === 11000) return res.status(409).json({ error: "PARTNER_EMAIL_ALREADY_EXISTS", message: "Ya existe una solicitud o cuenta con este correo." });
    throw error;
  }
  await PartnerLocalityGroup.findOneAndUpdate({ localityKey: groupKey }, { $set: { localityName: locality, province, isActive: true }, $addToSet: { restaurantIds: partner._id } }, { upsert: true, new: true });
  await notifyOnboarding({ channel: "admin", type: "onboarding.partner_application.created", entityId: String(partner._id), tenantId: (partner as any).tenantId });
  res.status(201).json({ message: "Solicitud recibida para revisión.", partner: { id: partner.id, name: partner.name, email: partner.email, phone: partner.phone, locality, partnerGroupKey: groupKey, onboarding_status: partner.onboardingStatus } });
});

function assignedRestaurantIds(employee: any): string[] {
  const ids = [
    ...(Array.isArray(employee?.restaurantIds) ? employee.restaurantIds : []),
    employee?.restaurantId,
  ].map((value) => String(value || "")).filter((value) => Boolean(objectId(value)));
  return [...new Set(ids)];
}

async function partnerLocationsFor(employee: any, roles = partnerRolesForEmployee(employee), permissions = [...permissionsForPartnerRoles(roles)]) {
  const ids = assignedRestaurantIds(employee);
  if (!ids.length) return [];
  const restaurants = await Restaurant.find({ _id: { $in: ids } }).select("_id name address isActive onboardingStatus").lean().exec() as any[];
  const byId = new Map(restaurants.map((restaurant) => [String(restaurant._id), restaurant]));
  return ids.map((id) => byId.get(id)).filter(Boolean).map((restaurant: any) => ({
    id: String(restaurant._id),
    name: restaurant.name,
    address: restaurant.address || "",
    isOpen: Boolean(restaurant.isActive && restaurant.onboardingStatus === "approved"),
    roles,
    permissions,
  }));
}

async function partnerAccessForRequest(req: express.Request) {
  if (!req.auth?.employeeId) return null;
  const employee = await EmployeeAccount.findById(req.auth.employeeId).select("restaurantId restaurantIds jobRole apiRole roles partnerRoles").lean().exec() as any;
  if (!employee) return null;
  const roles = partnerRolesForEmployee(employee);
  return { employee, restaurantIds: assignedRestaurantIds(employee), roles, permissions: [...permissionsForPartnerRoles(roles)] };
}

async function employeeRestaurant(req: express.Request, access?: Awaited<ReturnType<typeof partnerAccessForRequest>>) {
  if (!req.auth?.employeeId) {
    const scopedRestaurantId = String(process.env.PARTNER_API_RESTAURANT_ID || "").trim();
    return req.auth?.role === "partner" && objectId(scopedRestaurantId) ? scopedRestaurantId : null;
  }
  const resolvedAccess = access ?? await partnerAccessForRequest(req);
  if (!resolvedAccess?.restaurantIds.length) return null;
  const requested = String(req.header("x-piki-restaurant-id") || "").trim();
  if (requested) return resolvedAccess.restaurantIds.includes(requested) ? requested : null;
  return resolvedAccess.restaurantIds[0] || null;
}

async function partnerRequestAccess(req: express.Request, permission: PartnerPermission) {
  const access = await partnerAccessForRequest(req);
  return { access, allowed: Boolean(access && partnerCan(access.roles, permission)) };
}
const menuModifierSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(120), price: z.number().min(0).max(1000), required: z.boolean().default(false), options: z.array(z.string().max(120)).max(30).default([]) });
const partnerMenuItemSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(160), description: z.string().max(500).default(""), price: z.number().min(0).max(1000), category: z.string().max(100).default("General"), image: z.string().max(1200).refine((value) => value === "" || value.startsWith("https://api.pikidelivery.com/api/v1/catalog/assets/"), "La imagen debe proceder del almacenamiento de PIKI").default(""), allergens: z.array(z.string().max(80)).max(30).default([]), modifiers: z.array(menuModifierSchema).max(20).default([]), available: z.boolean().default(true), vegetarian: z.boolean().default(false), popular: z.boolean().default(false) });
function detectedMenuMime(bytes: Buffer): string | null {
  if (bytes.length >= 12 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-") return "application/pdf";
  return null;
}
function safeAssetFileName(value: string): string {
  const cleaned = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 160);
  return cleaned || "carta";
}
function assetResponse(asset: any) {
  return { id: String(asset._id || asset.id), fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256, folderKey: asset.folderKey, locality: asset.locality, kind: asset.kind, scanStatus: asset.scanStatus || "clean", scanEngine: asset.scanEngine || "ClamAV", scannedAt: asset.scannedAt || null, createdAt: asset.createdAt || null, url: publicAssetUrl(String(asset._id || asset.id)) };
}
app.get("/api/v1/catalog/assets/:id", async (req, res) => {
  const assetId = objectId(String(req.params.id));
  if (!assetId) return res.status(400).json({ error: "INVALID_ASSET_ID" });
  const asset = await PartnerAsset.findOne({ _id: assetId, kind: { $in: ["menu_image", "menu_file", "restaurant_image"] }, scanStatus: "clean" }).select("+contentBase64 mimeType fileName sizeBytes").lean().exec() as any;
  if (!asset) return res.status(404).json({ error: "ASSET_NOT_FOUND" });
  res.setHeader("Content-Type", asset.mimeType);
  res.setHeader("Content-Length", String(asset.sizeBytes));
  res.setHeader("Content-Disposition", `inline; filename="${safeAssetFileName(asset.fileName)}"`);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
  return res.send(Buffer.from(asset.contentBase64, "base64"));
});
app.get("/api/v1/partners/menu/assets", requireRole("partner"), async (req, res) => {
  const restaurantId = await employeeRestaurant(req);
  if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const assets = await PartnerAsset.find({ restaurantId: objectId(restaurantId), kind: { $in: MENU_ASSET_KINDS }, scanStatus: "clean" }).sort({ createdAt: -1 }).limit(100).lean().exec();
  return res.json({ assets: assets.map(assetResponse) });
});
app.post("/api/v1/partners/menu/assets", requireRole("partner"), async (req, res) => {
  const restaurantId = await employeeRestaurant(req);
  if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const parsed = z.object({ fileName: z.string().min(1).max(180), mimeType: z.enum(MENU_ASSET_MIME_TYPES), sizeBytes: z.number().int().positive().max(MAX_MENU_FILE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/i), contentBase64: z.string().min(1).max(5_800_000), kind: z.enum(MENU_ASSET_KINDS).default("menu_image") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_MENU_ASSET", maxImageBytes: MAX_MENU_IMAGE_BYTES, maxFileBytes: MAX_MENU_FILE_BYTES, allowedTypes: MENU_ASSET_MIME_TYPES, details: parsed.error.flatten() });
  const maxBytes = parsed.data.kind === "menu_image" ? MAX_MENU_IMAGE_BYTES : MAX_MENU_FILE_BYTES;
  const allowedMime = parsed.data.kind === "menu_image" ? MENU_IMAGE_MIME_TYPES.includes(parsed.data.mimeType as typeof MENU_IMAGE_MIME_TYPES[number]) : MENU_FILE_MIME_TYPES.includes(parsed.data.mimeType as typeof MENU_FILE_MIME_TYPES[number]);
  if (!allowedMime) return res.status(400).json({ error: "MENU_ASSET_TYPE_NOT_ALLOWED", kind: parsed.data.kind });
  const rawBase64 = parsed.data.contentBase64.replace(/^data:[^;]+;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(rawBase64) || rawBase64.length % 4 === 1) return res.status(400).json({ error: "MENU_ASSET_BASE64_INVALID" });
  const bytes = Buffer.from(rawBase64, "base64");
  if (bytes.length !== parsed.data.sizeBytes || bytes.length > maxBytes) return res.status(413).json({ error: parsed.data.kind === "menu_image" ? "MENU_IMAGE_TOO_LARGE" : "MENU_FILE_TOO_LARGE", maxBytes });
  const actualMime = detectedMenuMime(bytes);
  if (actualMime !== parsed.data.mimeType) return res.status(400).json({ error: "MENU_ASSET_CONTENT_TYPE_MISMATCH", declaredType: parsed.data.mimeType });
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== parsed.data.sha256.toLowerCase()) return res.status(400).json({ error: "MENU_ASSET_CHECKSUM_MISMATCH" });
  try {
    await scanUploadBuffer(bytes, parsed.data.fileName);
  } catch (error) {
    if (error instanceof MalwareDetectedError) return res.status(422).json({ error: "MALWARE_DETECTED", message: "El archivo ha sido rechazado por el analizador antivirus." });
    console.error("Menu asset antivirus scan failed", error instanceof Error ? error.message : error);
    if (error instanceof MalwareScannerUnavailableError) return res.status(503).json({ error: "MALWARE_SCANNER_UNAVAILABLE", message: "La subida queda temporalmente bloqueada hasta que el analizador antivirus esté disponible." });
    return res.status(503).json({ error: "MALWARE_SCANNER_ERROR", message: "No se ha podido completar el análisis antivirus." });
  }
  const restaurant = await Restaurant.findById(restaurantId).select("locality partnerGroupKey").lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  const locality = restaurant.locality || "Sin localidad";
  const asset = await PartnerAsset.create({ restaurantId: objectId(restaurantId), organizationKey: restaurantId, folderKey: organizationFolder(locality, restaurantId), locality, kind: parsed.data.kind, fileName: safeAssetFileName(parsed.data.fileName), mimeType: parsed.data.mimeType, sizeBytes: bytes.length, sha256: digest, contentBase64: rawBase64, scanStatus: "clean", scanEngine: "ClamAV", scannedAt: new Date() });
  const groupKey = localityKey(locality);
  await PartnerLocalityGroup.findOneAndUpdate({ localityKey: groupKey }, { $set: { localityName: locality, province: "Valencia", isActive: true }, $addToSet: { restaurantIds: objectId(restaurantId) } }, { upsert: true, new: true });
  return res.status(201).json({ asset: assetResponse(asset) });
});
app.delete("/api/v1/partners/menu/assets/:id", requireRole("partner"), async (req, res) => {
  const restaurantId = await employeeRestaurant(req);
  const assetId = objectId(String(req.params.id));
  if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  if (!assetId) return res.status(400).json({ error: "INVALID_ASSET_ID" });
  const asset = await PartnerAsset.findOne({ _id: assetId, restaurantId: objectId(restaurantId), kind: { $in: MENU_ASSET_KINDS } }).lean().exec() as any;
  if (!asset) return res.status(404).json({ error: "ASSET_NOT_FOUND" });
  const referenced = await Restaurant.exists({ _id: objectId(restaurantId), menu: { $elemMatch: { image: publicAssetUrl(String(asset._id)) } } });
  if (referenced) return res.status(409).json({ error: "MENU_ASSET_IN_USE", message: "No se puede borrar una imagen que está asignada a un producto." });
  await PartnerAsset.deleteOne({ _id: assetId, restaurantId: objectId(restaurantId) });
  return res.status(204).send();
});
app.get("/api/v1/admin/partner-groups/locality", requireRole("admin"), async (_req, res) => res.json({ groups: await PartnerLocalityGroup.find({ isActive: true }).sort({ localityName: 1 }).lean().exec() }));
app.get("/api/v1/partners/locations", requireRole("partner"), async (req, res) => {
  const access = await partnerAccessForRequest(req);
  return res.json({ locations: access ? await partnerLocationsFor(access.employee, access.roles, access.permissions) : [] });
});
app.patch("/api/v1/partners/store/status", requireRole("partner"), async (req, res) => {
  const { access, allowed } = await partnerRequestAccess(req, "store:write");
  if (!allowed) return res.status(403).json({ error: "PARTNER_PERMISSION_DENIED", permission: "store:write" });
  const restaurantId = await employeeRestaurant(req, access);
  if (!restaurantId) return res.status(403).json({ error: access?.restaurantIds.length ? "PARTNER_RESTAURANT_ACCESS_DENIED" : "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const parsed = z.object({ status: z.enum(["open", "paused"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_STORE_STATUS" });
  const restaurant = await Restaurant.findOneAndUpdate({ _id: restaurantId, onboardingStatus: "approved" }, { $set: { isActive: parsed.data.status === "open" } }, { new: true }).select("_id name isActive").lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant: { id: String(restaurant._id), name: restaurant.name }, status: restaurant.isActive ? "open" : "paused", isOpen: Boolean(restaurant.isActive) });
});
app.get("/api/v1/partners/menu", requireRole("partner"), async (req, res) => {
  const { access, allowed } = await partnerRequestAccess(req, "menu:read");
  if (!allowed) return res.status(403).json({ error: "PARTNER_PERMISSION_DENIED", permission: "menu:read" });
  const restaurantId = await employeeRestaurant(req, access);
  if (!restaurantId) return res.status(403).json({ error: access?.restaurantIds.length ? "PARTNER_RESTAURANT_ACCESS_DENIED" : "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const restaurant = await Restaurant.findById(restaurantId).select("name menu").lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant, menu: restaurant.menu || [] });
});
app.put("/api/v1/partners/menu", requireRole("partner"), async (req, res) => {
  const { access, allowed } = await partnerRequestAccess(req, "menu:write");
  if (!allowed) return res.status(403).json({ error: "PARTNER_PERMISSION_DENIED", permission: "menu:write" });
  const restaurantId = await employeeRestaurant(req, access);
  if (!restaurantId) return res.status(403).json({ error: access?.restaurantIds.length ? "PARTNER_RESTAURANT_ACCESS_DENIED" : "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const parsed = z.object({ items: z.array(partnerMenuItemSchema).max(500) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_MENU", details: parsed.error.flatten() });
  const restaurant = await Restaurant.findByIdAndUpdate(restaurantId, { $set: { menu: parsed.data.items } }, { new: true }).select("name menu").lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant, menu: restaurant.menu || [] });
});
app.get("/api/v1/partners/kitchen/orders", requireRole("partner"), async (req, res) => {
  const { access, allowed } = await partnerRequestAccess(req, "orders:read");
  if (!allowed) return res.status(403).json({ error: "PARTNER_PERMISSION_DENIED", permission: "orders:read" });
  const restaurantId = await employeeRestaurant(req, access);
  if (!restaurantId) return res.status(403).json({ error: access?.restaurantIds.length ? "PARTNER_RESTAURANT_ACCESS_DENIED" : "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const orders = await Order.find({ restaurantId, ...dispatchablePaymentFilter, status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup"] } }).sort({ createdAt: 1 }).lean().exec() as any[];
  const [restaurantRecord, customers] = await Promise.all([Restaurant.findById(restaurantId).select("name address phone cuisine").lean().exec(), CustomerAccount.find({ _id: { $in: orders.map((order) => order.customerId).filter(Boolean) } }).select("name email").lean().exec()]);
  const restaurant = restaurantRecord as any;
  const customerMap = new Map(customers.map((customer: any) => [String(customer._id), customer]));
  return res.json({ orders: orders.map((order: any) => ({ ...order, restaurant: restaurant ? { name: restaurant.name, address: restaurant.address || "", phone: restaurant.phone || "", cuisine: restaurant.cuisine || "" } : null, customer: order.customerId ? customerMap.get(String(order.customerId)) || null : null, pickupQrUrl: order.status === "ready_for_pickup" ? pickupQrUrl(order.publicCode) : null, pickupPin: order.status === "ready_for_pickup" ? pickupQrPin(order.publicCode) : null })) });
});
app.patch("/api/v1/partners/kitchen/orders/:id/status", requireRole("partner"), async (req, res) => {
  const parsed = z.object({ status: z.enum(["accepted", "preparing", "ready_for_pickup", "cancelled"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_KITCHEN_STATUS" });
  const permission: PartnerPermission = parsed.data.status === "cancelled" ? "orders:cancel" : parsed.data.status === "accepted" ? "orders:write" : "orders:prepare";
  const { access, allowed: permissionGranted } = await partnerRequestAccess(req, permission);
  if (!permissionGranted) return res.status(403).json({ error: "PARTNER_PERMISSION_DENIED", permission });
  const restaurantId = await employeeRestaurant(req, access);
  if (!restaurantId) return res.status(403).json({ error: access?.restaurantIds.length ? "PARTNER_RESTAURANT_ACCESS_DENIED" : "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const orderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findOne({ _id: orderId, restaurantId });
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const current = order.status as any;
  const target = parsed.data.status;
  const allowedTransitions: Record<string, string[]> = { pending: ["accepted", "cancelled"], accepted: ["preparing", "cancelled"], preparing: ["ready_for_pickup", "cancelled"] };
  if (!allowedTransitions[current]?.includes(target)) return res.status(409).json({ error: "INVALID_ORDER_TRANSITION", from: current, to: target });
  if (target === "accepted" && !( ["authorized", "paid"] as string[]).includes(order.paymentState) && order.paymentMethod !== "cash") return res.status(409).json({ error: "PAYMENT_NOT_CONFIRMED" });
  order.status = target as any;
  order.statusHistory.push({ status: target, actorRole: "partner", reason: "Actualización desde pantalla de cocina" } as any);
  await order.save();
  await publishOrderStatusEvents(order, target).catch((error) => console.warn("Realtime partner status event failed", error instanceof Error ? error.message : error));
  scheduleCustomerOrderPush(order, target);
  return res.json({ order });
});
app.get("/api/v1/partners/metrics/overview", requireRole("partner"), async (req, res) => {
  const { access, allowed } = await partnerRequestAccess(req, "metrics:read");
  if (!allowed) return res.status(403).json({ error: "PARTNER_PERMISSION_DENIED", permission: "metrics:read" });
  const restaurantId = await employeeRestaurant(req, access);
  if (!restaurantId) return res.status(403).json({ error: access?.restaurantIds.length ? "PARTNER_RESTAURANT_ACCESS_DENIED" : "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const [todayRows, yesterdayCount, restaurant] = await Promise.all([
    Order.aggregate([{ $match: { restaurantId: objectId(restaurantId), createdAt: { $gte: today } } }, { $group: { _id: null, orders: { $sum: 1 }, cancellations: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } }, revenueCents: { $sum: { $cond: [{ $ne: ["$status", "cancelled"] }, "$totalCents", 0] } } } }]),
    Order.countDocuments({ restaurantId, createdAt: { $gte: yesterday, $lt: today } }),
    Restaurant.findById(restaurantId).select("rating").lean().exec(),
  ]);
  const overview = todayRows[0] || { orders: 0, cancellations: 0, revenueCents: 0 };
  const trend = yesterdayCount ? ((Number(overview.orders) - yesterdayCount) / yesterdayCount) * 100 : Number(overview.orders) ? 100 : 0;
  return res.json({ overview: { orders: Number(overview.orders), revenueCents: Number(overview.revenueCents), cancellations: Number(overview.cancellations), rating: Number((restaurant as any)?.rating || 0), trend } });
});

app.get("/api/v1/commercial/portfolio", requireRole("commercial"), async (req, res) => {
  const employeeId = req.auth?.employeeId;
  const employee = employeeId ? await EmployeeAccount.findById(employeeId).select("portfolioId").lean().exec() as any : null;
  const restaurants = employeeId ? await Restaurant.find({ commercialEmployeeId: objectId(employeeId) }).sort({ createdAt: -1 }).lean().exec() : [];
  return res.json({ portfolioId: employee?.portfolioId || null, restaurants });
});

app.patch("/api/v1/admin/restaurants/:id/assign-commercial", requireOwner(), async (req, res) => {
  const restaurantId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  const commercialId = objectId(String(req.body?.employeeId || ""));
  if (!restaurantId || !commercialId) return res.status(400).json({ error: "INVALID_ASSIGNMENT" });
  const commercial = await EmployeeAccount.findOne({ _id: commercialId, jobRole: "commercial", active: true }).lean().exec() as any;
  if (!commercial) return res.status(404).json({ error: "COMMERCIAL_ACCOUNT_NOT_FOUND" });
  const restaurant = await Restaurant.findByIdAndUpdate(restaurantId, { $set: { commercialEmployeeId: commercialId } }, { new: true }).lean().exec();
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant, portfolioId: commercial.portfolioId });
});

app.patch("/api/v1/admin/employees/:id/partner-locations", requireOwner(), async (req, res) => {
  const employeeId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!employeeId) return res.status(400).json({ error: "INVALID_EMPLOYEE_ID" });
  const parsed = z.object({ restaurantIds: z.array(z.string().regex(/^[a-f\d]{24}$/i)).min(1).max(100), partnerRoles: z.array(z.enum(partnerOperationalRoles)).min(1).max(10).optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PARTNER_ASSIGNMENT", details: parsed.error.flatten() });
  const employee = await EmployeeAccount.findById(employeeId).select("email ownerProtected apiRole roles partnerRoles authorizationStatus accessLevel restaurantId restaurantIds").lean().exec() as any;
  if (!canReceivePartnerLocations(employee, ownerEmail)) return res.status(404).json({ error: "PARTNER_ACCOUNT_NOT_FOUND" });
  const uniqueIds = [...new Set(parsed.data.restaurantIds)];
  const restaurants = await Restaurant.find({ _id: { $in: uniqueIds.map((id) => objectId(id)) }, onboardingStatus: "approved" }).select("_id name address isActive onboardingStatus").lean().exec() as any[];
  if (restaurants.length !== uniqueIds.length) return res.status(409).json({ error: "PARTNER_RESTAURANT_ASSIGNMENT_INVALID", message: "Solo se pueden asignar locales existentes y aprobados." });
  const partnerRoles = parsed.data.partnerRoles || partnerRolesForEmployee(employee);
  const updated = await EmployeeAccount.findByIdAndUpdate(employeeId, { $set: { restaurantId: objectId(uniqueIds[0]), restaurantIds: uniqueIds.map((id) => objectId(id)), partnerRoles } }, { new: true }).select("_id name email restaurantId restaurantIds partnerRoles roles apiRole accessLevel authorizationStatus").lean().exec() as any;
  await AccessAuthorization.create({ employeeId, action: "role_changed", previousStatus: employee.authorizationStatus || "approved", nextStatus: updated.authorizationStatus || "approved", previousRole: JSON.stringify({ restaurantIds: assignedRestaurantIds(employee), partnerRoles: employee.partnerRoles || [] }), nextRole: JSON.stringify({ restaurantIds: uniqueIds, partnerRoles }), accessLevel: updated.accessLevel || "subadmin", actorEmployeeId: objectId(req.auth!.employeeId!), reason: "Asignación actualizada para operación PIKI Partner Orders" });
  await revokeEmployeeSessions(employeeId);
  const permissions = [...permissionsForPartnerRoles(partnerRoles)];
  return res.json({ employee: { id: String(updated._id), email: updated.email, roles: partnerRoles, locations: await partnerLocationsFor(updated, partnerRoles, permissions) } });
});

app.get("/api/v1/admin/restaurants", requireRole("admin"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const filter = status ? { onboardingStatus: status } : {};
  const restaurants = await Restaurant.find(filter).sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ restaurants });
});

app.patch("/api/v1/admin/restaurants/:id/status", requireRole("admin"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam); if (!id) return res.status(400).json({ error: "INVALID_RESTAURANT_ID" });
  const parsed = z.object({ status: z.enum(["pending_review", "approved", "rejected", "suspended"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RESTAURANT_STATUS", details: parsed.error.flatten() });
  const existing = await Restaurant.findById(id).select("partnerProfile onboardingStatus").lean().exec() as any;
  if (!existing) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  if (["approved", "rejected"].includes(parsed.data.status)) {
    const documents = existing.partnerProfile?.documents || [];
    if (!documents.length || documents.some((document: any) => document.status === "received")) return res.status(409).json({ error: "PARTNER_DOCUMENT_REVIEW_REQUIRED", message: "Debes revisar todos los documentos del partner antes de aprobar o rechazar la solicitud." });
    if (parsed.data.status === "approved" && documents.some((document: any) => document.status !== "approved")) return res.status(409).json({ error: "PARTNER_DOCUMENTS_NOT_APPROVED", message: "No se puede aprobar: existe documentación del partner rechazada." });
  }
  const restaurant = await Restaurant.findByIdAndUpdate(id, { $set: { onboardingStatus: parsed.data.status, isActive: parsed.data.status === "approved", onboardingReviewedBy: objectId(req.auth!.employeeId!), onboardingReviewedAt: new Date() } }, { new: true }).lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  const partnerAccount = await EmployeeAccount.findOne({ restaurantId: restaurant._id, apiRole: "partner" }).select("_id authorizationStatus").exec() as any;
  if (parsed.data.status === "approved" && !partnerAccount) {
    await Restaurant.findByIdAndUpdate(id, { $set: { onboardingStatus: "pending_review", isActive: false } }).exec();
    return res.status(409).json({ error: "PARTNER_ACCOUNT_MISSING", message: "La solicitud no tiene una cuenta Partner asociada." });
  }
  if (partnerAccount) {
    const approved = parsed.data.status === "approved";
    const nextStatus = approved ? "approved" : parsed.data.status === "rejected" ? "revoked" : "suspended";
    await EmployeeAccount.findByIdAndUpdate(partnerAccount._id, { $set: { authorizationStatus: nextStatus, active: approved, authorizedAt: approved ? new Date() : null, authorizedBy: approved ? objectId(req.auth!.employeeId!) : null, authorizationReason: `Estado del comercio: ${parsed.data.status}`, ...(approved ? {} : { sessionHash: null }) } }).exec();
    if (!approved) await revokeEmployeeSessions(String(partnerAccount._id));
    await AccessAuthorization.create({ employeeId: partnerAccount._id, action: parsed.data.status, previousStatus: partnerAccount.authorizationStatus || "pending", nextStatus, previousRole: "partner", nextRole: "partner", accessLevel: "subadmin", actorEmployeeId: objectId(req.auth!.employeeId!), reason: `Estado del comercio: ${parsed.data.status}` });
  }
  if (parsed.data.status === "approved" && existing.onboardingStatus !== "approved") {
    await notifyOnboarding({ channel: "admin", type: "onboarding.partner_application.approved", entityId: String(restaurant._id), tenantId: (restaurant as any).tenantId });
  }
  return res.json({ restaurant, partnerAccount: partnerAccount ? { id: String(partnerAccount._id), access: parsed.data.status === "approved" ? "enabled" : "disabled" } : null });
});

app.get("/api/v1/admin/restaurants/:id/documents", requireRole("admin"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_RESTAURANT_ID" });
  const restaurant = await Restaurant.findById(id).lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  const profile = restaurant.partnerProfile || {};
  return res.json({ restaurantId: restaurant._id, legalName: profile.legalName || null, taxId: profile.taxId || null, documents: (profile.documents || []).map(({ contentBase64, ...metadata }: any) => metadata) });
});
app.get("/api/v1/admin/restaurants/:id/documents/:documentId/content", requireRole("admin"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_RESTAURANT_ID" });
  const restaurant = await Restaurant.findOne({ _id: id, "partnerProfile.documents._id": req.params.documentId }).select("+partnerProfile.documents.contentBase64").lean().exec() as any;
  const document = restaurant?.partnerProfile?.documents?.find((item: any) => String(item._id) === req.params.documentId);
  if (!document) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
  return res.json({ fileName: document.fileName, mimeType: document.mimeType, sizeBytes: document.sizeBytes, sha256: document.sha256, contentBase64: document.contentBase64 });
});

app.patch("/api/v1/admin/restaurants/:id/documents/:documentId/status", requireRole("admin"), async (req, res) => {
  const restaurantId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!restaurantId) return res.status(400).json({ error: "INVALID_RESTAURANT_ID" });
  const parsed = z.object({ status: z.enum(["received", "approved", "rejected"]), reviewNotes: z.string().max(1000).default("") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DOCUMENT_STATUS", details: parsed.error.flatten() });
  const restaurant = await Restaurant.findOneAndUpdate({ _id: restaurantId, "partnerProfile.documents._id": req.params.documentId }, { $set: { "partnerProfile.documents.$.status": parsed.data.status, "partnerProfile.documents.$.reviewNotes": parsed.data.reviewNotes, "partnerProfile.documents.$.reviewedAt": new Date(), "partnerProfile.documents.$.reviewedBy": objectId(req.auth!.employeeId!) } }, { new: true }).lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
  const document = (restaurant.partnerProfile?.documents || []).find((item: any) => String(item._id) === req.params.documentId);
  return res.json({ restaurantId, document: document ? { _id: document._id, type: document.type, fileName: document.fileName, status: document.status } : null });
});

app.post("/api/v1/public/rider-leads", async (req, res) => {
  const parsed = riderLeadSubmissionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_LEAD", details: parsed.error.flatten() });
  if (parsed.data.website) return res.status(400).json({ error: "INVALID_RIDER_LEAD" });
  const { website: _website, ...data } = parsed.data;
  try {
    const lead = await RiderLead.create({ ...data, email: normalizeLeadEmail(data.email), privacyNoticeAcceptedAt: new Date(), status: "new", history: [{ status: "new", notes: "Solicitud recibida desde Únete a PIKI." }] });
    await notifyOnboarding({ channel: "admin", type: "onboarding.rider_lead.created", entityId: String(lead._id), tenantId: (lead as any).tenantId });
    return res.status(201).json({ message: "Solicitud recibida. El equipo Fleet revisará tus datos y te contactará.", lead: { id: String(lead._id), status: lead.status } });
  } catch (error) {
    if ((error as any)?.code === 11000) return res.status(409).json({ error: "APPLICATION_ALREADY_EXISTS", message: "Ya existe una solicitud activa con este correo." });
    throw error;
  }
});

app.get("/api/v1/admin/rider-leads", requireRole("admin", "commercial", "gerente_comercial_zona"), async (req, res) => {
  const rawStatus = typeof req.query.status === "string" ? req.query.status : undefined;
  const parsedStatus = rawStatus && rawStatus !== "all" ? webLeadStatusSchema.safeParse(rawStatus) : null;
  if (parsedStatus && !parsedStatus.success) return res.status(400).json({ error: "INVALID_LEAD_STATUS" });
  const leads = await RiderLead.find(parsedStatus?.success ? { status: parsedStatus.data } : {}).sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ leads });
});

app.patch("/api/v1/admin/rider-leads/:id", requireRole("admin", "commercial", "gerente_comercial_zona"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam);
  if (!id) return res.status(400).json({ error: "INVALID_LEAD_ID" });
  const parsed = webLeadReviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_LEAD_REVIEW", details: parsed.error.flatten() });
  if (parsed.data.status === "info_requested" && !parsed.data.notes) return res.status(400).json({ error: "INFO_REQUEST_NOTES_REQUIRED" });
  const actor = req.auth?.employeeId ? objectId(req.auth.employeeId) : null;
  const lead = await RiderLead.findByIdAndUpdate(id, { $set: { status: parsed.data.status, notes: parsed.data.notes, reviewedBy: actor, reviewedAt: new Date() }, $push: { history: { status: parsed.data.status, notes: parsed.data.notes, actorEmployeeId: actor, changedAt: new Date() } } }, { new: true }).lean().exec();
  if (!lead) return res.status(404).json({ error: "RIDER_LEAD_NOT_FOUND" });
  return res.json({ lead });
});

app.post("/api/v1/riders/applications", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!allowRiderApplication(ip)) return res.status(429).json({ error: "APPLICATION_RATE_LIMITED", retryAfterSeconds: 900 });
  const parsed = riderApplicationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_APPLICATION", details: parsed.error.flatten() });
  if (parsed.data.website) return res.status(400).json({ error: "INVALID_RIDER_APPLICATION" });
  const documentTypes = new Set<string>(parsed.data.documents.map((document) => document.type));
  const missing: string[] = ["identity or residence_permit", "bank_certificate"].filter((required) => required === "identity or residence_permit" ? !documentTypes.has("identity") && !documentTypes.has("residence_permit") : !documentTypes.has(required));
  if (["motorcycle", "scooter", "car"].includes(parsed.data.vehicle)) {
    for (const required of ["driving_license", "insurance", "vehicle_registration", "vehicle_technical_sheet"]) if (!documentTypes.has(required)) missing.push(required);
  }
  if (parsed.data.vehicle === "electric_scooter") for (const required of ["scooter_responsible_declaration", "dgt_mvp_homologation"]) if (!documentTypes.has(required)) missing.push(required);
  if (missing.length) return res.status(400).json({ error: "REQUIRED_RIDER_DOCUMENTS_MISSING", required: missing });
  const duplicate = await RiderApplication.findOne({ email: parsed.data.email.toLowerCase(), status: { $in: ["pending", "contacted", "approved"] } }).lean().exec();
  if (duplicate) return res.status(409).json({ error: "APPLICATION_ALREADY_EXISTS" });
  const application = await RiderApplication.create({ ...parsed.data, email: parsed.data.email.toLowerCase(), status: "pending", source: "rider_landing" });
  await notifyOnboarding({ channel: "admin", type: "onboarding.rider_application.created", entityId: String(application._id), tenantId: (application as any).tenantId });
  return res.status(201).json({ message: "Solicitud recibida. El equipo Fleet se pondrá en contacto contigo.", application: { id: application.id, status: application.status } });
});

app.get("/api/v1/rider-applications", requireRole("admin"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const applications = await RiderApplication.find(status ? { status } : {}).sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ applications });
});

app.get("/api/v1/rider-applications/:id/documents", requireRole("admin"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const application = await RiderApplication.findById(id).select("name email documents").lean().exec() as any;
  if (!application) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  return res.json({ applicationId: application._id, name: application.name, email: application.email, documents: (application.documents || []).map(({ contentBase64, ...metadata }: any) => metadata) });
});
app.get("/api/v1/rider-applications/:id/documents/:documentId/content", requireRole("admin"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const application = await RiderApplication.findOne({ _id: id, "documents._id": req.params.documentId }).select("+documents.contentBase64").lean().exec() as any;
  const document = application?.documents?.find((item: any) => String(item._id) === req.params.documentId);
  if (!document) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
  return res.json({ fileName: document.fileName, mimeType: document.mimeType, sizeBytes: document.sizeBytes, sha256: document.sha256, contentBase64: document.contentBase64 });
});
app.patch("/api/v1/rider-applications/:id/documents/:documentId/status", requireRole("admin"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const parsed = z.object({ status: z.enum(["approved", "rejected"]), reviewNotes: z.string().max(1000).default("") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DOCUMENT_STATUS", details: parsed.error.flatten() });
  const application = await RiderApplication.findOneAndUpdate({ _id: id, "documents._id": req.params.documentId }, { $set: { "documents.$.status": parsed.data.status, "documents.$.reviewNotes": parsed.data.reviewNotes, "documents.$.reviewedAt": new Date(), "documents.$.reviewedBy": objectId(req.auth!.employeeId!) } }, { new: true }).select("name email documents").lean().exec() as any;
  if (!application) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
  return res.json({ applicationId: application._id, documents: (application.documents || []).map(({ contentBase64, ...metadata }: any) => metadata) });
});
app.patch("/api/v1/rider-applications/:id/status", requireRole("admin"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam); if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const parsed = z.object({ status: z.enum(["pending", "contacted", "approved", "rejected"]), notes: z.string().max(1000).optional(), assignedFleetId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_APPLICATION_STATUS", details: parsed.error.flatten() });
  const existing = await RiderApplication.findById(id).select("documents status tenantId").lean().exec() as any;
  if (!existing) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  if (parsed.data.status === "approved") {
    const documents = existing.documents || [];
    const allDocumentsApproved = documents.length > 0 && documents.every((document: any) => document.status === "approved");
    const identityApproved = documents.some((document: any) => ["identity", "residence_permit"].includes(document.type) && document.status === "approved");
    if (!allDocumentsApproved || !identityApproved) return res.status(409).json({ error: "RIDER_DOCUMENT_REVIEW_REQUIRED", message: "Valida todos los documentos, incluida la identidad, antes de aprobar el alta." });
  }
  const update: Record<string, unknown> = { status: parsed.data.status, notes: parsed.data.notes, reviewedBy: objectId(req.auth!.employeeId!), reviewedAt: new Date() };
  if (parsed.data.status === "approved") update.identityVerificationStatus = "verified";
  if (parsed.data.assignedFleetId !== undefined) update.assignedFleetId = parsed.data.assignedFleetId ? objectId(parsed.data.assignedFleetId) : null;
  const application = await RiderApplication.findByIdAndUpdate(id, { $set: update }, { new: true }).lean().exec() as any;
  if (!application) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  let approvedRiderId = "";
  if (parsed.data.status === "approved") {
    const existingRider = await Rider.findOne({ email: application.email }).select("_id riderCode").lean().exec() as any;
    const approvedRider = await Rider.findOneAndUpdate({ email: application.email }, { $set: { tenantId: application.tenantId || null, ...buildApprovedRiderOperationalProfile(application), fleetId: application.assignedFleetId || null, status: "offline" }, $setOnInsert: { riderCode: existingRider?.riderCode || await nextRiderCode() } }, { upsert: true, new: true }).select("_id").lean().exec() as any;
    approvedRiderId = approvedRider ? String(approvedRider._id) : "";
  }
  if (existing.status !== parsed.data.status && ["approved", "rejected"].includes(parsed.data.status)) {
    const type = `onboarding.rider_application.${parsed.data.status}`;
    const payload = { applicationId: String(application._id), riderId: approvedRiderId };
    await notifyOnboarding({ channel: "admin", type, entityId: String(application._id), tenantId: (application as any).tenantId, payload });
    if (parsed.data.status === "approved") await notifyOnboarding({ channel: "fleet", type, entityId: approvedRiderId || String(application._id), tenantId: (application as any).tenantId, payload });
  }
  const documentReviewPending = (application.documents || []).some((document: any) => document.status !== "approved");
  return res.json({ application, documentReviewPending, warning: documentReviewPending ? "La solicitud se ha gestionado; el expediente documental continúa pendiente de revisión." : undefined });
});

app.get("/api/v1/riders", requireRole("admin", "fleet"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const riders = await Rider.find({ ...(status ? { status } : {}), ...(await fleetRiderFilter(req)) }).sort({ name: 1 }).limit(200).lean().exec();
  return res.json({ riders });
});

const riderZoneSchema = z.object({ zoneSlug: z.string().regex(/^[a-z0-9-]+$/).nullable() });
app.patch("/api/v1/riders/:id/zone", requireRole("admin", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const parsed = riderZoneSchema.safeParse({ zoneSlug: req.body?.zoneSlug ?? req.body?.zone ?? null });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_ZONE" });
  const employee = req.auth?.role === "fleet" ? await employeeScope(req) : null;
  if (req.auth?.role === "fleet" && !employee?.fleetId) return res.status(403).json({ error: "FLEET_NOT_ASSIGNED" });
  const rider = await Rider.findOne({ _id: riderId, ...tenantScope(req), ...(await fleetRiderFilter(req)) }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  let zone = null;
  if (parsed.data.zoneSlug) {
    zone = await Zone.findOne({ ...tenantScope(req), slug: parsed.data.zoneSlug, isActive: true }).lean().exec() as any;
    if (!zone) return res.status(404).json({ error: "ZONE_NOT_FOUND", message: "La zona seleccionada no está activa o no existe." });
    if (req.auth?.role === "fleet") {
      const allowedZones = Array.isArray(employee?.zoneSlugs) && employee.zoneSlugs.length ? employee.zoneSlugs : (await Fleet.findById(employee.fleetId).select("serviceZones").lean().exec() as any)?.serviceZones || [];
      if (allowedZones.length && !allowedZones.includes(zone.slug)) return res.status(403).json({ error: "ZONE_ACCESS_DENIED" });
    }
  }
  const update: Record<string, unknown> = { zoneSlug: parsed.data.zoneSlug };
  if (req.auth?.role === "fleet" && !rider.fleetId) update.fleetId = employee?.fleetId;
  const updated = await Rider.findOneAndUpdate({ _id: riderId, ...tenantScope(req) }, { $set: update }, { new: true }).lean().exec() as any;
  return res.json({ rider: updated, zone });
});

app.get("/api/v1/rider-slots", requireRole("admin", "fleet", "rider"), async (req, res) => {
  const riderId = typeof req.query.riderId === "string" ? objectId(req.query.riderId) : null;
  const filter = riderId ? { riderId, ...tenantScope(req) } : { ...tenantScope(req) };
  const slots = await RiderSlot.find(filter).sort({ date: 1, startTime: 1 }).limit(500).lean().exec();
  return res.json({ slots });
});

app.post("/api/v1/rider-slots", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = riderSlotCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SLOT", details: parsed.error.flatten() });
  const riderId = objectId(parsed.data.riderId); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findOne({ _id: riderId, ...tenantScope(req) }).lean().exec() as any; if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  if (req.auth?.role === "fleet") {
    const employee = await employeeScope(req);
    if (!employee?.fleetId) return res.status(403).json({ error: "FLEET_NOT_ASSIGNED" });
    if (rider.fleetId && String(rider.fleetId) !== String(employee.fleetId)) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
    if (!rider.fleetId) await Rider.updateOne({ _id: riderId, fleetId: null }, { $set: { fleetId: employee.fleetId } }).exec();
  }
  const zone = await Zone.findOne({ ...tenantScope(req), slug: parsed.data.zoneSlug, isActive: true }).lean().exec() as any; if (!zone) return res.status(404).json({ error: "ZONE_NOT_FOUND" });
  const { riderId: _riderId, ...slotData } = parsed.data;
  const slot = await RiderSlot.findOneAndUpdate({ riderId, ...tenantScope(req), date: parsed.data.date, startTime: parsed.data.startTime }, { $set: { ...slotData, ...tenantScope(req), riderId, zoneSlug: zone.slug } }, { upsert: true, new: true }).lean().exec();
  return res.status(201).json({ slot });
});
app.post("/api/v1/rider-slots/week", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = riderSlotCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SLOT", details: parsed.error.flatten() });
  if (parsed.data.startTime === parsed.data.endTime) return res.status(400).json({ error: "INVALID_SLOT_TIME_RANGE" });
  const riderId = objectId(parsed.data.riderId); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findOne({ _id: riderId, ...tenantScope(req) }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  if (req.auth?.role === "fleet") {
    const employee = await employeeScope(req);
    if (!employee?.fleetId) return res.status(403).json({ error: "FLEET_NOT_ASSIGNED" });
    if (rider.fleetId && String(rider.fleetId) !== String(employee.fleetId)) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
    if (!rider.fleetId) await Rider.updateOne({ _id: riderId, fleetId: null }, { $set: { fleetId: employee.fleetId } }).exec();
  }
  const zone = await Zone.findOne({ ...tenantScope(req), slug: parsed.data.zoneSlug, isActive: true }).select("slug").lean().exec() as any;
  if (!zone) return res.status(404).json({ error: "ZONE_NOT_FOUND" });
  const start = new Date(`${parsed.data.date}T12:00:00Z`);
  const slots = [];
  for (let day = 0; day < 7; day += 1) {
    const date = new Date(start); date.setUTCDate(start.getUTCDate() + day);
    const dateString = date.toISOString().slice(0, 10);
    const slot = await RiderSlot.findOneAndUpdate(
      { riderId, ...tenantScope(req), date: dateString, startTime: parsed.data.startTime },
      { $set: { zoneSlug: zone.slug, date: dateString, startTime: parsed.data.startTime, endTime: parsed.data.endTime, status: parsed.data.status, notes: parsed.data.notes, ...tenantScope(req), riderId } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    ).lean().exec();
    slots.push(slot);
  }
  return res.status(201).json({ slots, count: slots.length });
});
app.patch("/api/v1/rider-slots/:id", requireRole("admin", "fleet"), async (req, res) => {
  const slotId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!slotId) return res.status(400).json({ error: "INVALID_RIDER_SLOT_ID" });
  const parsed = riderSlotSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SLOT", details: parsed.error.flatten() });
  if (parsed.data.startTime === parsed.data.endTime) return res.status(400).json({ error: "INVALID_SLOT_TIME_RANGE" });
  const existing = await RiderSlot.findOne({ _id: slotId, ...tenantScope(req) }).lean().exec() as any;
  if (!existing) return res.status(404).json({ error: "RIDER_SLOT_NOT_FOUND" });
  if (req.auth?.role === "fleet" && !(await fleetCanAccessRider(req, existing.riderId))) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
  const zone = await Zone.findOne({ ...tenantScope(req), slug: parsed.data.zoneSlug, isActive: true }).select("slug").lean().exec() as any;
  if (!zone) return res.status(404).json({ error: "ZONE_NOT_FOUND" });
  try {
    const slot = await RiderSlot.findOneAndUpdate({ _id: slotId, ...tenantScope(req) }, { $set: { ...parsed.data, zoneSlug: zone.slug } }, { new: true }).lean().exec();
    return res.json({ slot });
  } catch (error: any) {
    if (error?.code === 11000) return res.status(409).json({ error: "RIDER_SLOT_ALREADY_EXISTS", message: "Ya existe otro turno para ese rider, fecha y hora de inicio." });
    throw error;
  }
});
app.delete("/api/v1/rider-slots/:id", requireRole("admin", "fleet"), async (req, res) => {
  const slotId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!slotId) return res.status(400).json({ error: "INVALID_RIDER_SLOT_ID" });
  const existing = await RiderSlot.findOne({ _id: slotId, ...tenantScope(req) }).lean().exec() as any;
  if (!existing) return res.status(404).json({ error: "RIDER_SLOT_NOT_FOUND" });
  if (req.auth?.role === "fleet" && !(await fleetCanAccessRider(req, existing.riderId))) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
  const slot = await RiderSlot.findOneAndUpdate({ _id: slotId, ...tenantScope(req) }, { $set: { status: "cancelled" } }, { new: true }).lean().exec();
  return res.json({ slot, message: "Turno eliminado" });
});

app.post("/api/v1/orders", rateLimit(20, 60_000, "orders-create"), async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_ORDER", details: parsed.error.flatten() });
  if (parsed.data.paymentMethod !== "cash") return res.status(409).json({ error: "PAYMENT_METHOD_UNAVAILABLE", message: "Tarjeta y Bizum todavía no están disponibles. Selecciona efectivo al recibir." });
  const restaurantObjectId = objectId(parsed.data.restaurantId);
  if (!restaurantObjectId) return res.status(400).json({ error: "INVALID_RESTAURANT_ID" });
  const restaurant = await Restaurant.findOne({ _id: restaurantObjectId, isActive: true, onboardingStatus: "approved" }).lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_AVAILABLE" });
  const items = parsed.data.items.map((requested) => { const item = restaurant.menu.find((candidate: any) => candidate.id === requested.itemId); return item ? { itemId: item.id, name: item.name, quantity: requested.quantity, unitPriceCents: Math.round(item.price * 100) } : null; });
  if (items.some((item) => !item)) return res.status(400).json({ error: "INVALID_MENU_ITEM" });
  const normalizedItems = items as Array<{ itemId: string; name: string; quantity: number; unitPriceCents: number }>;
  const deliveryPoint: [number, number] = [parsed.data.deliveryLocation.longitude, parsed.data.deliveryLocation.latitude];
  const coverage = evaluateXativaCoverage(deliveryPoint);
  if (!coverage.covered || coverage.deliveryFeeCents === null || coverage.serviceFeeCents === null) {
    return res.status(422).json({ error: "DELIVERY_OUTSIDE_XATIVA_RADIUS", message: "Todavía no repartimos en esa dirección.", ...coverage });
  }
  const restaurantPoint = restaurant.location?.coordinates;
  if (!Array.isArray(restaurantPoint) || restaurantPoint.length < 2) return res.status(409).json({ error: "RESTAURANT_LOCATION_UNAVAILABLE" });
  const route = await quoteDeliveryRoute([Number(restaurantPoint[0]), Number(restaurantPoint[1])], deliveryPoint);
  const subtotalCents = normalizedItems.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const deliveryFeeCents = coverage.deliveryFeeCents;
  const serviceFeeCents = coverage.serviceFeeCents;
  const totalCents = subtotalCents + deliveryFeeCents + serviceFeeCents;
  const publicCode = `PIKI-${Date.now().toString(36).toUpperCase()}`;
  const dailyCode = await createDailyDisplayCode();
  const authenticatedCustomer = await currentCustomer(req) as any;
  const order = await Order.create({ tenantId: restaurant.tenantId || null, publicCode, ...dailyCode, restaurantId: restaurant._id, customerId: authenticatedCustomer?._id || null, items: normalizedItems, deliveryAddress: parsed.data.deliveryAddress, deliveryLocation: { type: "Point", coordinates: deliveryPoint }, coveragePolicySlug: coverage.policySlug, coveragePolicyVersion: coverage.policyVersion, coverageDecision: coverage.reason, straightLineDistanceKm: coverage.straightLineDistanceKm, withinMunicipality: coverage.withinMunicipality, deliveryBaseFeeCents: coverage.deliveryBaseFeeCents, outsideMunicipalitySurchargeCents: coverage.outsideMunicipalitySurchargeCents, routeDistanceKm: route.routeDistanceKm, routeDurationMinutes: route.routeDurationMinutes, routeProvider: route.routeProvider, routingDegraded: route.routingDegraded, requiredVehicleClasses: route.requiredVehicleClasses, subtotalCents, deliveryFeeCents, serviceFeeCents, totalCents, paymentMethod: parsed.data.paymentMethod, paymentState: "pending", statusHistory: [{ status: "pending", actorRole: "customer", reason: parsed.data.paymentMethod === "cash" ? "Pedido a contrarreembolso; cobro pendiente hasta la entrega" : "Pedido creado con política de cobertura Xàtiva" }] });
  if (parsed.data.paymentMethod === "cash") {
    const dispatch = queueAutomaticDispatch(order._id as mongoose.Types.ObjectId).catch((error) => console.warn("Immediate cash-order dispatch failed", error instanceof Error ? error.message : error));
    await Promise.all([dispatch, publishOrderIntakeEvents(order, { settlement: "cash_due", message: "Contrarreembolso: el Rider cobrará en efectivo al entregar." })]);
  }
  res.status(201).json({ order: { id: order.id, publicCode, displayCode: order.displayCode, displayCodeDate: order.displayCodeDate, status: order.status, paymentState: parsed.data.paymentMethod === "cash" ? "pending_cash_collection" : order.paymentState, paymentMethod: parsed.data.paymentMethod, cashDueAtDelivery: parsed.data.paymentMethod === "cash", deliveryQrUrl: deliveryQrUrl(publicCode), subtotalCents, deliveryFeeCents, serviceFeeCents, totalCents, coverage, route, etaMinutes: calculateEtaRange([restaurant.etaMinutes[0] || 20, restaurant.etaMinutes[1] || 35], [5, 20]) } });
});

const customerOrderSyncSchema = z.object({ publicCode: z.string().trim().min(6).max(64), restaurantSlug: z.string().trim().min(1).max(120), customerId: z.string().nullable().optional(), deliveryAddress: z.string().trim().min(5).max(1000), deliveryLocation: z.object({ latitude: z.number().finite(), longitude: z.number().finite() }).nullable().optional(), items: z.array(z.object({ itemId: z.string().min(1), name: z.string().min(1), quantity: z.number().int().min(1).max(20), unitPriceCents: z.number().int().min(0), totalCents: z.number().int().min(0).optional() })).min(1), subtotalCents: z.number().int().min(0), deliveryFeeCents: z.number().int().min(0), serviceFeeCents: z.number().int().min(0), totalCents: z.number().int().min(0), paymentMethod: z.enum(["stripe", "cash"]).default("stripe"), paymentState: z.enum(["pending", "authorized", "paid", "failed", "refunded"]).default("pending"), stripeCheckoutSessionId: z.string().nullable().optional(), stripePaymentIntentId: z.string().nullable().optional() });
app.post("/api/v1/internal/customer-orders/sync", async (req, res) => {
  const expected = process.env.PIKI_CUSTOMER_SYNC_SECRET;
  if (!expected || req.header("x-piki-customer-sync-secret") !== expected) return res.status(401).json({ error: "INVALID_SYNC_AUTH" });
  const parsed = customerOrderSyncSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_CUSTOMER_ORDER", details: parsed.error.flatten() });
  const input = parsed.data;
  const restaurantId = objectId(input.restaurantSlug);
  const restaurant = await Restaurant.findOne({ $or: [{ slug: input.restaurantSlug }, ...(restaurantId ? [{ _id: restaurantId }] : [])], isActive: true, onboardingStatus: "approved" }).lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_AVAILABLE" });
  const existing = await Order.findOne({ publicCode: input.publicCode }).lean().exec() as any;
  const location = input.deliveryLocation ? { type: "Point", coordinates: [input.deliveryLocation.longitude, input.deliveryLocation.latitude] } : restaurant.location;
  if (!location?.coordinates?.length) return res.status(409).json({ error: "DELIVERY_LOCATION_REQUIRED" });
  // Customer is the source of truth: never rebuild lines from a second menu copy.
  // This prevents price/name drift between Customer, Partner and Rider screens.
  const canonicalItems = input.items.map(({ itemId, name, quantity, unitPriceCents, totalCents }) => ({ itemId, name, quantity, unitPriceCents, ...(totalCents == null ? {} : { totalCents }) }));
  const order = await Order.findOneAndUpdate({ publicCode: input.publicCode }, { $set: { tenantId: restaurant.tenantId || null, restaurantId: restaurant._id, customerId: input.customerId || null, items: canonicalItems, deliveryAddress: input.deliveryAddress, deliveryLocation: location, subtotalCents: input.subtotalCents, deliveryFeeCents: input.deliveryFeeCents, serviceFeeCents: input.serviceFeeCents, totalCents: input.totalCents, paymentMethod: input.paymentMethod, paymentState: input.paymentState, ...(input.stripeCheckoutSessionId !== undefined ? { stripeCheckoutSessionId: input.stripeCheckoutSessionId } : {}), ...(input.stripePaymentIntentId !== undefined ? { stripePaymentIntentId: input.stripePaymentIntentId } : {}), ...(["authorized", "paid"].includes(input.paymentState) && !["authorized", "paid"].includes(existing?.paymentState || "") ? { status: "pending", assignmentState: "unassigned" } : {}) }, $setOnInsert: { publicCode: input.publicCode, status: "pending", assignmentState: "unassigned", statusHistory: [{ status: "pending", actorRole: "system", reason: "Pedido sincronizado desde PIKI Customer" }] } }, { upsert: true, new: true, setDefaultsOnInsert: true }).lean().exec() as any;
  const newlyPaid = ["authorized", "paid"].includes(input.paymentState) && !["authorized", "paid"].includes(existing?.paymentState || "");
  const newCashOrder = input.paymentMethod === "cash" && !existing;
  if (newlyPaid || newCashOrder) {
    const dispatch = queueAutomaticDispatch(order._id as mongoose.Types.ObjectId).catch((error) => console.warn("Immediate order dispatch failed", error instanceof Error ? error.message : error));
    const settlement = newCashOrder
      ? { settlement: "cash_due" as const, message: "Contrarreembolso recibido desde PIKI Customer: el Rider cobrará al entregar." }
      : { settlement: "paid" as const, message: "Pago confirmado desde PIKI Customer." };
    await Promise.all([dispatch, publishOrderIntakeEvents(order, settlement)]);
  }
  return res.status(existing ? 200 : 201).json({ order: { id: order._id, publicCode: order.publicCode, checkoutToken: checkoutToken(order.publicCode), status: order.status, paymentState: order.paymentState, assignmentState: order.assignmentState } });
});

function requireCustomerSyncSecret(req: express.Request, res: express.Response) {
  const expected = process.env.PIKI_CUSTOMER_SYNC_SECRET;
  if (!expected || req.header("x-piki-customer-sync-secret") !== expected) { res.status(401).json({ error: "INVALID_SYNC_AUTH" }); return false; }
  return true;
}

const customerSupportCreateSchema = z.object({ customerId: z.string().trim().min(1).max(160), customerName: z.string().trim().min(1).max(160), customerEmail: z.string().email(), orderRef: z.string().trim().max(120).optional(), category: z.enum(["order", "account", "technical", "billing", "finance", "other"]).default("order"), priority: z.enum(["low", "normal", "high"]).default("normal"), subject: z.string().trim().min(3).max(180), description: z.string().trim().min(3).max(4000) });
const customerSupportListSchema = z.object({ customerId: z.string().trim().min(1).max(160), customerEmail: z.string().email() });
app.post("/api/v1/internal/customer-support/tickets", async (req, res) => {
  if (!requireCustomerSyncSecret(req, res)) return;
  const parsed = customerSupportCreateSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_CUSTOMER_SUPPORT_TICKET", details: parsed.error.flatten() });
  const input = parsed.data;
  let orderId: mongoose.Types.ObjectId | null = null;
  if (input.orderRef) {
    const order = await Order.findOne({ ...supportOrderFilter(input.orderRef), customerId: input.customerId }).select("_id").lean().exec() as any;
    if (!order) return res.status(404).json({ error: "CUSTOMER_ORDER_NOT_FOUND" });
    orderId = order._id;
  }
  const ticket = await SupportTicket.create({ customerId: input.customerId, reporterEmail: input.customerEmail, sourceSurface: "customer", sourceRole: "customer", category: input.category, priority: input.priority, subject: input.subject, description: input.description, orderId, ticketNumber: `SUP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomInt(1000, 9999)}`, actions: [{ action: "ticket_created", metadata: { sourceSurface: "customer", customerId: input.customerId, customerName: input.customerName, orderRef: input.orderRef || null } }] });
  return res.status(201).json({ ticket: { _id: ticket._id, ticketNumber: ticket.ticketNumber, subject: ticket.subject, description: ticket.description, category: ticket.category, priority: ticket.priority, status: ticket.status, reporterEmail: ticket.reporterEmail, messages: ticket.messages, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt } });
});
app.post("/api/v1/internal/customer-support/tickets/list", async (req, res) => {
  if (!requireCustomerSyncSecret(req, res)) return;
  const parsed = customerSupportListSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_CUSTOMER_SUPPORT_QUERY" });
  const { customerId, customerEmail } = parsed.data;
  const tickets = await SupportTicket.find({ $or: [{ customerId }, { customerId: "", reporterEmail: customerEmail }] }).sort({ updatedAt: -1 }).limit(100).lean().exec();
  return res.json({ tickets });
});
app.get("/api/v1/internal/customer-orders/:publicCode/tracking", async (req, res) => {
  if (!requireCustomerSyncSecret(req, res)) return;
  const order = await Order.findOne({ publicCode: String(req.params.publicCode) }).lean().exec() as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const rider = order.riderId ? await Rider.findById(order.riderId).select("name vehicle location lastLocationAt photoUrl").lean().exec() as any : null;
  const coordinates = rider?.location?.coordinates;
  const updatedAt = rider?.lastLocationAt ? new Date(rider.lastLocationAt).getTime() : 0;
  const fresh = Array.isArray(coordinates) && coordinates.length >= 2 && updatedAt >= Date.now() - 120_000;
  const active = order.assignmentState === "assigned" && ["picked_up", "on_the_way"].includes(order.status);
  return res.json({ publicCode: order.publicCode, status: order.status, assignmentState: order.assignmentState, paymentMethod: order.paymentMethod, paymentState: order.paymentState, cashDueAtDelivery: order.paymentMethod === "cash" && order.paymentState !== "paid", riderId: rider?._id ? String(rider._id) : null, riderName: rider?.name || null, riderPhotoUrl: rider?.photoUrl || null, vehicle: rider?.vehicle || "bike", chatAvailable: active, locationAvailable: active && fresh, latitude: fresh ? Number(coordinates[1]) : null, longitude: fresh ? Number(coordinates[0]) : null, updatedAt: fresh ? updatedAt : null });
});
app.post("/api/v1/internal/customer-orders/:publicCode/messages", async (req, res) => {
  if (!requireCustomerSyncSecret(req, res)) return;
  const order = await Order.findOne({ publicCode: String(req.params.publicCode) }).lean().exec() as any;
  const customerId = String(req.body?.customerId || "");
  if (!order || !order.customerId || String(order.customerId) !== customerId || !order.riderId || !["picked_up", "on_the_way"].includes(order.status)) return res.status(403).json({ error: "CHAT_NOT_AVAILABLE" });
  if (req.body?.action === "send") {
    const body = String(req.body?.body || "").trim();
    if (!body || body.length > 500) return res.status(400).json({ error: "INVALID_MESSAGE" });
    const message = await RiderOrderMessage.create({ orderId: order._id, riderId: order.riderId, senderRole: "customer", body });
    return res.status(201).json({ id: String(message._id), senderRole: message.senderRole, body: message.body, createdAt: message.createdAt });
  }
  const messages = await RiderOrderMessage.find({ orderId: order._id }).sort({ createdAt: 1 }).limit(100).lean().exec();
  return res.json({ messages: messages.map((message: any) => ({ id: String(message._id), senderRole: message.senderRole, body: message.body, createdAt: message.createdAt })) });
});

const checkoutSchema = z.object({ orderId: z.string().min(1), checkoutToken: z.string().min(20).max(200), origin: z.string().url().refine((value) => isAllowedCorsOrigin(value), "INVALID_CHECKOUT_ORIGIN"), customerEmail: z.string().email().optional() });
app.post("/api/v1/payments/checkout", rateLimit(20, 60_000, "payments-checkout"), async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_CHECKOUT_REQUEST", details: parsed.error.flatten() });
  const id = objectId(parsed.data.orderId);
  const order = (id ? await Order.findById(id).lean().exec() : await Order.findOne({ publicCode: parsed.data.orderId }).lean().exec()) as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  if (!checkoutTokenIsValid(order.publicCode, parsed.data.checkoutToken)) return res.status(403).json({ error: "INVALID_CHECKOUT_TOKEN" });
  if (order.paymentMethod !== "stripe") return res.status(409).json({ error: "ORDER_USES_CASH", message: "Este pedido está configurado para pago en efectivo." });
  if (["authorized", "paid"].includes(order.paymentState)) return res.status(409).json({ error: "ORDER_ALREADY_PAID" });
  try {
    const session = await createCheckoutSession({
      orderId: String(order._id),
      publicCode: order.publicCode,
      origin: parsed.data.origin,
      customerEmail: parsed.data.customerEmail,
      items: (order.items || []).map((item: any) => ({ name: item.name, quantity: Number(item.quantity), unitPriceCents: Number(item.unitPriceCents) })),
      deliveryFeeCents: Number(order.deliveryFeeCents || 0),
      serviceFeeCents: Number(order.serviceFeeCents || 0),
      preferredPaymentMethod: "stripe",
    });
    await Order.updateOne({ _id: order._id, paymentState: "pending" }, { $set: { stripeCheckoutSessionId: session.id }, $inc: { version: 1 } }).exec();
    return res.status(201).json({ checkoutUrl: session.url, sessionId: session.id, orderId: String(order._id), publicCode: order.publicCode });
  } catch (error) {
    console.error(JSON.stringify({ event: "stripe_checkout_failed", orderId: String(order._id), errorType: error instanceof Error ? error.name : "UnknownError" }));
    return res.status(503).json({ error: "STRIPE_CHECKOUT_UNAVAILABLE", message: "El pago online no está disponible temporalmente." });
  }
});


const supportTicketInput = z.object({ orderRef: z.string().trim().max(120).optional(), reporterEmail: z.string().email().optional(), category: z.enum(["order", "rider", "partner", "account", "technical", "billing", "finance", "other"]).default("order"), priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"), subject: z.string().trim().min(3).max(180), description: z.string().trim().min(3).max(4000) });
const supportMessageInput = z.object({ body: z.string().trim().min(1).max(2000) });
const supportStatusInput = z.object({ status: z.enum(["open", "in_progress", "waiting", "resolved", "closed"]) });
const supportCancelInput = z.object({ reason: z.string().trim().min(10).max(500), ticketId: z.string().optional() });
function supportOrderFilter(ref: string): Record<string, unknown> { const id = objectId(ref); return id ? { _id: id } : { $or: [{ publicCode: ref }, { displayCode: ref }] }; }
async function enrichSupportTickets(tickets: any[]) {
  const orderIds = tickets.map((ticket) => ticket.orderId?._id || ticket.orderId).filter((id) => id && mongoose.isValidObjectId(id));
  if (!orderIds.length) return tickets;
  const orders = await Order.find({ _id: { $in: orderIds } }).select("_id publicCode displayCode status paymentState paymentMethod customerId customerPhone riderId restaurantId items deliveryAddress deliveryLocation subtotalCents deliveryFeeCents serviceFeeCents totalCents createdAt updatedAt statusHistory assignmentState assignedAt deliveredAt cancelledAt").select("+customerPhone").populate("riderId", "name riderCode email phone").populate("restaurantId", "name address phone email").lean().exec() as any[];
  const customerIds = orders.map((order) => order.customerId).filter((id) => mongoose.isValidObjectId(String(id))).map((id) => new mongoose.Types.ObjectId(String(id)));
  const customers = customerIds.length ? await CustomerAccount.find({ _id: { $in: customerIds } }).select("name email deliveryAddress").lean().exec() as any[] : [];
  const customerMap = new Map(customers.map((customer) => [String(customer._id), customer]));
  const orderMap = new Map(orders.map((order) => [String(order._id), { ...order, customer: order.customerId ? customerMap.get(String(order.customerId)) || null : null, customerPhone: order.customerPhone || null }]));
  return tickets.map((ticket) => { const orderId = ticket.orderId?._id || ticket.orderId; const order = orderMap.get(String(orderId)); return order ? { ...ticket, orderId: order } : ticket; });
}
const supportRoles = ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "support"] as const;
const financeTicketCategories = ["billing", "finance"] as const;
const isFinanceTicketCategory = (category: string) => financeTicketCategories.includes(category as typeof financeTicketCategories[number]);
const ticketRoleScope = (req: express.Request): Record<string, unknown> => req.auth?.role === "finance" ? { category: { $in: financeTicketCategories } } : req.auth?.role === "support" ? { category: { $nin: financeTicketCategories } } : {};
app.post("/api/v1/support/tickets", requireRole(...supportRoles), async (req, res) => {
  const parsed = supportTicketInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_SUPPORT_TICKET", details: parsed.error.flatten() });
  if (req.auth?.role === "support" && isFinanceTicketCategory(parsed.data.category)) return res.status(403).json({ error: "SUPPORT_TICKET_CATEGORY_RESTRICTED" });
  const order = parsed.data.orderRef ? await Order.findOne({ ...tenantScope(req), ...supportOrderFilter(parsed.data.orderRef) }).select("_id").lean().exec() as any : null;
  if (parsed.data.orderRef && !order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const actorEmployeeId = objectId(String(req.auth?.employeeId || ""));
  const sourceSurface = String(req.header("x-piki-surface") || "admin").toLowerCase();
  const ticket = await SupportTicket.create({ ...parsed.data, reporterEmail: parsed.data.reporterEmail || "", sourceSurface, sourceRole: req.auth?.role || "", orderId: order?._id || null, ticketNumber: `SUP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomInt(1000, 9999)}`, createdBy: actorEmployeeId, actions: [{ action: "ticket_created", actorEmployeeId, metadata: { orderRef: parsed.data.orderRef || null, sourceSurface, sourceRole: req.auth?.role || null } }] });
  return res.status(201).json({ ticket });
});
app.get("/api/v1/support/tickets/mine", requireRole(...supportRoles), async (req, res) => {
  const tickets = await SupportTicket.find({ ...tenantScope(req), ...ticketRoleScope(req), $or: [{ createdBy: objectId(String(req.auth?.employeeId || "")) }, { reporterEmail: String(req.query.email || "").toLowerCase() }] }).sort({ updatedAt: -1 }).limit(100).lean().exec();
  return res.json({ tickets });
});
app.get("/api/v1/admin/support/orders/search", requireRole("admin", "support"), async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (q.length < 2) return res.json({ orders: [] });
  const orders = await Order.find({ ...tenantScope(req), ...supportOrderFilter(q) }).sort({ createdAt: -1 }).limit(25).select("_id publicCode displayCode status paymentState paymentMethod riderId restaurantId customerId totalCents createdAt statusHistory").populate("riderId", "name riderCode email").populate("restaurantId", "name").lean().exec();
  return res.json({ orders });
});
app.get("/api/v1/admin/support/tickets", requireRole("admin", "support", "finance"), async (req, res) => {
  const filter: Record<string, unknown> = { ...tenantScope(req), ...ticketRoleScope(req) };
  if (typeof req.query.status === "string" && req.query.status !== "all") filter.status = req.query.status;
  if (typeof req.query.q === "string" && req.query.q.trim()) { const q = req.query.q.trim(); filter.$or = [{ ticketNumber: q }, { reporterEmail: { $regex: q, $options: "i" } }, { subject: { $regex: q, $options: "i" } }]; }
  const tickets = await SupportTicket.find(filter).sort({ updatedAt: -1 }).limit(500).populate("assignedTo", "name email").lean().exec();
  return res.json({ tickets: await enrichSupportTickets(tickets) });
});
app.post("/api/v1/admin/support/tickets", requireRole("admin", "support", "finance"), async (req, res) => {
  const parsed = supportTicketInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_SUPPORT_TICKET", details: parsed.error.flatten() });
  if (req.auth?.role === "finance" && !isFinanceTicketCategory(parsed.data.category)) return res.status(403).json({ error: "FINANCE_TICKET_CATEGORY_REQUIRED" });
  if (req.auth?.role === "support" && isFinanceTicketCategory(parsed.data.category)) return res.status(403).json({ error: "SUPPORT_TICKET_CATEGORY_RESTRICTED" });
  const order = parsed.data.orderRef ? await Order.findOne({ ...tenantScope(req), ...supportOrderFilter(parsed.data.orderRef) }).select("_id").lean().exec() as any : null;
  if (parsed.data.orderRef && !order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const actorEmployeeId = objectId(String(req.auth?.employeeId || ""));
  const ticket = await SupportTicket.create({ ...parsed.data, orderId: order?._id || null, ticketNumber: `SUP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomInt(1000, 9999)}`, createdBy: actorEmployeeId, actions: [{ action: "ticket_created", actorEmployeeId, metadata: { orderRef: parsed.data.orderRef || null } }] });
  return res.status(201).json({ ticket });
});
async function supportAgent(req: express.Request) {
  return req.auth?.employeeId ? await EmployeeAccount.findOne({ _id: req.auth.employeeId, ...tenantScope(req) }).select("_id name email").lean().exec() as any : null;
}
async function riderForSupportTicket(ticket: any) {
  if (ticket.orderId) { const order = await Order.findById(ticket.orderId).select("riderId").lean().exec() as any; if (order?.riderId) return String(order.riderId); }
  const rider = ticket.reporterEmail ? await Rider.findOne({ email: ticket.reporterEmail }).select("_id").lean().exec() as any : null;
  return rider ? String(rider._id) : null;
}
app.post("/api/v1/admin/support/tickets/:id/messages", requireRole("admin", "support", "finance"), async (req, res) => {
  const parsed = supportMessageInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_SUPPORT_MESSAGE" });
  const id = objectId(String(req.params.id)); if (!id) return res.status(400).json({ error: "INVALID_TICKET_ID" });
  const agent = await supportAgent(req); if (!agent) return res.status(403).json({ error: "SUPPORT_AGENT_NOT_FOUND" });
  const agentDisplayName = String(agent.name || agent.email || "Agente de soporte").trim().split(/\s+/).slice(0, 2).join(" ");
  const current = await SupportTicket.findOne({ _id: id, ...tenantScope(req), ...ticketRoleScope(req) }).lean().exec() as any;
  if (!current) return res.status(404).json({ error: "TICKET_NOT_FOUND" });
  if (["resolved", "closed"].includes(current.status)) return res.status(409).json({ error: "SUPPORT_CHAT_CLOSED" });
  if (current.assignedTo && String(current.assignedTo) !== String(agent._id)) return res.status(409).json({ error: "SUPPORT_TICKET_ASSIGNED", assignedTo: String(current.assignedTo) });
  const ticket = await SupportTicket.findOneAndUpdate({ _id: id, ...tenantScope(req), ...ticketRoleScope(req), $or: [{ assignedTo: null }, { assignedTo: agent._id }] }, { $push: { messages: { senderRole: "support", senderEmployeeId: agent._id, senderName: agentDisplayName, body: parsed.data.body } }, $set: { status: "in_progress", assignedTo: agent._id, agentTypingAt: null } }, { new: true }).populate("assignedTo", "name email").lean().exec() as any;
  const riderId = await riderForSupportTicket(current);
  if (riderId) void publishRealtimeEvent({ channel: "rider", audienceKey: `rider:${riderId}`, tenantId: current.tenantId, type: "support.message", payload: { ticketId: String(id), status: ticket?.status, senderRole: "support" } });
  return res.json({ ticket });
});
app.patch("/api/v1/admin/support/tickets/:id/status", requireRole("admin", "support", "finance"), async (req, res) => {
  const parsed = supportStatusInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_SUPPORT_STATUS" });
  const id = objectId(String(req.params.id)); if (!id) return res.status(400).json({ error: "INVALID_TICKET_ID" });
  const actorEmployeeId = objectId(String(req.auth?.employeeId || ""));
  const agent = await supportAgent(req); if (!agent) return res.status(403).json({ error: "SUPPORT_AGENT_NOT_FOUND" });
  const current = await SupportTicket.findOne({ _id: id, ...tenantScope(req), ...ticketRoleScope(req) }).select("assignedTo category").lean().exec() as any;
  if (!current) return res.status(404).json({ error: "TICKET_NOT_FOUND" });
  if (current.assignedTo && String(current.assignedTo) !== String(agent._id)) return res.status(409).json({ error: "SUPPORT_TICKET_ASSIGNED", assignedTo: String(current.assignedTo) });
  const ticket = await SupportTicket.findOneAndUpdate({ _id: id, ...tenantScope(req), ...ticketRoleScope(req) }, { $set: { status: parsed.data.status, assignedTo: agent._id, ...(parsed.data.status === "resolved" || parsed.data.status === "closed" ? { resolvedAt: new Date() } : {}) }, $push: { actions: { action: "status_changed", actorEmployeeId, reason: parsed.data.status === "closed" ? `Conversación cerrada por ${String(agent.name || agent.email || "Agente de soporte").trim().split(/\s+/).slice(0, 2).join(" ")}.` : "", metadata: { status: parsed.data.status, agentName: String(agent.name || agent.email || "Agente de soporte").trim().split(/\s+/).slice(0, 2).join(" ") } } } }, { new: true }).populate("assignedTo", "name email").lean().exec();
  if (!ticket) return res.status(404).json({ error: "TICKET_NOT_FOUND" });
  return res.json({ ticket });
});
app.post("/api/v1/admin/support/orders/:id/cancel", requireRole("admin", "support"), async (req, res) => {
  const parsed = supportCancelInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_SUPPORT_CANCELLATION", details: parsed.error.flatten() });
  const orderId = objectId(String(req.params.id)); if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findOne({ _id: orderId, ...tenantScope(req) }).lean().exec() as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  if (["delivered", "cancelled"].includes(order.status)) return res.status(409).json({ error: "ORDER_ALREADY_CLOSED", status: order.status });
  const updated = await Order.findOneAndUpdate({ _id: orderId, status: order.status, version: order.version }, { $set: { status: "cancelled", cancelledAt: new Date() }, $inc: { version: 1 }, $push: { statusHistory: { status: "cancelled", actorRole: "admin", reason: parsed.data.reason } } }, { new: true }).lean().exec();
  if (!updated) return res.status(409).json({ error: "ORDER_CHANGED_RETRY" });
  await releaseRiderOrderSlot(orderId, order.riderId);
  const actorEmployeeId = objectId(String(req.auth?.employeeId || ""));
  if (parsed.data.ticketId) await SupportTicket.updateOne({ _id: objectId(parsed.data.ticketId), ...tenantScope(req) }, { $push: { actions: { action: "order_cancelled", actorEmployeeId, reason: parsed.data.reason, metadata: { orderId: String(orderId) } } } }).exec();
  scheduleCustomerOrderPush(updated, "cancelled");
  return res.json({ order: updated, audit: { action: "order_cancelled", reason: parsed.data.reason } });
});
app.post("/api/v1/riders/:id/support/tickets", requireRole("rider"), async (req, res) => {
  const parsed = z.object({ subject: z.string().trim().min(3).max(180), description: z.string().trim().min(3).max(4000), priority: z.enum(["low", "normal", "high", "urgent"]).default("normal"), orderId: z.string().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SUPPORT_TICKET", details: parsed.error.flatten() });
  const riderId = objectId(String(req.params.id)); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  if (!(await canAccessRiderShift(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const rider = await Rider.findOne({ _id: riderId, ...tenantScope(req) }).select("email name").lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  let orderId: mongoose.Types.ObjectId | null = null;
  if (parsed.data.orderId) {
    orderId = objectId(parsed.data.orderId);
    if (!orderId || !(await Order.exists({ _id: orderId, riderId, ...tenantScope(req) }))) return res.status(404).json({ error: "RIDER_ORDER_NOT_FOUND" });
  }
  const ticket = await SupportTicket.create({ tenantId: (rider as any).tenantId || null, orderId, reporterEmail: rider.email, sourceSurface: "rider", sourceRole: "rider", category: "rider", priority: parsed.data.priority, subject: parsed.data.subject, description: parsed.data.description, ticketNumber: `SUP-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${randomInt(1000, 9999)}`, messages: [{ senderRole: "rider", senderName: rider.name, body: parsed.data.description }], actions: [{ action: "rider_ticket_created", metadata: { riderId: String(riderId) } }] });
  void publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey((rider as any).tenantId, "admin"), tenantId: (rider as any).tenantId, type: "support.ticket_created", payload: { ticketId: String(ticket._id), priority: ticket.priority, orderId: orderId ? String(orderId) : null } });
  return res.status(201).json({ ticket: { id: ticket._id, ticketNumber: ticket.ticketNumber, status: ticket.status, messages: ticket.messages } });
});
app.get("/api/v1/riders/:riderId/support/tickets", requireRole("rider"), async (req, res) => {
  const riderId = objectId(String(req.params.riderId)); if (!riderId || !(await canAccessRiderShift(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const rider = await Rider.findOne({ _id: riderId, ...tenantScope(req) }).select("email").lean().exec() as any; if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const tickets = await SupportTicket.find({ ...tenantScope(req), reporterEmail: rider.email }).sort({ updatedAt: -1 }).limit(50).populate("assignedTo", "name email").lean().exec();
  return res.json({ tickets });
});
app.post("/api/v1/admin/support/tickets/:id/typing", requireRole("admin", "support", "finance"), async (req, res) => {
  const agent = await supportAgent(req); if (!agent) return res.status(403).json({ error: "SUPPORT_AGENT_NOT_FOUND" });
  const active = Boolean(req.body?.active);
  const ticket = await SupportTicket.findOneAndUpdate({ _id: req.params.id, ...tenantScope(req), ...ticketRoleScope(req), $or: [{ assignedTo: null }, { assignedTo: agent._id }] }, { $set: { agentTypingAt: active ? new Date() : null, ...(active ? { assignedTo: agent._id, status: "in_progress" } : {}) } }, { new: true }).lean().exec() as any;
  if (!ticket) return res.status(404).json({ error: "TICKET_NOT_FOUND_OR_ASSIGNED" });
  return res.json({ ok: true, agentTypingAt: ticket.agentTypingAt });
});

app.post("/api/v1/riders/:riderId/support/tickets/:ticketId/typing", requireRole("rider"), async (req, res) => {
  const rider = await Rider.findById(req.params.riderId).lean().exec() as any; if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const active = Boolean(req.body?.active);
  const ticket = await SupportTicket.findOneAndUpdate({ _id: req.params.ticketId, reporterEmail: rider.email, ...tenantScope(req), status: { $nin: ["resolved", "closed"] } }, { $set: { riderTypingAt: active ? new Date() : null } }, { new: true }).lean().exec() as any;
  if (!ticket) return res.status(404).json({ error: "TICKET_NOT_FOUND" });
  return res.json({ ok: true, riderTypingAt: ticket.riderTypingAt });
});

app.post("/api/v1/riders/:riderId/support/tickets/:ticketId/messages", requireRole("rider"), async (req, res) => {
  const parsed = supportMessageInput.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_SUPPORT_MESSAGE" });
  const riderId = objectId(String(req.params.riderId)); const ticketId = objectId(String(req.params.ticketId)); if (!riderId || !ticketId || !(await canAccessRiderShift(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const rider = await Rider.findOne({ _id: riderId, ...tenantScope(req) }).select("email name").lean().exec() as any; if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const current = await SupportTicket.findOne({ _id: ticketId, reporterEmail: rider.email, ...tenantScope(req) }).lean().exec() as any; if (!current) return res.status(404).json({ error: "TICKET_NOT_FOUND" });
  if (["resolved", "closed"].includes(current.status)) return res.status(409).json({ error: "SUPPORT_CHAT_CLOSED" });
  const ticket = await SupportTicket.findOneAndUpdate({ _id: ticketId, reporterEmail: rider.email, ...tenantScope(req) }, { $push: { messages: { senderRole: "rider", senderName: rider.name, body: parsed.data.body } }, $set: { status: current.assignedTo ? "in_progress" : "open", riderTypingAt: null } }, { new: true }).populate("assignedTo", "name email").lean().exec();
  return res.json({ ticket });
});
app.get("/api/v1/orders", requireRole("admin", "partner", "rider", "fleet"), async (req, res) => {
  const filter: Record<string, unknown> = { ...tenantScope(req) };
  const employee = await employeeScope(req);
  if (req.auth?.role === "partner") filter.restaurantId = employee?.restaurantId || null;
  if (req.auth?.role === "rider") {
    const rider = employee?.email ? await Rider.findOne({ email: employee.email, ...tenantScope(req) }).select("_id").lean().exec() as any : null;
    filter.riderId = rider?._id || null;
  }
  if (req.auth?.role === "fleet") {
    const riders = employee?.fleetId ? await Rider.find({ fleetId: employee.fleetId, ...tenantScope(req) }).select("_id").lean().exec() : [];
    // Fleet must see both orders already assigned to its Riders and real
    // customer orders waiting for their first assignment. The previous
    // filter only returned assigned orders, hiding fresh KFC/customer orders.
    filter.$or = [{ riderId: { $in: riders.map((rider: any) => rider._id) } }, { riderId: null }];
    // QA orders are dispatched automatically and must not pollute the real
    // customer-demand selector used by Fleet operations.
    filter.isTestOrder = { $ne: true };
  }
  if (typeof req.query.customerId === "string") filter.customerId = req.query.customerId;
  if (typeof req.query.status === "string") filter.status = req.query.status;
  if (req.query.active === "true") {
    filter.status = { $in: [...activeOperationalOrderStatuses] };
    filter.$and = [dispatchablePaymentFilter];
  } else if (req.query.operational === "true" || req.query.dispatchable === "true") {
    filter.status = { $in: ["pending", "accepted", "preparing", "ready_for_pickup"] };
    // Keep this payment predicate separate from Fleet's rider-scope $or.
    filter.$and = [dispatchablePaymentFilter];
  }
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(100).lean().exec() as any[];
  const restaurants = await Restaurant.find({ _id: { $in: orders.map((order) => order.restaurantId).filter(Boolean) } }).select("name slug").lean().exec() as any[];
  const restaurantNames = new Map(restaurants.map((restaurant) => [String(restaurant._id), restaurant.name || restaurant.slug || "Establecimiento"]));
  res.json({ orders: orders.map((order) => ({ ...order, restaurantName: restaurantNames.get(String(order.restaurantId)) || "Establecimiento pendiente" })) });
});

app.get("/api/v1/orders/:id", requireRole("admin", "partner", "rider", "fleet"), async (req, res) => {
  const orderParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(orderParam); const order = (id ? await Order.findOne({ _id: id, ...tenantScope(req) }).lean().exec() : await Order.findOne({ publicCode: orderParam, ...tenantScope(req) }).lean().exec()) as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const employee = await employeeScope(req);
  const allowed = req.auth?.role === "admin"
    || (req.auth?.role === "partner" && employee?.restaurantId && String(order.restaurantId) === String(employee.restaurantId))
    || (req.auth?.role === "rider" && employee?.email && Boolean(await Rider.exists({ _id: order.riderId, email: employee.email })))
    || (req.auth?.role === "fleet" && employee?.fleetId && Boolean(await Rider.exists({ _id: order.riderId, fleetId: employee.fleetId })));
  if (!allowed) return res.status(403).json({ error: "ORDER_ACCESS_DENIED" });
  return res.json({ order });
});

async function recordCashCollection(order: any, riderId: mongoose.Types.ObjectId, actorRole: "rider" | "admin" | "fleet" | "finance") {
  if (order.paymentMethod !== "cash") return null;
  const idempotencyKey = `cash-collection:${String(order._id)}`;
  const entry = await CashLedgerEntry.findOneAndUpdate(
    { idempotencyKey },
    { $setOnInsert: { orderId: order._id, riderId, actorRole, direction: "in", amountCents: Number(order.totalCents || 0), reason: "customer_cash_collection", idempotencyKey, note: "Cobro en efectivo confirmado en la entrega", reference: String(order.publicCode || "") } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean().exec() as any;
  await Order.updateOne({ _id: order._id, cashCollectedAt: null }, { $set: { cashCollectedAt: new Date(), cashCollectedByRiderId: riderId, paymentState: "paid" } }).exec();
  return entry;
}

async function publishCashWalletEvent(input: { riderId: mongoose.Types.ObjectId; amountCents: number; type: "cash.wallet_changed" | "cash.handover_recorded"; reference?: string }) {
  const rider = await Rider.findById(input.riderId).select("tenantId").lean().exec() as any;
  const tenantId = rider?.tenantId ? String(rider.tenantId) : null;
  const payload = { riderId: String(input.riderId), amountCents: Number(input.amountCents || 0), reference: input.reference || null, occurredAt: new Date().toISOString() };
  await Promise.all([
    publishRealtimeEvent({ channel: "rider", audienceKey: `rider:${payload.riderId}`, tenantId, type: input.type, payload, dedupeKey: `${input.type}:rider:${payload.riderId}:${payload.reference || payload.occurredAt}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(tenantId, "admin"), tenantId, type: input.type, payload, dedupeKey: `${input.type}:admin:${payload.riderId}:${payload.reference || payload.occurredAt}` }),
    publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(tenantId, "fleet"), tenantId, type: input.type, payload, dedupeKey: `${input.type}:fleet:${payload.riderId}:${payload.reference || payload.occurredAt}` }),
  ]);
}

async function cashWallet(riderId: mongoose.Types.ObjectId) {
  const rows = await CashLedgerEntry.aggregate([{ $match: { riderId } }, { $group: { _id: "$direction", totalCents: { $sum: "$amountCents" }, entries: { $sum: 1 } } }]);
  const inRow = rows.find((row: any) => row._id === "in"); const outRow = rows.find((row: any) => row._id === "out");
  return { riderId: String(riderId), collectedCents: Number(inRow?.totalCents || 0), handedOverCents: Number(outRow?.totalCents || 0), availableCents: Number(inRow?.totalCents || 0) - Number(outRow?.totalCents || 0), collectedEntries: Number(inRow?.entries || 0), updatedAt: new Date().toISOString() };
}

const cashHandoverSchema = z.object({ riderId: z.string().regex(/^[a-f\d]{24}$/i), amountCents: z.number().int().positive().max(1_000_000), reference: z.string().trim().min(3).max(120), note: z.string().trim().max(500).default("") });
async function recordCashHandover(input: z.infer<typeof cashHandoverSchema>, actorRole: "admin" | "fleet" | "finance") {
  const riderId = objectId(input.riderId);
  if (!riderId) throw new Error("INVALID_RIDER_ID");
  const wallet = await cashWallet(riderId);
  if (input.amountCents > wallet.availableCents) {
    const error = new Error("HANDOVER_EXCEEDS_AVAILABLE_CASH") as Error & { wallet?: typeof wallet };
    error.wallet = wallet; throw error;
  }
  const idempotencyKey = `cash-handover:${String(riderId)}:${input.reference}`;
  const entry = await CashLedgerEntry.findOneAndUpdate(
    { idempotencyKey },
    { $setOnInsert: { orderId: null, riderId, actorRole, direction: "out", amountCents: input.amountCents, reason: "cash_handover", idempotencyKey, note: input.note, reference: input.reference } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean().exec() as any;
  return { entry, wallet: await cashWallet(riderId) };
}


app.post("/api/v1/orders/:id/transitions", requireRole("admin", "partner", "rider", "fleet"), async (req, res) => {
  const parsed = transitionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_TRANSITION", details: parsed.error.flatten() });
  const orderId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(orderId); if (!id) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findById(id); if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const employee = await employeeScope(req);
  if (req.auth?.role === "partner" && (!employee?.restaurantId || String(order.restaurantId) !== String(employee.restaurantId))) return res.status(403).json({ error: "PARTNER_ORDER_ACCESS_DENIED" });
  if (req.auth?.role === "fleet" && (!employee?.fleetId || !(await Rider.exists({ _id: order.riderId, fleetId: employee.fleetId }))) ) return res.status(403).json({ error: "FLEET_ORDER_ACCESS_DENIED" });
  const actorRole = req.auth?.role === "admin" ? (parsed.data.actorRole || req.auth.role) : req.auth?.role;
  if (!actorRole) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  if (actorRole === "rider") {
    const rider = await riderAccessForRequest(order.riderId, req);
    if (!rider) return res.status(403).json({ error: "RIDER_ORDER_ACCESS_DENIED" });
    if (parsed.data.status === "cancelled") {
      return res.status(403).json({ error: "RIDER_CANCELLATION_NOT_ALLOWED", message: "Los Riders no pueden cancelar pedidos. Deben abrir una incidencia en Soporte PIKI para que Operaciones agote las vías de contacto con el Customer antes de cancelar." });
    }
    if (parsed.data.status === "delivered") {
      return res.status(409).json({ error: "DELIVERY_QR_REQUIRED", message: "El Rider debe confirmar la entrega usando el QR o PIN que proporciona el Customer." });
    }
  }
  try { assertTransition(order.status, parsed.data.status, actorRole); } catch (error) { return res.status(409).json({ error: "INVALID_ORDER_TRANSITION", message: error instanceof Error ? error.message : "Transition not allowed" }); }
  if (parsed.data.status === "delivered" && order.paymentMethod === "cash") return res.status(409).json({ error: "DELIVERY_QR_REQUIRED", message: "Un pedido a contrarreembolso debe cerrarse con el QR del Customer para registrar el cobro en efectivo una sola vez." });
  const update: Record<string, unknown> = { $set: { status: parsed.data.status, ...(actorRole === "rider" && parsed.data.status === "picked_up" && order.assignmentState === "offered" ? { assignmentState: "assigned", assignmentExpiresAt: null } : {}) }, $inc: { version: 1 }, $push: { statusHistory: { status: parsed.data.status, actorRole, reason: parsed.data.reason || "" } } };
  if (parsed.data.status === "delivered") update.$set = { status: "delivered", deliveredAt: new Date() };
  if (parsed.data.status === "cancelled") update.$set = { status: "cancelled", cancelledAt: new Date() };
  const updated = await Order.findOneAndUpdate({ _id: id, version: order.version, status: order.status }, update, { new: true }).lean().exec();
  if (!updated) return res.status(409).json({ error: "ORDER_CHANGED_RETRY" });
  if (actorRole === "rider" && parsed.data.status === "picked_up" && order.assignmentState === "offered" && order.riderId) {
    await RiderAssignmentReservation.updateOne({ orderId: order._id, riderId: order.riderId, status: "reserved" }, { $set: { expiresAt: null } }).exec();
  }
  if (["delivered", "cancelled"].includes(parsed.data.status)) await RiderOrderMessage.deleteMany({ orderId: order._id }).exec();
  scheduleCustomerOrderPush(updated, parsed.data.status);
  if (["delivered", "cancelled"].includes(parsed.data.status) && order.riderId) {
    await releaseRiderOrderSlot(order._id, order.riderId);
  }
  await publishOrderStatusEvents(updated, parsed.data.status);
  return res.json({ order: updated });
});

async function riderAccessForRequest(riderId: any, req: express.Request) {
  if (!riderId || req.auth?.role !== "rider") return null;
  if (req.auth.employeeId) {
    const employee = await EmployeeAccount.findOne({ _id: req.auth.employeeId, ...tenantScope(req) }).select("email").lean().exec() as any;
    return employee ? await Rider.findOne({ _id: riderId, email: employee.email, ...tenantScope(req) }).select("_id vehicle email tenantId").lean().exec() : null;
  }
  // El token técnico nunca sirve para todos los riders: queda limitado por configuración a uno.
  const scopedRiderId = String(process.env.RIDER_API_RIDER_ID || "").trim();
  return scopedRiderId && String(riderId) === scopedRiderId
    ? await Rider.findOne({ _id: riderId, ...tenantScope(req) }).select("_id vehicle email tenantId").lean().exec()
    : null;
}

const riderMessageSchema = z.object({ body: z.string().trim().min(1).max(500) });
async function riderOrderAccess(riderIdParam: string, orderIdParam: string, req: express.Request) {
  const riderId = objectId(riderIdParam); const orderId = objectId(orderIdParam);
  if (!riderId || !orderId) return null;
  const rider = await riderAccessForRequest(riderId, req);
  if (!rider) return null;
  return await Order.findOne({ _id: orderId, riderId, assignmentState: "assigned", status: { $nin: ["delivered", "cancelled"] } }).select("_id riderId status").lean().exec() as any;
}
app.get("/api/v1/riders/:riderId/orders/:orderId/messages", requireRole("rider"), async (req, res) => {
  const order = await riderOrderAccess(String(req.params.riderId), String(req.params.orderId), req);
  if (!order) return res.status(403).json({ error: "RIDER_ORDER_ACCESS_DENIED" });
  const messages = await RiderOrderMessage.find({ orderId: order._id }).sort({ createdAt: 1 }).limit(100).lean().exec();
  return res.json({ messages });
});
app.post("/api/v1/riders/:riderId/orders/:orderId/messages", requireRole("rider"), async (req, res) => {
  const order = await riderOrderAccess(String(req.params.riderId), String(req.params.orderId), req);
  if (!order) return res.status(403).json({ error: "RIDER_ORDER_ACCESS_DENIED" });
  const parsed = riderMessageSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_MESSAGE", details: parsed.error.flatten() });
  const message = await RiderOrderMessage.create({ orderId: order._id, riderId: order.riderId, senderRole: "rider", body: parsed.data.body });
  return res.status(201).json({ message });
});
app.post("/api/v1/riders/:riderId/orders/:orderId/confirm-pickup", requireRole("rider"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.riderId) ? req.params.riderId[0] : req.params.riderId);
  const orderId = objectId(Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId);
  if (!riderId || !orderId) return res.status(400).json({ error: "INVALID_PICKUP_CONFIRMATION" });
  const riderAccess = await riderAccessForRequest(riderId, req);
  if (!riderAccess) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const order = await Order.findOne({ _id: orderId, riderId, assignmentState: { $in: ["offered", "assigned"] } }).lean().exec() as any;
  if (!order) return res.status(404).json({ error: "ACTIVE_RIDER_ORDER_NOT_FOUND" });
  try {
    assertTransition(order.status, "picked_up", "rider");
  } catch {
    return res.status(409).json({ error: "INVALID_PICKUP_STATUS", message: "Este pedido ya no puede confirmarse como recogido." });
  }
  const pickupCode = String(req.body?.pickupQr || req.body?.pickupPin || "").trim();
  if (pickupCode && !pickupQrIsValid(order.publicCode, pickupCode)) return res.status(422).json({ error: "PICKUP_QR_INVALID", message: "El QR o PIN de recogida no es válido." });
  const updated = await Order.findOneAndUpdate(
    { _id: orderId, riderId, assignmentState: { $in: ["offered", "assigned"] }, status: order.status, version: order.version },
    { $set: { status: "picked_up", assignmentState: "assigned", assignmentExpiresAt: null }, $inc: { version: 1 }, $push: { statusHistory: { status: "picked_up", actorRole: "rider", reason: pickupCode ? "Recogida confirmada por Rider con QR/PIN" : order.status === "ready_for_pickup" ? "Recogida confirmada por Rider" : "Recogida confirmada antes de que Partner marcara el pedido como listo" } } },
    { new: true },
  ).lean().exec();
  if (!updated) return res.status(409).json({ error: "ORDER_CHANGED_RETRY" });
  if (order.assignmentState === "offered") await RiderAssignmentReservation.updateOne({ orderId: order._id, riderId, status: "reserved" }, { $set: { expiresAt: null } }).exec();
  scheduleCustomerOrderPush(updated, "picked_up");
  await publishOrderStatusEvents(updated, "picked_up");
  return res.json({ message: order.status === "ready_for_pickup" ? "Recogida confirmada. Ya puedes iniciar la ruta hacia el cliente." : "Recogida confirmada aunque el Partner todavía no haya marcado el pedido como listo.", order: updated });
});
app.post("/api/v1/riders/:riderId/orders/:orderId/confirm-delivery", requireRole("rider"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.riderId) ? req.params.riderId[0] : req.params.riderId);
  const orderId = objectId(Array.isArray(req.params.orderId) ? req.params.orderId[0] : req.params.orderId);
  if (!riderId || !orderId) return res.status(400).json({ error: "INVALID_DELIVERY_CONFIRMATION" });
  const riderAccess = await riderAccessForRequest(riderId, req);
  if (!riderAccess) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const order = await Order.findOne({ _id: orderId, riderId, assignmentState: "assigned" }).lean().exec() as any;
  if (!order) return res.status(404).json({ error: "ASSIGNED_ORDER_NOT_FOUND" });
  if (order.status !== "on_the_way") return res.status(409).json({ error: "ORDER_NOT_ON_THE_WAY", message: "Primero confirma que has recogido el pedido e iniciado la ruta." });
  if (!deliveryQrIsValid(order.publicCode, req.body?.deliveryQr)) return res.status(422).json({ error: "DELIVERY_QR_INVALID", message: "Escanea el QR o introduce el PIN que proporciona el Customer antes de confirmar la entrega." });
  if (order.paymentMethod === "stripe") {
    if (!order.stripePaymentIntentId || order.paymentState !== "authorized") return res.status(409).json({ error: "PAYMENT_NOT_AUTHORIZED", message: "El pago online todavía no está autorizado para capturarse." });
    try { await captureStripePaymentIntent(order.stripePaymentIntentId); }
    catch (error) { return res.status(409).json({ error: "PAYMENT_CAPTURE_FAILED", message: error instanceof Error ? error.message : "No se pudo capturar el pago." }); }
  }
  if (order.paymentMethod === "cash") {
    const cashEntry = await recordCashCollection(order, riderId, "rider");
    if (cashEntry) await publishCashWalletEvent({ riderId, amountCents: Number(order.totalCents || 0), type: "cash.wallet_changed", reference: String(order.publicCode || "") });
  }
  const updated = await Order.findOneAndUpdate({ _id: orderId, riderId, status: "on_the_way", version: order.version }, { $set: { status: "delivered", deliveredAt: new Date(), ...(order.paymentMethod === "stripe" ? { paymentState: "paid" } : {}) }, $inc: { version: 1 }, $push: { statusHistory: { status: "delivered", actorRole: "rider", reason: order.paymentMethod === "cash" ? "Entrega confirmada y cobro en efectivo registrado" : "Entrega confirmada por el Rider" } } }, { new: true }).lean().exec();
  if (!updated) return res.status(409).json({ error: "ORDER_CHANGED_RETRY" });
  const deliveredOrder = updated as any;
  await RiderOrderMessage.deleteMany({ orderId, riderId }).exec();
  await releaseRiderOrderSlot(orderId, riderId);
  scheduleCustomerOrderPush(deliveredOrder, "delivered");
  return res.json({ message: order.paymentMethod === "cash" ? "Entrega confirmada y efectivo registrado en cartera." : "Entrega confirmada.", chatPurged: true, order: { id: deliveredOrder._id, publicCode: deliveredOrder.publicCode, status: deliveredOrder.status, deliveredAt: deliveredOrder.deliveredAt, paymentMethod: deliveredOrder.paymentMethod, cashCollected: Boolean(deliveredOrder.cashCollectedAt) } });
});

app.get("/api/v1/riders/:id/cash-wallet", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  if (req.auth?.role === "rider" && !(await riderAccessForRequest(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  if (req.auth?.role === "fleet" && !(await fleetCanAccessRider(req, riderId))) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
  const [wallet, entries] = await Promise.all([cashWallet(riderId), CashLedgerEntry.find({ riderId }).sort({ createdAt: -1 }).limit(50).lean().exec()]);
  return res.json({ wallet, entries });
});

app.post("/api/v1/ops/cash-handovers", requireRole("admin", "fleet", "finance"), async (req, res) => {
  const parsed = cashHandoverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_CASH_HANDOVER", details: parsed.error.flatten() });
  const handoverRiderId = objectId(parsed.data.riderId);
  if (!handoverRiderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  if (req.auth?.role === "fleet" && !(await fleetCanAccessRider(req, handoverRiderId))) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
  try {
    const result = await recordCashHandover(parsed.data, req.auth?.role === "finance" ? "finance" : req.auth?.role === "fleet" ? "fleet" : "admin");
    await publishCashWalletEvent({ riderId: objectId(parsed.data.riderId)!, amountCents: parsed.data.amountCents, type: "cash.handover_recorded", reference: parsed.data.reference });
    return res.status(201).json(result);
  } catch (error) {
    if (error instanceof Error && error.message === "HANDOVER_EXCEEDS_AVAILABLE_CASH") return res.status(409).json({ error: error.message, wallet: (error as Error & { wallet?: unknown }).wallet });
    if (error instanceof Error && error.message === "INVALID_RIDER_ID") return res.status(400).json({ error: error.message });
    throw error;
  }
});

app.get("/api/v1/ops/cash-wallets", requireRole("admin", "fleet", "finance"), async (_req, res) => {
  const rows = await CashLedgerEntry.aggregate([{ $group: { _id: "$riderId", collectedCents: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$amountCents", 0] } }, handedOverCents: { $sum: { $cond: [{ $eq: ["$direction", "out"] }, "$amountCents", 0] } }, entries: { $sum: 1 } } }]);
  const riderIds = rows.map((row: any) => row._id).filter(Boolean); const riders = await Rider.find({ _id: { $in: riderIds }, ...(await fleetRiderFilter(_req)) }).select("name email fleetId").lean().exec(); const names = new Map(riders.map((rider: any) => [String(rider._id), rider]));
  return res.json({ wallets: rows.map((row: any) => ({ riderId: String(row._id), rider: names.get(String(row._id)) || null, collectedCents: Number(row.collectedCents || 0), handedOverCents: Number(row.handedOverCents || 0), availableCents: Number(row.collectedCents || 0) - Number(row.handedOverCents || 0), entries: Number(row.entries || 0) })) });
});

app.post("/api/v1/riders/:id/location", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const parsed = riderLocationSchema.safeParse({ ...req.body, riderId: req.params.id });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_LOCATION", details: parsed.error.flatten() });
  const id = objectId(parsed.data.riderId); if (!id) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  if (req.auth?.role === "rider" && !(await riderAccessForRequest(id, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  if (req.auth?.role === "fleet" && !(await fleetCanAccessRider(req, id))) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
  const activeSlot = (await findCurrentRiderSlot(id)).slot as any;
  const statusUpdate = activeSlot?.status === "active" ? { status: "available" } : {};
  const rider = await Rider.findByIdAndUpdate(id, { $set: { location: { type: "Point", coordinates: [parsed.data.longitude, parsed.data.latitude] }, lastLocationAt: new Date(), ...statusUpdate } }, { new: true }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  return res.json({ rider: { id: rider._id, riderCode: rider.riderCode, status: rider.status, location: rider.location, lastLocationAt: rider.lastLocationAt } });
});
app.patch("/api/v1/riders/:id/status", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam); if (!id) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const parsed = z.object({ status: z.enum(["offline", "available", "busy", "paused"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_STATUS" });
  if (req.auth?.role === "rider" && !(await riderAccessForRequest(id, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  if (req.auth?.role === "fleet" && !(await fleetCanAccessRider(req, id))) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
  if (parsed.data.status === "available") {
    const { now, slot } = await findCurrentRiderSlot(id);
    const rider = await Rider.findById(id).select("lastLocationAt").lean().exec() as any;
    if (!slot || (slot as any).status !== "active") return res.status(409).json({ error: "SHIFT_RESERVATION_REQUIRED", message: "Debes iniciar tu jornada antes de ponerte disponible.", now });
    if (!rider?.lastLocationAt || new Date(rider.lastLocationAt).getTime() < Date.now() - 90_000) return res.status(409).json({ error: "FRESH_LOCATION_REQUIRED", message: "Activa y comparte tu ubicación para quedar disponible." });
  }
  const rider = await Rider.findByIdAndUpdate(id, { $set: { status: parsed.data.status } }, { new: true }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  return res.json({ rider: { id: rider._id, riderCode: rider.riderCode, name: rider.name, status: rider.status, fleetId: rider.fleetId, lastLocationAt: rider.lastLocationAt } });
});

app.get("/api/v1/riders/:id/slots", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const riderId = objectId(riderIdParam); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  if (req.auth?.role === "rider" && !(await riderAccessForRequest(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  if (req.auth?.role === "fleet" && !(await fleetCanAccessRider(req, riderId))) return res.status(403).json({ error: "FLEET_RIDER_ACCESS_DENIED" });
  const slots = await RiderSlot.find({ riderId, ...tenantScope(req) }).sort({ date: 1, startTime: 1 }).limit(500).lean().exec();
  return res.json({ riderId, slots });
});

function madridNow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}
function previousCalendarDate(date: string) { const value = new Date(`${date}T12:00:00Z`); value.setUTCDate(value.getUTCDate() - 1); return value.toISOString().slice(0, 10); }
function slotContainsTime(slot: { startTime: string; endTime: string }, time: string) { return slot.startTime < slot.endTime ? slot.startTime <= time && time < slot.endTime : time >= slot.startTime || time < slot.endTime; }

async function findCurrentRiderSlot(riderId: mongoose.Types.ObjectId) {
  const now = madridNow();
  const candidates = await RiderSlot.find({ riderId, date: { $in: [now.date, previousCalendarDate(now.date)] }, status: { $in: ["planned", "active"] } }).sort({ date: 1, startTime: 1 }).lean().exec();
  const slot = candidates.find((candidate: any) => slotContainsTime(candidate, now.time) && (candidate.date === now.date || candidate.startTime >= candidate.endTime));
  return { now, slot, selfStartAllowed: false };
}

async function currentSlotRiderIds(scope: Record<string, unknown> = {}) {
  const now = madridNow();
  const candidates = await RiderSlot.find({ ...scope, date: { $in: [now.date, previousCalendarDate(now.date)] }, status: { $in: ["planned", "active"] } }).select("riderId date startTime endTime").lean().exec();
  return [...new Set(candidates.filter((candidate: any) => slotContainsTime(candidate, now.time) && (candidate.date === now.date || candidate.startTime >= candidate.endTime)).map((candidate: any) => candidate.riderId))];
}

async function canAccessRiderShift(riderId: mongoose.Types.ObjectId, req: express.Request) {
  if (req.auth?.role !== "rider") return true;
  return Boolean(await riderAccessForRequest(riderId, req));
}

app.get("/api/v1/riders/session", requireRole("rider"), async (req, res) => {
  const employeeId = req.auth?.employeeId;
  if (!employeeId) return res.status(403).json({ error: "RIDER_EMPLOYEE_SESSION_REQUIRED" });
  const employee = await EmployeeAccount.findById(employeeId).lean().exec() as any;
  const rider = employee ? await Rider.findOne({ email: employee.email }).lean().exec() as any : null;
  if (!rider) return res.status(404).json({ error: "RIDER_ACCOUNT_NOT_LINKED" });
  const { now, slot } = await findCurrentRiderSlot(rider._id);
  // A previous browser session must never keep a rider online after its slot ended.
  await RiderSlot.updateMany({ riderId: rider._id, status: "active", date: { $lt: now.date } }, { $set: { status: "completed" } }).exec();
  const hasActiveOrder = Boolean(await Order.exists({ riderId: rider._id, status: { $nin: ["delivered", "cancelled"] }, assignmentState: { $in: ["offered", "assigned"] } }));
  const effectiveStatus = hasActiveOrder ? "busy" : (slot as any)?.status === "active" ? rider.status : "offline";
  const update: Record<string, unknown> = { status: effectiveStatus };
  if (!hasActiveOrder && effectiveStatus === "offline") update.activeOrderId = null;
  if (effectiveStatus !== rider.status || update.activeOrderId === null) await Rider.updateOne({ _id: rider._id }, { $set: update }).exec();
  return res.json({ rider: { id: rider._id, riderCode: rider.riderCode, name: rider.name, email: rider.email, status: effectiveStatus, fleetId: rider.fleetId }, now, slot: slot || null });
});

app.get("/api/v1/riders/:id/shift", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findById(riderId).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  if (!(await canAccessRiderShift(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const { now, slot, selfStartAllowed } = await findCurrentRiderSlot(riderId);
  return res.json({ rider: { id: rider._id, riderCode: rider.riderCode, status: rider.status }, now, eligible: Boolean(slot) || selfStartAllowed, selfStartAllowed, shift: slot });
});

app.post("/api/v1/riders/:id/shift/start", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findById(riderId).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  if (!(await canAccessRiderShift(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const { now, slot } = await findCurrentRiderSlot(riderId);
  if (!slot) {
    if (req.auth?.role === "rider") {
      const tenantId = req.auth?.tenantId ?? null;
      const eventId = `security:rider-shift-out-of-hours:${String(riderId)}:${now.date}:${now.time}`;
      const payload = { riderId: String(riderId), riderName: rider.name, riderEmail: rider.email, riderCode: rider.riderCode, date: now.date, time: now.time, reason: "SHIFT_RESERVATION_REQUIRED" };
      await Promise.allSettled([
        publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(tenantId, "fleet"), type: "security.rider_shift_out_of_hours", payload, tenantId, dedupeKey: `${eventId}:fleet` }),
        publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(tenantId, "admin"), type: "security.rider_shift_out_of_hours", payload, tenantId, dedupeKey: `${eventId}:admin` }),
      ]);
    }
    return res.status(409).json({ error: "SHIFT_RESERVATION_REQUIRED", message: "No tienes un slot asignado para esta franja. Contacta con Fleet para que te asigne día, horario y zona.", now });
  }
  const currentSlot = slot as any;
  const updatedSlot = await RiderSlot.findOneAndUpdate({ _id: currentSlot._id, status: { $in: ["planned", "active"] } }, { $set: { status: "active" } }, { new: true }).lean().exec();
  const hasOrders = await Order.exists({ riderId, status: { $nin: ["delivered", "cancelled"] }, assignmentState: { $in: ["offered", "assigned"] } });
  const hasFreshLocation = Boolean(rider.lastLocationAt && new Date(rider.lastLocationAt).getTime() >= Date.now() - 90_000);
  const status = hasOrders ? "busy" : hasFreshLocation ? "available" : "paused";
  await Rider.findByIdAndUpdate(riderId, { $set: { status } }).exec();
  return res.json({ message: hasFreshLocation ? "Jornada iniciada" : "Jornada iniciada: comparte tu ubicación para quedar disponible.", warningSound: "start_shift", locationRequired: !hasFreshLocation, rider: { id: riderId, riderCode: rider.riderCode, status }, shift: updatedSlot });
});

app.post("/api/v1/riders/:id/shift/stop", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  if (!(await canAccessRiderShift(riderId, req))) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  if (await Order.exists({ riderId, status: { $nin: ["delivered", "cancelled"] }, assignmentState: { $in: ["offered", "assigned"] } })) return res.status(409).json({ error: "ACTIVE_DELIVERY_REQUIRES_SUPPORT", message: "Completa el reparto o contacta con Soporte antes de finalizar la jornada." });
  const { slot } = await findCurrentRiderSlot(riderId);
  if (slot) await RiderSlot.updateOne({ _id: (slot as any)._id }, { $set: { status: "completed" } }).exec();
  const rider = await Rider.findByIdAndUpdate(riderId, { $set: { status: "offline", activeOrderId: null } }, { new: true }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  return res.json({ message: "Jornada finalizada", rider: { id: rider._id, riderCode: rider.riderCode, status: rider.status } });
});

app.post("/api/v1/riders/:id/slots", requireRole("admin", "fleet"), async (req, res) => {
  const riderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const riderId = objectId(riderIdParam); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const parsed = riderSlotSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SLOT", details: parsed.error.flatten() });
  if (parsed.data.endTime <= parsed.data.startTime) return res.status(400).json({ error: "INVALID_SLOT_TIME_RANGE" });
  const rider = await Rider.findOne({ _id: riderId, ...tenantScope(req) }).lean().exec(); if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const zone = await Zone.findOne({ ...tenantScope(req), slug: parsed.data.zoneSlug, isActive: true }).select("slug").lean().exec();
  if (!zone) return res.status(404).json({ error: "ZONE_NOT_FOUND" });
  const limits = await tenantLimits(req);
  const [dailyForRider, dailyForTenant] = await Promise.all([
    RiderSlot.countDocuments({ riderId, ...tenantScope(req), date: parsed.data.date, status: { $nin: ["cancelled", "completed"] } }),
    RiderSlot.countDocuments({ ...tenantScope(req), date: parsed.data.date, status: { $nin: ["cancelled", "completed"] } }),
  ]);
  if (dailyForRider >= limits.maxSlotsPerRiderPerDay) return res.status(409).json({ error: "RIDER_DAILY_SLOT_LIMIT", limit: limits.maxSlotsPerRiderPerDay });
  if (dailyForTenant >= limits.maxDailySlots) return res.status(409).json({ error: "TENANT_DAILY_SLOT_CAPACITY_REACHED", limit: limits.maxDailySlots });
  const overlap = await RiderSlot.findOne({ riderId, ...tenantScope(req), date: parsed.data.date, status: { $nin: ["cancelled", "completed"] }, $or: [{ startTime: { $lt: parsed.data.endTime }, endTime: { $gt: parsed.data.startTime } }] }).lean().exec();
  if (overlap) return res.status(409).json({ error: "RIDER_SLOT_OVERLAP", slot: overlap });
  try {
    const slot = await RiderSlot.create({ ...parsed.data, ...tenantScope(req), riderId });
    return res.status(201).json({ slot });
  } catch (error: any) {
    if (error?.code === 11000) return res.status(409).json({ error: "RIDER_SLOT_ALREADY_EXISTS", message: "Ya existe un slot para ese rider, fecha y hora de inicio." });
    throw error;
  }
});

app.get("/api/v1/fleet/heatmap", requireRole("admin", "fleet"), async (_req, res) => {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await Order.find({ createdAt: { $gte: since }, deliveryLocation: { $exists: true }, status: { $ne: "cancelled" } }).select("deliveryLocation status createdAt").lean().exec();
  const bins = new Map<string, { latitude: number; longitude: number; demand: number; active: number }>();
  for (const row of rows as any[]) { const [longitude, latitude] = row.deliveryLocation.coordinates || []; if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue; const key = `${latitude.toFixed(3)}:${longitude.toFixed(3)}`; const current = bins.get(key) || { latitude: Number(latitude.toFixed(3)), longitude: Number(longitude.toFixed(3)), demand: 0, active: 0 }; current.demand += 1; if (row.status !== "delivered") current.active += 1; bins.set(key, current); }
  return res.json({ since, points: [...bins.values()].sort((a, b) => b.demand - a.demand) });
});

app.post("/api/v1/riders/:id/incidents", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = riderIncidentSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_INCIDENT", details: parsed.error.flatten() });
  const riderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const riderId = objectId(riderIdParam); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findById(riderId).lean().exec();
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const incident = await RiderIncident.create({ riderId, ...parsed.data, createdByRole: req.auth?.role || "admin" });
  const incidents = await RiderIncident.find({ riderId }).lean().exec();
  const decision = calculateSanctionDecision(incidents.map((item: any) => ({ id: String(item._id), riderId: String(item.riderId), reason: item.reason, occurredAt: item.occurredAt, evidence: item.evidence, acknowledged: item.acknowledged, resolved: item.resolved })), new Date(), defaultSanctionPolicy);
  return res.status(201).json({ incident, sanction: decision });
});

app.get("/api/v1/riders/:id/sanction-status", requireRole("admin", "fleet", "rider"), async (req, res) => {
  const riderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const riderId = objectId(riderIdParam); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findById(riderId).lean().exec();
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const incidents = await RiderIncident.find({ riderId }).sort({ occurredAt: -1 }).limit(100).lean().exec();
  const decision = calculateSanctionDecision(incidents.map((item: any) => ({ id: String(item._id), riderId: String(item.riderId), reason: item.reason, occurredAt: item.occurredAt, evidence: item.evidence, acknowledged: item.acknowledged, resolved: item.resolved })), new Date(), defaultSanctionPolicy);
  return res.json({ riderId, policy: defaultSanctionPolicy, incidents, sanction: decision });
});

const automaticDispatchInFlight = new Set<string>();

/**
 * Asignación automática idempotente. El algoritmo solo acepta riders con sesión
 * operativa, GPS reciente y capacidad disponible. preferredRiderId se reserva
 * para pedidos QA internos y nunca se expone a Customer/Partner.
 */
async function assignOrderAutomatically(orderId: mongoose.Types.ObjectId, preferredRiderId?: mongoose.Types.ObjectId) {
  if (!databaseReady || mongoose.connection.readyState !== 1) return { state: "database_unavailable" as const };
  const key = String(orderId);
  if (automaticDispatchInFlight.has(key)) return { state: "in_progress" as const };
  automaticDispatchInFlight.add(key);
  try {
    const order = await Order.findById(orderId).lean().exec() as any;
    if (!order) return { state: "not_found" as const };
    const tenantFilter: Record<string, unknown> = order.tenantId ? { tenantId: order.tenantId } : {};
    if (!(order.paymentState === "authorized" || order.paymentState === "paid" || order.paymentMethod === "cash") || !isDispatchableOrderStatus(order.status)) return { state: "not_dispatchable" as const };
    if (order.riderId || order.assignmentState === "assigned" || order.assignmentState === "offered") return { state: "already_assigned" as const, riderId: order.riderId };
    const restaurant = await Restaurant.findOne({ _id: order.restaurantId, ...tenantFilter }).lean().exec() as any;
    if (!restaurant?.location?.coordinates || !order.deliveryLocation?.coordinates) return { state: "missing_geolocation" as const };
    const policy = await dispatchLoadPolicy();
    const freshness = new Date(Date.now() - 90_000);
    const currentRiderIds = await currentSlotRiderIds(tenantFilter);
    const riderFilter: Record<string, unknown> = { ...tenantFilter, isTestRider: { $ne: true }, _id: { $in: currentRiderIds }, status: { $in: ["available", "busy"] }, lastLocationAt: { $gte: freshness }, location: { $exists: true } };
    if (preferredRiderId) riderFilter._id = { $in: currentRiderIds.filter((id) => String(id) === String(preferredRiderId)) };
    const riders = await Rider.find(riderFilter).limit(100).lean().exec() as any[];
    const counts = await activeOrderCounts(riders.map((rider) => rider._id));
    const ranked = rankDispatchCandidates(riders.map((rider) => ({ id: String(rider._id), status: rider.status, vehicle: rider.vehicle, location: rider.location, lastLocationAt: rider.lastLocationAt, reliabilityScore: rider.reliabilityScore, activeOrderCount: counts.get(String(rider._id)) || 0, zoneFit: 1, servicePriority: preferredRiderId && String(rider._id) === String(preferredRiderId) ? 1 : 0.5 })), { restaurantLocation: [restaurant.location.coordinates[0], restaurant.location.coordinates[1]], customerLocation: [order.deliveryLocation.coordinates[0], order.deliveryLocation.coordinates[1]], routeDistanceKm: typeof order.routeDistanceKm === "number" ? order.routeDistanceKm : null, routeDurationMinutes: typeof order.routeDurationMinutes === "number" ? order.routeDurationMinutes : null, requiredVehicleClasses: Array.isArray(order.requiredVehicleClasses) ? order.requiredVehicleClasses : [], preparationMinutes: 15, maxConcurrentOrders: policy.maxConcurrentOrders });
    if (!ranked.length) return { state: "no_eligible_rider" as const, candidatesConsidered: riders.length };
    for (const decision of ranked) {
      const riderId = objectId(decision.riderId); if (!riderId) continue;
      const assignmentReservation = await reserveRiderOrderSlot(riderId, order._id, tenantFilter, policy.maxConcurrentOrders);
      if (!assignmentReservation) continue;
      const rider = assignmentReservation.rider;
      const expiresAt = assignmentReservation.reservation.expiresAt;
      const assigned = await Order.findOneAndUpdate({ _id: order._id, ...tenantFilter, riderId: null, assignmentState: { $in: ["unassigned", "expired", "rejected"] } }, { $set: { riderId: rider._id, assignmentState: "offered", assignmentExpiresAt: expiresAt, dispatchScore: decision.score }, $inc: { dispatchAttempts: 1, version: 1 } }, { new: true }).lean().exec() as any;
      if (!assigned) { await releaseRiderOrderSlot(order._id, rider._id); continue; }
      await DispatchDecision.create({ ...tenantFilter, orderId: assigned._id, ...decision, riderId: rider._id, outcome: "offered", actorRole: "system" });
      await publishRiderOfferEvent(assigned, String(rider._id));
      return { state: "offered" as const, orderId: assigned._id, riderId: rider._id, expiresAt, decision, policy };
    }
    return { state: "reservation_race" as const };
  } finally {
    automaticDispatchInFlight.delete(key);
  }
}

async function queueAutomaticDispatch(orderId: mongoose.Types.ObjectId, preferredRiderId?: mongoose.Types.ObjectId) {
  // Reintenta la selección del Rider; el flujo de alta espera este resultado para sincronizar las apps.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await assignOrderAutomatically(orderId, preferredRiderId);
    if (!["no_eligible_rider", "reservation_race"].includes(result.state)) return result;
    await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
  }
  return assignOrderAutomatically(orderId, preferredRiderId);
}

setCustomerOrderDispatcher(async (orderId) => {
  if (!mongoose.Types.ObjectId.isValid(orderId)) return { state: "invalid_order_id" as const };
  return queueAutomaticDispatch(new mongoose.Types.ObjectId(orderId));
});

async function expireStaleOffers() {
  const expired = await Order.find({ assignmentState: "offered", assignmentExpiresAt: { $lte: new Date() } }).select("_id riderId").limit(100).lean().exec() as any[];
  for (const offer of expired) {
    const released = await Order.findOneAndUpdate({ _id: offer._id, assignmentState: "offered", assignmentExpiresAt: { $lte: new Date() } }, { $set: { assignmentState: "expired", riderId: null, assignmentExpiresAt: null }, $inc: { version: 1 } }, { new: false }).lean().exec() as any;
    if (!released?.riderId) continue;
    await releaseRiderOrderSlot(released._id, released.riderId);
    await DispatchDecision.updateMany({ orderId: released._id, riderId: released.riderId, outcome: "offered" }, { $set: { outcome: "expired" } }).exec();
  }
}

async function runAutomaticDispatchSweep() {
  if (!databaseReady || mongoose.connection.readyState !== 1) return;
  await expireStaleOffers();
  const candidates = await Order.find({ riderId: null, assignmentState: { $in: ["unassigned", "expired", "rejected"] }, ...dispatchablePaymentFilter, status: { $in: [...dispatchableOrderStatuses] } }).select("_id").sort({ createdAt: 1 }).limit(25).lean().exec();
  for (const order of candidates) void queueAutomaticDispatch(order._id as mongoose.Types.ObjectId).catch((error) => console.error("Automatic dispatch sweep failed", error));
}
async function findDispatchOrder(orderId: mongoose.Types.ObjectId, req: express.Request) {
  const scoped = await Order.findOne({ _id: orderId, ...tenantScope(req) }).lean().exec() as any;
  if (scoped || req.auth?.role !== "fleet") return scoped;
  return null;
}
function dispatchScope(req: express.Request, order: any) {
  return tenantScope(req);
}
async function findDispatchRestaurant(order: any, req: express.Request, scope: Record<string, unknown>) {
  const scoped = await Restaurant.findOne({ _id: order.restaurantId, ...scope }).lean().exec() as any;
  return scoped;
}
app.get("/api/v1/dispatch/orders/:id/preview", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DISPATCH_REQUEST", details: parsed.error.flatten() });
  const orderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = objectId(orderIdParam);
  if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await findDispatchOrder(orderId, req);
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const scope = { ...dispatchScope(req, order), isTestRider: { $ne: true } };
  const restaurant = await findDispatchRestaurant(order, req, scope);
  if (!restaurant?.location?.coordinates || !order.deliveryLocation?.coordinates) return res.status(409).json({ error: "MISSING_GEOLOCATION" });
  const freshness = new Date(Date.now() - 90_000);
  const policy = await dispatchLoadPolicy();
  const maxConcurrentOrders = policy.maxConcurrentOrders;
  const diagnosticPool = await Rider.find({ ...scope }).select("_id riderCode name status lastLocationAt location tenantId fleetId activeOrderId zoneSlug").limit(200).lean().exec() as any[];
  const currentRiderIds = new Set((await currentSlotRiderIds(scope)).map((id) => String(id)));
  const riders = diagnosticPool.filter((rider: any) => currentRiderIds.has(String(rider._id)) && ["available", "busy"].includes(rider.status) && rider.lastLocationAt && new Date(rider.lastLocationAt).getTime() >= freshness.getTime() && rider.location?.coordinates?.length >= 2).slice(0, 100);
  const counts = await activeOrderCounts(riders.map((rider) => rider._id));
  const ranked = rankDispatchCandidates(riders.map((rider) => ({ id: String(rider._id), status: rider.status, vehicle: rider.vehicle, location: rider.location, lastLocationAt: rider.lastLocationAt, reliabilityScore: rider.reliabilityScore, activeOrderCount: counts.get(String(rider._id)) || 0, zoneFit: 1, servicePriority: 0.5 })), { restaurantLocation: [restaurant.location.coordinates[0], restaurant.location.coordinates[1]], customerLocation: [order.deliveryLocation.coordinates[0], order.deliveryLocation.coordinates[1]], routeDistanceKm: typeof order.routeDistanceKm === "number" ? order.routeDistanceKm : null, routeDurationMinutes: typeof order.routeDurationMinutes === "number" ? order.routeDurationMinutes : null, requiredVehicleClasses: Array.isArray(order.requiredVehicleClasses) ? order.requiredVehicleClasses : [], preparationMinutes: parsed.data.preparationMinutes, maxCustomerEtaMinutes: parsed.data.maxCustomerEtaMinutes, maxConcurrentOrders });
  await DispatchDecision.insertMany(ranked.map((decision) => ({ orderId: order._id, ...decision, riderId: objectId(decision.riderId), outcome: "preview", actorRole: req.auth?.role || "system" })));
  const diagnostic = {
    totalRiders: diagnosticPool.length,
    onlineRiders: diagnosticPool.filter((rider) => ["available", "busy"].includes(rider.status)).length,
    freshGpsRiders: diagnosticPool.filter((rider) => rider.lastLocationAt && new Date(rider.lastLocationAt).getTime() >= freshness.getTime()).length,
    ridersWithLocation: diagnosticPool.filter((rider) => rider.location?.coordinates?.length >= 2).length,
    eligibleRiders: riders.length,
    visibleRiders: diagnosticPool.map((rider) => ({ riderCode: rider.riderCode, name: rider.name, status: rider.status, lastLocationAt: rider.lastLocationAt, hasLocation: Boolean(rider.location?.coordinates?.length >= 2), hasFreshGps: Boolean(rider.lastLocationAt && new Date(rider.lastLocationAt).getTime() >= freshness.getTime()), hasActiveOrder: Boolean(rider.activeOrderId), sameTenant: !order.tenantId || String(rider.tenantId || "") === String(order.tenantId || ""), exclusion: !["available", "busy"].includes(rider.status) ? "not_available" : !rider.location?.coordinates?.length ? "missing_gps" : !rider.lastLocationAt || new Date(rider.lastLocationAt).getTime() < freshness.getTime() ? "gps_stale" : rider.activeOrderId ? "active_order" : null })),
  };
  return res.json({ algorithmVersion: ranked[0]?.algorithmVersion || "piki-jarvis-v1", orderId: order._id, policy, candidatesConsidered: riders.length, eligibleCandidates: ranked.length, candidates: ranked, diagnostic });
});

app.get("/api/v1/dispatch/orders/:id/decisions", requireRole("admin", "fleet"), async (req, res) => {
  const orderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const decisions = await DispatchDecision.find({ orderId }).sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ decisions });
});

app.post("/api/v1/dispatch/orders/:id/assign", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DISPATCH_REQUEST", details: parsed.error.flatten() });
  const orderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = objectId(orderIdParam);
  if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await findDispatchOrder(orderId, req);
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  if (!( ["authorized", "paid"] as string[]).includes(order.paymentState) && order.paymentMethod !== "cash") return res.status(409).json({ error: "ORDER_NOT_PAID" });
  if (!isDispatchableOrderStatus(order.status)) return res.status(409).json({ error: "ORDER_NOT_DISPATCHABLE", status: order.status });
  if (order.riderId || order.assignmentState === "assigned") return res.status(409).json({ error: "ORDER_ALREADY_ASSIGNED" });
  const scope = dispatchScope(req, order);
  const restaurant = await findDispatchRestaurant(order, req, scope);
  if (!restaurant?.location?.coordinates || !order.deliveryLocation?.coordinates) return res.status(409).json({ error: "MISSING_GEOLOCATION" });
  const freshness = new Date(Date.now() - 90_000);
  const policy = await dispatchLoadPolicy();
  const maxConcurrentOrders = policy.maxConcurrentOrders;
  const riderPool = await Rider.find({ ...scope }).select("_id riderCode name status lastLocationAt location tenantId fleetId activeOrderId zoneSlug vehicle reliabilityScore").limit(200).lean().exec() as any[];
  const currentRiderIds = new Set((await currentSlotRiderIds(scope)).map((id) => String(id)));
  const riders = riderPool.filter((rider: any) => currentRiderIds.has(String(rider._id)) && ["available", "busy"].includes(rider.status) && rider.lastLocationAt && new Date(rider.lastLocationAt).getTime() >= freshness.getTime() && rider.location?.coordinates?.length >= 2).slice(0, 100);
  const counts = await activeOrderCounts(riders.map((rider) => rider._id));
  const ranked = rankDispatchCandidates(riders.map((rider) => ({ id: String(rider._id), status: rider.status, vehicle: rider.vehicle, location: rider.location, lastLocationAt: rider.lastLocationAt, reliabilityScore: rider.reliabilityScore, activeOrderCount: counts.get(String(rider._id)) || 0, zoneFit: 1, servicePriority: 0.5 })), { restaurantLocation: [restaurant.location.coordinates[0], restaurant.location.coordinates[1]], customerLocation: [order.deliveryLocation.coordinates[0], order.deliveryLocation.coordinates[1]], routeDistanceKm: typeof order.routeDistanceKm === "number" ? order.routeDistanceKm : null, routeDurationMinutes: typeof order.routeDurationMinutes === "number" ? order.routeDurationMinutes : null, requiredVehicleClasses: Array.isArray(order.requiredVehicleClasses) ? order.requiredVehicleClasses : [], preparationMinutes: parsed.data.preparationMinutes, maxConcurrentOrders });
  if (!ranked.length) return res.status(409).json({ error: "NO_ELIGIBLE_RIDER", candidatesConsidered: riders.length });
  for (const decision of ranked) {
    const riderId = objectId(decision.riderId); if (!riderId) continue;
    const assignmentReservation = await reserveRiderOrderSlot(riderId, order._id, scope, maxConcurrentOrders);
    if (!assignmentReservation) continue;
    const rider = assignmentReservation.rider;
    const assigned = await Order.findOneAndUpdate({ _id: order._id, ...scope, riderId: null, assignmentState: { $in: ["unassigned", "expired", "rejected"] } }, { $set: { riderId: rider._id, assignmentState: "assigned", assignmentExpiresAt: null, dispatchScore: decision.score }, $inc: { dispatchAttempts: 1, version: 1 } }, { new: true }).lean().exec() as any;
    if (!assigned) { await releaseRiderOrderSlot(order._id, rider._id); continue; }
    await RiderAssignmentReservation.updateOne({ orderId: assigned._id, riderId: rider._id, status: "reserved" }, { $set: { expiresAt: null } }).exec();
    await DispatchDecision.create({ ...scope, orderId: assigned._id, ...decision, riderId: rider._id, outcome: "accepted", actorRole: req.auth?.role || "system" });
    await publishRiderOfferEvent(assigned, String(rider._id));
    return res.status(201).json({ assignment: { orderId: assigned._id, riderId: rider._id, slot: assignmentReservation.reservation.slot, state: assigned.assignmentState, expiresAt: null, score: decision.score, pickupDistanceKm: decision.pickupDistanceKm, pickupEtaMinutes: decision.pickupEtaMinutes, customerEtaMinutes: decision.customerEtaMinutes, totalEtaMinutes: decision.totalEtaMinutes, algorithmVersion: decision.algorithmVersion, maxConcurrentOrders, saturated: policy.saturated, reasons: decision.reasons } });
  }
  return res.status(409).json({ error: "RIDER_RESERVATION_RACE", message: "Los candidatos cambiaron mientras se asignaba el pedido; reintenta." });
});

app.post("/api/v1/dispatch/orders/:id/offer-response", requireRole("rider", "admin", "fleet"), async (req, res) => {
  const decisionSchema = z.object({ accept: z.boolean() });
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_OFFER_RESPONSE" });
  if (req.auth?.role === "rider" && !parsed.data.accept) return res.status(403).json({ error: "RIDER_REJECTION_NOT_ALLOWED", message: "Los repartos asignados son obligatorios. Si existe una incidencia, comunícala inmediatamente desde Soporte PIKI." });
  const orderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = objectId(orderIdParam); if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findOne({ _id: orderId, ...tenantScope(req) }).lean().exec() as any;
  if (!order || !order.riderId || order.assignmentState !== "offered") return res.status(404).json({ error: "ACTIVE_RIDER_OFFER_NOT_FOUND" });
  if (req.auth?.role === "rider") {
    const rider = await riderAccessForRequest(order.riderId, req);
    if (!rider) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  }
  if (new Date(order.assignmentExpiresAt || 0).getTime() < Date.now()) {
    await expireStaleOffers();
    return res.status(409).json({ error: "OFFER_EXPIRED", message: "La oferta ha vencido y se ha devuelto a la cola de reparto." });
  }
  if (parsed.data.accept) {
    const updated = await Order.findOneAndUpdate({ _id: orderId, ...tenantScope(req), assignmentState: "offered", riderId: order.riderId }, { $set: { assignmentState: "assigned" }, $inc: { version: 1 } }, { new: true }).lean().exec() as any;
    if (!updated) return res.status(409).json({ error: "OFFER_CHANGED_RETRY" });
    await RiderAssignmentReservation.updateOne({ orderId: updated._id, riderId: updated.riderId, status: "reserved" }, { $set: { expiresAt: null } }).exec();
    await publishOrderStatusEvents(updated, updated.status);
    return res.json({ assignment: { state: "assigned", orderId: updated._id, riderId: updated.riderId } });
  }
  await Order.findOneAndUpdate({ _id: orderId, ...tenantScope(req), assignmentState: "offered", riderId: order.riderId }, { $set: { assignmentState: "rejected", riderId: null, assignmentExpiresAt: null }, $inc: { version: 1 } }).exec();
  await releaseRiderOrderSlot(orderId, order.riderId);
  return res.json({ assignment: { state: "rejected", orderId } });
});

app.get("/api/v1/riders/:id/offers", requireRole("rider"), async (req, res) => {
  if (!databaseReady || mongoose.connection.readyState !== 1) return res.status(503).json({ error: "DATABASE_UNAVAILABLE", message: "La API está reconectando la base de datos; vuelve a intentar en unos segundos." });
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_SESSION" });
  const rider = await riderAccessForRequest(riderId, req);
  if (!rider) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const offers = await Order.find({ riderId, assignmentState: { $in: ["offered", "assigned"] }, status: { $nin: ["delivered", "cancelled"] } })
    .select("_id publicCode displayCode displayCodeDate restaurantId customerId riderId status paymentState paymentMethod totalCents assignmentState assignmentExpiresAt deliveryAddress deliveryLocation items createdAt +customerPhone")
    .sort({ createdAt: -1 }).limit(10).lean().exec() as any[];
  const riderProfile = await Rider.findById(riderId).select("vehicle").lean().exec() as any;
  const restaurantIds = offers.map((offer) => offer.restaurantId).filter(Boolean);
  const customerIds = offers.map((offer) => offer.customerId).filter((value): value is mongoose.Types.ObjectId => Boolean(value) && mongoose.isValidObjectId(value));
  const [restaurants, customers] = await Promise.all([
    Restaurant.find({ _id: { $in: restaurantIds } }).select("name address phone cuisine etaMinutes deliveryFeeCents").lean().exec(),
    CustomerAccount.find({ _id: { $in: customerIds } }).select("name").lean().exec(),
  ]);
  const restaurantById = new Map(restaurants.map((restaurant: any) => [String(restaurant._id), restaurant]));
  const customerById = new Map(customers.map((customer: any) => [String(customer._id), customer]));
  const phase: Record<string, string> = { accepted: "going_to_restaurant", preparing: "waiting_for_food", ready_for_pickup: "going_to_restaurant", picked_up: "going_to_customer", on_the_way: "going_to_customer" };
  const now = Date.now();
  const enrichedOffers = offers.map((offer) => {
    const restaurant = restaurantById.get(String(offer.restaurantId)) as any;
    const customer = customerById.get(String(offer.customerId)) as any;
    const customerPhase = ["picked_up", "on_the_way"].includes(offer.status);
    return {
      _id: offer._id,
      publicCode: offer.publicCode,
      displayCode: offer.displayCode || null,
      displayCodeDate: offer.displayCodeDate || null,
      status: offer.status,
      paymentState: offer.paymentState,
      paymentMethod: offer.paymentMethod || "stripe",
      totalCents: Number(offer.totalCents || 0),
      assignmentState: offer.assignmentState,
      assignmentExpiresAt: offer.assignmentExpiresAt,
      items: offer.items,
      createdAt: offer.createdAt,
      vehicle: riderProfile?.vehicle || "unknown",
      phase: phase[offer.status] || "assigned",
      etaMinutes: offer.assignmentExpiresAt ? Math.max(0, Math.ceil((new Date(offer.assignmentExpiresAt).getTime() - now) / 60000)) : null,
      restaurant: restaurant ? { name: restaurant.name, address: restaurant.address || "", phone: restaurant.phone || "", cuisine: restaurant.cuisine || "", etaMinutes: restaurant.etaMinutes || [] } : null,
      customerName: customerPhase ? customer?.name || "Cliente" : null,
      customerPhone: customerPhase ? offer.customerPhone || null : null,
      deliveryAddress: customerPhase ? offer.deliveryAddress || "" : null,
      deliveryLocation: customerPhase ? offer.deliveryLocation || null : null,
    };
  });
  return res.json({ offers: enrichedOffers, refreshedAt: new Date().toISOString() });
});

app.get("/api/v1/riders/operational-map", requireRole("rider"), async (req, res) => {
  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("zoneSlugs fleetId").lean().exec() as any : null;
  const zoneSlugs = Array.isArray(employee?.zoneSlugs) ? employee.zoneSlugs.filter((value: unknown): value is string => typeof value === "string") : [];
  const filter: Record<string, unknown> = { isActive: true };
  if (zoneSlugs.length) filter.slug = { $in: zoneSlugs };
  const zones = await Zone.find(filter).select("slug name isActive polygon").sort({ name: 1 }).lean().exec();
  return res.json({ zones, source: "piki-api", refreshedAt: new Date().toISOString() });
});
app.get("/api/v1/riders/:id/mobility-advice", requireRole("rider"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId || !req.auth?.employeeId) return res.status(400).json({ error: "INVALID_RIDER_SESSION" });
  const employee = await EmployeeAccount.findById(req.auth.employeeId).select("email").lean().exec() as any;
  const rider = employee ? await Rider.findOne({ _id: riderId, email: employee.email }).select("location").lean().exec() as any : null;
  if (!rider) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const zones = await Zone.find({ isActive: true }).select("slug name polygon").lean().exec() as any[];
  const since = new Date(Date.now() - 45 * 60 * 1000);
  const zoneDemand = await Promise.all(zones.map(async (zone) => {
    const coordinates = zone.polygon?.coordinates?.[0]?.[0];
    const anchor: [number, number] = Array.isArray(coordinates) ? [Number(coordinates[0]), Number(coordinates[1])] : [0, 0];
    const ordersLastWindow = await Order.countDocuments({ createdAt: { $gte: since }, status: { $nin: ["cancelled"] }, deliveryLocation: { $geoWithin: { $geometry: zone.polygon } } });
    return { slug: zone.slug, name: zone.name, anchor, ordersLastWindow };
  }));
  const currentPoint = rider.location?.coordinates;
  const currentZoneRaw = Array.isArray(currentPoint) && currentPoint.length >= 2
    ? await Zone.findOne({ isActive: true, polygon: { $geoIntersects: { $geometry: { type: "Point", coordinates: currentPoint } } } }).select("slug").lean().exec() as any
    : null;
  const currentZone = currentZoneRaw ? zoneDemand.find((zone) => zone.slug === currentZoneRaw.slug) || null : null;
  const advice = computeMobilityAdvice({ currentZone, zones: zoneDemand, lowActivityMinutes: Number(req.query.lowActivityMinutes || 15) });
  return res.json({ advice, checkedAt: new Date().toISOString(), windowMinutes: 45 });
});
app.post("/api/v1/zones", requireRole("admin"), async (req, res) => {
  const parsed = zoneSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_ZONE", details: parsed.error.flatten() });
  const zone = await Zone.findOneAndUpdate({ ...tenantScope(req), slug: parsed.data.slug }, { $set: { ...parsed.data, ...tenantScope(req), polygon: { type: "Polygon", coordinates: parsed.data.polygon.coordinates } } }, { upsert: true, new: true }).lean().exec();
  return res.status(201).json({ zone });
});

app.get("/api/v1/zones", requireRole("admin", "fleet"), async (req, res) => {
  const employee = await employeeScope(req);
  let filter: Record<string, unknown> = { ...tenantScope(req), isActive: true };
  if (req.auth?.role === "fleet") {
    const fleet = employee?.fleetId ? await Fleet.findById(employee.fleetId).select("serviceZones").lean().exec() as any : null;
    const allowedZones = Array.isArray(employee?.zoneSlugs) && employee.zoneSlugs.length ? employee.zoneSlugs : fleet?.serviceZones || [];
    if (allowedZones.length) filter.slug = { $in: allowedZones };
  }
  const zones = await Zone.find(filter).sort({ name: 1 }).lean().exec();
  return res.json({ zones });
});

app.get("/api/v1/fleets", requireRole("admin", "fleet"), async (req, res) => {
  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("fleetId").lean().exec() as any : null;
  const filter = req.auth?.role === "fleet" ? { _id: employee?.fleetId || null } : {};
  const fleets = await Fleet.find(filter).sort({ name: 1 }).lean().exec();
  return res.json({ fleets });
});

const fleetInputSchema = z.object({ name: z.string().trim().min(2).max(120), legalName: z.string().trim().max(180).default(""), taxId: z.string().trim().max(32).default(""), managerName: z.string().trim().min(2).max(120), contactEmail: z.string().trim().email().or(z.literal("")), contactPhone: z.string().trim().min(6).max(40), address: z.string().trim().min(5).max(240), postalCode: z.string().trim().min(3).max(12), city: z.string().trim().min(2).max(120), vehicleTypes: z.array(z.enum(["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"])).min(1).max(6), maxRiders: z.coerce.number().int().min(1).max(10000), serviceZones: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).max(300), notes: z.string().trim().max(2000).default("") });
app.post("/api/v1/fleets", requireRole("admin"), async (req, res) => {
  const parsed = fleetInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_FLEET", details: parsed.error.flatten() });
  const fleet = await Fleet.findOneAndUpdate({ ...tenantScope(req), name: parsed.data.name }, { $set: { ...parsed.data, ...tenantScope(req), taxId: parsed.data.taxId.toUpperCase() } }, { upsert: true, new: true, runValidators: true }).lean().exec();
  return res.status(201).json({ fleet });
});

app.patch("/api/v1/rider-applications/:id/assign-fleet", requireRole("admin", "fleet"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id); if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const fleetId = objectId(typeof req.body?.fleetId === "string" ? req.body.fleetId : ""); if (!fleetId) return res.status(400).json({ error: "INVALID_FLEET_ID" });
  const fleet = await Fleet.findOne({ _id: fleetId, ...(req.auth?.role === "fleet" ? { _id: (await employeeScope(req))?.fleetId || null } : {}) }).lean() as any; if (!fleet) return res.status(404).json({ error: "FLEET_NOT_FOUND" });
  const application = await RiderApplication.findOneAndUpdate({ _id: id, ...(req.auth?.role === "fleet" ? { assignedFleetId: fleet._id } : {}) }, { $set: { assignedFleetId: fleetId } }, { new: true }).lean().exec() as any;
  if (!application) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  if (application.status === "approved") await Rider.updateOne({ email: application.email }, { $set: { fleetId } }).exec();
  return res.json({ application, fleet });
});

app.get("/api/v1/fleets/pending-partner-orders", requireRole("admin", "fleet", "commercial"), async (req, res) => {
  const employee = await employeeScope(req);
  const commercialRestaurants = req.auth?.role === "commercial" ? await Restaurant.find({ commercialEmployeeId: employee?._id }).select("_id").lean().exec() : [];
  const orders = await Order.find({ ...dispatchablePaymentFilter, status: "pending", ...(req.auth?.role === "commercial" ? { restaurantId: { $in: commercialRestaurants.map((restaurant: any) => restaurant._id) } } : {}) }).select("publicCode restaurantId totalCents createdAt status paymentState paymentMethod assignmentState").sort({ createdAt: 1 }).limit(100).lean().exec() as any[];
  const restaurants = await Restaurant.find({ _id: { $in: orders.map((order) => order.restaurantId) } }).select("name").lean().exec() as any[];
  const names = new Map(restaurants.map((restaurant) => [String(restaurant._id), restaurant.name]));
  return res.json({ orders: orders.map((order) => ({ id: String(order._id), publicCode: order.publicCode, restaurant: names.get(String(order.restaurantId)) || "Restaurante", totalCents: order.totalCents, createdAt: order.createdAt, status: order.status, paymentState: order.paymentState, paymentMethod: order.paymentMethod || "stripe", cashDueAtDelivery: order.paymentMethod === "cash", assignmentState: order.assignmentState })) });
});
app.get("/api/v1/finance/overview", requireRole("admin", "finance"), async (_req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [gmv, cashIn, cashOut, pendingCash] = await Promise.all([
    Order.aggregate([{ $match: { paymentState: "paid", createdAt: { $gte: startOfDay } } }, { $group: { _id: null, totalCents: { $sum: "$totalCents" }, orders: { $sum: 1 } } }]),
    CashLedgerEntry.aggregate([{ $match: { direction: "in", createdAt: { $gte: startOfDay } } }, { $group: { _id: null, totalCents: { $sum: "$amountCents" } } }]),
    CashLedgerEntry.aggregate([{ $match: { direction: "out", createdAt: { $gte: startOfDay } } }, { $group: { _id: null, totalCents: { $sum: "$amountCents" } } }]),
    CashLedgerEntry.aggregate([{ $group: { _id: { riderId: "$riderId", direction: "$direction" }, totalCents: { $sum: "$amountCents" } } }]),
  ]);
  const balances = new Map<string, number>(); for (const row of pendingCash as any[]) { const key = String(row._id.riderId); balances.set(key, (balances.get(key) || 0) + (row._id.direction === "in" ? row.totalCents : -row.totalCents)); }
  return res.json({ service: "piki-api", overview: { gmv_today_cents: Number(gmv[0]?.totalCents || 0), paid_orders_today: Number(gmv[0]?.orders || 0), cash_collected_today_cents: Number(cashIn[0]?.totalCents || 0), cash_handed_over_today_cents: Number(cashOut[0]?.totalCents || 0), cash_pending_cents: Array.from(balances.values()).reduce((sum, value) => sum + Math.max(0, value), 0) } });
});

app.get("/api/v1/admin/overview", requireRole("admin"), async (_req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [activeRestaurants, pendingRestaurants, riders, openOrders, deliveredToday, gmv] = await Promise.all([
    Restaurant.countDocuments({ isActive: true, onboardingStatus: "approved" }),
    Restaurant.countDocuments({ onboardingStatus: "pending_review" }),
    Rider.countDocuments({ isTestRider: { $ne: true } }),
    Order.countDocuments({ status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"] } }),
    Order.countDocuments({ status: "delivered", deliveredAt: { $gte: startOfDay } }),
    Order.aggregate([{ $match: { paymentState: "paid", createdAt: { $gte: startOfDay } } }, { $group: { _id: null, totalCents: { $sum: "$totalCents" }, orders: { $sum: 1 } } }]),
  ]);
  res.json({ service: "piki-api", overview: { active_restaurants: activeRestaurants, pending_restaurants: pendingRestaurants, riders, open_orders: openOrders, delivered_today: deliveredToday, gmv_today_cents: Number(gmv[0]?.totalCents || 0), paid_orders_today: Number(gmv[0]?.orders || 0) } });
});

app.get("/api/v1/admin/operations/health", requireRole("admin", "fleet"), async (_req, res) => {
  const now = Date.now();
  const freshCutoff = new Date(now - 90_000);
  const staleCutoff = new Date(now - 10 * 60_000);
  const [riders, dispatchQueue, activeOffers, activeOrders] = await Promise.all([
    Rider.find({ isTestRider: { $ne: true } }).select("status lastLocationAt location fleetId zoneSlug").lean().exec(),
    Order.countDocuments({ riderId: null, assignmentState: { $in: ["unassigned", "expired", "rejected"] }, ...dispatchablePaymentFilter, status: { $in: [...dispatchableOrderStatuses] } }),
    Order.countDocuments({ assignmentState: "offered", assignmentExpiresAt: { $gt: new Date() } }),
    Order.countDocuments({ status: { $in: [...activeOperationalOrderStatuses] } }),
  ]);
  const summary = riders.reduce((acc: any, rider: any) => {
    const hasGps = Array.isArray(rider.location?.coordinates) && rider.location.coordinates.length >= 2;
    const last = rider.lastLocationAt ? new Date(rider.lastLocationAt) : null;
    const freshGps = Boolean(last && last >= freshCutoff && hasGps);
    const staleGps = Boolean(last && last < freshCutoff && last >= staleCutoff);
    acc.total += 1;
    if (["available", "busy"].includes(rider.status)) acc.online += 1;
    if (rider.status === "offline") acc.offline += 1;
    if (freshGps) acc.freshGps += 1;
    else if (staleGps) acc.staleGps += 1;
    else if (!hasGps || !last) acc.missingGps += 1;
    return acc;
  }, { total: 0, online: 0, offline: 0, freshGps: 0, staleGps: 0, missingGps: 0 });
  return res.json({ service: "piki-api", generatedAt: new Date().toISOString(), riders: summary, dispatch: { queue: dispatchQueue, activeOffers, activeOrders }, thresholds: { freshGpsSeconds: 90, staleGpsMinutes: 10 } });
});

app.get("/api/v1/admin/operations/live", requireRole("admin"), async (_req, res) => {
  const riders = await Rider.find({ isTestRider: { $ne: true }, location: { $exists: true } }).select("riderCode name email status vehicle location lastLocationAt activeOrderId fleetId").lean().exec() as any[];
  const activeOrderIds = riders.map((rider) => rider.activeOrderId).filter(Boolean);
  const orders = await Order.find({ _id: { $in: activeOrderIds } }).select("publicCode displayCode status assignmentState deliveryAddress restaurantId customerId riderId").select("+customerPhone").lean().exec() as any[];
  const restaurants = await Restaurant.find({ _id: { $in: orders.map((order) => order.restaurantId) } }).select("name address").lean().exec() as any[];
  const restaurantMap = new Map(restaurants.map((restaurant) => [String(restaurant._id), restaurant]));
  const orderMap = new Map(orders.map((order) => [String(order._id), { ...order, customerPhone: order.customerPhone || null, restaurant: restaurantMap.get(String(order.restaurantId)) || null }]));
  return res.json({ refreshedAt: new Date().toISOString(), riders: riders.map((rider) => ({ id: rider._id, riderCode: rider.riderCode, name: rider.name, status: rider.status, vehicle: rider.vehicle, location: rider.location, lastLocationAt: rider.lastLocationAt, activeOrder: rider.activeOrderId ? orderMap.get(String(rider.activeOrderId)) || null : null })) });
});

app.get("/api/v1/riders/overview", requireRole("admin", "fleet"), async (_req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [registered, unassigned, active, completed] = await Promise.all([Rider.countDocuments(), Order.countDocuments({ riderId: null, ...dispatchablePaymentFilter, status: { $in: [...dispatchableOrderStatuses] } }), Order.countDocuments({ riderId: { $ne: null }, status: { $in: ["picked_up", "on_the_way"] } }), Order.countDocuments({ riderId: { $ne: null }, status: "delivered", deliveredAt: { $gte: startOfDay } })]);
  res.json({ service: "piki-api", overview: { registered_riders: registered, unassigned_orders: unassigned, active_deliveries: active, completed_today: completed } });
});

app.get("/api/v1/riders/statistics", requireRole("rider"), async (req, res) => {
  if (!req.auth?.employeeId) return res.status(409).json({ error: "RIDER_EMPLOYEE_SESSION_REQUIRED" });
  const employee = await EmployeeAccount.findById(req.auth.employeeId).select("email").lean().exec() as any;
  const rider = employee ? await Rider.findOne({ email: employee.email }).select("_id reliabilityScore").lean().exec() as any : null;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const start = new Date(); start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - 6);
  const [summary, daily] = await Promise.all([
    Order.aggregate([{ $match: { riderId: rider._id } }, { $group: { _id: null, completed: { $sum: { $cond: [{ $eq: ["$status", "delivered"] }, 1, 0] } }, cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } }, accepted: { $sum: 1 } } }]),
    Order.aggregate([{ $match: { riderId: rider._id, deliveredAt: { $gte: start }, status: "delivered" } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$deliveredAt", timezone: "Europe/Madrid" } }, completed: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
  ]);
  const dailyMap = new Map(daily.map((item: any) => [item._id, item.completed]));
  const dailyDeliveries = Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(start.getDate() + index); const key = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(day); return { date: key, completed: dailyMap.get(key) || 0 }; });
  const totals = summary[0] || { completed: 0, cancelled: 0, accepted: 0 };
  return res.json({ statistics: { completed: totals.completed, cancelled: totals.cancelled, accepted: totals.accepted, rating: rider.reliabilityScore ? `${Math.round(rider.reliabilityScore * 100)}%` : "—", distance: "—", dailyDeliveries } });
});

app.get("/api/v1/fleets/overview", requireRole("admin", "fleet"), async (_req, res) => {
  const [fleets, assignedRiders, zones, liveOrders] = await Promise.all([Fleet.countDocuments({ isActive: true }), Rider.countDocuments({ fleetId: { $ne: null } }), Zone.countDocuments({ isActive: true }), Order.countDocuments({ status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"] } })]);
  res.json({ service: "piki-api", overview: { active_fleets: fleets, assigned_riders: assignedRiders, active_zones: zones, live_orders: liveOrders } });
});

app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) return next(error);
  // Never return stack traces, credentials, documents, or invalid values to clients/logs.
  const name = String(error?.name || "Error");
  const invalid = ["CastError", "ValidationError", "SyntaxError"].includes(name);
  const unavailable = /Mongo.*(Network|NotConnected|ServerSelection)|MongooseServerSelection/.test(name);
  const status = invalid ? 400 : unavailable ? 503 : 500;
  console.error(JSON.stringify({ event: "request_failed", method: req.method, path: req.path, errorType: name, status }));
  res.status(status).json({ error: invalid ? "INVALID_REQUEST" : unavailable ? "DATABASE_UNAVAILABLE" : "INTERNAL_SERVER_ERROR" });
});

async function repairConfiguredPartnerAccess() {
  const email = String(process.env.REPAIR_PARTNER_EMAIL || "").trim().toLowerCase();
  if (!email) return;
  const account = await EmployeeAccount.findOne({ email }).select("_id email restaurantId apiRole jobRole active authorizationStatus").lean().exec() as any;
  if (!account) { console.log(JSON.stringify({ event: "partner_access_repair", email, result: "account_not_found" })); return; }
  const restaurant = account.restaurantId
    ? await Restaurant.findById(account.restaurantId).select("_id email onboardingStatus isActive").lean().exec() as any
    : await Restaurant.findOne({ email }).select("_id email onboardingStatus isActive").lean().exec() as any;
  if (!restaurant) { console.log(JSON.stringify({ event: "partner_access_repair", email, result: "restaurant_not_found", accountId: String(account._id) })); return; }
  if (restaurant.onboardingStatus !== "approved" || restaurant.isActive !== true) {
    console.log(JSON.stringify({ event: "partner_access_repair", email, result: "restaurant_not_approved", restaurantId: String(restaurant._id), onboardingStatus: restaurant.onboardingStatus, isActive: restaurant.isActive })); return;
  }
  await EmployeeAccount.updateOne({ _id: account._id }, { $set: { restaurantId: restaurant._id, apiRole: "partner", jobRole: "partner", active: true, authorizationStatus: "approved", authorizedAt: new Date(), authorizationReason: "Reparación de acceso Partner solicitada por PIKI para pruebas operativas." } }).exec();
  console.log(JSON.stringify({ event: "partner_access_repair", email, result: "repaired", restaurantId: String(restaurant._id), previous: { active: account.active, authorizationStatus: account.authorizationStatus, apiRole: account.apiRole, jobRole: account.jobRole, restaurantId: account.restaurantId ? String(account.restaurantId) : null } }));
}

async function start() {
  const uri = process.env.MONGODB_URI;
  if (uri) { await mongoose.connect(uri, { dbName: databaseName, serverSelectionTimeoutMS: 10_000, socketTimeoutMS: 45_000, maxPoolSize: 20, minPoolSize: 2, retryWrites: true }); await EmployeeAccount.updateMany({ authorizationStatus: { $exists: false } }, { $set: { authorizationStatus: "approved", accessLevel: "subadmin" } }).exec(); await EmployeeAccount.updateOne({ email: ownerEmail }, { $set: { accessLevel: "superadmin", authorizationStatus: "approved", ownerProtected: true, active: true } }).exec(); const owner = await EmployeeAccount.findOne({ email: ownerEmail }).select("_id").lean().exec() as any; const legacyApproved = await EmployeeAccount.find({ email: { $ne: ownerEmail }, authorizationStatus: "approved", authorizedAt: null }).select("_id apiRole accessLevel createdAt").lean().exec() as any[]; for (const employee of legacyApproved) { const authorizedAt = employee.createdAt || new Date(); await EmployeeAccount.updateOne({ _id: employee._id, authorizedAt: null }, { $set: { authorizedAt, authorizedBy: owner?._id || null, authorizationReason: "Migración de autorización aprobada existente." } }).exec(); if (owner?._id && !(await AccessAuthorization.exists({ employeeId: employee._id }))) await AccessAuthorization.create({ employeeId: employee._id, action: "created", previousStatus: null, nextStatus: "approved", previousRole: null, nextRole: employee.apiRole, accessLevel: employee.accessLevel || "subadmin", actorEmployeeId: owner._id, reason: "Migración de autorización aprobada existente." }); } await ensureIndexes(); startRealtimeRelay(); startNotificationWorker(); if (process.env.REPAIR_PARTNER_EMAIL) await repairConfiguredPartnerAccess(); databaseReady = true; if (process.env.RUN_TENANT_MIGRATION === "true") { if (process.env.ALLOW_TENANT_MIGRATION !== "true") throw new Error("RUN_TENANT_MIGRATION requires ALLOW_TENANT_MIGRATION=true"); console.log(JSON.stringify({ event: "tenant_migration_started" })); console.log(JSON.stringify({ event: "tenant_migration_completed", ...(await runTenantMigration()) })); } } else console.warn("MONGODB_URI is not configured; /ready will remain unavailable.");
  await EmployeeSession.init();
  const server = app.listen(port, "0.0.0.0", () => console.log(`PIKI API listening on port ${port}`));
  const sweepTimer = setInterval(() => { void runAutomaticDispatchSweep().catch((error) => console.error("Automatic dispatch sweep crashed", error)); }, 5_000).unref();
  void runAutomaticDispatchSweep().catch((error) => console.error("Initial automatic dispatch sweep failed", error));
  process.once("SIGTERM", () => {
    clearInterval(sweepTimer); stopNotificationWorker(); databaseReady = false;
    server.close(() => { void mongoose.disconnect().finally(() => process.exit(0)); });
    setTimeout(() => process.exit(0), 25_000).unref();
  });
}

if (process.env.PIKI_NO_LISTEN !== "true") start().catch((error) => { console.error("Unable to start PIKI API", error); process.exit(1); });
