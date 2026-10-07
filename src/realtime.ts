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
  const document = await RealtimeEvent.create({
    tenantId: validTenantId(input.tenantId),
    channel: input.channel,
    audienceKey: input.audienceKey,
    type: input.type,
    payload: input.payload,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
  });
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

async function resolveAudience(request: Request): Promise<ResolvedAudience | null> {
  const surface = String(request.header("x-piki-surface") || request.query.surface || "").toLowerCase();
  if (surface === "customer") {
    const customer = await currentCustomer(request) as any;
    return customer ? { channel: "customer", audienceKeys: [`customer:${String(customer._id)}`] } : null;
  }
  const auth = await resolveRole(request);
  if (!auth?.employeeId) return null;
  if (surface === "admin" && ["admin", "support"].includes(auth.role)) {
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
    const employee = await EmployeeAccount.findById(auth.employeeId).select("restaurantId").lean().exec() as any;
    return employee?.restaurantId ? { channel: "partner", audienceKeys: [`restaurant:${String(employee.restaurantId)}`] } : null;
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
  const backlog = await RealtimeEvent.find(query).sort({ _id: 1 }).limit(REPLAY_LIMIT).lean().exec() as unknown as PersistedRealtimeEvent[];
  backlog.forEach((event) => writeUniqueEvent(event));
  const close = () => { clearInterval(heartbeat); stream.off("event", listener); };
  request.on("close", close);
  response.on("close", close);
}

export async function getRestaurantForOrder(order: any) {
  return Restaurant.findById(order.restaurantId).select("_id name").lean().exec();
}
