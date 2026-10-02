import mongoose from "mongoose";
import { CustomerAccount, EmployeeAccount, Notification, Restaurant, Rider } from "./models.js";
import { pushConfigured, sendPushToOwner } from "./push.js";
import type { PikiSurface } from "./appVersion.js";

export type NotificationPrincipal = {
  surface: PikiSurface;
  ownerType: "customer" | "employee";
  ownerId: string;
  tenantId: string | null;
};

type RealtimeNotificationInput = {
  eventId: string;
  channel: "partner" | "fleet" | "admin" | "rider" | "customer";
  audienceKey: string;
  tenantId?: string | null;
  type: string;
  payload: Record<string, unknown>;
};

type Recipient = NotificationPrincipal;
type NoticeCopy = { category: string; title: string; body: string; url: string; entityType: string; entityId: string };

function validId(value: unknown): string | null {
  const id = typeof value === "string" ? value : value == null ? "" : String(value);
  return mongoose.isValidObjectId(id) ? id : null;
}

function idFromAudience(audienceKey: string, prefix: string): string | null {
  if (!audienceKey.startsWith(`${prefix}:`)) return null;
  return validId(audienceKey.slice(prefix.length));
}

function tenantQuery(tenantId?: string | null): Record<string, unknown> {
  const id = validId(tenantId);
  return id ? { tenantId: new mongoose.Types.ObjectId(id) } : { $or: [{ tenantId: null }, { tenantId: { $exists: false } }] };
}

export function notificationRecipientTenantId(accountTenantId: unknown): string | null {
  return validId(accountTenantId);
}

function orderReference(payload: Record<string, unknown>): string {
  const value = String(payload.publicCode || payload.orderCode || payload.orderId || "").trim();
  return value ? `#${value.slice(0, 60)}` : "tu pedido";
}

const statusLabel: Record<string, string> = {
  pending: "pendiente de aceptación",
  accepted: "aceptado",
  preparing: "en preparación",
  ready_for_pickup: "listo para recoger",
  picked_up: "recogido por el rider",
  on_the_way: "en camino",
  delivered: "entregado",
  cancelled: "cancelado",
};

