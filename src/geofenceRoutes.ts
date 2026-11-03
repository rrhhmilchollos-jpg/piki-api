import type { Express, Request } from "express";
import { z } from "zod";
import { requireRole } from "./auth.js";
import { Order, Rider, Zone } from "./models.js";
import { publishRealtimeEvent } from "./realtime.js";
import { distanceToGeometryMeters, mergeGeometries, pointInGeometry, type GeoGeometry } from "./geofence.js";

/** Avisos seguidos dentro de la ventana antes de suspender al rider. */
export const GEOFENCE_STRIKE_LIMIT = 3;
export const GEOFENCE_STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Minutos que un rider puede estar fuera de zona sin que cuente como aviso. */
export const GEOFENCE_GRACE_MINUTES = 5;

const ACTIVE_ORDER_STATUSES = ["assigned", "accepted", "heading_to_partner", "at_partner", "picked_up", "on_the_way", "arrived"];

type ZoneDoc = { slug: string; name: string; polygon?: GeoGeometry | null };

/** Zonas que cubren al rider: su slug asignado o, si no tiene, toda su ciudad. */
export async function riderZones(rider: { zoneSlug?: string | null; city?: string | null }): Promise<ZoneDoc[]> {
  const zones = await Zone.find({ isActive: true }).select("slug name polygon").lean().exec() as unknown as ZoneDoc[];
  const normalise = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const citySlug = normalise(String(rider.city ?? "")).trim().replace(/\s+/g, "-");
  const assigned = rider.zoneSlug ? normalise(rider.zoneSlug) : "";
  // La geocerca es el municipio completo: si el rider está asignado a una zona
  // de su ciudad, reparte en todas las zonas de esa ciudad (centro, barrios y
  // pedanías), no solo en el polígono de su zona operativa.
  const municipality = assigned && citySlug && assigned.startsWith(citySlug) ? citySlug : null;
  const prefix = municipality ?? citySlug;
  if (prefix) {
    const byCity = zones.filter((zone) => normalise(zone.slug) === prefix || normalise(zone.slug).startsWith(`${prefix}-`));
    if (byCity.length) return byCity;
  }
  if (rider.zoneSlug) {
    const exact = zones.filter((zone) => zone.slug === rider.zoneSlug);
    if (exact.length) return exact;
  }
  return [];
}

export async function riderDeliveryGeometry(rider: { zoneSlug?: string | null; city?: string | null }): Promise<GeoGeometry | null> {
  const zones = await riderZones(rider);
  return mergeGeometries(zones.map((zone) => (zone.polygon ?? null) as GeoGeometry | null));
}

async function hasActiveDelivery(riderId: unknown): Promise<boolean> {
  const order = await Order.exists({ riderId, status: { $in: ACTIVE_ORDER_STATUSES } });
  return Boolean(order);
}

function riderIdFrom(req: Request): string | null {
  const raw = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  return /^[a-f\d]{24}$/.test(String(raw)) ? String(raw) : null;
}

