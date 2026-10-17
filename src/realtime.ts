import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { EmployeeAccount, Order, RealtimeEvent, Restaurant, Rider, Tenant } from "./models.js";
import { currentCustomer } from "./customerCompat.js";
import { resolveRole } from "./auth.js";
import { publishInboxNotification } from "./notifications.js";

export type RealtimeChannel = "partner" | "fleet" | "admin" | "rider" | "customer";
export type RealtimeEventPayload = Record<string, unknown>;
type PersistedRealtimeEvent = { _id: mongoose.Types.ObjectId; tenantId?: mongoose.Types.ObjectId | null; channel: RealtimeChannel; audienceKey: string; type: string; payload: RealtimeEventPayload; createdAt: Date };
type ResolvedAudience = { channel: RealtimeChannel; audienceKeys: string[] };

const stream = new EventEmitter();
stream.setMaxListeners(0);
const HEARTBEAT_MS = 20_000;
const REPLAY_LIMIT = 100;
const emittedIds = new Set<string>();
let relayStarted = false;

function validTenantId(value: unknown): mongoose.Types.ObjectId | null {
  const stringValue = value == null ? "" : String(value);
  return mongoose.isValidObjectId(stringValue) ? new mongoose.Types.ObjectId(stringValue) : null;
}

export function tenantAudienceKey(tenantId: unknown, role: "fleet" | "admin"): string {
  const id = validTenantId(tenantId);
  return `tenant:${id ? String(id) : "default"}:role:${role}`;
}

function emitOnce(event: PersistedRealtimeEvent) {
  const id = String(event._id);
  if (emittedIds.has(id)) return;
  emittedIds.add(id);
  if (emittedIds.size > 5_000) emittedIds.delete(emittedIds.values().next().value as string);
  stream.emit("event", event);
}

/**
 * MongoDB change streams distribute the durable outbox across Render instances.
 * The local emit below remains a safe fallback while Mongo is reconnecting.
 */
export function startRealtimeRelay() {
  if (relayStarted || mongoose.connection.readyState !== 1) return;
  relayStarted = true;
  try {
    const changes = RealtimeEvent.watch([], { fullDocument: "default" });
    changes.on("change", (change: any) => {
      if (change.operationType === "insert" && change.fullDocument) emitOnce(change.fullDocument as PersistedRealtimeEvent);
    });
    changes.on("error", (error) => {
      relayStarted = false;
      console.warn("Realtime change-stream relay unavailable; local relay remains active", error instanceof Error ? error.message : error);
    });
  } catch (error) {
    relayStarted = false;
    console.warn("Realtime change-stream relay could not start; local relay remains active", error instanceof Error ? error.message : error);
  }
}

function writeEvent(response: Response, event: PersistedRealtimeEvent) {
  response.write(`id: ${String(event._id)}\n`);
  response.write(`event: ${event.type}\n`);
  response.write(`data: ${JSON.stringify({ id: String(event._id), type: event.type, payload: event.payload, occurredAt: event.createdAt.toISOString() })}\n\n`);
}

export async function publishRealtimeEvent(input: { channel: RealtimeChannel; audienceKey: string; type: string; payload: RealtimeEventPayload; tenantId?: string | mongoose.Types.ObjectId | null; dedupeKey?: string }) {
  const eventData = {
    tenantId: validTenantId(input.tenantId),
    channel: input.channel,
    audienceKey: input.audienceKey,
    type: input.type,
    payload: input.payload,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
  };
  // Use Mongo's unique dedupe index as the cross-instance lock. This makes
  // retries safe even when two Render instances publish the same event at once.
  let document;
  if (input.dedupeKey) {
    try {
      document = await RealtimeEvent.findOneAndUpdate(
        { dedupeKey: input.dedupeKey },
        { $setOnInsert: eventData },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).exec();
    } catch (error) {
      if ((error as any)?.code !== 11000) throw error;
      document = await RealtimeEvent.findOne({ dedupeKey: input.dedupeKey }).exec();
    }
  } else {
    document = await RealtimeEvent.create(eventData);
  }
  if (!document) throw new Error("REALTIME_EVENT_NOT_PERSISTED");
  const event = document.toObject() as PersistedRealtimeEvent;
  emitOnce(event);
  try {
    await publishInboxNotification({
      eventId: String(event._id), channel: event.channel, audienceKey: event.audienceKey,
      tenantId: event.tenantId ? String(event.tenantId) : null, type: event.type, payload: event.payload,
    });
  } catch (error) {
    console.warn("Realtime notification fan-out failed", error instanceof Error ? error.message : "unknown error");
  }
  return event;
}