export function buildNoticeCopy(input: RealtimeNotificationInput, recipient: Recipient): NoticeCopy | null {
  const orderId = String(input.payload.orderId || "").trim();
  const orderRef = orderReference(input.payload);
  const customerUrl = orderId ? `/?order_id=${encodeURIComponent(orderId)}` : "/";
  const employeeUrl = "/";
  const url = recipient.surface === "customer" ? customerUrl : employeeUrl;
  const entityType = orderId ? "order" : "";

  if (input.type === "order.awaiting_partner_acceptance") {
    if (!["partner", "fleet", "admin"].includes(recipient.surface)) return null;
    const title = recipient.surface === "partner" ? "Nuevo pedido" : "Nuevo pedido en cocina";
    const body = recipient.surface === "partner" ? `Revisa el pedido ${orderRef} en cocina.` : `${orderRef} está pendiente de aceptación del establecimiento.`;
    return { category: "order", title, body, url, entityType: "order", entityId: orderId };
  }
  if (input.type === "order.payment_confirmed" || input.type === "order.cash_due") {
    const cash = input.type === "order.cash_due" || input.payload.cashDueAtDelivery === true;
    return {
      category: "payment",
      title: cash ? "Pedido en efectivo" : recipient.surface === "customer" ? "Pago confirmado" : "Nuevo pago confirmado",
      body: cash ? `${orderRef} se cobrará en efectivo al entregar.` : `El pago de ${orderRef} está confirmado.`,
      url, entityType: "order", entityId: orderId,
    };
  }
  if (input.type === "order.processing") {
    if (recipient.surface !== "customer") return null;
    return { category: "order", title: "Pedido recibido", body: `El establecimiento ya está gestionando ${orderRef}.`, url, entityType: "order", entityId: orderId };
  }
  if (input.type === "order.rider_offer") {
    if (recipient.surface !== "rider") return null;
    return { category: "delivery", title: "Nuevo reparto asignado", body: `Tienes una nueva oferta para ${orderRef}.`, url, entityType: "order", entityId: orderId };
  }
  if (input.type === "security.rider_shift_out_of_hours") {
    if (!["fleet", "admin"].includes(recipient.surface)) return null;
    const riderName = String(input.payload.riderName || input.payload.riderEmail || "Rider desconocido").slice(0, 120);
    const riderCode = String(input.payload.riderCode || "").trim();
    const attemptedAt = `${String(input.payload.date || "")} ${String(input.payload.time || "")}`.trim();
    const suffix = riderCode ? ` (${riderCode})` : "";
    return {
      category: "security",
      title: "Intento de jornada fuera de horario",
      body: `${riderName}${suffix} intentó iniciar jornada fuera de su slot reservado${attemptedAt ? ` · ${attemptedAt}` : ""}.`,
      url: "/",
      entityType: "rider",
      entityId: String(input.payload.riderId || ""),
    };
  }
  if (input.type.startsWith("onboarding.")) {
    const entityId = String(input.payload.entityId || input.payload.applicationId || input.payload.leadId || "");
    const applicationId = String(input.payload.applicationId || entityId);
    if (input.type === "onboarding.partner_lead.created") {
      if (recipient.surface !== "admin") return null;
      return { category: "onboarding", title: "Nueva solicitud de partner", body: "Hay una solicitud web pendiente de revisión en Solicitudes web.", url: "/?section=Solicitudes%20web", entityType: "partner_lead", entityId };
    }
    if (input.type === "onboarding.rider_lead.created") {
      if (recipient.surface !== "admin") return null;
      return { category: "onboarding", title: "Nueva solicitud de rider", body: "Hay una solicitud web pendiente de revisión en Solicitudes web.", url: "/?section=Solicitudes%20web", entityType: "rider_lead", entityId };
    }
    if (input.type === "onboarding.partner_application.created") {
      if (recipient.surface !== "admin") return null;
      return { category: "onboarding", title: "Expediente partner recibido", body: "Hay documentación de partner pendiente de revisión en Comercios.", url: "/?section=Comercios", entityType: "partner_application", entityId };
    }
    if (input.type === "onboarding.rider_application.created") {
      if (recipient.surface !== "admin") return null;
      return { category: "onboarding", title: "Expediente rider recibido", body: "Hay documentación de rider pendiente de revisión en Riders.", url: "/?section=Riders", entityType: "rider_application", entityId };
    }
    if (input.type === "onboarding.partner_application.approved") {
      if (recipient.surface !== "admin") return null;
      return { category: "onboarding", title: "Partner aprobado", body: "El comercio y su documentación han sido aprobados; el acceso Partner está activado.", url: "/?section=Comercios", entityType: "partner_application", entityId };
    }
    if (input.type === "onboarding.rider_application.approved") {
      if (recipient.surface === "admin") {
        return { category: "onboarding", title: "Rider aprobado", body: "La revisión documental terminó. El expediente está disponible en Riders.", url: "/?section=Riders", entityType: "rider_application", entityId: applicationId };
      }
      if (recipient.surface === "fleet") {
        const riderId = String(input.payload.riderId || "");
        return { category: "onboarding", title: "Nuevo rider aprobado", body: "El rider ya está disponible en la lista operativa de Fleet.", url: "/?section=Riders", entityType: "rider", entityId: riderId };
      }
      return null;
    }
    if (input.type === "onboarding.partner_application.rejected" || input.type === "onboarding.rider_application.rejected") {
      if (recipient.surface !== "admin") return null;
      const partner = input.type.includes("partner");
      return { category: "onboarding", title: partner ? "Solicitud partner rechazada" : "Solicitud rider rechazada", body: "La decisión queda registrada en el expediente de alta.", url: partner ? "/?section=Comercios" : "/?section=Riders", entityType: partner ? "partner_application" : "rider_application", entityId };
    }
    return null;
  }
  if (input.type === "order.status_changed") {
    const status = String(input.payload.status || "");
    const label = statusLabel[status] || "actualizado";
    const body = recipient.surface === "customer"
      ? String(input.payload.message || `Tu pedido ${orderRef} está ${label}.`).slice(0, 240)
      : `${orderRef} está ${label}.`;
    return { category: "order", title: status === "cancelled" ? "Pedido cancelado" : "Actualización de pedido", body, url, entityType: "order", entityId: orderId };
  }
  if (input.type === "cash.wallet_changed" || input.type === "cash.handover_recorded") {
    if (!["rider", "fleet", "admin"].includes(recipient.surface)) return null;
    const cents = Number(input.payload.amountCents || 0);
    const amount = Number.isFinite(cents) && cents > 0 ? ` · ${(cents / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" })}` : "";
    const handover = input.type === "cash.handover_recorded";
    return {
      category: "cash",
      title: handover ? "Liquidación de efectivo" : "Cartera de efectivo actualizada",
      body: handover ? `Se ha registrado una entrega de efectivo${amount}.` : `Tu saldo operativo de efectivo ha cambiado${amount}.`,
      url: employeeUrl, entityType: "cash", entityId: String(input.payload.riderId || ""),
    };
  }
  return null;
}