export function mountGeofenceRoutes(app: Express): void {
  // Polígono de reparto del rider, para pintarlo y compararlo en la app.
  app.get("/api/v1/riders/:id/delivery-zone", requireRole("admin", "fleet", "rider"), async (req, res) => {
    const riderId = riderIdFrom(req);
    if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
    const rider = await Rider.findById(riderId).select("zoneSlug city name").lean().exec() as any;
    if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
    const zones = await riderZones(rider);
    const geometry = mergeGeometries(zones.map((zone) => (zone.polygon ?? null) as GeoGeometry | null));
    return res.json({
      riderId,
      city: rider.city ?? null,
      zoneSlug: rider.zoneSlug ?? null,
      zoneNames: zones.map((zone) => zone.name),
      geometry,
      strikeLimit: GEOFENCE_STRIKE_LIMIT,
      graceMinutes: GEOFENCE_GRACE_MINUTES,
    });
  });

  // Comprobación autoritativa: el servidor decide si está dentro y si toca aviso.
  app.post("/api/v1/riders/:id/geofence-check", requireRole("admin", "fleet", "rider"), async (req, res) => {
    const riderId = riderIdFrom(req);
    if (!riderId) return res.status(400).json({ error: "INVALID_RIDER_ID" });
    const parsed = z.object({
      latitude: z.coerce.number().min(-90).max(90),
      longitude: z.coerce.number().min(-180).max(180),
      accuracy: z.coerce.number().min(0).max(100000).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "INVALID_POSITION" });
    const rider = await Rider.findById(riderId).lean().exec() as any;
    if (!rider) return res.status(404).json({ error: "RIDER_NOT_FOUND" });
    const zones = await riderZones(rider);
    const geometry = mergeGeometries(zones.map((zone) => (zone.polygon ?? null) as GeoGeometry | null));
    if (!geometry) {
      return res.json({ inside: true, geometry: null, action: "none", message: "Sin geocerca configurada para este rider.", strikes: rider.geofenceStrikes ?? 0 });
    }
    const inside = pointInGeometry(parsed.data.latitude, parsed.data.longitude, geometry);
    const distance = inside ? 0 : Math.round(distanceToGeometryMeters(parsed.data.latitude, parsed.data.longitude, geometry));
    const delivering = await hasActiveDelivery(rider._id);

    if (inside) {
      await Rider.updateOne(
        { _id: rider._id },
        { $set: { geofenceStrikes: 0, geofenceZoneSlug: rider.zoneSlug ?? null, geofenceOutside: false, geofenceCheckedAt: new Date(), geofenceDistanceMeters: 0 } },
      ).exec();
      return res.json({ inside: true, distanceMeters: 0, delivering, action: "none", strikes: 0, message: "Dentro de tu zona de reparto." });
    }
    if (delivering) {
      return res.json({
        inside: false,
        distanceMeters: distance,
        delivering,
        action: "exception",
        strikes: rider.geofenceStrikes ?? 0,
        message: "Estás fuera de la geocerca, pero llevas un pedido en curso: no cuenta como aviso.",
      });
    }

    const now = Date.now();
    const lastAt = rider.lastGeofenceViolationAt ? new Date(rider.lastGeofenceViolationAt).getTime() : 0;
    const withinWindow = lastAt > 0 && now - lastAt < GEOFENCE_STRIKE_WINDOW_MS;
    const strikes = (withinWindow ? (rider.geofenceStrikes ?? 0) : 0) + 1;
    const patch: Record<string, unknown> = {
      geofenceStrikes: strikes,
      lastGeofenceViolationAt: new Date(),
      geofenceZoneSlug: rider.zoneSlug ?? null,
      geofenceDistanceMeters: distance,
      geofenceOutside: true,
      geofenceCheckedAt: new Date(),
    };
    let action: "warn" | "sanction" = strikes >= GEOFENCE_STRIKE_LIMIT ? "sanction" : "warn";
    if (action === "sanction") {
      patch.lifecycleStatus = "suspended";
      patch.lifecycleReason = `Fuera de zona ${strikes} veces en 24 h (${distance} m de la geocerca)`;
      patch.lifecycleChangedAt = new Date();
      patch.status = "offline";
    }
    await Rider.updateOne({ _id: rider._id }, { $set: patch }).exec();

    const tenantId = rider.tenantId ?? null;
    const payload = {
      riderId,
      riderName: rider.name,
      riderCode: rider.riderCode,
      distanceMeters: distance,
      strikes,
      action,
      latitude: parsed.data.latitude,
      longitude: parsed.data.longitude,
    };
    await Promise.allSettled([
      publishRealtimeEvent({ channel: "fleet", audienceKey: "fleet", type: "geofence.rider_outside", payload, tenantId }),
      publishRealtimeEvent({ channel: "admin", audienceKey: "admin", type: "geofence.rider_outside", payload, tenantId }),
    ]);

    return res.json({
      inside: false,
      distanceMeters: distance,
      delivering,
      action,
      strikes,
      strikeLimit: GEOFENCE_STRIKE_LIMIT,
      message: action === "sanction"
        ? "Te has salido de la zona de reparto varias veces: la cuenta queda suspendida hasta que la flota lo revise."
        : "Estás fuera de la zona de reparto. Vuelve a la zona para poder recibir pedidos.",
    });
  });

  // Sincroniza la geocerca de todos los riders desde las zonas activas.
  app.post("/api/v1/admin/maintenance/riders/geofence-sync", requireRole("admin"), async (req, res) => {
    const parsed = z.object({ apply: z.coerce.boolean().default(false), city: z.string().trim().optional() }).safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: "INVALID_INPUT" });
    const riders = await Rider.find(parsed.data.city ? { city: new RegExp(`^${parsed.data.city}$`, "i") } : {}).select("name riderCode city zoneSlug").lean().exec() as any[];
    const report: Array<{ rider: string; zones: string[]; inside: boolean | null; error?: string }> = [];
    for (const rider of riders) {
      const zones = await riderZones(rider);
      const geometry = mergeGeometries(zones.map((zone) => (zone.polygon ?? null) as GeoGeometry | null));
      if (!geometry) {
        report.push({ rider: rider.name, zones: [], inside: null, error: "SIN_GEOCERCA" });
        continue;
      }
      if (parsed.data.apply) {
        await Rider.updateOne(
          { _id: rider._id },
          { $set: { geofence: { type: geometry.type, coordinates: geometry.coordinates }, geofenceZoneSlug: rider.zoneSlug ?? null, geofenceSyncedAt: new Date() } },
        ).exec();
      }
      const point = rider.lastLocation?.coordinates;
      const inside = Array.isArray(point) ? pointInGeometry(point[1], point[0], geometry) : null;
      report.push({ rider: rider.name, zones: zones.map((zone) => zone.slug), inside });
    }
    return res.json({ apply: parsed.data.apply, riders: report });
  });
}
