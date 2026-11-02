/**
 * Rutas de jornada del rider.
 *
 *  - Contrato y tramos que fija la flota (pantalla en Fleet).
 *  - Corte manual de jornada desde Fleet.
 *  - Barrido de jornada: simulación por defecto, `?apply=1` para ejecutar.
 *  - Histórico de barridos para poder auditar qué pasó y cuándo.
 */

import type { Express, Request, Response } from "express";
import mongoose from "mongoose";
import { z } from "zod";
import { EmployeeAccount, Rider } from "./models.js";
import { requireRole } from "./auth.js";
import { buildFleetEntityScope, buildTenantScope } from "./tenantScope.js";
import {
  buildShiftSnapshot,
  cutRiderShift,
  deleteShiftPlan,
  runShiftSweep,
  saveShiftPlan,
  ShiftSweepRun,
} from "./shiftPlans.js";
import { shiftSweepWorkerStatus } from "./shiftSweepWorker.js";

const shiftPlanSchema = z
  .object({
    weeklyHours: z.number().int(),
    shifts: z
      .array(
        z
          .object({
            weekday: z.number().int().min(0).max(6),
            start: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
            end: z.string().trim().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          })
          .strict(),
      )
      .min(1)
      .max(21),
  })
  .strict();

function riderIdParam(request: Request): mongoose.Types.ObjectId | null {
  const raw = Array.isArray(request.params.id) ? request.params.id[0] : request.params.id;
  return mongoose.isValidObjectId(raw) ? new mongoose.Types.ObjectId(raw) : null;
}

async function employeeScope(request: Request) {
  if (!request.auth?.employeeId) return null;
  return (await EmployeeAccount.findOne({ _id: request.auth.employeeId, ...buildTenantScope(request.auth.tenantId) })
    .select("email fleetId")
    .lean()
    .exec()) as any;
}

/**
 * Un rider solo se toca desde su tenant; Fleet, además, solo desde su propia
 * flota. La sesión es la única fuente del alcance.
 */
async function riderScope(request: Request, riderId: mongoose.Types.ObjectId) {
  const tenant = buildTenantScope(request.auth?.tenantId);
  if (request.auth?.role === "rider") {
    const employee = await employeeScope(request);
    return employee?.email ? { _id: riderId, email: employee.email, ...tenant } : { _id: null };
  }
  if (request.auth?.role === "fleet") {
    const employee = await employeeScope(request);
    return { _id: riderId, ...tenant, ...buildFleetEntityScope({ tenantId: request.auth?.tenantId, role: request.auth?.role, fleetId: employee?.fleetId }) };
  }
  return { _id: riderId, ...tenant };
}

