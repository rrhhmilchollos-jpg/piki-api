import "dotenv/config";
import { createHash, randomInt } from "node:crypto";
import cors from "cors";
import express from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { CustomerAccount, DispatchDecision, EmployeeAccount, Fleet, Order, Restaurant, PartnerAsset, PartnerLocalityGroup, Rider, RiderApplication, RiderIncident, RiderSlot, SignatureRequest, Zone, ensureIndexes } from "./models.js";
import { seedCatalog } from "./seed.js";
import { assertTransition, calculateEtaRange, transitionSchema, validateCoordinates } from "./workflow.js";
import { configuredAuthRoles, requireOwner, requireRole } from "./auth.js";
import { createCheckoutSession, processStripeWebhook, stripeConfigured } from "./stripe.js";
import { rankDispatchCandidates } from "./dispatch.js";
import { calculateSanctionDecision, defaultSanctionPolicy } from "./sanctions.js";
import { handleCustomerTrpc } from "./customerCompat.js";
import { createSessionToken, generateTemporaryPassword, hashPassword, hashSessionToken, verifyPassword } from "./employeeAuth.js";
import { createSignaturitSignature, signaturitBaseUrl, signaturitConfigured, signaturitMode, signatureWebhookUrl, webhookDigest } from "./signaturit.js";

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
app.use(express.json({ limit: "12mb" }));
app.all("/api/trpc/:procedure", handleCustomerTrpc);

const objectId = (value: string) => mongoose.isValidObjectId(value) ? new mongoose.Types.ObjectId(value) : null;
const locationSchema = z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) });
const orderItemSchema = z.object({ itemId: z.string().min(1), quantity: z.number().int().min(1).max(20) });
const createOrderSchema = z.object({ restaurantId: z.string().min(1), customerId: z.string().max(160).optional(), deliveryAddress: z.string().min(5).max(280), deliveryLocation: locationSchema, items: z.array(orderItemSchema).min(1).max(50) });
const riderLocationSchema = locationSchema.extend({ riderId: z.string().min(1) });
const zoneSchema = z.object({ name: z.string().min(2).max(120), slug: z.string().regex(/^[a-z0-9-]+$/), serviceFeeCents: z.number().int().min(0).max(10000).default(0), maxEtaMinutes: z.number().int().min(1).max(240).default(60), polygon: z.object({ coordinates: z.array(z.array(z.array(z.number()))).min(1) }) });
const dispatchSchema = z.object({ preparationMinutes: z.coerce.number().int().min(1).max(180).default(15), offerSeconds: z.coerce.number().int().min(15).max(180).default(60), maxCustomerEtaMinutes: z.coerce.number().int().min(10).max(240).optional() });
const riderIncidentSchema = z.object({ reason: z.enum(["late_acceptance", "late_delivery", "no_show", "unsafe_driving", "fraud_signal", "customer_complaint", "document_expired", "other"]), evidence: z.array(z.string().url()).max(10).default([]), occurredAt: z.coerce.date().optional() });
const riderSlotSchema = z.object({ zoneSlug: z.string().regex(/^[a-z0-9-]+$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/), status: z.enum(["planned", "active", "completed", "cancelled"]).default("planned"), notes: z.string().max(500).default("") });
const riderSlotCreateSchema = riderSlotSchema.extend({ riderId: z.string().regex(/^[a-f\d]{24}$/) });
const riderDocumentInputSchema = z.object({ type: z.enum(["identity", "residence_permit", "social_security_number", "bank_certificate", "driving_license", "insurance", "vehicle_registration", "vehicle_technical_sheet", "scooter_responsible_declaration", "dgt_mvp_homologation", "other"]), fileName: z.string().min(1).max(180), mimeType: z.string().min(1).max(120), sizeBytes: z.number().int().min(1).max(2_500_000), sha256: z.string().regex(/^[a-f0-9]{64}$/i), contentBase64: z.string().min(1).max(3_500_000) });
const riderApplicationSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), phone: z.string().min(6).max(40), city: z.string().min(2).max(120), vehicle: z.enum(["bike", "electric_bike", "electric_scooter", "motorcycle", "scooter", "car"]), availability: z.string().min(2).max(160), socialSecurityNumber: z.string().min(4).max(40), identityVerificationMethod: z.literal("online_scan"), safetyDeclarationAccepted: z.literal(true), documents: z.array(riderDocumentInputSchema).min(3).max(12), website: z.string().max(0).optional() });
const riderApplicationAttempts = new Map<string, { count: number; resetAt: number }>();
const ownerEmail = "rrhh.milchollos@gmail.com";
const MAX_MENU_IMAGE_BYTES = 200 * 1024;
const MENU_IMAGE_MIME_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;
function localityKey(value: string) { return value.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "sin-localidad"; }
function organizationFolder(locality: string, restaurantId: string) { return `partners/${localityKey(locality)}/${restaurantId}/menu`; }
function publicAssetUrl(assetId: string) { return `${process.env.PUBLIC_API_URL || "https://api.pikidelivery.com"}/api/v1/catalog/assets/${assetId}`; }

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
    Order.countDocuments({ riderId: null, paymentState: "paid", status: { $in: ["accepted", "preparing", "ready_for_pickup"] } }),
    Rider.countDocuments({ status: { $in: ["available", "busy"] } }),
  ]);
  const saturated = queuedOrders >= Math.max(3, Math.ceil(Math.max(activeRiders, 1) * 1.5));
  return { maxConcurrentOrders: saturated ? 2 as const : 1 as const, saturated, queuedOrders, activeRiders };
}

async function activeOrderCounts(riderIds: mongoose.Types.ObjectId[]) {
  const rows = await Order.aggregate([{ $match: { riderId: { $in: riderIds }, status: { $nin: ["delivered", "cancelled"] }, assignmentState: { $in: ["offered", "assigned"] } } }, { $group: { _id: "$riderId", count: { $sum: 1 } } }]);
  return new Map(rows.map((row: any) => [String(row._id), Number(row.count)]));
}

