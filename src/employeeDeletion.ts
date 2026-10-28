import mongoose from "mongoose";
import type { Express, Request } from "express";
import { z } from "zod";
import { requireOwner } from "./auth.js";
import { EmployeeAccount } from "./models.js";
import { employeeDeletionBlocker, type DeletionEmployee, type DeletionDependencies } from "./employeeDeletionPolicy.js";

type Session = mongoose.mongo.ClientSession;
type Filter = Record<string, any>;
const inputSchema = z.object({ confirmationEmail: z.string().trim().email(), reason: z.string().trim().min(10).max(500) }).strict();
const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const idOf = (req: Request) => {
  const id = String(req.params.id || "");
  return /^[a-f\d]{24}$/i.test(id) ? new mongoose.Types.ObjectId(id) : null;
};
function actorScope(req: Request): Filter {
  return req.auth?.isRootOwner ? {} : { tenantId: req.auth?.tenantId ? new mongoose.Types.ObjectId(req.auth.tenantId) : null };
}
function database() {
  if (!mongoose.connection.db) throw new Error("DATABASE_NOT_READY");
  return mongoose.connection.db;
}

async function contextFor(req: Request, session?: Session) {
  const id = idOf(req);
  if (!id) return null;
  const employee = await EmployeeAccount.findOne({ _id: id, ...actorScope(req) }).session(session || null).lean().exec() as any;
  if (!employee) return null;
  const db = database();
  const options = session ? { session } : {};
  const email = new RegExp(`^${escaped(String(employee.email).trim())}$`, "i");
  const scope: Filter = { tenantId: employee.tenantId || null };
  const riders = await db.collection("riders").find({ ...scope, email }, options).project({ _id: 1, riderCode: 1 }).toArray();
  const riderIds = riders.map((rider) => rider._id);
  const linked = { riderId: { $in: riderIds } };
  const [activeOrders, cash, pendingPayouts, activeReservations, historicalOrders, foreignProfiles] = await Promise.all([
    db.collection("orders").countDocuments({ ...linked, archivedAt: null, status: { $nin: ["delivered", "cancelled"] } }, options),
    db.collection("cash_ledger_entries").aggregate([{ $match: linked }, { $group: { _id: null, balance: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$amountCents", { $multiply: [-1, "$amountCents"] }] } } } }], options).toArray(),
    db.collection("rider_payout_batches").countDocuments({ ...linked, status: { $in: ["prepared", "approved", "failed"] } }, options),
    db.collection("rider_assignment_reservations").countDocuments({ ...linked, status: "reserved" }, options),
    db.collection("orders").countDocuments(linked, options),
    db.collection("riders").countDocuments({ email, tenantId: { $ne: employee.tenantId || null } }, options),
  ]);
  const dependencies: DeletionDependencies = { activeOrders, unsettledCashCents: Number(cash[0]?.balance || 0), pendingPayouts, activeReservations };
  const blocker = foreignProfiles ? "PROFILE_TENANT_CONFLICT" : employeeDeletionBlocker(employee as DeletionEmployee, String(req.auth?.employeeId), String(employee.email), dependencies);
  return { employee, email, scope, riderIds, riders, dependencies, historicalOrders, blocker };
}

export function registerEmployeeDeletionRoutes(app: Express) {
  app.get("/api/v1/admin/employees/:id/permanent-deletion/preview", requireOwner(), async (req, res) => {
    const context = await contextFor(req);
    if (!context) return res.status(404).json({ error: "EMPLOYEE_NOT_FOUND" });
    const { employee, riders, dependencies, historicalOrders, blocker } = context;
    return res.json({ employee: { _id: employee._id, name: employee.name, email: employee.email, active: employee.active, authorizationStatus: employee.authorizationStatus }, riders: riders.map((rider) => ({ _id: rider._id, riderCode: rider.riderCode })), dependencies, historicalOrdersPreserved: historicalOrders, eligible: blocker === null, blocker, preserves: ["orders", "cash_ledger_entries", "marketplace_ledger_entries", "payout_batches", "legal_signatures", "audit_trail"], removes: ["employee_account", "rider_profiles", "employee_sessions", "passkeys", "push_subscriptions", "recruitment_profiles", "document_request_credentials", "tracking_locations"] });
  });

  app.delete("/api/v1/admin/employees/:id/permanent", requireOwner(), async (req, res) => {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "EXPLICIT_DELETION_CONFIRMATION_REQUIRED" });
    if (!idOf(req)) return res.status(400).json({ error: "INVALID_EMPLOYEE_ID" });
    try {
      const result = await mongoose.connection.transaction(async (session) => {
        const context = await contextFor(req, session);
        if (!context) throw new Error("EMPLOYEE_NOT_FOUND");
        const { employee, email, scope, riderIds, dependencies, historicalOrders } = context;
        const blocker = context.blocker || employeeDeletionBlocker(employee as DeletionEmployee, String(req.auth?.employeeId), parsed.data.confirmationEmail, dependencies);
        if (blocker) throw new Error(blocker);
        const db = database();
        const options = { session };
        const employeeId = employee._id;
        const recruitment = await db.collection("rider_leads").find({ ...scope, email }, options).project({ _id: 1 }).toArray();
        const applications = await db.collection("rider_applications").find({ ...scope, email }, options).project({ _id: 1 }).toArray();
        const relatedIds = [employeeId, ...riderIds, ...recruitment.map((item) => item._id), ...applications.map((item) => item._id)];
        const removed: Record<string, number> = {};
        const remove = async (collection: string, filter: Filter) => {
          const result = await db.collection(collection).deleteMany(filter, options);
          removed[collection] = result.deletedCount;
        };
        // All filters bind to an exact identity or derived profile ids. Never delete business history.
        await remove("employee_sessions", { employeeId });
        await remove("tenant_memberships", { employeeId });
        await remove("passkey_credentials", { ownerType: "employee", ownerId: employeeId });
        await remove("passkey_challenges", { ownerType: "employee", ownerId: employeeId });
        await remove("push_subscriptions", { ownerType: "employee", ownerId: employeeId });
        await remove("notifications", { ownerType: "employee", ownerId: employeeId });
        await remove("location_samples", { riderId: { $in: riderIds } });
        await remove("tracking_sessions", { riderId: { $in: riderIds } });
        await remove("document_requests", { ...scope, $or: [{ recipientEmail: email }, { subjectId: { $in: relatedIds } }] });
        await remove("rider_leads", { ...scope, email });
        await remove("rider_applications", { ...scope, email });
        await remove("onboarding_requests", { ...scope, $or: [{ requestedBy: employeeId }, { "payload.email": email }] });
        await remove("riders", { ...scope, _id: { $in: riderIds } });
        await remove("employee_accounts", { _id: employeeId, active: false, authorizationStatus: "revoked" });
        if (removed.employee_accounts !== 1) throw new Error("EMPLOYEE_CHANGED_DURING_DELETION");
        await db.collection("governance_audit_events").insertOne({ tenantId: employee.tenantId || null, action: "employee_profile_permanently_deleted", actorEmployeeId: new mongoose.Types.ObjectId(String(req.auth!.employeeId)), actorRole: "admin", targetType: "employee", targetId: String(employeeId), reason: parsed.data.reason, before: { authorizationStatus: "revoked", riderProfileCount: riderIds.length }, after: { removed, historicalOrdersPreserved: historicalOrders }, createdAt: new Date(), updatedAt: new Date() }, options);
        return { deleted: true, employeeId: String(employeeId), riderIds: riderIds.map(String), removed, historicalOrdersPreserved: historicalOrders, financialHistoryPreserved: true };
      });
      return res.json(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "PERMANENT_DELETION_FAILED";
      const known = /^(EMPLOYEE_NOT_FOUND|PROTECTED_ACCOUNT|CONFIRMATION_EMAIL_MISMATCH|REVOKE_ACCOUNT_BEFORE_DELETION|ACTIVE_ORDERS_BLOCK_DELETION|UNSETTLED_CASH_BLOCKS_DELETION|PENDING_PAYOUTS_BLOCK_DELETION|ACTIVE_RESERVATIONS_BLOCK_DELETION|PROFILE_TENANT_CONFLICT|EMPLOYEE_CHANGED_DURING_DELETION)$/;
      if (known.test(message)) return res.status(message === "EMPLOYEE_NOT_FOUND" ? 404 : 409).json({ error: message, deleted: false });
      // Do not leak database internals or fall back to a non-atomic cascade.
      return res.status(503).json({ error: "ATOMIC_DELETION_UNAVAILABLE", deleted: false, message: "No se pudo completar el borrado atómico; no se confirma ninguna eliminación. Revisa la disponibilidad de transacciones de la base de datos." });
    }
  });
}
