import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { EmployeeAccount, Order, RealtimeEvent, Restaurant, Rider } from "./models.js";
import { currentCustomer } from "./customerCompat.js";
import { resolveRole } from "./auth.js";

export type RealtimeChannel = "partner" | "fleet" | "admin" | "rider" | "customer";
export type RealtimeEventPayload = Record<string, unknown>;
type PersistedRealtimeEvent = { _id: mongoose.Types.ObjectId; channel: RealtimeChannel; audienceKey: string; type: string; payload: RealtimeEventPayload; createdAt: Date };

const stream = new EventEmitter();
stream.setMaxListeners(0);
const HEARTBEAT_MS = 20_000;
const REPLAY_LIMIT = 100;
const emittedIds = new Set<string>();
let relayStarted = false;

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

export async function publishRealtimeEvent(input: { channel: RealtimeChannel; audienceKey: string; type: string; payload: RealtimeEventPayload; dedupeKey?: string }) {
  const document = await RealtimeEvent.create({
    channel: input.channel,
    audienceKey: input.audienceKey,
    type: input.type,
    payload: input.payload,
    ...(input.dedupeKey ? { dedupeKey: input.dedupeKey } : {}),
  });
  const event = document.toObject() as PersistedRealtimeEvent;
  emitOnce(event);
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

export async function publishPaidOrderEvents(order: any) {
  const base = {
    orderId: String(order._id),
    publicCode: order.publicCode,
    restaurantId: String(order.restaurantId),
    status: "pending",
    paymentState: "paid",
    assignmentState: "unassigned",
    totalCents: Number(order.totalCents || 0),
    createdAt: new Date(order.createdAt || Date.now()).toISOString(),
  };
  const events: Array<Promise<unknown>> = [
    publishRealtimeEvent({ channel: "partner", audienceKey: `restaurant:${base.restaurantId}`, type: "order.awaiting_partner_acceptance", payload: { ...base, message: "Nuevo pedido pagado. Debe aceptarse antes de buscar rider." }, dedupeKey: `paid:partner:${base.orderId}` }),
    publishRealtimeEvent({ channel: "fleet", audienceKey: "role:fleet", type: "order.awaiting_partner_acceptance", payload: { ...base, queue: "Pedidos por asignar", message: "Pedido pagado pendiente de aceptación del restaurante." }, dedupeKey: `paid:fleet:${base.orderId}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: "role:admin", type: "order.payment_confirmed", payload: { ...base, gmvDeltaCents: base.totalCents, activeOrdersDelta: 1 }, dedupeKey: `paid:admin:${base.orderId}` }),
  ];
  if (order.customerId && mongoose.isValidObjectId(order.customerId)) {
    events.push(publishRealtimeEvent({ channel: "customer", audienceKey: `customer:${String(order.customerId)}`, type: "order.processing", payload: customerOrderPayload(order), dedupeKey: `paid:customer:${base.orderId}` }));
  }
  await Promise.all(events);
}

export async function publishOrderStatusEvents(order: any, status: string) {
  const base = { orderId: String(order._id), publicCode: order.publicCode, status, paymentState: order.paymentState, assignmentState: order.assignmentState };
  const events: Array<Promise<unknown>> = [
    publishRealtimeEvent({ channel: "fleet", audienceKey: "role:fleet", type: "order.status_changed", payload: base, dedupeKey: `status:fleet:${base.orderId}:${status}:${order.version || 0}` }),
    publishRealtimeEvent({ channel: "admin", audienceKey: "role:admin", type: "order.status_changed", payload: base, dedupeKey: `status:admin:${base.orderId}:${status}:${order.version || 0}` }),
  ];
  if (order.customerId && mongoose.isValidObjectId(order.customerId)) {
    events.push(publishRealtimeEvent({ channel: "customer", audienceKey: `customer:${String(order.customerId)}`, type: "order.status_changed", payload: { ...customerOrderPayload(order), status }, dedupeKey: `status:customer:${base.orderId}:${status}:${order.version || 0}` }));
  }
  if (order.riderId) {
    events.push(publishRealtimeEvent({ channel: "rider", audienceKey: `rider:${String(order.riderId)}`, type: "order.status_changed", payload: base, dedupeKey: `status:rider:${base.orderId}:${status}:${order.version || 0}` }));
  }
  await Promise.all(events);
}

export async function publishRiderOfferEvent(order: any, riderId: string) {
  await publishRealtimeEvent({
    channel: "rider",
    audienceKey: `rider:${riderId}`,
    type: "order.rider_offer",
    payload: { orderId: String(order._id), publicCode: order.publicCode, assignmentState: "offered", status: order.status, message: "Tienes una nueva oferta de reparto." },
    dedupeKey: `offer:rider:${String(order._id)}:${riderId}:${order.dispatchAttempts || 0}`,
  });
}

async function resolveAudience(request: Request): Promise<{ channel: RealtimeChannel; audienceKey: string } | null> {
  const surface = String(request.header("x-piki-surface") || request.query.surface || "").toLowerCase();
  if (surface === "customer") {
    const customer = await currentCustomer(request) as any;
    return customer ? { channel: "customer", audienceKey: `customer:${String(customer._id)}` } : null;
  }
  const auth = await resolveRole(request);
  if (!auth) return null;
  if (surface === "admin" && auth.role === "admin") return { channel: "admin", audienceKey: "role:admin" };
  if (surface === "fleet" && ["fleet", "commercial"].includes(auth.role)) return { channel: "fleet", audienceKey: "role:fleet" };
  if (surface === "partner" && auth.role === "partner" && auth.employeeId) {
    const employee = await EmployeeAccount.findById(auth.employeeId).select("restaurantId").lean().exec() as any;
    return employee?.restaurantId ? { channel: "partner", audienceKey: `restaurant:${String(employee.restaurantId)}` } : null;
  }
  if (surface === "rider" && auth.role === "rider" && auth.employeeId) {
    const employee = await EmployeeAccount.findById(auth.employeeId).select("email").lean().exec() as any;
    const rider = employee?.email ? await Rider.findOne({ email: employee.email }).select("_id").lean().exec() as any : null;
    return rider ? { channel: "rider", audienceKey: `rider:${String(rider._id)}` } : null;
  }
  return null;
}

export async function serveRealtimeEvents(request: Request, response: Response) {
  const audience = await resolveAudience(request);
  if (!audience) return response.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
  const suppliedId = String(request.header("last-event-id") || request.query.since || "");
  const after = mongoose.isValidObjectId(suppliedId) ? new mongoose.Types.ObjectId(suppliedId) : null;
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  response.write(`event: ready\ndata: ${JSON.stringify({ channel: audience.channel })}\n\n`);
  const query: Record<string, unknown> = { channel: audience.channel, audienceKey: audience.audienceKey };
  if (after) query._id = { $gt: after };
  const delivered = new Set<string>();
  const writeUniqueEvent = (event: PersistedRealtimeEvent) => {
    const eventId = String(event._id);
    if (delivered.has(eventId)) return;
    delivered.add(eventId);
    writeEvent(response, event);
  };
  const listener = (event: PersistedRealtimeEvent) => {
    if (event.channel === audience.channel && event.audienceKey === audience.audienceKey) writeUniqueEvent(event);
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
