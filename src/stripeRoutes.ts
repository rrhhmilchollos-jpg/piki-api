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
import { EmployeeAccount, Order, Rider } from "./models.js";
import { CodHold, codHoldLiability, normalizeReference } from "./codHolds.js";
import { findOrderByReference } from "./orderReferences.js";
import { listCodHoldSweepRuns, listOpenCodHolds, runCodHoldSweep } from "./codHoldSweep.js";
import { codHoldSweepWorkerStatus } from "./codHoldSweepWorker.js";
import {
  authorizationAmountCents,
  authorizationExpiry,
  authorizeCodOrder,
  captureCodOrder,
  handleStripeEvent,
  releaseCodOrder,
  retrieveAuthorization,
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


/**
 * El rider que entrega es quien cobra o libera en la puerta. Puede hacerlo con
 * su propia sesión, pero solo sobre el pedido que tiene asignado: sin esta
 * comprobación cualquier rider podría capturar la garantía de otro.
 */
async function riderOwnsOrder(request: Request, order: { riderId?: unknown } | null) {
  if (request.auth?.role !== "rider") return true;
  const employeeId = request.auth?.employeeId;
  if (!employeeId || !order?.riderId) return false;
  const employee = await EmployeeAccount.findById(employeeId).select("email").lean().exec() as { email?: string } | null;
  if (!employee?.email) return false;
  return Boolean(await Rider.exists({ _id: order.riderId, email: employee.email }));
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
          // Si la referencia ya tuvo una retención resuelta (liberada, caducada
          // o fallida), se reutiliza el registro: el índice es único y crear
          // otro dejaría al cliente sin garantía por un duplicado.
          await CodHold.findOneAndUpdate(
            { reference: normalized },
            {
              $set: {
                amountCents: declared,
                status: "authorized",
                paymentIntentId: created.paymentIntentId,
                clientSecret: created.clientSecret,
                expiresAt: created.expiresAt,
                capturedCents: null,
                resolvedAt: null,
                reason: null,
                stripeStatus: created.status,
                sweepClaimedUntil: null,
                lastSweepAt: null,
                lastSweepReason: null,
              },
              $setOnInsert: { reference: normalized },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true },
          );
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
      if (order.paymentState === "authorized" || order.paymentState === "paid") {
        response.status(409).json({
          error: "el pedido ya tiene una retención activa o está cobrado",
          paymentState: order.paymentState,
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
          paymentState: order.paymentState,
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
          paymentState: result.status === "requires_capture" ? "authorized" : "pending",
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
    requireRole("admin", "finance", "fleet", "rider"),
    async (request: Request, response: Response) => {
      const reference = String(request.params.id ?? "").trim();
      if (!reference) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const order = await findOrderByReference(reference);
      if (request.auth?.role === "rider" && !(await riderOwnsOrder(request, order))) {
        response.status(403).json({ error: "este pedido no está asignado a tu rider" });
        return;
      }
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
          paymentState: "paid",
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
    requireRole("admin", "finance", "fleet", "rider"),
    async (request: Request, response: Response) => {
      const reference = String(request.params.id ?? "").trim();
      if (!reference) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const order = await findOrderByReference(reference);
      const reasonInput = String((request.body ?? {}).reason ?? "paid_in_cash");
      if (request.auth?.role === "rider" && !(await riderOwnsOrder(request, order))) {
        response.status(403).json({ error: "este pedido no está asignado a tu rider" });
        return;
      }
      if (!order || !order.stripePaymentIntentId) {
        const hold = await CodHold.findOne({ reference: normalizeReference(reference), status: "authorized" });
        if (!hold) {
          response.status(404).json({ error: "pedido sin retención" });
          return;
        }
        try {
          const result = await releaseCodOrder(hold.paymentIntentId, reasonInput);
          hold.set({
            status: "released",
            resolvedAt: new Date(),
            reason: reasonInput,
            lastSweepReason: reasonInput,
            stripeStatus: "canceled",
          });
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
        // Si cobró en efectivo, el pedido está cobrado: ponerlo como caducado
        // dejaría la caja descuadrada justo en el caso normal.
        const paidInCash = Boolean(order.cashCollectedAt) || reason === "paid_in_cash";
        order.set({
          paymentState: paidInCash ? "paid" : "expired",
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
  //
  // Hace las dos cosas: las retenciones colgadas del pedido y las que solo
  // existen por referencia (`CodHold`). Las segundas son las que se quedaban
  // huérfanas, porque nada las miraba.
  app.post(
    "/api/v1/admin/cod-sweep",
    requireRole("admin", "finance"),
    async (request: Request, response: Response) => {
      const apply = request.query.apply === "1" || request.body?.apply === true;
      const actorId = request.auth?.employeeId ?? null;
      try {
        const [orders, holds] = await Promise.all([
          sweepExpiringCodAuthorizations(new Date(), { apply }),
          runCodHoldSweep({ apply, source: "manual", actorId }),
        ]);
        response.json({
          apply,
          // Campos de siempre (retenciones ligadas a un pedido).
          inspected: orders.inspected,
          released: orders.released,
          failed: orders.failed,
          errors: [...orders.errors, ...holds.errors],
          // Garantías por referencia.
          holds,
        });
      } catch (error) {
        response.status(502).json({ error: (error as Error).message });
      }
    },
  );

  // Estado del barrido automático: si el worker está vivo y qué hizo la última vez.
  app.get(
    "/api/v1/admin/cod-sweep/status",
    requireRole("admin", "finance", "fleet"),
    async (_request: Request, response: Response) => {
      const [liability, runs] = await Promise.all([codHoldLiability(), listCodHoldSweepRuns(1)]);
      response.json({
        worker: codHoldSweepWorkerStatus(),
        stripeConfigured: stripeConfigured(),
        liability,
        lastRun: runs[0] ?? null,
      });
    },
  );

  // Historial de pasadas, para auditar qué se liberó y cuándo.
  app.get(
    "/api/v1/admin/cod-sweep/runs",
    requireRole("admin", "finance", "fleet"),
    async (request: Request, response: Response) => {
      const limit = Math.max(1, Math.min(100, Number(request.query.limit ?? 10) || 10));
      response.json({ runs: await listCodHoldSweepRuns(limit) });
    },
  );

  // Garantías vivas con su antigüedad: la lista que contabilidad revisa.
  app.get(
    "/api/v1/admin/cod-holds",
    requireRole("admin", "finance", "fleet"),
    async (request: Request, response: Response) => {
      const limit = Math.max(1, Math.min(200, Number(request.query.limit ?? 50) || 50));
      response.json({ holds: await listOpenCodHolds(limit) });
    },
  );

  app.get(
    "/api/v1/admin/cod-holds/summary",
    requireRole("admin", "finance", "fleet"),
    async (_request: Request, response: Response) => {
      response.json(await codHoldLiability());
    },
  );

  // Auditoría de un pedido concreto: qué se retuvo, qué se cobró y en qué
  // estado está el pago en el banco. Solo lectura y solo con el token de
  // plataforma, para poder responder «¿esto es una retención o un cargo?».
  app.get(
    "/api/v1/admin/payment-audit/:reference",
    requireRole("admin"),
    async (request: Request, response: Response) => {
      const reference = String(request.params.reference || "").trim();
      if (!reference) return response.status(400).json({ error: "REFERENCE_REQUIRED" });
      const order = await findOrderByReference(reference);
      const hold = await CodHold.findOne({
        $or: [
          ...(order?.orderId ? [{ orderId: new mongoose.Types.ObjectId(String(order.orderId)) }] : []),
          { reference: normalizeReference(reference) },
        ],
      })
        .sort({ createdAt: -1 })
        .lean()
        .exec() as Record<string, any> | null;
      const paymentIntentId = String(hold?.paymentIntentId || (order as any)?.stripePaymentIntentId || "");
      let bank: Record<string, unknown> | null = null;
      if (paymentIntentId && stripeConfigured()) {
        try {
          const snapshot = await retrieveAuthorization(paymentIntentId);
          bank = {
            paymentIntentId,
            status: snapshot.status,
            amountCents: snapshot.amountCents,
            capturedCents: snapshot.capturedCents,
          };
        } catch (error) {
          bank = { paymentIntentId, error: error instanceof Error ? error.message : String(error) };
        }
      }
      response.json({
        reference,
        order: order
          ? {
              orderId: order.orderId,
              publicCode: order.publicCode || order.reference,
              status: order.status,
              paymentMethod: (order as any).paymentMethod ?? null,
              paymentState: order.paymentState,
              totalCents: (order as any).totalCents ?? null,
              paymentCapturedCents: (order as any).paymentCapturedCents ?? null,
              paymentCapturedAt: (order as any).paymentCapturedAt ?? null,
              cashCollectedAt: order.cashCollectedAt,
              deliveredAt: order.deliveredAt,
              createdAt: order.createdAt,
              riderId: (order as any).riderId ? String((order as any).riderId) : null,
            }
          : null,
        codHold: hold
          ? {
              reference: hold.reference,
              status: hold.status,
              amountCents: hold.amountCents,
              paymentIntentId: hold.paymentIntentId,
              createdAt: hold.createdAt,
              expiresAt: hold.expiresAt,
              resolvedAt: hold.resolvedAt ?? null,
              resolutionReason: hold.resolutionReason ?? null,
            }
          : null,
        bank,
        verdict: !hold
          ? order
            ? "pedido_sin_garantia"
            : "sin_pedido_ni_garantia"
          : hold.status === "captured"
            ? "garantia_cobrada"
            : hold.status === "authorized"
              ? "retencion_viva"
              : `garantia_${hold.status}`,
      });
    },
  );
}
