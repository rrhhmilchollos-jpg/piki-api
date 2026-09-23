import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Fleet, Order, Restaurant, Rider, RiderApplication, RiderIncident, RiderSlot, Zone, ensureIndexes } from "./models.js";
import { seedCatalog } from "./seed.js";
import { assertTransition, calculateEtaRange, transitionSchema, validateCoordinates } from "./workflow.js";
import { configuredAuthRoles, requireRole } from "./auth.js";
import { createCheckoutSession, processStripeWebhook, stripeConfigured } from "./stripe.js";
import { rankDispatchCandidates } from "./dispatch.js";
import { calculateSanctionDecision, defaultSanctionPolicy } from "./sanctions.js";
import { handleCustomerTrpc } from "./customerCompat.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultOrigins = ["http://localhost:3000", "http://localhost:5173", "https://pikidelivery.com", "https://www.pikidelivery.com", "https://app.pikidelivery.com", "https://partners.pikidelivery.com", "https://admin.pikidelivery.com", "https://riders.pikidelivery.com", "https://fleet.pikidelivery.com"].join(",");
const allowedOrigins = (process.env.CORS_ORIGINS || defaultOrigins).split(",").map((origin) => origin.trim()).filter(Boolean);
const databaseName = process.env.MONGODB_DB || "piki";
let databaseReady = false;

app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true, credentials: true }));
app.post("/api/v1/payments/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.header("stripe-signature");
  if (!signature || !stripeConfigured()) return res.status(503).json({ error: "STRIPE_WEBHOOK_NOT_CONFIGURED" });
  try {
    const result = await processStripeWebhook(req.body as Buffer, signature);
    return res.status(200).json({ received: true, ...result });
  } catch (error) {
    return res.status(400).json({ error: "INVALID_STRIPE_WEBHOOK", message: error instanceof Error ? error.message : "Webhook rejected" });
  }
});
app.use(express.json({ limit: "1mb" }));
app.all("/api/trpc/:procedure", handleCustomerTrpc);

const objectId = (value: string) => mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;
const locationSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const orderItemSchema = z.object({ itemId: z.string().min(1), quantity: z.number().int().min(1).max(20) });
const createOrderSchema = z.object({ restaurantId: z.string().min(1), customerId: z.string().max(160).optional(), deliveryAddress: z.string().min(5).max(280), deliveryLocation: locationSchema, items: z.array(orderItemSchema).min(1).max(50) });
const riderLocationSchema = locationSchema.extend({ riderId: z.string().min(1) });
const zoneSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), serviceFeeCents: z.number().int().min(0).max(10000).default(0), maxEtaMinutes: z.number().int().min(1).max(240).default(60), polygon: z.object({ coordinates: z.array(z.array(z.array(z.number()))).min(1) }) });
const dispatchSchema = z.object({ preparationMinutes: z.number().int().min(1).max(180).default(15), offerSeconds: z.number().int().min(15).max(180).default(60) });
const riderIncidentSchema = z.object({ reason: z.enum(["late_acceptance", "late_delivery", "no_show", "unsafe_driving", "fraud_signal", "customer_complaint", "document_expired", "other"]), evidence: z.array(z.string().url()).max(10).default([]), occurredAt: z.coerce.date().optional() });
const riderSlotSchema = z.object({ zoneSlug: z.string().regex(/^[a-z0-9-]+$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/), status: z.enum(["planned", "active", "completed", "cancelled"]).default("planned"), notes: z.string().max(500).default("") });
const riderSlotCreateSchema = riderSlotSchema.extend({ riderId: z.string().regex(/^[a-f\d]{24}$/) });
const riderApplicationSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), phone: z.string().min(6).max(40), city: z.string().min(2).max(120), vehicle: z.enum(["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"]), availability: z.string().min(2).max(160), website: z.string().max(0).optional() });
const riderApplicationAttempts = new Map<string, { count: number; resetAt: number }>();

