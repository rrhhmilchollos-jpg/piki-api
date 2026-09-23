import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Fleet, Order, Restaurant, Rider, Zone, ensureIndexes } from "./models.js";
import { seedCatalog } from "./seed.js";
import { assertTransition, calculateEtaRange, transitionSchema, validateCoordinates } from "./workflow.js";
import { configuredAuthRoles, requireRole } from "./auth.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultOrigins = ["http://localhost:3000", "http://localhost:5173", "https://pikidelivery.com", "https://www.pikidelivery.com", "https://app.pikidelivery.com", "https://partners.pikidelivery.com", "https://admin.pikidelivery.com", "https://riders.pikidelivery.com", "https://fleet.pikidelivery.com"].join(",");
const allowedOrigins = (process.env.CORS_ORIGINS || defaultOrigins).split(",").map((origin) => origin.trim()).filter(Boolean);
const databaseName = process.env.MONGODB_DB || "piki";
let databaseReady = false;

app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json({ limit: "1mb" }));

const objectId = (value: string) => mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;
const locationSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const orderItemSchema = z.object({ itemId: z.string().min(1), quantity: z.number().int().min(1).max(20) });
const createOrderSchema = z.object({ restaurantId: z.string().min(1), customerId: z.string().max(160).optional(), deliveryAddress: z.string().min(5).max(280), deliveryLocation: locationSchema, items: z.array(orderItemSchema).min(1).max(50) });
const riderLocationSchema = locationSchema.extend({ riderId: z.string().min(1) });
const zoneSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), serviceFeeCents: z.number().int().min(0).max(10000).default(0), maxEtaMinutes: z.number().int().min(1).max(240).default(60), polygon: z.object({ coordinates: z.array(z.array(z.array(z.number()))).min(1) }) });

app.get("/health", (_req, res) => res.json({ service: "piki-api", status: "ok", version: "0.2.0", environment: process.env.NODE_ENV || "development" }));
app.get("/ready", (_req, res) => {
  if (!databaseReady || mongoose.connection.readyState !== 1) return res.status(503).json({ service: "piki-api", status: "not_ready", database: "unavailable" });
  return res.json({ service: "piki-api", status: "ready", database: "connected" });
});
app.get("/api/v1", (_req, res) => res.json({ name: "PIKI API", version: "v1", status: databaseReady ? "ready" : "initializing" }));

app.get("/api/v1/auth/status", (_req, res) => res.json({ authentication: "bearer", configured_roles: configuredAuthRoles() }));

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
  const totalCents = subtotalCents + deliveryFeeCents + 79;
  const publicCode = `PIKI-${Date.now().toString(36).toUpperCase()}`;
  const order = await Order.create({ publicCode, restaurantId: restaurant._id, customerId: parsed.data.customerId || null, items: normalizedItems, deliveryAddress: parsed.data.deliveryAddress, deliveryLocation: { type: "Point", coordinates: [parsed.data.deliveryLocation.longitude, parsed.data.deliveryLocation.latitude] }, subtotalCents, deliveryFeeCents, totalCents, statusHistory: [{ status: "pending", actorRole: "customer", reason: "Pedido creado" }] });
  res.status(201).json({ order: { id: order.id, publicCode, status: order.status, subtotalCents, deliveryFeeCents, serviceFeeCents: 79, totalCents, etaMinutes: calculateEtaRange([restaurant.etaMinutes[0] || 20, restaurant.etaMinutes[1] || 35], [5, 20]) } });
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

app.post("/api/v1/zones", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = zoneSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_ZONE", details: parsed.error.flatten() });
  const zone = await Zone.findOneAndUpdate({ slug: parsed.data.slug }, { $set: { ...parsed.data, polygon: { type: "Polygon", coordinates: parsed.data.polygon.coordinates } } }, { upsert: true, new: true }).lean().exec();
  return res.status(201).json({ zone });
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
