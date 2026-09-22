import "dotenv/config";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { Fleet, Order, Restaurant, Rider, ensureIndexes } from "./models.js";
import { seedCatalog } from "./seed.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const defaultOrigins = ["http://localhost:3000", "http://localhost:5173"].join(",");
const allowedOrigins = (process.env.CORS_ORIGINS || defaultOrigins).split(",").map((origin) => origin.trim()).filter(Boolean);
const databaseName = process.env.MONGODB_DB || "piki";
let databaseReady = false;

app.use(cors({ origin: allowedOrigins.length ? allowedOrigins : true }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => res.json({ service: "piki-api", status: "ok", version: "0.1.0", environment: process.env.NODE_ENV || "development" }));
app.get("/ready", (_req, res) => {
  if (!databaseReady || mongoose.connection.readyState !== 1) return res.status(503).json({ service: "piki-api", status: "not_ready", database: "unavailable" });
  return res.json({ service: "piki-api", status: "ready", database: "connected" });
});
app.get("/api/v1", (_req, res) => res.json({ name: "PIKI API", version: "v1", status: databaseReady ? "ready" : "initializing" }));

app.get("/api/v1/catalog/restaurants", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const filter: Record<string, unknown> = { isActive: true, onboardingStatus: "approved" };
  if (category && category !== "Todos") filter.category = category;
  if (query) filter.$or = [{ name: { $regex: query, $options: "i" } }, { cuisine: { $regex: query, $options: "i" } }, { category: { $regex: query, $options: "i" } }];
  const restaurants = await Restaurant.find(filter).sort({ promoted: -1, rating: -1, reviews: -1 }).lean().exec();
  res.json({ restaurants });
});

const partnerSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), phone: z.string().min(6).max(40), address: z.string().min(5).max(280).optional() });
app.post("/api/v1/partners/onboarding", async (req, res) => {
  const parsed = partnerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_PARTNER", details: parsed.error.flatten() });
  const slug = `${parsed.data.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
  const partner = await Restaurant.create({ slug, name: parsed.data.name, cuisine: "Pendiente de configurar", category: "Otros", address: parsed.data.address || "", tagline: "Solicitud recibida por PIKI", onboardingStatus: "pending_review", isActive: false, email: parsed.data.email, phone: parsed.data.phone });
  res.status(201).json({ message: "Solicitud recibida para revisión.", partner: { id: partner.id, name: partner.name, onboardingStatus: partner.onboardingStatus } });
});

app.get("/api/v1/admin/overview", async (_req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [activeRestaurants, pendingRestaurants, riders, openOrders, deliveredToday] = await Promise.all([
    Restaurant.countDocuments({ isActive: true, onboardingStatus: "approved" }), Restaurant.countDocuments({ onboardingStatus: "pending_review" }), Rider.countDocuments(), Order.countDocuments({ status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"] } }), Order.countDocuments({ status: "delivered", deliveredAt: { $gte: startOfDay } }),
  ]);
  res.json({ service: "piki-api", overview: { active_restaurants: activeRestaurants, pending_restaurants: pendingRestaurants, riders, open_orders: openOrders, delivered_today: deliveredToday } });
});

app.get("/api/v1/riders/overview", async (_req, res) => {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const [registered, unassigned, active, completed] = await Promise.all([
    Rider.countDocuments(), Order.countDocuments({ riderId: null, status: "ready_for_pickup" }), Order.countDocuments({ riderId: { $ne: null }, status: { $in: ["picked_up", "on_the_way"] } }), Order.countDocuments({ riderId: { $ne: null }, status: "delivered", deliveredAt: { $gte: startOfDay } }),
  ]);
  res.json({ service: "piki-api", overview: { registered_riders: registered, unassigned_orders: unassigned, active_deliveries: active, completed_today: completed } });
});

app.get("/api/v1/fleets/overview", async (_req, res) => {
  const [fleets, assignedRiders, liveOrders] = await Promise.all([
    Fleet.countDocuments({ isActive: true }), Rider.countDocuments({ fleetId: { $ne: null } }), Order.countDocuments({ status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup", "picked_up", "on_the_way"] } }),
  ]);
  res.json({ service: "piki-api", overview: { active_fleets: fleets, assigned_riders: assignedRiders, active_zones: 0, live_orders: liveOrders } });
});

app.use((_req, res) => res.status(404).json({ error: "NOT_FOUND" }));

async function start() {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    await mongoose.connect(uri, { dbName: databaseName, serverSelectionTimeoutMS: 10_000 });
    await ensureIndexes();
    if (process.env.SEED_DEMO_DATA === "true") await seedCatalog();
    databaseReady = true;
  } else {
    console.warn("MONGODB_URI is not configured; /ready will remain unavailable.");
  }
  app.listen(port, "0.0.0.0", () => console.log(`PIKI API listening on port ${port}`));
}

start().catch((error) => { console.error("Unable to start PIKI API", error); process.exit(1); });
process.on("SIGTERM", () => { mongoose.disconnect().catch(() => undefined); });
