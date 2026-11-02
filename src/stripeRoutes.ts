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

const authorizeSchema = z.object({
  paymentMethodId: z.string().min(3).optional(),
  customerId: z.string().min(3).optional(),
  email: z.string().email().optional(),
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
  app.post(
    "/api/v1/orders/:id/cod-authorization",
    requireRole("admin", "fleet", "support"),
    async (request: Request, response: Response) => {
      const orderId = orderIdFrom(request);
      if (!orderId) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const parsed = authorizeSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        response.status(400).json({ error: "datos inválidos", detail: parsed.error.issues });
        return;
      }
      const order = await Order.findById(orderId);
      if (!order) {
        response.status(404).json({ error: "pedido no encontrado" });
        return;
      }
      if (order.paymentMethod !== "cash") {
        response.status(409).json({ error: "el pedido no es contra­rreembolso" });
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
      const orderId = orderIdFrom(request);
      if (!orderId) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const order = await Order.findById(orderId);
      if (!order || !order.stripePaymentIntentId) {
        response.status(404).json({ error: "pedido sin retención" });
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
      const orderId = orderIdFrom(request);
      if (!orderId) {
        response.status(400).json({ error: "pedido inválido" });
        return;
      }
      const order = await Order.findById(orderId);
      if (!order || !order.stripePaymentIntentId) {
        response.status(404).json({ error: "pedido sin retención" });
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
