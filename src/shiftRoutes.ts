/** Barrido de jornada: corta a quien ya no puede trabajar y libera sus pedidos. */
import type { Express, Request, Response } from "express";
import mongoose from "mongoose";
import { Order } from "./models.js";
import { requireRole } from "./auth.js";
import { planSweep, isReleasable, type AssignedOrder } from "./shiftSweep.js";
import type { RiderShiftPlan } from "./shiftEnforcement.js";

export function mountShiftSweep(app: Express): void {
  app.post("/api/v1/admin/shift-sweep", requireRole("admin", "fleet"), async (request: Request, response: Response) => {
    const apply = String(request.query.apply || "") === "1";
    const db = mongoose.connection.db;
    if (!db) return response.status(503).json({ error: "DB_NOT_READY" });
    const planes = await db.collection("rider_shift_plans").find({}).toArray();
    const activos = await Order.find({ riderId: { $exists: true, $ne: null }, status: { $in: ["assigned", "accepted", "preparing", "ready_for_pickup"] } })
      .select("publicCode riderId status assignedAt createdAt")
      .lean()
      .exec() as any[];
    const ahora = new Date();
    const orders: AssignedOrder[] = activos.map((order) => ({
      orderId: String(order._id),
      publicCode: order.publicCode,
      riderId: String(order.riderId),
      status: order.status,
      assignedMinutes: Math.max(0, Math.round((ahora.getTime() - new Date(order.assignedAt || order.createdAt || ahora).getTime()) / 60000)),
    }));
    const result = planSweep({
      now: ahora,
      riders: planes.map((plan: any) => ({ riderId: String(plan.riderId), plan: plan as RiderShiftPlan, workedMinutesThisWeek: Number(plan.workedMinutesThisWeek || 0) })),
      orders,
    });
    let applied = 0;
    if (apply) {
      for (const action of result.actions) {
        if (action.kind !== "release_order") continue;
        const order = activos.find((item) => item.publicCode === action.publicCode);
        if (!order || !isReleasable(order.status)) continue;
        await Order.updateOne({ _id: order._id }, { $unset: { riderId: "" }, $set: { assignmentState: "pending", status: "ready_for_pickup", releasedAt: new Date(), releaseReason: action.reason } });
        applied += 1;
      }
    }
    return response.json({ dryRun: !apply, ...result, applied });
  });
}
