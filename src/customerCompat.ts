import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { Order, Restaurant, CustomerAccount, RiderOrderMessage } from "./models.js";
import { publishOrderIntakeEvents } from "./realtime.js";
import { evaluateXativaCoverage } from "./coverage/xativaPolicy.js";
import { quoteDeliveryRoute } from "./coverage/routing.js";
import { CUSTOMER_CATALOG_RESTAURANT_FILTER, customerCatalogRestaurantName } from "./customerCatalogPolicy.js";
import { modifierGroupsForItem, quoteMenuItem, usesReferenceAddOns } from "./menuModifiers.js";

const COOKIE = "piki_customer_session";
let dispatchCustomerOrder: ((orderId: string) => Promise<unknown>) | null = null;
export function setCustomerOrderDispatcher(dispatcher: (orderId: string) => Promise<unknown>) {
  dispatchCustomerOrder = dispatcher;
}
const hashToken = (value: string) => createHash("sha256").update(value).digest("hex");
const hashPassword = (value: string, salt = randomBytes(16).toString("hex")) => `${salt}:${scryptSync(value, salt, 64).toString("hex")}`;
const checkPassword = (value: string, encoded: string) => {
  const [salt, digest] = encoded.split(":");
  if (!salt || !digest) return false;
  const actual = scryptSync(value, salt, 64);
  const expected = Buffer.from(digest, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const publicUser = (user: any) => user ? ({ id: String(user._id), name: user.name, email: user.email, role: "user", createdAt: user.createdAt, lastSignedIn: user.lastSignedIn }) : null;

function inputOf(req: Request): any {
  const body = req.body ?? {};
  if (body.json) return body.json;
  const first = body["0"];
  if (first?.json) return first.json;
  if (typeof req.query.input === "string") {
    try { const parsed = JSON.parse(req.query.input); return parsed.json ?? parsed; } catch { return {}; }
  }
  return body;
}
function reply(res: Response, value: unknown) { return res.json({ result: { data: { json: value } } }); }
function fail(res: Response, message: string, code = "BAD_REQUEST") { const status = code === "UNAUTHORIZED" || code === "AUTH_REQUIRED" ? 401 : code === "FORBIDDEN" ? 403 : code === "CONFLICT" ? 409 : code === "NOT_FOUND" ? 404 : code === "STRIPE_UNAVAILABLE" ? 503 : 400; return res.status(status).json({ error: { json: { message, code: -32000, data: { code, httpStatus: status } } } }); }
function getSession(req: Request) {
  const header = req.header("x-piki-session");
  if (header) return header;
  const cookie = req.header("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE}=`));
  return cookie ? cookie.slice(COOKIE.length + 1) : null;
}
export async function currentCustomer(req: Request) { const raw = getSession(req); return raw ? CustomerAccount.findOne({ sessionHash: hashToken(raw) }).lean().exec() : null; }
async function setSession(res: Response, userId: string) { const raw = randomBytes(32).toString("base64url"); await CustomerAccount.updateOne({ _id: userId }, { $set: { sessionHash: hashToken(raw), lastSignedIn: new Date() } }).exec(); res.setHeader("Set-Cookie", `${COOKIE}=${raw}; Max-Age=31536000; Path=/; HttpOnly; Secure; SameSite=None`); }
const customerPaymentMethod = (value: unknown) => {
  const method = String(value || "cash");
  return method === "cash" ? "cash" : null;
};

const deliveryQrUrl = (orderCode: string) => {
  const secret = String(process.env.DELIVERY_QR_SECRET || "").trim();
  if (process.env.NODE_ENV === "production" && !secret) throw new Error("DELIVERY_QR_SECRET is required in production");
  const signature = createHmac("sha256", secret || "development-only-delivery-qr-secret").update(`delivery:${orderCode}`).digest("hex").slice(0, 24);
  return `${(process.env.CUSTOMER_APP_URL || "https://pikidelivery.com").replace(/\/$/, "")}/?order_id=${encodeURIComponent(orderCode)}&delivery_token=${signature}`;
};
const deliveryPin = (orderCode: string) => {
  const secret = String(process.env.DELIVERY_QR_SECRET || "").trim();
  const signature = createHmac("sha256", secret || "development-only-delivery-qr-secret").update(`delivery:${orderCode}`).digest("hex").slice(0, 24);
  return signature.slice(-6).toUpperCase();
};

function restaurantView(row: any) {
  const useReferenceFallback = usesReferenceAddOns(row);
  return { id: String(row._id), name: customerCatalogRestaurantName(row), cuisine: row.cuisine, category: row.category, tagline: row.tagline || "Descubre este establecimiento en PIKI.", eta: `${row.etaMinutes?.[0] || 20}–${row.etaMinutes?.[1] || 35} min`, fee: (row.deliveryFeeCents || 0) / 100, rating: row.rating || 0, reviews: row.reviews || 0, promoted: row.promoted, image: row.image || "", accent: row.accent || "#FFD72E", menu: (row.menu || []).map((item: any) => ({ id: item.id, name: item.name, description: item.description || "", price: item.price, allergens: Array.isArray(item.allergens) ? item.allergens : [], vegetarian: Boolean(item.vegetarian), popular: Boolean(item.popular), modifierGroups: modifierGroupsForItem(item, useReferenceFallback) })) };
}

export async function handleCustomerTrpc(req: Request, res: Response) {
  const procedure = String(req.params.procedure || "");
  const input = inputOf(req);
  try {
    if (procedure === "catalog.list") {
      const filter: Record<string, unknown> = { ...CUSTOMER_CATALOG_RESTAURANT_FILTER };
      if (input?.category) filter.category = input.category;
      const rows = await Restaurant.find(filter).sort({ promoted: -1, rating: -1, reviews: -1 }).lean().exec();
      const query = String(input?.query || "").trim().toLowerCase();
      return reply(res, rows.map(restaurantView).filter((row) => !query || `${row.name} ${row.cuisine} ${row.category}`.toLowerCase().includes(query)));
    }
    if (procedure === "catalog.byId") {
      const row = await Restaurant.findOne({ _id: input?.id, ...CUSTOMER_CATALOG_RESTAURANT_FILTER }).lean().exec();
      return reply(res, row ? restaurantView(row) : null);
    }
    if (procedure === "auth.me") return reply(res, await currentCustomer(req).then((user) => publicUser(user)));
    if (procedure === "customer.deliveryAddress.get") {
      const user = await currentCustomer(req) as any;
      if (!user) return fail(res, "Inicia sesión para consultar tu dirección guardada.", "AUTH_REQUIRED");
      const coordinates = user.deliveryLocation?.coordinates;
      const hasSavedAddress = typeof user.deliveryAddress === "string" && user.deliveryAddress.length >= 5 && Array.isArray(coordinates) && coordinates.length >= 2;
      return reply(res, hasSavedAddress ? { saved: true, address: user.deliveryAddress, deliveryLocation: { latitude: Number(coordinates[1]), longitude: Number(coordinates[0]) }, updatedAt: user.deliveryAddressUpdatedAt || null } : { saved: false, address: null, deliveryLocation: null, updatedAt: null });
    }
    if (procedure === "customer.deliveryAddress.save") {
      const user = await currentCustomer(req) as any;
      if (!user) return fail(res, "Inicia sesión para guardar tu dirección.", "AUTH_REQUIRED");
      const address = String(input?.address || "").trim();
      const latitude = Number(input?.deliveryLocation?.latitude); const longitude = Number(input?.deliveryLocation?.longitude);
      if (address.length < 5 || address.length > 280 || !Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return fail(res, "Selecciona una dirección válida de la lista antes de guardarla.", "DELIVERY_LOCATION_REQUIRED");
      const coverage = evaluateXativaCoverage([longitude, latitude]);
      if (!coverage.covered) return fail(res, "Todavía no repartimos en esa dirección.", "DELIVERY_OUTSIDE_COVERAGE");
      const updatedAt = new Date();
      await CustomerAccount.updateOne({ _id: user._id }, { $set: { deliveryAddress: address, deliveryLocation: { type: "Point", coordinates: [longitude, latitude] }, deliveryAddressUpdatedAt: updatedAt } }).exec();
      return reply(res, { saved: true, address, deliveryLocation: { latitude, longitude }, updatedAt, coverage });
    }
    if (procedure === "auth.register") {
      const name = String(input?.name || "").trim(); const email = String(input?.email || "").trim().toLowerCase(); const password = String(input?.password || "");
      if (name.length < 2 || !email.includes("@") || password.length < 8) return fail(res, "Datos de cuenta no válidos");
      if (await CustomerAccount.exists({ email })) return fail(res, "Ya existe una cuenta con este email", "CONFLICT");
      const user = await CustomerAccount.create({ name, email, passwordHash: hashPassword(password) }); await setSession(res, String(user._id)); return reply(res, { user: publicUser(user) });
    }
    if (procedure === "auth.login") {
      const email = String(input?.email || "").trim().toLowerCase(); const user = await CustomerAccount.findOne({ email }).exec();
      if (!user || !checkPassword(String(input?.password || ""), user.passwordHash)) return fail(res, "Email o contraseña incorrectos", "UNAUTHORIZED");
      await setSession(res, String(user._id)); return reply(res, { user: publicUser(user) });
    }
    if (procedure === "auth.logout") { res.clearCookie(COOKIE); return reply(res, { success: true }); }
    if (procedure === "order.get" || procedure === "order.customerTracking") {
      const user = await currentCustomer(req) as any;
      if (!user) return fail(res, "Inicia sesión con la cuenta que realizó el pedido.", "AUTH_REQUIRED");
      const publicCode = String(input?.id || "").trim();
      const order = await Order.findOne({ publicCode, customerId: String(user._id) }).select("_id publicCode status restaurantId riderId assignmentState routeDurationMinutes deliveryAddress paymentState").lean().exec() as any;
      if (!order) return fail(res, "Pedido no encontrado", "NOT_FOUND");
      const restaurant = await Restaurant.findById(order.restaurantId).select("name").lean().exec() as any;
      if (procedure === "order.get") {
        return reply(res, { id: order.publicCode, restaurant: restaurant?.name || "Pedido PIKI", status: order.status, eta: order.routeDurationMinutes ? `${order.routeDurationMinutes} min` : "actualizando…" });
      }
      // The rider location is private until Partner has prepared the order and Rider has confirmed pickup.
      if (!order.riderId || order.assignmentState !== "assigned" || !["picked_up", "on_the_way"].includes(order.status)) {
        return reply(res, { available: false, status: order.status, reason: "not_in_delivery" });
      }
      const rider = await (await import("./models.js")).Rider.findById(order.riderId).select("name vehicle photoUrl location lastLocationAt").lean().exec() as any;
      const coordinates = rider?.location?.coordinates;
      const updatedAt = rider?.lastLocationAt ? new Date(rider.lastLocationAt).getTime() : 0;
      const fresh = Array.isArray(coordinates) && coordinates.length >= 2 && updatedAt >= Date.now() - 90_000;
      if (!fresh) return reply(res, { available: false, status: order.status, riderName: rider.name || "Tu rider", riderPhotoUrl: rider.photoUrl || null, vehicle: rider.vehicle || "bike", reason: "location_unavailable" });
      return reply(res, { available: true, status: order.status, riderName: rider.name || "Tu rider", riderPhotoUrl: rider.photoUrl || null, vehicle: rider.vehicle || "bike", phase: "going_to_customer", etaMinutes: order.routeDurationMinutes || null, latitude: Number(coordinates[1]), longitude: Number(coordinates[0]), accuracyMeters: null, updatedAt });
    }
    if (procedure === "order.deliveryCredentials") {
      const user = await currentCustomer(req) as any;
      if (!user) return fail(res, "Debes iniciar sesión para ver el QR de entrega", "AUTH_REQUIRED");
      const publicCode = String(input?.id || "").trim();
      const order = await Order.findOne({ publicCode, customerId: String(user._id) }).select("publicCode status").lean().exec() as any;
      if (!order) return fail(res, "Pedido no encontrado", "NOT_FOUND");
      const available = order.status === "on_the_way";
      return reply(res, { available, pin: available ? deliveryPin(order.publicCode) : null, qrToken: available ? deliveryQrUrl(order.publicCode) : null, state: available ? "pending" : "unavailable" });
    }
    if (procedure === "order.messages" || procedure === "order.sendMessage") {
      const user = await currentCustomer(req) as any;
      if (!user) return fail(res, "Debes iniciar sesión para consultar el chat", "AUTH_REQUIRED");
      const publicCode = String(input?.id || "").trim();
      if (!publicCode) return fail(res, "Pedido no válido", "BAD_REQUEST");
      const order = await Order.findOne({ publicCode, customerId: String(user._id) }).select("_id riderId assignmentState status").lean().exec() as any;
      const activeStatuses = ["picked_up", "on_the_way"];
      if (!order || !order.riderId || order.assignmentState !== "assigned" || !activeStatuses.includes(order.status)) {
        return fail(res, "El chat solo está disponible durante una entrega activa", "FORBIDDEN");
      }
      if (procedure === "order.messages") {
        const messages = await RiderOrderMessage.find({ orderId: order._id }).sort({ createdAt: 1 }).limit(100).lean().exec();
        return reply(res, messages.map((message: any) => ({ id: String(message._id), senderRole: message.senderRole, body: message.body, createdAt: message.createdAt })));
      }
      const body = String(input?.body || "").trim();
      if (!body || body.length > 500) return fail(res, "El mensaje debe tener entre 1 y 500 caracteres", "BAD_REQUEST");
      const message = await RiderOrderMessage.create({ orderId: order._id, riderId: order.riderId, senderRole: "customer", body });
      return reply(res, { id: String(message._id), senderRole: message.senderRole, body: message.body, createdAt: message.createdAt });
    }
    if (procedure === "order.create" || procedure === "order.checkout") {
      const user = await currentCustomer(req) as any;
      if (!user) return fail(res, "Debes iniciar sesión para realizar pedidos", "AUTH_REQUIRED");
      const restaurant = await Restaurant.findOne({ _id: input?.restaurantId, ...CUSTOMER_CATALOG_RESTAURANT_FILTER }).lean().exec() as any;
      if (!restaurant) return fail(res, "Restaurante no encontrado", "NOT_FOUND");
      const requested = Array.isArray(input?.items) ? input.items : [];
      const useReferenceFallback = usesReferenceAddOns(restaurant);
      const items = requested.map((line: any) => {
        const item = restaurant.menu.find((candidate: any) => candidate.id === line.id);
        if (!item) return null;
        try {
          const quote = quoteMenuItem(item, line.selections, useReferenceFallback);
          return { itemId: item.id, name: quote.name, quantity: Number(line.quantity), unitPriceCents: quote.unitPriceCents, selectedOptions: quote.selectedOptions };
        } catch {
          return null;
        }
      });
      if (!items.length || items.some((item: any) => !item || !Number.isInteger(item.quantity) || item.quantity < 1)) return fail(res, "La cesta no es válida");
      const normalized = items as Array<{itemId: string; name: string; quantity: number; unitPriceCents: number; selectedOptions: Array<{ groupId: string; groupName: string; optionId: string; optionName: string; unitPriceCents: number }>}>;
      const paymentMethod = customerPaymentMethod(input?.paymentMethod);
      if (!paymentMethod) return fail(res, "Tarjeta y Bizum todavía no están disponibles. Selecciona efectivo al recibir.", "PAYMENT_METHOD_UNAVAILABLE");
      const latitude = Number(input?.deliveryLocation?.latitude); const longitude = Number(input?.deliveryLocation?.longitude);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) return fail(res, "Selecciona una dirección válida de la lista antes de confirmar el pedido.", "DELIVERY_LOCATION_REQUIRED");
      const deliveryPoint: [number, number] = [longitude, latitude];
      const coverage = evaluateXativaCoverage(deliveryPoint);
      if (!coverage.covered || coverage.deliveryFeeCents === null || coverage.serviceFeeCents === null) return fail(res, "Todavía no repartimos en esa dirección.", "DELIVERY_OUTSIDE_COVERAGE");
      const restaurantPoint = restaurant.location?.coordinates;
      if (!Array.isArray(restaurantPoint) || restaurantPoint.length < 2) return fail(res, "El restaurante no tiene ubicación operativa configurada.", "RESTAURANT_LOCATION_UNAVAILABLE");
      const route = await quoteDeliveryRoute([Number(restaurantPoint[0]), Number(restaurantPoint[1])], deliveryPoint);
      const subtotalCents = normalized.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);
      const deliveryCents = coverage.deliveryFeeCents; const serviceCents = coverage.serviceFeeCents; const totalCents = subtotalCents + deliveryCents + serviceCents;
      const code = `PIKI-${Date.now().toString(36).toUpperCase()}`;
      const order = await Order.create({ publicCode: code, tenantId: restaurant.tenantId || null, restaurantId: restaurant._id, customerId: String(user._id), items: normalized, deliveryAddress: String(input.address || "").trim(), deliveryLocation: { type: "Point", coordinates: deliveryPoint }, coveragePolicySlug: coverage.policySlug, coveragePolicyVersion: coverage.policyVersion, coverageDecision: coverage.reason, straightLineDistanceKm: coverage.straightLineDistanceKm, withinMunicipality: coverage.withinMunicipality, deliveryBaseFeeCents: coverage.deliveryBaseFeeCents, outsideMunicipalitySurchargeCents: coverage.outsideMunicipalitySurchargeCents, routeDistanceKm: route.routeDistanceKm, routeDurationMinutes: route.routeDurationMinutes, routeProvider: route.routeProvider, routingDegraded: route.routingDegraded, requiredVehicleClasses: route.requiredVehicleClasses, subtotalCents, deliveryFeeCents: deliveryCents, serviceFeeCents: serviceCents, totalCents, paymentMethod, paymentState: "pending", statusHistory: [{ status: "pending", actorRole: "customer", reason: "Pedido a contrarreembolso; cobro pendiente hasta la entrega" }] });
      const dispatch = dispatchCustomerOrder
        ? dispatchCustomerOrder(String(order._id)).catch((error) => console.warn("Customer compatibility order dispatch failed", error instanceof Error ? error.message : error))
        : Promise.resolve();
      await Promise.all([dispatch, publishOrderIntakeEvents(order, { settlement: "cash_due", message: "Pedido a contrarreembolso: el Rider cobrará en efectivo al entregar." })]);
      return reply(res, { orderId: code, checkoutUrl: null, totalCents, paymentMethod, paymentState: "pending_cash_collection", cashDueAtDelivery: true, deliveryQrUrl: deliveryQrUrl(code), coverage, route });
    }
    return fail(res, `Procedimiento no soportado: ${procedure}`, "NOT_FOUND");
  } catch (error) { console.error(`[customerCompat] ${procedure}`, error); return fail(res, "Error interno de la plataforma", "INTERNAL_SERVER_ERROR"); }
}
