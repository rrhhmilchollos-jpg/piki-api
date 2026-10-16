import mongoose from "mongoose";
import "dotenv/config";
import { CustomerAccount, EmployeeAccount, Fleet, Order, Restaurant, Rider, RiderSlot, Tenant, TenantMembership } from "../src/models.js";

export type QaCleanupResult = {
  ok: true;
  dbName: string;
  runId: string;
  deleted: Record<string, number | number[]>;
};

export async function cleanupStagingQaRun(runId: string): Promise<QaCleanupResult> {
  if (process.env.NODE_ENV !== "staging") throw new Error("NODE_ENV must be staging");
  if (process.env.ALLOW_QA_SEED !== "true") throw new Error("Set ALLOW_QA_SEED=true explicitly for staging QA cleanup");
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  if (!/^qa-[a-z0-9-]{8,64}$/.test(runId)) throw new Error("E2E_RUN_ID must have format qa-... and be unique");
  const dbName = process.env.MONGODB_DB;
  if (!dbName || !/staging|qa|test/i.test(dbName)) throw new Error("MONGODB_DB must explicitly name a staging/QA/test database");

  const opensConnection = mongoose.connection.readyState !== 1;
  if (opensConnection) await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10_000 });
  try {
    const database = mongoose.connection;
    const [orders, riders, employees, customers, restaurants, tenant] = await Promise.all([
      Order.find({ qaRunId: runId }).select("_id").lean().exec(),
      Rider.find({ qaRunId: runId }).select("_id").lean().exec(),
      EmployeeAccount.find({ qaRunId: runId }).select("_id").lean().exec(),
      CustomerAccount.find({ qaRunId: runId }).select("_id").lean().exec(),
      Restaurant.find({ qaRunId: runId }).select("_id").lean().exec(),
      Tenant.findOne({ slug: `piki-qa-${runId.slice(3)}` }).select("_id").lean().exec(),
    ]);
    const orderIds = orders.map((order: any) => order._id);
    const riderIds = riders.map((rider: any) => rider._id);
    const employeeIds = employees.map((employee: any) => employee._id);
    const customerIds = customers.map((customer: any) => customer._id);
    const restaurantIds = restaurants.map((restaurant: any) => restaurant._id);
    const tenantId = (tenant as any)?._id || null;
    const ids = (values: any[]) => ({ $in: values.length ? values : [] });
    const orderFilter = { orderId: ids(orderIds) };
    const orderPayloadFilter = { "payload.orderId": ids(orderIds.map(String)) };
    const tenantFilter: Record<string, any> = tenantId ? { tenantId } : { _id: { $exists: false } };

    const linked = await Promise.all([
      database.collection("rider_order_messages").deleteMany(orderFilter),
      database.collection("dispatch_decisions").deleteMany(orderFilter),
      database.collection("dispatch_outbox").deleteMany(orderFilter),
      database.collection("rider_assignment_reservations").deleteMany(orderFilter),
      database.collection("support_tickets").deleteMany(orderFilter),
      database.collection("cash_ledger_entries").deleteMany(orderFilter),
      database.collection("marketplace_ledger_entries").deleteMany(orderFilter),
      database.collection("realtime_events").deleteMany({ $or: [orderPayloadFilter, tenantFilter] }),
      database.collection("notifications").deleteMany({ $or: [{ entityType: "order", entityId: ids(orderIds.map(String)) }, { tenantId: tenantId || null, ownerId: { $in: [...employeeIds.map(String), ...customerIds.map(String)] } }] }),
      database.collection("employee_sessions").deleteMany({ employeeId: ids(employeeIds) }),
      database.collection("tracking_sessions").deleteMany({ riderId: ids(riderIds) }),
      database.collection("location_samples").deleteMany({ riderId: ids(riderIds) }),
      database.collection("rider_incentive_entries").deleteMany({ riderId: ids(riderIds) }),
      database.collection("rider_shift_incentive_metrics").deleteMany({ riderId: ids(riderIds) }),
      database.collection("rider_referral_profiles").deleteMany({ riderId: ids(riderIds) }),
      database.collection("push_subscriptions").deleteMany({ ownerId: { $in: [...employeeIds.map(String), ...customerIds.map(String)] } }),
      database.collection("tenant_memberships").deleteMany(tenantFilter),
    ]);
    const [deletedOrders, deletedSlots, deletedRiders, deletedCustomers, deletedEmployees, deletedRestaurants, deletedFleet, deletedTenant] = await Promise.all([
      Order.deleteMany({ qaRunId: runId }),
      RiderSlot.deleteMany({ tenantId: tenantId || null }),
      Rider.deleteMany({ qaRunId: runId }),
      CustomerAccount.deleteMany({ qaRunId: runId }),
      EmployeeAccount.deleteMany({ qaRunId: runId }),
      Restaurant.deleteMany({ qaRunId: runId }),
      Fleet.deleteMany(tenantFilter),
      tenantId ? Tenant.deleteOne({ _id: tenantId }) : Promise.resolve({ deletedCount: 0 }),
    ]);
    return {
      ok: true,
      dbName,
      runId,
      deleted: {
        linkedCollections: linked.map((result: any) => Number(result.deletedCount || 0)),
        orders: Number(deletedOrders.deletedCount || 0),
        slots: Number(deletedSlots.deletedCount || 0),
        riders: Number(deletedRiders.deletedCount || 0),
        customers: Number(deletedCustomers.deletedCount || 0),
        employees: Number(deletedEmployees.deletedCount || 0),
        restaurants: Number(deletedRestaurants.deletedCount || 0),
        fleets: Number(deletedFleet.deletedCount || 0),
        tenants: Number((deletedTenant as any).deletedCount || 0),
      },
    };
  } finally {
    if (opensConnection) await mongoose.disconnect();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const runId = String(process.env.E2E_RUN_ID || "").trim();
  const result = await cleanupStagingQaRun(runId);
  console.log(JSON.stringify(result, null, 2));
}