function allowRiderApplication(ip: string) {
  const now = Date.now(); const current = riderApplicationAttempts.get(ip);
  if (!current || current.resetAt <= now) { riderApplicationAttempts.set(ip, { count: 1, resetAt: now + 15 * 60_000 }); return true; }
  if (current.count >= 5) return false; current.count += 1; return true;
}

app.get("/health", (_req, res) => res.json({ service: "piki-api", status: "ok", version: "0.2.0", environment: process.env.NODE_ENV || "development" }));
app.get("/ready", (_req, res) => {
  if (!databaseReady || mongoose.connection.readyState !== 1) return res.status(503).json({ service: "piki-api", status: "not_ready", database: "unavailable" });
  return res.json({ service: "piki-api", status: "ready", database: "connected" });
});
app.get("/api/v1", (_req, res) => res.json({ name: "PIKI API", version: "v1", status: databaseReady ? "ready" : "initializing" }));

app.get("/api/v1/auth/status", (_req, res) => res.json({ authentication: "bearer", configured_roles: configuredAuthRoles() }));
app.get("/api/v1/payments/status", (_req, res) => res.json({ provider: "stripe", secretKeyConfigured: Boolean(process.env.STRIPE_SECRET_KEY), webhookConfigured: stripeConfigured(), mode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "live" : "test_or_unknown" }));

app.get("/api/v1/catalog/restaurants", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const filter: Record<string, unknown> = { isActive: true, onboardingStatus: "approved" };
  if (category && category !== "Todos") filter.category = category;
  if (query) filter.$or = [{ name: { $regex: query, $options: "i" } }, { cuisine: { $regex: query, $options: "i" } }, { category: { $regex: query, $options: "i" } }];
  const restaurants = await Restaurant.find(filter).sort({ promoted: -1, rating: -1, reviews: -1 }).lean().exec();
  res.json({ restaurants });
});

app.get("/api/v1/coverage", async (req, res) => {
  const latitude = Number(req.query.latitude); const longitude = Number(req.query.longitude);
  if (!validateCoordinates(latitude, longitude)) return res.status(400).json({ error: "INVALID_COORDINATES" });
  const point = { type: "Point", coordinates: [longitude, latitude] } as const;
  const zones = await Zone.find({ isActive: true, polygon: { $geoIntersects: { $geometry: point } } }).lean().exec();
  const restaurants = zones.length ? await Restaurant.find({ isActive: true, onboardingStatus: "approved", location: { $geoWithin: { $geometry: { type: "Polygon", coordinates: zones[0].polygon.coordinates } } } }).sort({ promoted: -1, rating: -1 }).lean().exec() : [];
  res.json({ covered: zones.length > 0, zones, restaurants });
});

const partnerSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), phone: z.string().min(6).max(40), address: z.string().min(5).max(280).optional() });
app.post("/api/v1/partners/onboarding", async (req, res) => {
  const parsed = partnerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PARTNER", details: parsed.error.flatten() });
  const slug = `${parsed.data.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
  const partner = await Restaurant.create({ slug, name: parsed.data.name, cuisine: "Pendiente de configurar", category: "Otros", address: parsed.data.address || "", tagline: "Solicitud recibida por PIKI", onboardingStatus: "pending_review", isActive: false, email: parsed.data.email, phone: parsed.data.phone });
  res.status(201).json({ message: "Solicitud recibida para revisión.", partner: { id: partner.id, name: partner.name, email: partner.email, phone: partner.phone, onboarding_status: partner.onboardingStatus } });
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
  const restaurant = await Restaurant.findByIdAndUpdate(id, { $set: { onboardingStatus: parsed.data.status, isActive: parsed.data.status === "approved" } }, { new: true }).lean().exec();
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant });
});

app.post("/api/v1/riders/applications", async (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!allowRiderApplication(ip)) return res.status(429).json({ error: "APPLICATION_RATE_LIMITED", retryAfterSeconds: 900 });
  const parsed = riderApplicationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_APPLICATION", details: parsed.error.flatten() });
  if (parsed.data.website) return res.status(400).json({ error: "INVALID_RIDER_APPLICATION" });
  const duplicate = await RiderApplication.findOne({ email: parsed.data.email.toLowerCase(), status: { $in: ["pending", "contacted", "approved"] } }).lean().exec();
  if (duplicate) return res.status(409).json({ error: "APPLICATION_ALREADY_EXISTS" });
  const application = await RiderApplication.create({ ...parsed.data, email: parsed.data.email.toLowerCase(), status: "pending", source: "rider_landing" });
  return res.status(201).json({ message: "Solicitud recibida. El equipo Fleet se pondrá en contacto contigo.", application: { id: application.id, status: application.status } });
});

app.get("/api/v1/rider-applications", requireRole("admin", "fleet"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const filter = status ? { status } : {};
  const applications = await RiderApplication.find(filter).sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ applications });
});

app.patch("/api/v1/rider-applications/:id/status", requireRole("admin", "fleet"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam); if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const parsed = z.object({ status: z.enum(["pending", "contacted", "approved", "rejected"]), notes: z.string().max(1000).optional(), assignedFleetId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_APPLICATION_STATUS", details: parsed.error.flatten() });
  const update: Record<string, unknown> = { status: parsed.data.status, notes: parsed.data.notes };
  if (parsed.data.assignedFleetId !== undefined) update.assignedFleetId = parsed.data.assignedFleetId ? objectId(parsed.data.assignedFleetId) : null;
  const application = await RiderApplication.findByIdAndUpdate(id, { $set: update }, { new: true }).lean().exec() as any;
  if (!application) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  if (parsed.data.status === "approved") {
    await Rider.findOneAndUpdate({ email: application.email }, { $set: { name: application.name, email: application.email, vehicle: application.vehicle, fleetId: application.assignedFleetId || null, status: "offline" } }, { upsert: true, new: true }).exec();
  }
  return res.json({ application });
});

app.get("/api/v1/riders", requireRole("admin", "fleet"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const riders = await Rider.find(status ? { status } : {}).sort({ name: 1 }).limit(200).lean().exec();
  return res.json({ riders });
});

app.get("/api/v1/rider-slots", requireRole("admin", "fleet", "rider"), async (req, res) => {
  const riderId = typeof req.query.riderId === "string" ? objectId(req.query.riderId) : null;
  const filter = riderId ? { riderId } : {};
  const slots = await RiderSlot.find(filter).sort({ date: 1, startTime: 1 }).limit(500).lean().exec();
  return res.json({ slots });
});

app.post("/api/v1/rider-slots", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = riderSlotCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SLOT", details: parsed.error.flatten() });
  const riderId = objectId(parsed.data.riderId); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findById(riderId).lean().exec(); if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const zone = await Zone.findOne({ slug: parsed.data.zoneSlug, isActive: true }).lean().exec() as any; if (!zone) return res.status(404).json({ error: "ZONE_NOT_FOUND" });
  const { riderId: _riderId, ...slotData } = parsed.data;
  const slot = await RiderSlot.findOneAndUpdate({ riderId, date: parsed.data.date, startTime: parsed.data.startTime }, { $set: { ...slotData, riderId, zoneSlug: zone.slug } }, { upsert: true, new: true }).lean().exec();
  return res.status(201).json({ slot });
});

app.post("/api/v1/orders", async (req, res) => {
  const parsed = createOrderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_ORDER", details: parsed.error.flatten() });
  const restaurantObjectId = objectId(parsed.data.restaurantId);
  if (!restaurantObjectId) return res.status(400).json({ error: "INVALID_RESTAURANT_ID" });
  const restaurant = await Restaurant.findOne({ _id: restaurantObjectId, isActive: true, onboardingStatus: "approved" }).lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_AVAILABLE" });
  const items = parsed.data.items.map((requested) => { const item = restaurant.menu.find((candidate: any) => candidate.id === requested.itemId); return item ? { itemId: item.id, name: item.name, quantity: requested.quantity, unitPriceCents: Math.round(item.price * 100) } : null; });
  if (items.some((item) => !item)) return res.status(400).json({ error: "INVALID_MENU_ITEM" });
  const normalizedItems = items as Array<{ itemId: string; name: string; quantity: number; unitPriceCents: number }>;
  const subtotalCents = normalizedItems.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
  const deliveryFeeCents = restaurant.deliveryFeeCents;
  const serviceFeeCents = 79;
  const totalCents = subtotalCents + deliveryFeeCents + serviceFeeCents;
  const publicCode = `PIKI-${Date.now().toString(36).toUpperCase()}`;
  const order = await Order.create({ publicCode, restaurantId: restaurant._id, customerId: parsed.data.customerId || null, items: normalizedItems, deliveryAddress: parsed.data.deliveryAddress, deliveryLocation: { type: "Point", coordinates: [parsed.data.deliveryLocation.longitude, parsed.data.deliveryLocation.latitude] }, subtotalCents, deliveryFeeCents, totalCents, paymentState: "pending", statusHistory: [{ status: "pending", actorRole: "customer", reason: "Pedido creado" }] });
  res.status(201).json({ order: { id: order.id, publicCode, status: order.status, paymentState: order.paymentState, subtotalCents, deliveryFeeCents, serviceFeeCents, totalCents, etaMinutes: calculateEtaRange([restaurant.etaMinutes[0] || 20, restaurant.etaMinutes[1] || 35], [5, 20]) } });
});

const checkoutSchema = z.object({ orderId: z.string().min(1), origin: z.string().url(), customerEmail: z.string().email().optional() });
app.post("/api/v1/payments/checkout", async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_CHECKOUT_REQUEST", details: parsed.error.flatten() });
  const id = objectId(parsed.data.orderId);
  const order = (id ? await Order.findById(id).lean().exec() : await Order.findOne({ publicCode: parsed.data.orderId }).lean().exec()) as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  if (order.paymentState === "paid") return res.status(409).json({ error: "ORDER_ALREADY_PAID" });
  try {
    const session = await createCheckoutSession({ orderId: String(order._id), publicCode: order.publicCode, origin: parsed.data.origin, customerEmail: parsed.data.customerEmail, items: order.items, deliveryFeeCents: order.deliveryFeeCents, serviceFeeCents: 79 });
    await Order.updateOne({ _id: order._id }, { $set: { stripeCheckoutSessionId: session.id } }).exec();
    return res.status(201).json({ checkout: { id: session.id, url: session.url, expiresAt: session.expires_at } });
  } catch (error) {
    return res.status(503).json({ error: "STRIPE_UNAVAILABLE", message: error instanceof Error ? error.message : "Stripe unavailable" });
  }
});

app.get("/api/v1/orders", requireRole("admin", "partner", "rider", "fleet"), async (req, res) => {
  const filter: Record<string, unknown> = {};
  if (typeof req.query.customerId === "string") filter.customerId = req.query.customerId;
  if (typeof req.query.status === "string") filter.status = req.query.status;
  const orders = await Order.find(filter).sort({ createdAt: -1 }).limit(100).lean().exec();
  res.json({ orders });
});

app.get("/api/v1/orders/:id", async (req, res) => {
  const id = objectId(req.params.id); const order = id ? await Order.findById(id).lean().exec() : await Order.findOne({ publicCode: req.params.id }).lean().exec();
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  return res.json({ order });
});

app.post("/api/v1/orders/:id/transitions", requireRole("admin", "partner", "rider", "fleet"), async (req, res) => {
  const parsed = transitionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_TRANSITION", details: parsed.error.flatten() });
  const orderId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(orderId); if (!id) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findById(id); if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const actorRole = req.auth?.role === "admin" ? parsed.data.actorRole : req.auth?.role;
  if (!actorRole) return res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  try { assertTransition(order.status, parsed.data.status, actorRole); } catch (error) { return res.status(409).json({ error: "INVALID_ORDER_TRANSITION", message: error instanceof Error ? error.message : "Transition not allowed" }); }
  const update: Record<string, unknown> = { $set: { status: parsed.data.status }, $inc: { version: 1 }, $push: { statusHistory: { status: parsed.data.status, actorRole, reason: parsed.data.reason || "" } } };
  if (parsed.data.status === "delivered") update.$set = { status: "delivered", deliveredAt: new Date() };
  if (parsed.data.status === "cancelled") update.$set = { status: "cancelled", cancelledAt: new Date() };
  const updated = await Order.findOneAndUpdate({ _id: id, version: order.version, status: order.status }, update, { new: true }).lean().exec();
  if (!updated) return res.status(409).json({ error: "ORDER_CHANGED_RETRY" });
  return res.json({ order: updated });
});

app.post("/api/v1/riders/:id/location", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const parsed = riderLocationSchema.safeParse({ ...req.body, riderId: req.params.id });
  if (!parsed.success) return res.status(400).json({ error: "INVALID_LOCATION", details: parsed.error.flatten() });
  const id = objectId(parsed.data.riderId); if (!id) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findByIdAndUpdate(id, { $set: { location: { type: "Point", coordinates: [parsed.data.longitude, parsed.data.latitude] }, lastLocationAt: new Date() } }, { new: true }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  return res.json({ rider: { id: rider._id, status: rider.status, location: rider.location, lastLocationAt: rider.lastLocationAt } });
});

app.get("/api/v1/riders/:id/slots", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const riderId = objectId(riderIdParam); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const slots = await RiderSlot.find({ riderId }).sort({ date: 1, startTime: 1 }).limit(100).lean().exec();
  return res.json({ riderId, slots });
});

app.post("/api/v1/riders/:id/slots", requireRole("admin", "fleet"), async (req, res) => {
  const riderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const riderId = objectId(riderIdParam); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const parsed = riderSlotSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_SLOT", details: parsed.error.flatten() });
  const rider = await Rider.findById(riderId).lean().exec(); if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const overlap = await RiderSlot.findOne({ riderId, date: parsed.data.date, status: { $nin: ["cancelled", "completed"] }, $or: [{ startTime: { $lt: parsed.data.endTime }, endTime: { $gt: parsed.data.startTime } }] }).lean().exec();
  if (overlap) return res.status(409).json({ error: "RIDER_SLOT_OVERLAP", slot: overlap });
  const slot = await RiderSlot.create({ ...parsed.data, riderId });
  return res.status(201).json({ slot });
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

app.post("/api/v1/dispatch/orders/:id/assign", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DISPATCH_REQUEST", details: parsed.error.flatten() });
  const orderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = objectId(orderIdParam);
  if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findById(orderId).lean().exec() as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  if (order.paymentState !== "paid") return res.status(409).json({ error: "ORDER_NOT_PAID" });
  if (!["accepted", "preparing", "ready_for_pickup"].includes(order.status)) return res.status(409).json({ error: "ORDER_NOT_DISPATCHABLE", status: order.status });
  if (order.riderId || order.assignmentState === "assigned") return res.status(409).json({ error: "ORDER_ALREADY_ASSIGNED" });
  const restaurant = await Restaurant.findById(order.restaurantId).lean().exec() as any;
  if (!restaurant?.location?.coordinates || !order.deliveryLocation?.coordinates) return res.status(409).json({ error: "MISSING_GEOLOCATION" });
  const freshness = new Date(Date.now() - 90_000);
  const riders = await Rider.find({ status: "available", activeOrderId: null, lastLocationAt: { $gte: freshness }, location: { $exists: true } }).limit(100).lean().exec() as any[];
  const ranked = rankDispatchCandidates(riders.map((rider) => ({ id: String(rider._id), status: rider.status, vehicle: rider.vehicle, location: rider.location, lastLocationAt: rider.lastLocationAt, reliabilityScore: rider.reliabilityScore, activeOrderCount: 0, zoneFit: 1, servicePriority: 0.5 })), { restaurantLocation: [restaurant.location.coordinates[0], restaurant.location.coordinates[1]], customerLocation: [order.deliveryLocation.coordinates[0], order.deliveryLocation.coordinates[1]], preparationMinutes: parsed.data.preparationMinutes });
  if (!ranked.length) return res.status(409).json({ error: "NO_ELIGIBLE_RIDER", candidatesConsidered: riders.length });
  for (const decision of ranked) {
    const rider = await Rider.findOneAndUpdate({ _id: objectId(decision.riderId), status: "available", activeOrderId: null }, { $set: { status: "busy", activeOrderId: order._id } }, { new: true }).lean().exec() as any;
    if (!rider) continue;
    const expiresAt = new Date(Date.now() + parsed.data.offerSeconds * 1000);
    const assigned = await Order.findOneAndUpdate({ _id: order._id, riderId: null, assignmentState: { $in: ["unassigned", "expired", "rejected"] } }, { $set: { riderId: rider._id, assignmentState: "offered", assignmentExpiresAt: expiresAt, dispatchScore: decision.score }, $inc: { dispatchAttempts: 1, version: 1 } }, { new: true }).lean().exec() as any;
    if (!assigned) { await Rider.updateOne({ _id: rider._id, activeOrderId: order._id }, { $set: { status: "available", activeOrderId: null } }).exec(); continue; }
    return res.status(201).json({ assignment: { orderId: assigned._id, riderId: rider._id, state: assigned.assignmentState, expiresAt, score: decision.score, pickupDistanceKm: decision.pickupDistanceKm, pickupEtaMinutes: decision.pickupEtaMinutes, customerEtaMinutes: decision.customerEtaMinutes, reasons: decision.reasons } });
  }
  return res.status(409).json({ error: "RIDER_RESERVATION_RACE", message: "Los candidatos cambiaron mientras se asignaba el pedido; reintenta." });
});

app.post("/api/v1/dispatch/orders/:id/offer-response", requireRole("rider", "admin", "fleet"), async (req, res) => {
  const decisionSchema = z.object({ accept: z.boolean() });
  const parsed = decisionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_OFFER_RESPONSE" });
  const orderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = objectId(orderIdParam); if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findById(orderId).lean().exec() as any;
  if (!order || !order.riderId || order.assignmentState !== "offered") return res.status(404).json({ error: "ACTIVE_RIDER_OFFER_NOT_FOUND" });
  if (new Date(order.assignmentExpiresAt || 0).getTime() < Date.now()) parsed.data.accept = false;
  if (parsed.data.accept) {
    const updated = await Order.findOneAndUpdate({ _id: orderId, assignmentState: "offered", riderId: order.riderId }, { $set: { assignmentState: "assigned" }, $inc: { version: 1 } }, { new: true }).lean().exec() as any;
    return updated ? res.json({ assignment: { state: "assigned", orderId: updated._id, riderId: updated.riderId } }) : res.status(409).json({ error: "OFFER_CHANGED_RETRY" });
  }
  await Order.findOneAndUpdate({ _id: orderId, assignmentState: "offered", riderId: order.riderId }, { $set: { assignmentState: "rejected", riderId: null, assignmentExpiresAt: null }, $inc: { version: 1 } }).exec();
  await Rider.updateOne({ _id: order.riderId, activeOrderId: orderId }, { $set: { status: "available", activeOrderId: null } }).exec();
  return res.json({ assignment: { state: "rejected", orderId } });
});

app.post("/api/v1/zones", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = zoneSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_ZONE", details: parsed.error.flatten() });
  const zone = await Zone.findOneAndUpdate({ slug: parsed.data.slug }, { $set: { ...parsed.data, polygon: { type: "Polygon", coordinates: parsed.data.polygon.coordinates } } }, { upsert: true, new: true }).lean().exec();
  return res.status(201).json({ zone });
});

app.get("/api/v1/zones", requireRole("admin", "fleet"), async (_req, res) => {
  const zones = await Zone.find({}).sort({ name: 1 }).lean().exec();
  return res.json({ zones });
});

app.get("/api/v1/fleets", requireRole("admin", "fleet"), async (_req, res) => {
  const fleets = await Fleet.find({}).sort({ name: 1 }).lean().exec();
  return res.json({ fleets });
});

app.post("/api/v1/fleets", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = z.object({ name: z.string().min(2).max(120), managerName: z.string().max(120).default(""), serviceZones: z.array(z.string().regex(/^[a-z0-9-]+$/)).default([]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_FLEET", details: parsed.error.flatten() });
  const fleet = await Fleet.findOneAndUpdate({ name: parsed.data.name }, { $set: parsed.data }, { upsert: true, new: true }).lean().exec();
  return res.status(201).json({ fleet });
});

app.patch("/api/v1/rider-applications/:id/assign-fleet", requireRole("admin", "fleet"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id); if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const fleetId = objectId(typeof req.body?.fleetId === "string" ? req.body.fleetId : ""); if (!fleetId) return res.status(400).json({ error: "INVALID_FLEET_ID" });
  const fleet = await Fleet.findById(fleetId).lean().exec(); if (!fleet) return res.status(404).json({ error: "FLEET_NOT_FOUND" });
  const application = await RiderApplication.findByIdAndUpdate(id, { $set: { assignedFleetId: fleetId } }, { new: true }).lean().exec() as any;
  if (!application) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  if (application.status === "approved") await Rider.updateOne({ email: application.email }, { $set: { fleetId } }).exec();
  return res.json({ application, fleet });
});

app.get("/api/v1/admin/overview", requireRole("admin"), async (_req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [activeRestaurants, pendingRestaurants, riders, openOrders, deliveredToday] = await Promise.all([Restaurant.countDocuments({ isActive: true, onboardingStatus: "approved" }), Restaurant.countDocuments({ onboardingStatus: "pending_review" }), Rider.countDocuments(), Order.countDocuments({ status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"] } }), Order.countDocuments({ status: "delivered", deliveredAt: { $gte: startOfDay } })]);
  res.json({ service: "piki-api", overview: { active_restaurants: activeRestaurants, pending_restaurants: pendingRestaurants, riders, open_orders: openOrders, delivered_today: deliveredToday } });
});

app.get("/api/v1/riders/overview", requireRole("admin", "rider", "fleet"), async (_req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [registered, unassigned, active, completed] = await Promise.all([Rider.countDocuments(), Order.countDocuments({ riderId: null, status: "ready_for_pickup" }), Order.countDocuments({ riderId: { $ne: null }, status: { $in: ["picked_up", "on_the_way"] } }), Order.countDocuments({ riderId: { $ne: null }, status: "delivered", deliveredAt: { $gte: startOfDay } })]);
  res.json({ service: "piki-api", overview: { registered_riders: registered, unassigned_orders: unassigned, active_deliveries: active, completed_today: completed } });
});

app.get("/api/v1/fleets/overview", requireRole("admin", "fleet"), async (_req, res) => {
  const [fleets, assignedRiders, zones, liveOrders] = await Promise.all([Fleet.countDocuments({ isActive: true }), Rider.countDocuments({ fleetId: { $ne: null } }), Zone.countDocuments({ isActive: true }), Order.countDocuments({ status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"] } })]);
  res.json({ service: "piki-api", overview: { active_fleets: fleets, assigned_riders: assignedRiders, active_zones: zones, live_orders: liveOrders } });
});

app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));

async function start() {
  const uri = process.env.MONGODB_URI;
  if (uri) { await mongoose.connect(uri, { dbName: databaseName, serverSelectionTimeoutMS: 10_000 }); await ensureIndexes(); if (process.env.SEED_DEMO_DATA === "true") await seedCatalog(); databaseReady = true; } else console.warn("MONGODB_URI is not configured; /ready will remain unavailable.");
  app.listen(port, "0.0.0.0", () => console.log(`PIKI API listening on port ${port}`));
}

start().catch((error) => { console.error("Unable to start PIKI API", error); process.exit(1); });
process.on("SIGTERM", () => { mongoose.disconnect().catch(() => undefined); });