function customerOrderPayload(order: any) {
  const messages: Record<string, string> = {
    pending: "Tu pedido está siendo procesado por el restaurante.",
    accepted: "El restaurante ha aceptado tu pedido.",
    preparing: "Tu pedido se está preparando.",
    ready_for_pickup: "Tu pedido está listo para recoger.",
    picked_up: "Tu rider ha recogido tu pedido.",
    on_the_way: "Tu pedido está en camino.",
    delivered: "Tu pedido ha sido entregado.",
    cancelled: "Tu pedido ha sido cancelado.",
  };
  return {
    orderId: String(order._id),
    publicCode: order.publicCode,
    status: order.status,
    paymentState: order.paymentState,
    assignmentState: order.assignmentState,
    message: messages[String(order.status)] || "Tu pedido ha sido actualizado.",
  };
}

export async function publishOrderIntakeEvents(order: any, settlement: { settlement?: "paid" | "cash_due"; message?: string } = {}) {
  const cashDue = settlement.settlement === "cash_due" || order.paymentMethod === "cash";
  const tenantId = validTenantId(order.tenantId);
  const base = {
    orderId: String(order._id),
    publicCode: order.publicCode,
    restaurantId: String(order.restaurantId),
    status: "pending",
    paymentState: cashDue ? "pending_cash_collection" : "paid",
    paymentMethod: order.paymentMethod || "stripe",
    cashDueAtDelivery: cashDue,
    assignmentState: "unassigned",
    totalCents: Number(order.totalCents || 0),
    createdAt: new Date(order.createdAt || Date.now()).toISOString(),
  };
  const events: Array<Promise<unknown>> = [
    publishRealtimeEvent({ channel: "partner", audienceKey: `restaurant:${base.restaurantId}`, tenantId, type: "order.awaiting_partner_acceptance", payload: { ...base, message: cashDue ? "Nuevo pedido a contrarreembolso: no se cobra ahora; el Rider cobrará al entregar." : "Nuevo pedido pagado online. PIKI avisa al Partner y busca Rider en paralelo." }, dedupeKey: `${cashDue ? "cash-due" : "paid"}:partner:${base.orderId}` }),
    publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(tenantId, "fleet"), tenantId, type: "order.awaiting_partner_acceptance", payload: { ...base, queue: "Pedidos pendientes del Partner", message: cashDue ? "CONTRARREEMBOLSO · el Rider cobra al entregar." : "Pedido pagado: el Rider recibe una oferta mientras el Partner empieza a prepararlo." }, dedupeKey: `${cashDue ? "cash-due" : "paid"}:fleet:${base.orderId}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(tenantId, "admin"), tenantId, type: cashDue ? "order.cash_due" : "order.payment_confirmed", payload: { ...base, gmvDeltaCents: base.totalCents, activeOrdersDelta: 1, message: settlement.message }, dedupeKey: `${cashDue ? "cash-due" : "paid"}:admin:${base.orderId}` }),
  ];
  if (order.customerId && mongoose.isValidObjectId(order.customerId)) {
    events.push(publishRealtimeEvent({ channel: "customer", audienceKey: `customer:${String(order.customerId)}`, tenantId, type: "order.processing", payload: { ...customerOrderPayload(order), paymentState: base.paymentState, paymentMethod: base.paymentMethod, cashDueAtDelivery: cashDue }, dedupeKey: `${cashDue ? "cash-due" : "paid"}:customer:${base.orderId}` }));
  }
  await Promise.all(events);
}

export async function publishOrderStatusEvents(order: any, status: string) {
  const tenantId = validTenantId(order.tenantId);
  const base = { orderId: String(order._id), publicCode: order.publicCode, restaurantId: String(order.restaurantId), status, paymentState: order.paymentState, assignmentState: order.assignmentState };
  const events: Array<Promise<unknown>> = [
    publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(tenantId, "fleet"), tenantId, type: "order.status_changed", payload: base, dedupeKey: `status:fleet:${base.orderId}:${status}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(tenantId, "admin"), tenantId, type: "order.status_changed", payload: base, dedupeKey: `status:admin:${base.orderId}:${status}:${order.version || 0}` }),
  ];
  if (order.restaurantId && mongoose.isValidObjectId(order.restaurantId)) {
    events.push(publishRealtimeEvent({ channel: "partner", audienceKey: `restaurant:${String(order.restaurantId)}`, tenantId, type: "order.status_changed", payload: base, dedupeKey: `status:partner:${base.orderId}:${status}:${order.version || 0}` }));
  }
  if (order.customerId && mongoose.isValidObjectId(order.customerId)) {
    events.push(publishRealtimeEvent({ channel: "customer", audienceKey: `customer:${String(order.customerId)}`, tenantId, type: "order.status_changed", payload: { ...customerOrderPayload({ ...order, status }), status }, dedupeKey: `status:customer:${base.orderId}:${status}:${order.version || 0}` }));
  }
  if (order.riderId) {
    events.push(publishRealtimeEvent({ channel: "rider", audienceKey: `rider:${String(order.riderId)}`, tenantId, type: "order.status_changed", payload: base, dedupeKey: `status:rider:${base.orderId}:${status}:${order.version || 0}` }));
  }
  await Promise.all(events);
}