async function resolveRecipients(input: RealtimeNotificationInput): Promise<Recipient[]> {
  const tenantId = validId(input.tenantId);
  if (input.channel === "customer") {
    const customerId = idFromAudience(input.audienceKey, "customer");
    if (!customerId) return [];
    const customer = await CustomerAccount.findById(customerId).select("_id tenantId").lean().exec() as any;
    return customer ? [{ surface: "customer", ownerType: "customer", ownerId: String(customer._id), tenantId: validId(customer.tenantId) }] : [];
  }
  if (input.channel === "partner") {
    const restaurantId = idFromAudience(input.audienceKey, "restaurant");
    if (!restaurantId) return [];
    const restaurant = await Restaurant.findById(restaurantId).select("_id tenantId").lean().exec() as any;
    if (!restaurant) return [];
    const accounts = await EmployeeAccount.find({ apiRole: "partner", restaurantId: restaurant._id, active: true, authorizationStatus: "approved", ...tenantQuery(restaurant.tenantId) }).select("_id tenantId").limit(500).lean().exec() as any[];
    return accounts.map((account) => ({ surface: "partner", ownerType: "employee", ownerId: String(account._id), tenantId: notificationRecipientTenantId(account.tenantId) }));
  }
  if (input.channel === "rider") {
    const riderId = idFromAudience(input.audienceKey, "rider");
    if (!riderId) return [];
    const rider = await Rider.findById(riderId).select("_id email tenantId").lean().exec() as any;
    if (!rider?.email) return [];
    const accounts = await EmployeeAccount.find({ apiRole: "rider", email: String(rider.email).toLowerCase(), active: true, authorizationStatus: "approved", ...tenantQuery(rider.tenantId) }).select("_id tenantId").limit(100).lean().exec() as any[];
    return accounts.map((account) => ({ surface: "rider", ownerType: "employee", ownerId: String(account._id), tenantId: notificationRecipientTenantId(account.tenantId) }));
  }

  const expected = input.channel === "fleet" ? "fleet" : "admin";
  const roleQuery: Record<string, unknown> = {
    apiRole: expected === "fleet" ? { $in: ["fleet", "commercial"] } : "admin",
    active: true,
    authorizationStatus: "approved",
  };
  if (expected === "admin") {
    const ownerEmail = String(process.env.PIKI_OWNER_EMAIL || "rrhh.milchollos@gmail.com").trim().toLowerCase();
    const tenantFilter = tenantId ? { tenantId: new mongoose.Types.ObjectId(tenantId) } : { tenantId: null };
    roleQuery.$or = [tenantFilter, { email: ownerEmail, ownerProtected: true, accessLevel: "superadmin" }];
  } else {
    Object.assign(roleQuery, tenantQuery(tenantId));
  }
  const accounts = await EmployeeAccount.find(roleQuery).select("_id tenantId").limit(500).lean().exec() as any[];
  return accounts.map((account) => ({ surface: expected, ownerType: "employee", ownerId: String(account._id), tenantId: notificationRecipientTenantId(account.tenantId) }));
}

