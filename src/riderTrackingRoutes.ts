/**
 * Rutas de seguimiento en vivo.
 *
 *  POST /api/v1/orders/:publicCode/location   el rider emite su posición
 *  GET  /api/v1/orders/:publicCode/location   cliente, flota y soporte la leen
 *
 * El rider solo puede escribir sobre un pedido que tiene asignado. La lectura
 * se limita a quien tiene sesión de cliente sobre ese pedido, o a los equipos
 * de flota, soporte y administración.
 */

import type { Express, Request, Response } from "express";
import mongoose from "mongoose";
import { Order } from "./models.js";
import { requireRole } from "./auth.js";
import { presentForCustomer, sanitizePing, isFresh } from "./riderLocation.js";
import { ensureLocationIndexes, readPing, savePing, riderOwnsOrder, type LocationCollection } from "./riderLocationStore.js";

function collection(): LocationCollection {
  return mongoose.connection.collection("rider_locations") as unknown as LocationCollection;
}

function destinationOf(order: any): { latitude: number; longitude: number } | null {
  const raw = order?.deliveryLocation;
  const lat = Number(raw?.latitude ?? raw?.lat ?? raw?.coordinates?.[1]);
  const lng = Number(raw?.longitude ?? raw?.lng ?? raw?.coordinates?.[0]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { latitude: lat, longitude: lng };
}

export function mountRiderTracking(app: Express): void {
  app.post("/api/v1/orders/:publicCode/location", requireRole("rider"), async (request: Request, response: Response) => {
    const order = await Order.findOne({ publicCode: String(request.params.publicCode) }).select("publicCode riderId").lean().exec() as any;
    if (!order) return response.status(404).json({ error: "ORDER_NOT_FOUND" });
    const primerPing = await readPing(collection(), order.publicCode);
    if (!riderOwnsOrder(primerPing, String(request.auth?.employeeId || ""))) {
      return response.status(403).json({ error: "RIDER_NOT_ASSIGNED" });
    }
    const parsed = sanitizePing({
      orderId: order.publicCode,
      riderId: String(request.auth?.employeeId || ""),
      latitude: request.body?.latitude,
      longitude: request.body?.longitude,
      accuracyMeters: request.body?.accuracyMeters,
      headingDegrees: request.body?.headingDegrees,
      speedMps: request.body?.speedMps,
    });
    if (!parsed.ok) return response.status(400).json({ error: "INVALID_LOCATION", reason: parsed.reason });
    await savePing(collection(), parsed.ping);
    return response.json({ ok: true, at: parsed.ping.at.toISOString() });
  });

  app.get(
    "/api/v1/orders/:publicCode/location",
    requireRole("rider", "fleet", "support", "admin"),
    async (request: Request, response: Response) => {
      const order = await Order.findOne({ publicCode: String(request.params.publicCode) })
        .select("publicCode riderId deliveryLocation status")
        .lean()
        .exec() as any;
      if (!order) return response.status(404).json({ error: "ORDER_NOT_FOUND" });
      const ping = await readPing(collection(), order.publicCode);
      const destino = destinationOf(order);
      const vista = destino ? presentForCustomer(ping as any, destino) : { visible: false as const, status: "sin_senal" as const };
      return response.json({
        orderId: order.publicCode,
        orderStatus: order.status,
        rider: ping && isFresh(ping.at)
          ? { latitude: ping.latitude, longitude: ping.longitude, headingDegrees: ping.headingDegrees, at: ping.at }
          : null,
        ...vista,
      });
    }
  );
}

export async function ensureTrackingIndexes(): Promise<void> {
  try {
    await ensureLocationIndexes(collection());
  } catch {
    // Si la base aún no está lista, el primer ping creará el documento igualmente.
  }
}
