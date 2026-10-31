import { z } from "zod";
import { VEHICLE_CATALOG_VERSION, vehicleTypeSchema } from "../vehicleCatalog.js";
const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const ring = z.array(point).min(4).max(20000).refine((points) => points[0][0] === points[points.length - 1][0] && points[0][1] === points[points.length - 1][1], "UNCLOSED_RING");
const polygon = z.array(ring).min(1).max(1000);
export const zoneGeometryInput = z.union([
  z.object({ type: z.literal("Polygon").default("Polygon"), coordinates: polygon }),
  z.object({ type: z.literal("MultiPolygon"), coordinates: z.array(polygon).min(1).max(1000) }),
]);
export const operationalZoneInputSchema = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  isActive: z.boolean().default(true),
  serviceFeeCents: z.number().int().min(0).max(10000).default(0),
  maxEtaMinutes: z.number().int().min(1).max(240).default(60),
  allowedVehicleTypes: z.array(vehicleTypeSchema).min(1).max(6).default([...vehicleTypeSchema.options]),
  vehicleCatalogVersion: z.number().int().min(1).default(VEHICLE_CATALOG_VERSION),
  polygon: zoneGeometryInput,
});