export async function publishRiderOfferEvent(order: any, riderId: string) {
  await publishRealtimeEvent({
    channel: "rider",
    audienceKey: `rider:${riderId}`,
    tenantId: validTenantId(order.tenantId),
    type: "order.rider_offer",
    payload: { orderId: String(order._id), publicCode: order.publicCode, assignmentState: "offered", status: order.status, message: "Tienes una nueva oferta de reparto." },
    dedupeKey: `offer:rider:${String(order._id)}:${riderId}:${order.dispatchAttempts || 0}`,
  });
}
export async function publishRiderHeadingToPartnerEvent(order: any, rider: any) {
  const tenantId = validTenantId(order.tenantId);
  const base = { orderId: String(order._id), publicCode: order.publicCode, restaurantId: String(order.restaurantId), riderId: String(rider._id), status: order.status, assignmentState: order.assignmentState, headingToPartnerAt: order.riderHeadingToPartnerAt || new Date(), message: "El Rider está en camino al Partner para recoger el pedido." };
  const events: Array<Promise<unknown>> = [
    publishRealtimeEvent({ channel: "rider", audienceKey: `rider:${base.riderId}`, tenantId, type: "order.rider_heading_to_partner", payload: base, dedupeKey: `heading:rider:${base.orderId}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "partner", audienceKey: `restaurant:${base.restaurantId}`, tenantId, type: "order.rider_heading_to_partner", payload: base, dedupeKey: `heading:partner:${base.orderId}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(tenantId, "fleet"), tenantId, type: "order.rider_heading_to_partner", payload: base, dedupeKey: `heading:fleet:${base.orderId}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(tenantId, "admin"), tenantId, type: "order.rider_heading_to_partner", payload: base, dedupeKey: `heading:admin:${base.orderId}:${order.version || 0}` }),
  ];
  if (order.customerId && mongoose.isValidObjectId(order.customerId)) events.push(publishRealtimeEvent({ channel: "customer", audienceKey: `customer:${String(order.customerId)}`, tenantId, type: "order.rider_heading_to_partner", payload: { ...customerOrderPayload(order), ...base }, dedupeKey: `heading:customer:${base.orderId}:${order.version || 0}` }));
  await Promise.all(events);
}
export async function publishRiderCustomerMessageEvent(order: any, message: any) {
  if (!order.customerId || !mongoose.isValidObjectId(order.customerId)) return;
  const messageId = String(message._id || `${order._id}:${message.createdAt || Date.now()}`);
  await publishRealtimeEvent({
    channel: "customer",
    audienceKey: `customer:${String(order.customerId)}`,
    tenantId: validTenantId(order.tenantId),
    type: "order.rider_message",
    payload: { orderId: String(order._id), publicCode: order.publicCode, riderId: order.riderId ? String(order.riderId) : null, messageId, message: String(message.body || "").slice(0, 240), senderRole: "rider" },
    dedupeKey: `message:customer:${messageId}`,
  });
}
export async function publishRiderScheduleEvent(input: { riderId: string; tenantId?: string | mongoose.Types.ObjectId | null; action: "updated" | "cancelled" | "weekly_updated" }) {
  const riderId = String(input.riderId);
  await publishRealtimeEvent({
    channel: "rider",
    audienceKey: `rider:${riderId}`,
    tenantId: input.tenantId,
    type: "rider.schedule_updated",
    payload: { riderId, action: input.action, updatedAt: new Date().toISOString() },
    dedupeKey: `schedule:rider:${riderId}:${input.action}:${Date.now()}`,
  });
}

export async function publishRiderArrivalEvent(order: any, rider: any, distanceMeters: number, source: "rider" | "gps_sweep") {
  const tenantId = validTenantId(order.tenantId);
  const base = {
    orderId: String(order._id), publicCode: order.publicCode, restaurantId: String(order.restaurantId), riderId: String(rider._id),
    status: order.status, assignmentState: order.assignmentState, arrivedAt: order.riderArrivedAt || new Date(),
    distanceMeters: Math.round(distanceMeters), source,
  };
  const events: Array<Promise<unknown>> = [
    publishRealtimeEvent({ channel: "rider", audienceKey: `rider:${base.riderId}`, tenantId, type: "order.rider_arrived_at_partner", payload: base, dedupeKey: `arrival:rider:${base.orderId}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "partner", audienceKey: `restaurant:${base.restaurantId}`, tenantId, type: "order.rider_arrived_at_partner", payload: base, dedupeKey: `arrival:partner:${base.orderId}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(tenantId, "fleet"), tenantId, type: "order.rider_arrived_at_partner", payload: base, dedupeKey: `arrival:fleet:${base.orderId}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(tenantId, "admin"), tenantId, type: "order.rider_arrived_at_partner", payload: base, dedupeKey: `arrival:admin:${base.orderId}:${order.version || 0}` }),
  ];
  if (order.customerId && mongoose.isValidObjectId(order.customerId)) {
    events.push(publishRealtimeEvent({ channel: "customer", audienceKey: `customer:${String(order.customerId)}`, tenantId, type: "order.rider_arrived_at_partner", payload: { ...customerOrderPayload(order), message: "Tu repartidor ya está en el establecimiento." }, dedupeKey: `arrival:customer:${base.orderId}:${order.version || 0}` }));
  }
  await Promise.all(events);
}