export function mountShiftRoutes(app: Express): void {
  /** Contrato y estado de jornada del rider. */
  app.get("/api/v1/riders/:id/shift-plan", requireRole("admin", "fleet", "rider"), async (request: Request, response: Response) => {
    const riderId = riderIdParam(request);
    if (!riderId) return response.status(400).json({ error: "INVALID_RIDER_ID" });
    const rider = (await Rider.findOne(await riderScope(request, riderId)).select("_id name email status fleetId").lean().exec()) as any;
    if (!rider) return response.status(403).json({ error: "RIDER_ACCESS_DENIED" });
    const snapshot = await buildShiftSnapshot(String(riderId));
    return response.json({ rider: { id: String(rider._id), name: rider.name, email: rider.email, status: rider.status }, shift: snapshot, contractHours: [10, 20, 30, 40] });
  });

  /** Guarda el contrato y los tramos. El exceso sobre las horas firmadas se rechaza. */
  app.put("/api/v1/riders/:id/shift-plan", requireRole("admin", "fleet"), async (request: Request, response: Response) => {
    const riderId = riderIdParam(request);
    if (!riderId) return response.status(400).json({ error: "INVALID_RIDER_ID" });
    const parsed = shiftPlanSchema.safeParse(request.body);
    if (!parsed.success) return response.status(400).json({ error: "INVALID_SHIFT_PLAN", details: parsed.error.flatten() });
    const rider = (await Rider.findOne(await riderScope(request, riderId)).select("_id name email tenantId").lean().exec()) as any;
    if (!rider) return response.status(403).json({ error: "RIDER_ACCESS_DENIED" });
    const result = await saveShiftPlan({
      riderId: String(riderId),
      tenantId: rider.tenantId ? String(rider.tenantId) : request.auth?.tenantId ?? null,
      weeklyHours: parsed.data.weeklyHours,
      shifts: parsed.data.shifts,
      updatedBy: request.auth?.employeeId ?? null,
    });
    if (!result.ok) return response.status(422).json({ error: result.error, message: result.message });
    const snapshot = await buildShiftSnapshot(String(riderId));
    return response.json({
      message: `Contrato de ${snapshot.weeklyHours} h guardado con ${parsed.data.shifts.length} tramo(s).`,
      shift: snapshot,
    });
  });

  /** Retira el contrato: el rider deja de estar sujeto a tramos y horas. */
  app.delete("/api/v1/riders/:id/shift-plan", requireRole("admin", "fleet"), async (request: Request, response: Response) => {
    const riderId = riderIdParam(request);
    if (!riderId) return response.status(400).json({ error: "INVALID_RIDER_ID" });
    const rider = await Rider.findOne(await riderScope(request, riderId)).select("_id").lean().exec();
    if (!rider) return response.status(403).json({ error: "RIDER_ACCESS_DENIED" });
    const removed = await deleteShiftPlan(String(riderId));
    return response.json({ removed, message: removed ? "Contrato de jornada retirado." : "El rider no tenía contrato guardado." });
  });

  /** Corte inmediato desde Fleet (fin de jornada, sanción, incidencia). */
  app.post("/api/v1/riders/:id/shift-plan/cut", requireRole("admin", "fleet"), async (request: Request, response: Response) => {
    const riderId = riderIdParam(request);
    if (!riderId) return response.status(400).json({ error: "INVALID_RIDER_ID" });
    const rider = await Rider.findOne(await riderScope(request, riderId)).select("_id").lean().exec();
    if (!rider) return response.status(403).json({ error: "RIDER_ACCESS_DENIED" });
    const reason = String((request.body as any)?.reason || "manual").slice(0, 120);
    const cut = await cutRiderShift({ riderId: String(riderId), reason });
    const swept = await runShiftSweep({ apply: true, source: "manual", actorId: request.auth?.employeeId ?? null });
    return response.json({
      message: cut
        ? `Jornada cortada. Sesión revocada en ${cut.sessionsRevoked} cuenta(s) y ${cut.slotsClosed} turno(s) cerrados.`
        : "No se pudo cortar la jornada del rider.",
      cut,
      sweep: { applied: swept.applied, released: swept.released },
    });
  });

  /** Barrido de jornada. Simula salvo que se pida `?apply=1`. */
  app.post("/api/v1/admin/shift-sweep", requireRole("admin", "fleet"), async (request: Request, response: Response) => {
    const apply = String(request.query.apply || "") === "1";
    if (!mongoose.connection.db) return response.status(503).json({ error: "DB_NOT_READY" });
    const report = await runShiftSweep({ apply, source: "manual", actorId: request.auth?.employeeId ?? null });
    return response.json(report);
  });

  /** Últimos barridos ejecutados (manuales y automáticos). */
  app.get("/api/v1/admin/shift-sweep/runs", requireRole("admin", "fleet"), async (request: Request, response: Response) => {
    const limit = Math.max(1, Math.min(50, Number(request.query.limit || 10)));
    const runs = (await ShiftSweepRun.find({}).sort({ createdAt: -1 }).limit(limit).lean().exec()) as any[];
    return response.json({
      worker: shiftSweepWorkerStatus(),
      runs: runs.map((run) => ({
        id: String(run._id),
        source: run.source,
        dryRun: run.dryRun,
        checked: run.checked,
        loggedOut: run.loggedOut,
        released: run.released,
        errors: run.errors || [],
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
      })),
    });
  });
}

/** Compatibilidad con el montaje anterior. */
export const mountShiftSweep = mountShiftRoutes;
