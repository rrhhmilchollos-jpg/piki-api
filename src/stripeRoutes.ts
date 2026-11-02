/**
 * Rutas del cobro asegurado del contra­rreembolso.
 *
 *  - POST /api/v1/orders/:id/cod-authorization  → retiene el total en la tarjeta
 *  - POST /api/v1/admin/orders/:id/cod-capture  → cobra la retención si no pagó
 *  - POST /api/v1/admin/orders/:id/cod-release  → libera al cobrar en efectivo
 *  - POST /api/v1/admin/cod-sweep               → barrido de retenciones a punto de caducar
 *  - POST /webhooks/stripe                      → eventos firmados de Stripe
 */
import express, { type Express, type Request, type Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { requireRole } from "./auth.js";
import { Order } from "./models.js";
import {
  CodHold,
  normalizeReference,
} from "./codHolds.js";
import {
  authorizationAmountCents,
  authorizationExpiry,
  authorizeCodOrder,
  captureCodOrder,
  handleStripeEvent,
  releaseCodOrder,
  stripeConfigured,
  sweepExpiringCodAuthorizations,
  verifyStripeWebhook,
} from "./stripePayments.js";

/**
 * Límite sencillo por IP para la autorización pública del cliente.
 * Evita que alguien machaque el endpoint creando retenciones en bucle.
 */
const codAttempts = new Map<string, { count: number; resetAt: number }>();
const COD_WINDOW_MS = 10 * 60 * 1000;
const COD_MAX_ATTEMPTS = 8;

function codAuthorizationLimiter(request: Request, response: Response, next: () => void): void {
  const key = request.ip ?? "desconocida";
  const now = Date.now();
  const entry = codAttempts.get(key);
  if (!entry || now > entry.resetAt) {
    codAttempts.set(key, { count: 1, resetAt: now + COD_WINDOW_MS });
    next();
    return;
  }
  entry.count += 1;
  if (entry.count > COD_MAX_ATTEMPTS) {
    response.status(429).json({ error: "demasiados intentos, espera unos minutos" });
    return;
  }
  next();
}

const authorizeSchema = z.object({
  paymentMethodId: z.string().min(3).optional(),
  customerId: z.string().min(3).optional(),
  email: z.string().email().optional(),
  orderCode: z.string().min(3).max(40).optional(),
  amountCents: z.number().int().min(50).max(500000).optional(),
  shortOrderNumber: z.string().min(1).max(40).optional(),
});

/**
 * El seguimiento del cliente identifica el pedido por su código visible
 * (PIKI-XXXX), no por el ObjectId. Aceptamos las dos formas.
 */
async function findOrderByReference(reference: string, extraCode?: string | null) {
  const candidates = new Set<string>();
  const push = (value?: string | null) => {
    if (!value) return;
    const raw = String(value).trim();
    if (!raw) return;
    candidates.add(raw);
    candidates.add(raw.toUpperCase());
    candidates.add(raw.replace(/^PIKI-?/i, "").toUpperCase());
    candidates.add(`PIKI-${raw.replace(/^PIKI-?/i, "").toUpperCase()}`);
  };
  push(reference);
  push(extraCode);

  if (mongoose.isValidObjectId(reference)) {
    const byId = await Order.findById(reference);
    if (byId) return byId;
  }
  const list = [...candidates];
  const exact = await Order.findOne({
    $or: [
      { displayCode: { $in: list } },
      { shortOrderNumber: { $in: list } },
      { orderCode: { $in: list } },
      { code: { $in: list } },
    ],
  });
  if (exact) return exact;

  // Último recurso: comparación sin distinguir mayúsculas ni el prefijo PIKI-.
  const bare = String(reference).trim().replace(/^PIKI-?/i, "");
  if (!bare) return null;
  const pattern = new RegExp(`^\\s*(PIKI-?)?${bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i");
  return Order.findOne({
    $or: [
      { displayCode: pattern },
      { shortOrderNumber: pattern },
      { orderCode: pattern },
      { code: pattern },
    ],
  });
}

function orderIdFrom(request: Request): string | null {
  const id = request.params.id;
  return typeof id === "string" && mongoose.isValidObjectId(id) ? id : null;
}

export function mountStripeWebhook(app: Express): void {
  app.post(
    "/webhooks/stripe",
    express.raw({ type: "application/json" }),
    async (request: Request, response: Response) => {
      try {
        const event = verifyStripeWebhook(
          request.body as Buffer,
          request.header("stripe-signature") ?? undefined,
        );
        const summary = await handleStripeEvent(event);
        response.json({ received: true, ...summary });
      } catch (error) {
        response.status(400).json({ error: (error as Error).message });
      }
    },
  );
}

export function mountStripeRoutes(app: Express): void {
  app.get(
    "/api/v1/admin/stripe/status",
    requireRole("admin", "finance", "fleet"),
    (_request: Request, response: Response) => {
      response.json({
        configured: stripeConfigured(),
        authorizationTtlDays: 7,
        releaseMarginHours: 12,
      });
    },
  );

  // El cliente acepta la retención al elegir contra­rreembolso.
  //
  // Es la única ruta del módulo abierta sin rol de empleado, porque quien la
  // llama es el cliente desde la web. Se protege por estado del pedido y por
  // límite de peticiones: solo se puede retener un pedido a contra­rreembolso
  // recién creado y sin retención previa, y la tarjeta siempre es del solicitante.
  app.post(
    "/api/v1/orders/:id/cod-authorization",
    codAuthorizationLimiter,
    async (request: Request, response: Response) => {
      const reference = String(request.params.id ?? "").trim();
      if (!reference) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const parsed = authorizeSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        response.status(400).json({ error: "datos inválidos", detail: parsed.error.issues });
        return;
      }
      const bodyCode = (request.body ?? {}) as { orderCode?: string; shortOrderNumber?: string };
      const order = await findOrderByReference(reference, bodyCode.orderCode ?? bodyCode.shortOrderNumber ?? null);

      // El pedido puede vivir solo en la base del servidor de Customer; en ese
      // caso la retención se registra por referencia y no se pierde la garantía.
      if (!order) {
        const declared = parsed.data.amountCents;
        if (!declared) {
          response.status(404).json({ error: "pedido no encontrado", referencia: reference });
          return;
        }
        const normalized = normalizeReference(reference);
        if (request.query.dry === "1") {
          response.json({ ok: true, mode: "referencia", reference: normalized, amountCents: declared });
          return;
        }
        const existing = await CodHold.findOne({ reference: normalized });
        if (existing && existing.status === "authorized") {
          response.status(409).json({ error: "este pedido ya tiene una retención activa", paymentIntentId: existing.paymentIntentId });
          return;
        }
        if (existing && existing.status === "captured") {
          response.status(409).json({ error: "este pedido ya está cobrado" });
          return;
        }
        try {
          const created = await authorizeCodOrder({
            orderId: normalized,
            amountCents: declared,
            paymentMethodId: parsed.data.paymentMethodId ?? null,
            customerId: parsed.data.customerId ?? null,
            email: parsed.data.email ?? null,
          });
          await CodHold.create({
            reference: normalized,
            amountCents: declared,
            status: "authorized",
            paymentIntentId: created.paymentIntentId,
            clientSecret: created.clientSecret,
            expiresAt: created.expiresAt,
          });
          response.status(201).json({
            paymentIntentId: created.paymentIntentId,
            clientSecret: created.clientSecret,
            requiresAction: created.requiresAction,
            amountCents: declared,
            expiresAt: created.expiresAt.toISOString(),
          });
        } catch (error) {
          response.status(502).json({ error: (error as Error).message });
        }
        return;
      }
      const orderId = String(order._id);
      if (!order) {
        response.status(404).json({ error: "pedido no encontrado" });
        return;
      }
      if (order.paymentMethod !== "cash") {
        response.status(409).json({ error: "el pedido no es contra­rreembolso" });
        return;
      }
      const createdAt = (order as unknown as { createdAt?: Date }).createdAt;
      if (createdAt && Date.now() - createdAt.getTime() > 6 * 60 * 60 * 1000) {
        response.status(409).json({ error: "este pedido ya no admite garantía de tarjeta" });
        return;
      }
      if (order.paymentStatus === "authorized" || order.paymentStatus === "paid") {
        response.status(409).json({
          error: "el pedido ya tiene una retención activa o está cobrado",
          paymentStatus: order.paymentStatus,
          paymentIntentId: order.stripePaymentIntentId,
        });
        return;
      }
      const amountCents = authorizationAmountCents(order);
      // ?dry=1 resuelve el pedido y devuelve el importe sin crear ninguna retención.
      if (request.query.dry === "1") {
        response.json({
          ok: true,
          orderId,
          reference,
          amountCents,
          paymentStatus: order.paymentStatus,
          paymentMethod: order.paymentMethod,
        });
        return;
      }
      if (amountCents <= 0) {
        response.status(409).json({ error: "el pedido no tiene importe que retener" });
        return;
      }
      try {
        const result = await authorizeCodOrder({
          orderId,
          amountCents,
          paymentMethodId: parsed.data.paymentMethodId ?? null,
          customerId: parsed.data.customerId ?? null,
          email: parsed.data.email ?? null,
        });
        order.set({
          stripePaymentIntentId: result.paymentIntentId,
          paymentStatus: result.status === "requires_capture" ? "authorized" : "pending",
          paymentAuthorizedAt: result.status === "requires_capture" ? new Date() : null,
          paymentAuthorizationExpiresAt: authorizationExpiry(),
          paymentHoldCents: amountCents,
        });
        await order.save();
        response.status(201).json({
          paymentIntentId: result.paymentIntentId,
          clientSecret: result.clientSecret,
          requiresAction: result.requiresAction,
          amountCents,
          expiresAt: result.expiresAt.toISOString(),
        });
      } catch (error) {
        response.status(502).json({ error: (error as Error).message });
      }
    },
  );

  // El rider no pudo cobrar: se captura la retención.
  app.post(
    "/api/v1/admin/orders/:id/cod-capture",
    requireRole("admin", "finance", "fleet"),
    async (request: Request, response: Response) => {
      const reference = String(request.params.id ?? "").trim();
      if (!reference) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const order = await findOrderByReference(reference);
      if (!order || !order.stripePaymentIntentId) {
        const hold = await CodHold.findOne({ reference: normalizeReference(reference), status: "authorized" });
        if (!hold) {
          response.status(404).json({ error: "pedido sin retención" });
          return;
        }
        try {
          const result = await captureCodOrder(hold.paymentIntentId, (request.body ?? {}).amountCents ?? undefined);
          hold.set({ status: "captured", capturedCents: result.capturedCents, resolvedAt: new Date() });
          await hold.save();
          response.json({ status: result.status, capturedCents: result.capturedCents });
        } catch (error) {
          response.status(502).json({ error: (error as Error).message });
        }
        return;
      }
      const partial = Number((request.body ?? {}).amountCents);
      try {
        const result = await captureCodOrder(
          order.stripePaymentIntentId,
          Number.isFinite(partial) && partial > 0 ? partial : undefined,
        );
        order.set({
          paymentStatus: "paid",
          paymentCapturedAt: new Date(),
          paymentCapturedCents: result.capturedCents,
        });
        await order.save();
        response.json({ status: result.status, capturedCents: result.capturedCents });
      } catch (error) {
        response.status(502).json({ error: (error as Error).message });
      }
    },
  );

  // Cobró en efectivo: se libera la retención y el cliente no ve ningún cargo.
  app.post(
    "/api/v1/admin/orders/:id/cod-release",
    requireRole("admin", "finance", "fleet"),
    async (request: Request, response: Response) => {
      const reference = String(request.params.id ?? "").trim();
      if (!reference) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const order = await findOrderByReference(reference);
      const reasonInput = String((request.body ?? {}).reason ?? "paid_in_cash");
      if (!order || !order.stripePaymentIntentId) {
        const hold = await CodHold.findOne({ reference: normalizeReference(reference), status: "authorized" });
        if (!hold) {
          response.status(404).json({ error: "pedido sin retención" });
          return;
        }
        try {
          const result = await releaseCodOrder(hold.paymentIntentId, reasonInput);
          hold.set({ status: "released", resolvedAt: new Date(), reason: reasonInput });
          await hold.save();
          response.json({ status: result.status });
        } catch (error) {
          response.status(502).json({ error: (error as Error).message });
        }
        return;
      }
      const reason = String((request.body ?? {}).reason ?? "paid_in_cash");
      try {
        const result = await releaseCodOrder(order.stripePaymentIntentId, reason);
        order.set({
          paymentStatus: "expired",
          paymentReleasedAt: new Date(),
          paymentReleaseReason: reason,
        });
        await order.save();
        response.json({ status: result.status });
      } catch (error) {
        response.status(502).json({ error: (error as Error).message });
      }
    },
  );

  // Barrido: libera lo que va a caducar. Simulación por defecto, ?apply=1 ejecuta.
  app.post(
    "/api/v1/admin/cod-sweep",
    requireRole("admin", "finance"),
    async (request: Request, response: Response) => {
      const apply = request.query.apply === "1" || request.body?.apply === true;
      try {
        const result = await sweepExpiringCodAuthorizations(new Date(), { apply });
        response.json({ apply, ...result });
      } catch (error) {
        response.status(502).json({ error: (error as Error).message });
      }
    },
  );
}