app.get("/health", (_req, res) => res.json({ service: "piki-api", status: "ok", version: "0.2.0", environment: process.env.NODE_ENV || "development" }));
app.get("/ready", (_req, res) => {
  if (!databaseReady || mongoose.connection.readyState !== 1) return res.status(503).json({ service: "piki-api", status: "not_ready", database: "unavailable" });
  return res.json({ service: "piki-api", status: "ready", database: "connected" });
});
app.get("/api/v1", (_req, res) => res.json({ name: "PIKI API", version: "v1", status: databaseReady ? "ready" : "initializing" }));

app.get("/api/v1/auth/status", (_req, res) => res.json({ authentication: "bearer", configured_roles: configuredAuthRoles() }));
const employeeLoginSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(200) });
app.post("/api/v1/auth/employee/login", async (req, res) => {
  const parsed = employeeLoginSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_LOGIN" });
  const employee = await EmployeeAccount.findOne({ email: parsed.data.email.toLowerCase(), active: true }).select("+passwordHash").exec() as any;
  if (!employee || !verifyPassword(parsed.data.password, employee.passwordHash)) return res.status(401).json({ error: "INVALID_CREDENTIALS" });
  const token = createSessionToken(); employee.sessionHash = hashSessionToken(token); employee.lastLoginAt = new Date(); await employee.save();
  return res.json({ accessToken: token, requiresPasswordChange: Boolean(employee.mustChangePassword), employee: { id: employee.id, name: employee.name, email: employee.email, jobRole: employee.jobRole, apiRole: employee.apiRole, portfolioId: employee.portfolioId, fleetId: employee.fleetId, zoneSlugs: employee.zoneSlugs } });
});
app.get("/api/v1/auth/employee/me", requireRole("admin", "partner", "rider", "fleet", "commercial"), async (req, res) => res.json({ employee: { id: req.auth?.employeeId, role: req.auth?.role, mustChangePassword: Boolean(req.auth?.mustChangePassword) } }));
app.post("/api/v1/auth/employee/change-password", requireRole("admin", "partner", "rider", "fleet", "commercial"), async (req, res) => {
  const parsed = z.object({ currentPassword: z.string().min(8), newPassword: z.string().min(12).max(200).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/) }).safeParse(req.body);
  if (!parsed.success || !req.auth?.employeeId) return res.status(400).json({ error: "INVALID_PASSWORD_CHANGE", message: "La contraseña debe tener 12 caracteres, mayúscula, minúscula y número." });
  const employee = await EmployeeAccount.findById(req.auth.employeeId).select("+passwordHash").exec() as any;
  if (!employee || !verifyPassword(parsed.data.currentPassword, employee.passwordHash)) return res.status(401).json({ error: "INVALID_CURRENT_PASSWORD" });
  employee.passwordHash = hashPassword(parsed.data.newPassword); employee.mustChangePassword = false; employee.passwordChangedAt = new Date(); await employee.save();
  return res.json({ changed: true });
});
const employeeCreateSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), jobRole: z.enum(["admin", "partner", "rider", "fleet", "zone_manager", "commercial"]), apiRole: z.enum(["admin", "partner", "rider", "fleet", "commercial"]).optional(), restaurantId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional(), fleetId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional(), zoneSlugs: z.array(z.string().regex(/^[a-z0-9-]+$/)).max(100).default([]) });
app.post("/api/v1/admin/employees", requireOwner(), async (req, res) => {
  const parsed = employeeCreateSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_EMPLOYEE", details: parsed.error.flatten() });
  const apiRole = parsed.data.apiRole || (parsed.data.jobRole === "commercial" ? "commercial" : parsed.data.jobRole === "zone_manager" ? "fleet" : parsed.data.jobRole);
  const temporaryPassword = generateTemporaryPassword();
  try {
    const employee = await EmployeeAccount.create({ ...parsed.data, restaurantId: parsed.data.restaurantId ? objectId(parsed.data.restaurantId) : null, fleetId: parsed.data.fleetId ? objectId(parsed.data.fleetId) : null, apiRole, passwordHash: hashPassword(temporaryPassword), mustChangePassword: true, active: true });
    return res.status(201).json({ employee: { id: employee.id, name: employee.name, email: employee.email, jobRole: employee.jobRole, apiRole: employee.apiRole, portfolioId: employee.portfolioId, fleetId: employee.fleetId, zoneSlugs: employee.zoneSlugs, active: employee.active }, temporaryPassword, warning: "Mostrar esta contraseña una sola vez y entregarla por un canal seguro." });
  } catch (error) { if ((error as any)?.code === 11000) return res.status(409).json({ error: "EMPLOYEE_EMAIL_ALREADY_EXISTS" }); throw error; }
});
app.get("/api/v1/admin/employees", requireRole("admin"), async (_req, res) => res.json({ employees: await EmployeeAccount.find({ email: { $ne: ownerEmail }, hiddenFromAdmin: { $ne: true } }).select("name email jobRole apiRole portfolioId fleetId zoneSlugs active mustChangePassword lastLoginAt createdAt").sort({ createdAt: -1 }).lean().exec() }));
app.get("/api/v1/admin/customers", requireRole("admin"), async (_req, res) => res.json({ customers: await CustomerAccount.find({}).select("name email lastSignedIn createdAt updatedAt").sort({ createdAt: -1 }).limit(1000).lean().exec() }));
app.patch("/api/v1/admin/employees/:id/active", requireOwner(), async (req, res) => { const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id); if (!id) return res.status(400).json({ error: "INVALID_EMPLOYEE_ID" }); const parsed = z.object({ active: z.boolean() }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_ACTIVE_STATE" }); const target = await EmployeeAccount.findById(id).select("email ownerProtected").lean().exec() as any; if (!target) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" }); if (target.ownerProtected || target.email === ownerEmail) return res.status(403).json({ error: "OWNER_ACCOUNT_PROTECTED" }); const employee = await EmployeeAccount.findByIdAndUpdate(id, { $set: { active: parsed.data.active, ...(parsed.data.active ? {} : { sessionHash: null }) } }, { new: true }).select("name email jobRole apiRole active mustChangePassword").lean().exec(); return res.json({ employee }); });
app.post("/api/v1/admin/owner/bootstrap", requireOwner(), async (req, res) => {
  const parsed = z.object({ email: z.literal(ownerEmail), password: z.string().min(8).max(200), name: z.string().min(2).max(160).default("Propietario y CEO de PIKI") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_OWNER_BOOTSTRAP" });
  const owner = await EmployeeAccount.findOneAndUpdate({ email: parsed.data.email }, { $set: { name: parsed.data.name, jobRole: "admin", apiRole: "admin", passwordHash: hashPassword(parsed.data.password), active: true, ownerProtected: true, hiddenFromAdmin: true, mustChangePassword: false, passwordChangedAt: new Date() }, $setOnInsert: { portfolioId: "owner_piki_ceo" } }, { upsert: true, new: true, setDefaultsOnInsert: true }).select("_id email name jobRole apiRole ownerProtected hiddenFromAdmin").lean().exec() as any;
  return res.json({ owner: { id: owner?._id, email: owner?.email, name: owner?.name, role: owner?.jobRole }, protected: true, hiddenFromAdmin: true });
});
app.get("/api/v1/payments/status", (_req, res) => res.json({ provider: "stripe", secretKeyConfigured: Boolean(process.env.STRIPE_SECRET_KEY), webhookConfigured: stripeConfigured(), mode: process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_") ? "live" : "test_or_unknown" }));
app.get("/api/v1/signatures/status", (_req, res) => res.json({ provider: "signaturit", configured: signaturitConfigured(), mode: signaturitMode(), apiBaseUrl: signaturitBaseUrl(), eventsUrlConfigured: Boolean(process.env.SIGNATURIT_EVENTS_URL), webhookProtected: Boolean(process.env.SIGNATURIT_WEBHOOK_TOKEN) }));
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
app.post("/api/v1/signatures/signaturit/events", async (req, res) => {
  const webhookToken = process.env.SIGNATURIT_WEBHOOK_TOKEN;
  if (webhookToken && req.query.token !== webhookToken) return res.status(401).json({ error: "INVALID_SIGNATURE_WEBHOOK_TOKEN" });
  const raw = JSON.stringify(req.body || {});
  const payload = req.body as any;
  const externalId = String(payload?.id || payload?.signature?.id || payload?.document?.signature_id || "");
  const eventType = String(payload?.type || payload?.event || "unknown");
  const status = eventType.includes("completed") || eventType.includes("signed") ? "signed" : eventType.includes("reject") ? "rejected" : undefined;
  if (externalId) await SignatureRequest.findOneAndUpdate({ externalId }, { $set: { ...(status ? { status } : {}), eventType, payloadDigest: webhookDigest(raw) } }).exec();
  return res.status(200).json({ received: true });
});

app.get("/api/v1/catalog/restaurants", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const category = typeof req.query.category === "string" ? req.query.category.trim() : "";
  const filter: Record<string, unknown> = { isActive: true, onboardingStatus: "approved" };
  if (category && category !== "Todos") filter.category = category;
  if (query) filter.$or = [{ name: { $regex: query, $options: "i" } }, { cuisine: { $regex: query, $options: "i" } }, { category: { $regex: query, $options: "i" } }];
  const restaurants = await Restaurant.find(filter).sort({ promoted: -1, rating: -1, reviews: -1 }).lean().exec();
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

app.get("/api/v1/coverage", async (req, res) => {
  const latitude = Number(req.query.latitude); const longitude = Number(req.query.longitude);
  if (!validateCoordinates(latitude, longitude)) return res.status(400).json({ error: "INVALID_COORDINATES" });
  const point = { type: "Point", coordinates: [longitude, latitude] } as const;
  const zones = await Zone.find({ isActive: true, polygon: { $geoIntersects: { $geometry: point } } }).lean().exec();
  const restaurants = zones.length ? await Restaurant.find({ isActive: true, onboardingStatus: "approved", location: { $geoWithin: { $geometry: { type: "Polygon", coordinates: zones[0].polygon.coordinates } } } }).sort({ promoted: -1, rating: -1 }).lean().exec() : [];
  res.json({ covered: zones.length > 0, zones, restaurants });
});

const partnerDocumentSchema = z.object({ type: z.enum(["tax_id", "bank_certificate", "insurance", "activity_license", "food_sanitary_authorization", "identity", "other"]), fileName: z.string().min(1).max(180), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]), sizeBytes: z.number().int().positive().max(2_500_000), sha256: z.string().regex(/^[a-f0-9]{64}$/), contentBase64: z.string().min(20).max(3_500_000) });
const openingHoursSchema = z.record(z.string().min(2).max(15), z.object({ open: z.string().regex(/^\d{2}:\d{2}$/), close: z.string().regex(/^\d{2}:\d{2}$/), closed: z.boolean() }));
const partnerSchema = z.object({ name: z.string().min(2).max(160), email: z.string().email(), phone: z.string().min(6).max(40), address: z.string().min(5).max(280), legalName: z.string().min(2).max(180), taxId: z.string().regex(/^[A-Za-z0-9-]{5,20}$/), legalForm: z.enum(["autonomo", "sl", "sa", "cooperativa", "otra"]), representativeName: z.string().min(2).max(160), representativeRole: z.string().min(2).max(100), representativeDocument: z.string().min(5).max(30), fiscalAddress: z.string().min(5).max(280), operatingAddress: z.string().min(5).max(280), postalCode: z.string().regex(/^\d{5}$/), city: z.string().min(2).max(100), province: z.string().min(2).max(100), iban: z.string().regex(/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/), bankAccountHolder: z.string().min(2).max(180), cuisine: z.string().min(2).max(100), vatRate: z.union([z.literal(4), z.literal(10), z.literal(21)]), commissionAccepted: z.literal(true), termsAcceptedAt: z.coerce.date(), contractAccepted: z.literal(true), privacyAccepted: z.literal(true), dataProcessingAccepted: z.literal(true), pdaUnits: z.number().int().min(1).max(50), pdaUnitCostCents: z.literal(30000), pdaCostAccepted: z.literal(true), pdaCostAcceptedAt: z.coerce.date(), privacyAcceptedAt: z.coerce.date(), dataProcessingAcceptedAt: z.coerce.date(), openingHours: openingHoursSchema, documents: z.array(partnerDocumentSchema).length(5) });
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
  const slug = `${parsed.data.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}-${Date.now().toString(36)}`;
  const { legalName, taxId, legalForm, representativeName, representativeRole, representativeDocument, fiscalAddress, operatingAddress, postalCode, city, province, iban, bankAccountHolder, cuisine, vatRate, commissionAccepted, termsAcceptedAt, contractAccepted, privacyAccepted, dataProcessingAccepted, pdaUnits, pdaUnitCostCents, pdaCostAccepted, pdaCostAcceptedAt, privacyAcceptedAt, dataProcessingAcceptedAt, openingHours, documents, ...contact } = parsed.data;
  const locality = city.trim();
  const groupKey = localityKey(locality);
  const partner = await Restaurant.create({ slug, name: contact.name, cuisine, category: cuisine, locality, partnerGroupKey: groupKey, address: operatingAddress, tagline: "Solicitud recibida por PIKI", onboardingStatus: "pending_review", isActive: false, email: contact.email, phone: contact.phone, partnerProfile: { legalName, taxId: taxId.toUpperCase(), legalForm, representativeName, representativeRole, representativeDocument, fiscalAddress, operatingAddress, postalCode, city, province, iban: iban.toUpperCase(), bankAccountHolder, cuisine, vatRate, commissionAccepted, termsAcceptedAt, contractAcceptedAt: contractAccepted ? termsAcceptedAt : null, privacyAcceptedAt, dataProcessingAcceptedAt, pdaUnits, pdaUnitCostCents, pdaCostAcceptedAt: pdaCostAccepted ? pdaCostAcceptedAt : null, openingHours, documents: documents.map(({ contentBase64, ...metadata }) => ({ ...metadata, contentBase64, status: "received" })) } });
  await PartnerLocalityGroup.findOneAndUpdate({ localityKey: groupKey }, { $set: { localityName: locality, province, isActive: true }, $addToSet: { restaurantIds: partner._id } }, { upsert: true, new: true });
  res.status(201).json({ message: "Solicitud recibida para revisión.", partner: { id: partner.id, name: partner.name, email: partner.email, phone: partner.phone, locality, partnerGroupKey: groupKey, onboarding_status: partner.onboardingStatus } });
});

async function employeeRestaurant(req: express.Request) {
  if (!req.auth?.employeeId) return null;
  const employee = await EmployeeAccount.findById(req.auth.employeeId).select("restaurantId jobRole").lean().exec() as any;
  return employee?.restaurantId ? String(employee.restaurantId) : null;
}
const menuModifierSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(120), price: z.number().min(0).max(1000), required: z.boolean().default(false), options: z.array(z.string().max(120)).max(30).default([]) });
const partnerMenuItemSchema = z.object({ id: z.string().min(1).max(80), name: z.string().min(1).max(160), description: z.string().max(500).default(""), price: z.number().min(0).max(1000), category: z.string().max(100).default("General"), image: z.string().max(1200).refine((value) => value === "" || value.startsWith("https://api.pikidelivery.com/api/v1/catalog/assets/"), "La imagen debe proceder del almacenamiento de PIKI").default(""), allergens: z.array(z.string().max(80)).max(30).default([]), modifiers: z.array(menuModifierSchema).max(20).default([]), available: z.boolean().default(true), vegetarian: z.boolean().default(false), popular: z.boolean().default(false) });
app.get("/api/v1/catalog/assets/:id", async (req, res) => {
  const assetId = objectId(String(req.params.id));
  if (!assetId) return res.status(400).json({ error: "INVALID_ASSET_ID" });
  const asset = await PartnerAsset.findOne({ _id: assetId, kind: { $in: ["menu_image", "restaurant_image"] } }).select("+contentBase64 mimeType fileName sizeBytes").lean().exec() as any;
  if (!asset) return res.status(404).json({ error: "ASSET_NOT_FOUND" });
  res.setHeader("Content-Type", asset.mimeType);
  res.setHeader("Content-Length", String(asset.sizeBytes));
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  return res.send(Buffer.from(asset.contentBase64, "base64"));
});
app.post("/api/v1/partners/menu/assets", requireRole("partner"), async (req, res) => {
  const restaurantId = await employeeRestaurant(req);
  if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" });
  const parsed = z.object({ fileName: z.string().min(1).max(180), mimeType: z.enum(MENU_IMAGE_MIME_TYPES), sizeBytes: z.number().int().positive().max(MAX_MENU_IMAGE_BYTES), sha256: z.string().regex(/^[a-f0-9]{64}$/i), contentBase64: z.string().min(1).max(300000), kind: z.literal("menu_image").default("menu_image") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_MENU_IMAGE", maxBytes: MAX_MENU_IMAGE_BYTES, allowedTypes: MENU_IMAGE_MIME_TYPES, details: parsed.error.flatten() });
  const rawBase64 = parsed.data.contentBase64.replace(/^data:[^;]+;base64,/, "");
  const bytes = Buffer.from(rawBase64, "base64");
  if (bytes.length !== parsed.data.sizeBytes || bytes.length > MAX_MENU_IMAGE_BYTES) return res.status(413).json({ error: "MENU_IMAGE_TOO_LARGE", maxBytes: MAX_MENU_IMAGE_BYTES });
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== parsed.data.sha256.toLowerCase()) return res.status(400).json({ error: "MENU_IMAGE_CHECKSUM_MISMATCH" });
  const restaurant = await Restaurant.findById(restaurantId).select("locality partnerGroupKey").lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  const locality = restaurant.locality || "Sin localidad";
  const asset = await PartnerAsset.create({ restaurantId: objectId(restaurantId), organizationKey: restaurantId, folderKey: organizationFolder(locality, restaurantId), locality, kind: parsed.data.kind, fileName: parsed.data.fileName.replace(/[^a-zA-Z0-9._-]/g, "_"), mimeType: parsed.data.mimeType, sizeBytes: bytes.length, sha256: digest, contentBase64: rawBase64 });
  const groupKey = localityKey(locality);
  await PartnerLocalityGroup.findOneAndUpdate({ localityKey: groupKey }, { $set: { localityName: locality, province: "Valencia", isActive: true }, $addToSet: { restaurantIds: objectId(restaurantId) } }, { upsert: true, new: true });
  return res.status(201).json({ asset: { id: asset.id, fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256, folderKey: asset.folderKey, locality: asset.locality, url: publicAssetUrl(asset.id) } });
});
app.get("/api/v1/admin/partner-groups/locality", requireRole("admin"), async (_req, res) => res.json({ groups: await PartnerLocalityGroup.find({ isActive: true }).sort({ localityName: 1 }).lean().exec() }));
app.get("/api/v1/partners/menu", requireRole("partner"), async (req, res) => { const restaurantId = await employeeRestaurant(req); if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" }); const restaurant = await Restaurant.findById(restaurantId).select("name menu").lean().exec() as any; if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" }); return res.json({ restaurant, menu: restaurant.menu || [] }); });
app.put("/api/v1/partners/menu", requireRole("partner"), async (req, res) => { const restaurantId = await employeeRestaurant(req); if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" }); const parsed = z.object({ items: z.array(partnerMenuItemSchema).max(500) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_MENU", details: parsed.error.flatten() }); const restaurant = await Restaurant.findByIdAndUpdate(restaurantId, { $set: { menu: parsed.data.items } }, { new: true }).select("name menu").lean().exec() as any; if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" }); return res.json({ restaurant, menu: restaurant.menu || [] }); });
app.get("/api/v1/partners/kitchen/orders", requireRole("partner"), async (req, res) => { const restaurantId = await employeeRestaurant(req); if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" }); const orders = await Order.find({ restaurantId, status: { $in: ["pending", "accepted", "preparing", "ready_for_pickup"] } }).sort({ createdAt: 1 }).lean().exec(); return res.json({ orders }); });
app.patch("/api/v1/partners/kitchen/orders/:id/status", requireRole("partner"), async (req, res) => { const restaurantId = await employeeRestaurant(req); if (!restaurantId) return res.status(403).json({ error: "PARTNER_RESTAURANT_NOT_ASSIGNED" }); const parsed = z.object({ status: z.enum(["accepted", "preparing", "ready_for_pickup", "cancelled"]) }).safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "INVALID_KITCHEN_STATUS" }); const orderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id); if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" }); const order = await Order.findOne({ _id: orderId, restaurantId }); if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" }); const current = order.status as any; const target = parsed.data.status; const allowed: Record<string, string[]> = { pending: ["accepted", "cancelled"], accepted: ["preparing", "cancelled"], preparing: ["ready_for_pickup", "cancelled"] }; if (!allowed[current]?.includes(target)) return res.status(409).json({ error: "INVALID_ORDER_TRANSITION", from: current, to: target }); if (target === "accepted" && order.paymentState !== "paid") return res.status(409).json({ error: "PAYMENT_NOT_CONFIRMED" }); order.status = target as any; order.statusHistory.push({ status: target, actorRole: "partner", reason: "Actualización desde pantalla de cocina" } as any); await order.save(); return res.json({ order }); });