export async function publishInboxNotification(input: RealtimeNotificationInput): Promise<number> {
  const recipients = await resolveRecipients(input);
  if (!recipients.length) return 0;
  const createdAt = new Date();
  const records = recipients.flatMap((recipient) => {
    const copy = buildNoticeCopy(input, recipient);
    if (!copy || !mongoose.isValidObjectId(recipient.ownerId)) return [];
    const tenantObjectId = validId(recipient.tenantId);
    return [{
      tenantId: tenantObjectId ? new mongoose.Types.ObjectId(tenantObjectId) : null,
      surface: recipient.surface,
      ownerType: recipient.ownerType,
      ownerId: new mongoose.Types.ObjectId(recipient.ownerId),
      ...copy,
      dedupeKey: `realtime:${input.eventId}:${recipient.surface}:${recipient.ownerId}`,
      readAt: null,
      pushStatus: "pending",
      pushAttempts: 0,
      pushNextAttemptAt: createdAt,
      pushLockUntil: null,
      createdAt,
      updatedAt: createdAt,
    }];
  });
  if (!records.length) return 0;
  try {
    const saved = await Notification.insertMany(records, { ordered: false });
    return saved.length;
  } catch (error: any) {
    const inserted = Number(error?.result?.insertedCount || error?.insertedDocs?.length || 0);
    if (Number(error?.code || error?.writeErrors?.[0]?.code) !== 11000) {
      console.warn("Notification inbox persistence failed", error instanceof Error ? error.message : "unknown error");
    }
    return inserted;
  }
}

export async function listNotifications(principal: NotificationPrincipal, options: { limit: number; cursor?: string }) {
  const tenantId = validId(principal.tenantId);
  const filter: Record<string, unknown> = {
    surface: principal.surface,
    ownerType: principal.ownerType,
    ownerId: new mongoose.Types.ObjectId(principal.ownerId),
    tenantId: tenantId ? new mongoose.Types.ObjectId(tenantId) : null,
  };
  const cursor = validId(options.cursor);
  const pageFilter = cursor ? { ...filter, _id: { $lt: new mongoose.Types.ObjectId(cursor) } } : filter;
  const [rows, unreadCount] = await Promise.all([
    Notification.find(pageFilter).select("_id category title body url entityType entityId readAt createdAt").sort({ _id: -1 }).limit(options.limit + 1).lean().exec(),
    Notification.countDocuments({ ...filter, readAt: null }).exec(),
  ]);
  const hasMore = rows.length > options.limit;
  const items = rows.slice(0, options.limit) as any[];
  return {
    notifications: items.map((item) => ({
      id: String(item._id), category: item.category, title: item.title, body: item.body,
      url: item.url, entityType: item.entityType, entityId: item.entityId,
      readAt: item.readAt ? new Date(item.readAt).toISOString() : null,
      createdAt: new Date(item.createdAt).toISOString(),
    })),
    unreadCount,
    hasMore,
    nextCursor: hasMore && items.length ? String(items[items.length - 1]._id) : null,
  };
}

export async function markNotificationRead(principal: NotificationPrincipal, notificationId: string) {
  const id = validId(notificationId);
  if (!id) return false;
  const tenantId = validId(principal.tenantId);
  const result = await Notification.updateOne({
    _id: new mongoose.Types.ObjectId(id),
    surface: principal.surface,
    ownerType: principal.ownerType,
    ownerId: new mongoose.Types.ObjectId(principal.ownerId),
    tenantId: tenantId ? new mongoose.Types.ObjectId(tenantId) : null,
  }, { $set: { readAt: new Date() } }).exec();
  return result.matchedCount > 0;
}

