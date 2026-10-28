import mongoose from "mongoose";
import type { Express } from "express";
import { z } from "zod";
import { requireOwner } from "../auth.js";
import { Zone } from "../models.js";
import { MunicipalExpansion } from "../expansionModels.js";
import { OPERATIONAL_AREAS } from "./operationalAreas.js";
import { zoneGeometryInput } from "./zoneInput.js";

export function registerTerritoryRoutes(app: Express) {
  app.get("/api/v1/admin/coverage/operational-areas", requireOwner(), (_req, res) => {
    return res.json({ policyVersion: 3, areas: OPERATIONAL_AREAS });
  });
  app.post("/api/v1/admin/coverage/activate-costera", requireOwner(), async (req, res) => {
    const body = z.object({ confirmation: z.literal("ACTIVATE_COSTERA_20261028"), policyVersion: z.literal(3) }).strict().safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "EXPLICIT_TERRITORY_ACTIVATION_REQUIRED" });
    if (!req.auth?.tenantId || !mongoose.isValidObjectId(req.auth.tenantId)) return res.status(403).json({ error: "TENANT_CONTEXT_REQUIRED" });
    const tenantId = new mongoose.Types.ObjectId(req.auth.tenantId);
    const actorEmployeeId = new mongoose.Types.ObjectId(req.auth.employeeId);
    try {
      const result = await mongoose.connection.transaction(async (session) => {
        const zones: Array<{ slug: string; name: string }> = [];
        for (const area of OPERATIONAL_AREAS) {
          const polygon = zoneGeometryInput.parse(area.geometry);
          const name = `Zona ${area.name}`;
          await Zone.findOneAndUpdate({ tenantId, slug: area.slug }, { $set: { tenantId, slug: area.slug, name, polygon, isActive: true, serviceFeeCents: 79, maxEtaMinutes: 60 } }, { new: true, upsert: true, session, runValidators: true }).exec();
          const municipalityKey = area.name === "Xàtiva" ? "xativa" : area.slug;
          await MunicipalExpansion.findOneAndUpdate({ tenantId, municipalityKey }, { $set: { municipalityName: area.name, phase: 1, phaseLabel: "Operativa · ampliación Costera", status: "active", zoneSlug: area.slug, activatedAt: new Date(), activatedBy: actorEmployeeId, notes: area.coverage === "full" ? "Geocerca municipal verificada; apertura autorizada por RRHH." : "Cobertura parcial: radio operativo de 3 km, recortado al término municipal de pertenencia; verificar siempre coordenadas." } }, { upsert: true, new: true, session, runValidators: true }).exec();
          zones.push({ slug: area.slug, name });
        }
        await mongoose.connection.db!.collection("governance_audit_events").insertOne({ tenantId, action: "costera_operational_areas_activated", actorEmployeeId, actorRole: "admin", targetType: "coverage", targetId: "costera-20261028", reason: "Apertura de localidades solicitada explícitamente por RRHH.", before: null, after: { policyVersion: 3, zones }, createdAt: new Date(), updatedAt: new Date() }, { session });
        return zones;
      });
      return res.json({ activated: true, policyVersion: 3, zones: result, count: result.length, employeeAssignmentsChanged: false, restaurantsChanged: false });
    } catch {
      return res.status(503).json({ error: "ATOMIC_TERRITORY_ACTIVATION_UNAVAILABLE", activated: false });
    }
  });
}