app.get("/api/v1/commercial/portfolio", requireRole("commercial"), async (req, res) => {
  const employeeId = req.auth?.employeeId;
  const employee = employeeId ? await EmployeeAccount.findById(employeeId).select("portfolioId").lean().exec() as any : null;
  const restaurants = employeeId ? await Restaurant.find({ commercialEmployeeId: objectId(employeeId) }).sort({ createdAt: -1 }).lean().exec() : [];
  return res.json({ portfolioId: employee?.portfolioId || null, restaurants });
});

app.patch("/api/v1/admin/restaurants/:id/assign-commercial", requireRole("admin"), async (req, res) => {
  const restaurantId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  const commercialId = objectId(String(req.body?.employeeId || ""));
  if (!restaurantId || !commercialId) return res.status(400).json({ error: "INVALID_ASSIGNMENT" });
  const commercial = await EmployeeAccount.findOne({ _id: commercialId, jobRole: "commercial", active: true }).lean().exec() as any;
  if (!commercial) return res.status(404).json({ error: "COMMERCIAL_ACCOUNT_NOT_FOUND" });
  const restaurant = await Restaurant.findByIdAndUpdate(restaurantId, { $set: { commercialEmployeeId: commercialId } }, { new: true }).lean().exec();
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant, portfolioId: commercial.portfolioId });
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
  const restaurant = await Restaurant.findByIdAndUpdate(id, { $set: { onboardingStatus: parsed.data.status, isActive: parsed.data.status === "approved" } }, { new: true }).lean().exec();
  if (!restaurant) return res.status(404).json({ error: "RESTAURANT_NOT_FOUND" });
  return res.json({ restaurant });
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
  const restaurant = await Restaurant.findOneAndUpdate({ _id: restaurantId, "partnerProfile.documents._id": req.params.documentId }, { $set: { "partnerProfile.documents.$.status": parsed.data.status, "partnerProfile.documents.$.reviewNotes": parsed.data.reviewNotes, "partnerProfile.documents.$.reviewedAt": new Date() } }, { new: true }).lean().exec() as any;
  if (!restaurant) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
  const document = (restaurant.partnerProfile?.documents || []).find((item: any) => String(item._id) === req.params.documentId);
  return res.json({ restaurantId, document: document ? { _id: document._id, type: document.type, fileName: document.fileName, status: document.status } : null });
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
  return res.status(201).json({ message: "Solicitud recibida. El equipo Fleet se pondrá en contacto contigo.", application: { id: application.id, status: application.status } });
});