export async function markAllNotificationsRead(principal: NotificationPrincipal) {
  const tenantId = validId(principal.tenantId);
  const result = await Notification.updateMany({
    surface: principal.surface,
    ownerType: principal.ownerType,
    ownerId: new mongoose.Types.ObjectId(principal.ownerId),
    tenantId: tenantId ? new mongoose.Types.ObjectId(tenantId) : null,
    readAt: null,
  }, { $set: { readAt: new Date() } }).exec();
  return result.modifiedCount;
}

function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * (2 ** Math.max(0, attempt - 1)));
}

export async function processNotificationPushBatch(batchSize = 20): Promise<number> {
  if (mongoose.connection.readyState !== 1 || !pushConfigured()) return 0;
  let processed = 0;
  for (let index = 0; index < batchSize; index += 1) {
    const now = new Date();
    const notification = await Notification.findOneAndUpdate({
      pushStatus: { $in: ["pending", "retry", "sending"] },
      pushNextAttemptAt: { $lte: now },
      $or: [{ pushLockUntil: null }, { pushLockUntil: { $exists: false } }, { pushLockUntil: { $lte: now } }],
    }, {
      $set: { pushStatus: "sending", pushLockUntil: new Date(now.getTime() + 60_000) },
      $inc: { pushAttempts: 1 },
    }, { sort: { createdAt: 1 }, new: true }).lean().exec() as any;
    if (!notification) break;
    processed += 1;
    const attempts = Number(notification.pushAttempts || 1);
    try {
      const delivery = await sendPushToOwner({
        surface: notification.surface,
        ownerType: notification.ownerType,
        ownerId: String(notification.ownerId),
        tenantId: notification.tenantId ? String(notification.tenantId) : null,
        payload: {
          title: notification.title,
          body: notification.body,
          url: notification.url,
          tag: String(notification.dedupeKey),
          renotify: true,
        },
      });
      if (delivery.delivered > 0) {
        await Notification.updateOne({ _id: notification._id, pushStatus: "sending" }, { $set: { pushStatus: "sent", pushLockUntil: null } }).exec();
      } else if (delivery.attempted === 0) {
        await Notification.updateOne({ _id: notification._id, pushStatus: "sending" }, { $set: { pushStatus: "unavailable", pushLockUntil: null } }).exec();
      } else if (attempts >= 5) {
        await Notification.updateOne({ _id: notification._id, pushStatus: "sending" }, { $set: { pushStatus: "dead", pushLockUntil: null } }).exec();
      } else {
        await Notification.updateOne({ _id: notification._id, pushStatus: "sending" }, { $set: { pushStatus: "retry", pushLockUntil: null, pushNextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)) } }).exec();
      }
    } catch (error) {
      if (attempts >= 5) {
        await Notification.updateOne({ _id: notification._id, pushStatus: "sending" }, { $set: { pushStatus: "dead", pushLockUntil: null } }).exec();
      } else {
        await Notification.updateOne({ _id: notification._id, pushStatus: "sending" }, { $set: { pushStatus: "retry", pushLockUntil: null, pushNextAttemptAt: new Date(Date.now() + retryDelayMs(attempts)) } }).exec();
      }
      console.warn("Notification push attempt failed", error instanceof Error ? error.message : "unknown error");
    }
  }
  return processed;
}

let notificationWorkerStarted = false;
export function startNotificationWorker() {
  if (notificationWorkerStarted) return;
  notificationWorkerStarted = true;
  const run = async () => {
    try { await processNotificationPushBatch(); }
    catch (error) { console.warn("Notification push worker failed", error instanceof Error ? error.message : "unknown error"); }
    if (notificationWorkerStarted) setTimeout(run, 5_000).unref();
  };
  void run();
}

export function stopNotificationWorker() {
  notificationWorkerStarted = false;
}