/** Emits a compact location update only for an active delivery and its authorised audiences. */
export async function publishRiderLocationEvents(order: any, rider: any) {
  const coordinates = rider?.location?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return;
  const [longitude, latitude] = coordinates;
  if (!Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return;
  const tenantId = validTenantId(order.tenantId);
  const recordedAt = new Date(rider.lastLocationAt || Date.now()).toISOString();
  const bucket = Math.floor(new Date(recordedAt).getTime() / 5_000);
  const base = {
    orderId: String(order._id), publicCode: order.publicCode, riderId: String(rider._id), status: order.status,
    latitude: Number(Number(latitude).toFixed(5)), longitude: Number(Number(longitude).toFixed(5)), recordedAt,
  };
  const events: Array<Promise<unknown>> = [
    publishRealtimeEvent({ channel: "fleet", audienceKey: tenantAudienceKey(tenantId, "fleet"), tenantId, type: "rider.location_updated", payload: base, dedupeKey: `location:fleet:${base.orderId}:${bucket}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: tenantAudienceKey(tenantId, "admin"), tenantId, type: "rider.location_updated", payload: base, dedupeKey: `location:admin:${base.orderId}:${bucket}` }),
  ];
  if (order.customerId && mongoose.isValidObjectId(order.customerId)) {
    events.push(publishRealtimeEvent({ channel: "customer", audienceKey: `customer:${String(order.customerId)}`, tenantId, type: "rider.location_updated", payload: base, dedupeKey: `location:customer:${base.orderId}:${bucket}` }));
  }
  await Promise.all(events);
}

async function resolveAudience(request: Request): Promise<ResolvedAudience | null> {
  const surface = String(request.header("x-piki-surface") || request.query.surface || "").toLowerCase();
  if (surface === "customer") {
    const customer = await currentCustomer(request) as any;
    return customer ? { channel: "customer", audienceKeys: [`customer:${String(customer._id)}`] } : null;
  }
  const auth = await resolveRole(request);
  if (!auth?.employeeId) return null;
  if (surface === "admin" && ["admin", "support", "finance"].includes(auth.role)) {
    const employee = await EmployeeAccount.findById(auth.employeeId).select("tenantId ownerProtected accessLevel").lean().exec() as any;
    if (!employee) return null;
    if (employee.ownerProtected === true && employee.accessLevel === "superadmin") {
      const tenants = await Tenant.find({}).select("_id").lean().exec() as any[];
      const audienceKeys = [tenantAudienceKey(null, "admin"), ...tenants.map((tenant) => tenantAudienceKey(tenant._id, "admin"))];
      return { channel: "admin", audienceKeys: [...new Set(audienceKeys)] };
    }
    return { channel: "admin", audienceKeys: [tenantAudienceKey(employee.tenantId, "admin")] };
  }
  if (surface === "fleet" && ["fleet", "commercial"].includes(auth.role)) {
    const employee = await EmployeeAccount.findById(auth.employeeId).select("tenantId").lean().exec() as any;
    return employee ? { channel: "fleet", audienceKeys: [tenantAudienceKey(employee.tenantId, "fleet")] } : null;
  }
  if (surface === "partner" && auth.role === "partner") {
    const employee = await EmployeeAccount.findById(auth.employeeId).select("restaurantId restaurantIds").lean().exec() as any;
    const assignedRestaurantIds = [...new Set([...(Array.isArray(employee?.restaurantIds) ? employee.restaurantIds : []), employee?.restaurantId].filter(Boolean).map(String))];
    const requestedRestaurantId = String(request.header("x-piki-restaurant-id") || "").trim();
    const restaurantIds = requestedRestaurantId ? assignedRestaurantIds.filter((id) => id === requestedRestaurantId) : assignedRestaurantIds;
    return restaurantIds.length ? { channel: "partner", audienceKeys: restaurantIds.map((id) => `restaurant:${id}`) } : null;
  }
  if (surface === "rider" && auth.role === "rider") {
    const employee = await EmployeeAccount.findById(auth.employeeId).select("email").lean().exec() as any;
    const rider = employee?.email ? await Rider.findOne({ email: employee.email }).select("_id").lean().exec() as any : null;
    return rider ? { channel: "rider", audienceKeys: [`rider:${String(rider._id)}`] } : null;
  }
  return null;
}

export async function serveRealtimeEvents(request: Request, response: Response) {
  const audience = await resolveAudience(request);
  if (!audience) {
    response.setHeader("WWW-Authenticate", "Bearer realm=\"PIKI API\"");
    return response.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  }
  const suppliedId = String(request.header("last-event-id") || request.query.since || "");
  const after = mongoose.isValidObjectId(suppliedId) ? new mongoose.Types.ObjectId(suppliedId) : null;
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write(`event: ready\ndata: ${JSON.stringify({ channel: audience.channel })}\n\n`);
  const query: Record<string, unknown> = { channel: audience.channel, audienceKey: { $in: audience.audienceKeys } };
  if (after) query._id = { $gt: after };
  const delivered = new Set<string>();
  const audienceKeySet = new Set(audience.audienceKeys);
  const writeUniqueEvent = (event: PersistedRealtimeEvent) => {
    const eventId = String(event._id);
    if (delivered.has(eventId)) return;
    delivered.add(eventId);
    writeEvent(response, event);
  };
  const listener = (event: PersistedRealtimeEvent) => {
    if (event.channel === audience.channel && audienceKeySet.has(event.audienceKey)) writeUniqueEvent(event);
  };
  const heartbeat = setInterval(() => response.write(`: heartbeat ${Date.now()}\n\n`), HEARTBEAT_MS);
  stream.on("event", listener);
  const backlog = (after
    ? await RealtimeEvent.find(query).sort({ _id: 1 }).limit(REPLAY_LIMIT).lean().exec()
    : (await RealtimeEvent.find(query).sort({ _id: -1 }).limit(REPLAY_LIMIT).lean().exec()).reverse()
  ) as unknown as PersistedRealtimeEvent[];
  backlog.forEach((event) => writeUniqueEvent(event));
  const close = () => { clearInterval(heartbeat); stream.off("event", listener); };
  request.on("close", close);
  response.on("close", close);
}

export async function getRestaurantForOrder(order: any) {
  return Restaurant.findById(order.restaurantId).select("_id name").lean().exec();
}