app.get("/api/v1/rider-applications", requireRole("admin", "fleet"), async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : undefined;
  const filter = status ? { status } : {};
  const applications = await RiderApplication.find(filter).sort({ createdAt: -1 }).limit(200).lean().exec();
  return res.json({ applications });
});

app.get("/api/v1/rider-applications/:id/documents", requireRole("admin", "fleet"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const application = await RiderApplication.findById(id).select("name email documents").lean().exec() as any;
  if (!application) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  return res.json({ applicationId: application._id, name: application.name, email: application.email, documents: (application.documents || []).map(({ contentBase64, ...metadata }: any) => metadata) });
});
app.get("/api/v1/rider-applications/:id/documents/:documentId/content", requireRole("admin", "fleet"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const application = await RiderApplication.findOne({ _id: id, "documents._id": req.params.documentId }).select("+documents.contentBase64").lean().exec() as any;
  const document = application?.documents?.find((item: any) => String(item._id) === req.params.documentId);
  if (!document) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
  return res.json({ fileName: document.fileName, mimeType: document.mimeType, sizeBytes: document.sizeBytes, sha256: document.sha256, contentBase64: document.contentBase64 });
});
app.patch("/api/v1/rider-applications/:id/documents/:documentId/status", requireRole("admin", "fleet"), async (req, res) => {
  const id = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const parsed = z.object({ status: z.enum(["approved", "rejected"]), reviewNotes: z.string().max(1000).default("") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DOCUMENT_STATUS", details: parsed.error.flatten() });
  const application = await RiderApplication.findOneAndUpdate({ _id: id, "documents._id": req.params.documentId }, { $set: { "documents.$.status": parsed.data.status, "documents.$.reviewNotes": parsed.data.reviewNotes, "documents.$.reviewedAt": new Date() } }, { new: true }).select("name email documents").lean().exec() as any;
  if (!application) return res.status(404).json({ error: "DOCUMENT_NOT_FOUND" });
  return res.json({ applicationId: application._id, documents: (application.documents || []).map(({ contentBase64, ...metadata }: any) => metadata) });
});
app.patch("/api/v1/rider-applications/:id/status", requireRole("admin", "fleet"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam); if (!id) return res.status(400).json({ error: "INVALID_APPLICATION_ID" });
  const parsed = z.object({ status: z.enum(["pending", "contacted", "approved", "rejected"]), notes: z.string().max(1000).optional(), assignedFleetId: z.string().regex(/^[a-f\d]{24}$/).nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_APPLICATION_STATUS", details: parsed.error.flatten() });
  const existing = await RiderApplication.findById(id).select("documents status").lean().exec() as any;
  if (!existing) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  if (["approved", "rejected"].includes(parsed.data.status)) {
    const documents = existing.documents || [];
    void documents;
  }
  const update: Record<string, unknown> = { status: parsed.data.status, notes: parsed.data.notes };
  if (parsed.data.assignedFleetId !== undefined) update.assignedFleetId = parsed.data.assignedFleetId ? objectId(parsed.data.assignedFleetId) : null;
  const application = await RiderApplication.findByIdAndUpdate(id, { $set: update }, { new: true }).lean().exec() as any;
  if (!application) return res.status(404).json({ error: "APPLICATION_NOT_FOUND" });
  if (parsed.data.status === "approved") {
    await Rider.findOneAndUpdate({ email: application.email }, { $set: { name: application.name, email: application.email, vehicle: application.vehicle, fleetId: application.assignedFleetId || null, status: "offline" } }, { upsert: true, new: true }).exec();
  }
  const documentReviewPending = (application.documents || []).some((document: any) => document.status !== "approved");
  return res.json({ application, documentReviewPending, warning: documentReviewPending ? "La solicitud se ha gestionado; el expediente documental continúa pendiente de revisión." : undefined });
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
  const dailyCode = await createDailyDisplayCode();
  const order = await Order.create({ publicCode, ...dailyCode, restaurantId: restaurant._id, customerId: parsed.data.customerId || null, items: normalizedItems, deliveryAddress: parsed.data.deliveryAddress, deliveryLocation: { type: "Point", coordinates: [parsed.data.deliveryLocation.longitude, parsed.data.deliveryLocation.latitude] }, subtotalCents, deliveryFeeCents, totalCents, paymentState: "pending", statusHistory: [{ status: "pending", actorRole: "customer", reason: "Pedido creado" }] });
  res.status(201).json({ order: { id: order.id, publicCode, displayCode: order.displayCode, displayCodeDate: order.displayCodeDate, status: order.status, paymentState: order.paymentState, subtotalCents, deliveryFeeCents, serviceFeeCents, totalCents, etaMinutes: calculateEtaRange([restaurant.etaMinutes[0] || 20, restaurant.etaMinutes[1] || 35], [5, 20]) } });
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
  if (["delivered", "cancelled"].includes(parsed.data.status) && order.riderId) {
    const remainingOrder = await Order.findOne({ riderId: order.riderId, _id: { $ne: order._id }, status: { $nin: ["delivered", "cancelled"] }, assignmentState: { $in: ["offered", "assigned"] } }).select("_id").lean().exec() as any;
    await Rider.findByIdAndUpdate(order.riderId, { $set: { status: remainingOrder ? "busy" : "available", activeOrderId: remainingOrder?._id || null } }).exec();
  }
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
app.patch("/api/v1/riders/:id/status", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const id = objectId(idParam); if (!id) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const parsed = z.object({ status: z.enum(["offline", "available", "busy", "paused"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_RIDER_STATUS" });
  if (parsed.data.status === "available") {
    const { now, slot } = await findCurrentRiderSlot(id);
    if (!slot) return res.status(409).json({ error: "SHIFT_RESERVATION_REQUIRED", message: "El rider necesita un slot reservado activo para ponerse disponible.", now });
  }
  const rider = await Rider.findByIdAndUpdate(id, { $set: { status: parsed.data.status } }, { new: true }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  return res.json({ rider: { id: rider._id, name: rider.name, status: rider.status, fleetId: rider.fleetId, lastLocationAt: rider.lastLocationAt } });
});

app.get("/api/v1/riders/:id/slots", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const riderId = objectId(riderIdParam); if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const slots = await RiderSlot.find({ riderId }).sort({ date: 1, startTime: 1 }).limit(100).lean().exec();
  return res.json({ riderId, slots });
});

function madridNow() {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

async function findCurrentRiderSlot(riderId: mongoose.Types.ObjectId) {
  const now = madridNow();
  const slot = await RiderSlot.findOne({ riderId, date: now.date, status: { $in: ["planned", "active"] }, startTime: { $lte: now.time }, endTime: { $gt: now.time } }).sort({ startTime: 1 }).lean().exec();
  return { now, slot };
}

app.get("/api/v1/riders/session", requireRole("rider"), async (req, res) => {
  const employeeId = req.auth?.employeeId;
  if (!employeeId) return res.status(403).json({ error: "RIDER_EMPLOYEE_SESSION_REQUIRED" });
  const employee = await EmployeeAccount.findById(employeeId).lean().exec() as any;
  const rider = employee ? await Rider.findOne({ email: employee.email }).lean().exec() as any : null;
  if (!rider) return res.status(404).json({ error: "RIDER_ACCOUNT_NOT_LINKED" });
  return res.json({ rider: { id: rider._id, name: rider.name, email: rider.email, status: rider.status, fleetId: rider.fleetId } });
});

app.get("/api/v1/riders/:id/shift", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findById(riderId).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const { now, slot } = await findCurrentRiderSlot(riderId);
  return res.json({ rider: { id: rider._id, status: rider.status }, now, eligible: Boolean(slot), shift: slot });
});

app.post("/api/v1/riders/:id/shift/start", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const rider = await Rider.findById(riderId).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  const { now, slot } = await findCurrentRiderSlot(riderId);
  if (!slot) return res.status(409).json({ error: "SHIFT_RESERVATION_REQUIRED", message: "No puedes iniciar la jornada fuera de tu horario reservado.", now });
  const currentSlot = slot as any;
  const updatedSlot = await RiderSlot.findOneAndUpdate({ _id: currentSlot._id, status: "planned" }, { $set: { status: "active" } }, { new: true }).lean().exec();
  await Rider.findByIdAndUpdate(riderId, { $set: { status: "available" } }).exec();
  return res.json({ message: "Jornada iniciada", warningSound: "start_shift", rider: { id: riderId, status: "available" }, shift: updatedSlot });
});

app.post("/api/v1/riders/:id/shift/stop", requireRole("admin", "rider", "fleet"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
  const { slot } = await findCurrentRiderSlot(riderId);
  if (slot) await RiderSlot.updateOne({ _id: (slot as any)._id }, { $set: { status: "completed" } }).exec();
  const rider = await Rider.findByIdAndUpdate(riderId, { $set: { status: "offline", activeOrderId: null } }, { new: true }).lean().exec() as any;
  if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
  return res.json({ message: "Jornada finalizada", rider: { id: rider._id, status: rider.status } });
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

app.get("/api/v1/dispatch/orders/:id/preview", requireRole("admin", "fleet"), async (req, res) => {
  const parsed = dispatchSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: "INVALID_DISPATCH_REQUEST", details: parsed.error.flatten() });
  const orderIdParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const orderId = objectId(orderIdParam);
  if (!orderId) return res.status(400).json({ error: "INVALID_ORDER_ID" });
  const order = await Order.findById(orderId).lean().exec() as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  const restaurant = await Restaurant.findById(order.restaurantId).lean().exec() as any;
  if (!restaurant?.location?.coordinates || !order.deliveryLocation?.coordinates) return res.status(409).json({ error: "MISSING_GEOLOCATION" });
  const freshness = new Date(Date.now() - 90_000);
  const policy = await dispatchLoadPolicy();
  const riders = await Rider.find({ status: { $in: ["available", "busy"] }, lastLocationAt: { $gte: freshness }, location: { $exists: true } }).limit(100).lean().exec() as any[];
  const counts = await activeOrderCounts(riders.map((rider) => rider._id));
  const ranked = rankDispatchCandidates(riders.map((rider) => ({ id: String(rider._id), status: rider.status, vehicle: rider.vehicle, location: rider.location, lastLocationAt: rider.lastLocationAt, reliabilityScore: rider.reliabilityScore, activeOrderCount: counts.get(String(rider._id)) || 0, zoneFit: 1, servicePriority: 0.5 })), { restaurantLocation: [restaurant.location.coordinates[0], restaurant.location.coordinates[1]], customerLocation: [order.deliveryLocation.coordinates[0], order.deliveryLocation.coordinates[1]], preparationMinutes: parsed.data.preparationMinutes, maxCustomerEtaMinutes: parsed.data.maxCustomerEtaMinutes, maxConcurrentOrders: policy.maxConcurrentOrders });
  await DispatchDecision.insertMany(ranked.map((decision) => ({ orderId: order._id, ...decision, riderId: objectId(decision.riderId), outcome: "preview", actorRole: req.auth?.role || "system" })));
  return res.json({ algorithmVersion: ranked[0]?.algorithmVersion || "piki-jarvis-v1", orderId: order._id, policy, candidatesConsidered: riders.length, eligibleCandidates: ranked.length, candidates: ranked });
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
  const order = await Order.findById(orderId).lean().exec() as any;
  if (!order) return res.status(404).json({ error: "ORDER_NOT_FOUND" });
  if (order.paymentState !== "paid") return res.status(409).json({ error: "ORDER_NOT_PAID" });
  if (!["accepted", "preparing", "ready_for_pickup"].includes(order.status)) return res.status(409).json({ error: "ORDER_NOT_DISPATCHABLE", status: order.status });
  if (order.riderId || order.assignmentState === "assigned") return res.status(409).json({ error: "ORDER_ALREADY_ASSIGNED" });
  const restaurant = await Restaurant.findById(order.restaurantId).lean().exec() as any;
  if (!restaurant?.location?.coordinates || !order.deliveryLocation?.coordinates) return res.status(409).json({ error: "MISSING_GEOLOCATION" });
  const freshness = new Date(Date.now() - 90_000);
  const policy = await dispatchLoadPolicy();
  const riders = await Rider.find({ status: { $in: ["available", "busy"] }, lastLocationAt: { $gte: freshness }, location: { $exists: true } }).limit(100).lean().exec() as any[];
  const counts = await activeOrderCounts(riders.map((rider) => rider._id));
  const ranked = rankDispatchCandidates(riders.map((rider) => ({ id: String(rider._id), status: rider.status, vehicle: rider.vehicle, location: rider.location, lastLocationAt: rider.lastLocationAt, reliabilityScore: rider.reliabilityScore, activeOrderCount: counts.get(String(rider._id)) || 0, zoneFit: 1, servicePriority: 0.5 })), { restaurantLocation: [restaurant.location.coordinates[0], restaurant.location.coordinates[1]], customerLocation: [order.deliveryLocation.coordinates[0], order.deliveryLocation.coordinates[1]], preparationMinutes: parsed.data.preparationMinutes, maxConcurrentOrders: policy.maxConcurrentOrders });
  if (!ranked.length) return res.status(409).json({ error: "NO_ELIGIBLE_RIDER", candidatesConsidered: riders.length });
  for (const decision of ranked) {
    const currentLoad = counts.get(decision.riderId) || 0;
    const riderUpdate = currentLoad === 0 ? { $set: { status: "busy", activeOrderId: order._id } } : { $set: { status: "busy" } };
    const riderFilter = currentLoad === 0 ? { _id: objectId(decision.riderId), status: { $in: ["available", "busy"] }, activeOrderId: null } : { _id: objectId(decision.riderId), status: { $in: ["available", "busy"] }, activeOrderId: { $ne: null } };
    const rider = await Rider.findOneAndUpdate(riderFilter, riderUpdate, { new: true }).lean().exec() as any;
    if (!rider) continue;
    const expiresAt = new Date(Date.now() + parsed.data.offerSeconds * 1000);
    const assigned = await Order.findOneAndUpdate({ _id: order._id, riderId: null, assignmentState: { $in: ["unassigned", "expired", "rejected"] } }, { $set: { riderId: rider._id, assignmentState: "offered", assignmentExpiresAt: expiresAt, dispatchScore: decision.score }, $inc: { dispatchAttempts: 1, version: 1 } }, { new: true }).lean().exec() as any;
    if (!assigned) { await Rider.updateOne({ _id: rider._id, activeOrderId: order._id }, { $set: { status: "available", activeOrderId: null } }).exec(); continue; }
    await DispatchDecision.create({ orderId: assigned._id, ...decision, riderId: rider._id, outcome: "offered", actorRole: req.auth?.role || "system" });
    return res.status(201).json({ assignment: { orderId: assigned._id, riderId: rider._id, state: assigned.assignmentState, expiresAt, score: decision.score, pickupDistanceKm: decision.pickupDistanceKm, pickupEtaMinutes: decision.pickupEtaMinutes, customerEtaMinutes: decision.customerEtaMinutes, totalEtaMinutes: decision.totalEtaMinutes, algorithmVersion: decision.algorithmVersion, maxConcurrentOrders: policy.maxConcurrentOrders, saturated: policy.saturated, reasons: decision.reasons } });
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

app.get("/api/v1/riders/:id/offers", requireRole("rider"), async (req, res) => {
  const riderId = objectId(Array.isArray(req.params.id) ? req.params.id[0] : req.params.id);
  if (!riderId || !req.auth?.employeeId) return res.status(400).json({ error: "INVALID_RIDER_SESSION" });
  const employee = await EmployeeAccount.findById(req.auth.employeeId).select("email").lean().exec() as any;
  const rider = employee ? await Rider.findOne({ _id: riderId, email: employee.email }).select("_id").lean().exec() : null;
  if (!rider) return res.status(403).json({ error: "RIDER_ACCESS_DENIED" });
  const offers = await Order.find({ riderId, assignmentState: { $in: ["offered", "assigned"] }, status: { $nin: ["delivered", "cancelled"] } })
    .select("_id publicCode displayCode displayCodeDate restaurantId status paymentState assignmentState assignmentExpiresAt deliveryAddress items createdAt")
    .sort({ createdAt: -1 }).limit(10).lean().exec();
  return res.json({ offers, refreshedAt: new Date().toISOString() });
});

app.get("/api/v1/riders/operational-map", requireRole("rider"), async (req, res) => {
  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("zoneSlugs fleetId").lean().exec() as any : null;
  const zoneSlugs = Array.isArray(employee?.zoneSlugs) ? employee.zoneSlugs.filter((value: unknown): value is string => typeof value === "string") : [];
  const filter: Record<string, unknown> = { isActive: true };
  if (zoneSlugs.length) filter.slug = { $in: zoneSlugs };
  const zones = await Zone.find(filter).select("slug name isActive polygon").sort({ name: 1 }).lean().exec();
  return res.json({ zones, source: "piki-api", refreshedAt: new Date().toISOString() });
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

app.get("/api/v1/fleets", requireRole("admin", "fleet"), async (req, res) => {
  const employee = req.auth?.employeeId ? await EmployeeAccount.findById(req.auth.employeeId).select("fleetId").lean().exec() as any : null;
  const filter = req.auth?.role === "fleet" ? { _id: employee?.fleetId || null } : {};
  const fleets = await Fleet.find(filter).sort({ name: 1 }).lean().exec();
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

async function start() {
  const uri = process.env.MONGODB_URI;
  if (uri) { await mongoose.connect(uri, { dbName: databaseName, serverSelectionTimeoutMS: 10_000 }); await ensureIndexes(); if (process.env.SEED_DEMO_DATA === "true") await seedCatalog(); databaseReady = true; } else console.warn("MONGODB_URI is not configured; /ready will remain unavailable.");
  app.listen(port, "0.0.0.0", () => console.log(`PIKI API listening on port ${port}`));
}

start().catch((error) => { console.error("Unable to start PIKI API", error); process.exit(1); });
process.on("SIGTERM", () => { mongoose.disconnect().catch(() => undefined); });
