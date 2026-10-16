import mongoose from "mongoose";
import "dotenv/config";
import { CustomerAccount, EmployeeAccount, Order, Restaurant, Rider } from "../src/models.js";

if (process.env.NODE_ENV !== "staging") throw new Error("NODE_ENV must be staging");
if (process.env.ALLOW_QA_SEED !== "true") throw new Error("Set ALLOW_QA_SEED=true explicitly for staging QA cleanup");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
const runId = String(process.env.E2E_RUN_ID || "").trim();
if (!/^qa-[a-z0-9-]{8,64}$/.test(runId)) throw new Error("E2E_RUN_ID must have format qa-... and be unique");
const dbName = process.env.MONGODB_DB;
if (!dbName || !/staging|qa|test/i.test(dbName)) throw new Error("MONGODB_DB must explicitly name a staging/QA/test database");

await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10_000 });
try {
  const database = mongoose.connection;
  const orders = await Order.find({ qaRunId: runId }).select("_id").lean().exec();
  const orderIds = orders.map((order) => order._id);
  const orderFilter = orderIds.length ? { orderId: { $in: orderIds } } : { orderId: { $in: [] } };
  const orderStringFilter = orderIds.length ? { "payload.orderId": { $in: orderIds.map(String) } } : { "payload.orderId": { $in: [] } };
  const riderFilter = { qaRunId: runId };
  const [linked, deletedOrders, restaurants, riders, customers, employees] = await Promise.all([
    Promise.all([
      database.collection("rider_order_messages").deleteMany(orderFilter),
      database.collection("dispatch_decisions").deleteMany(orderFilter),
      database.collection("dispatch_outbox").deleteMany(orderFilter),
      database.collection("rider_assignment_reservations").deleteMany(orderFilter),
      database.collection("support_tickets").deleteMany(orderFilter),
      database.collection("cash_ledger_entries").deleteMany(orderFilter),
      database.collection("marketplace_ledger_entries").deleteMany(orderFilter),
      database.collection("realtime_events").deleteMany(orderStringFilter),
      database.collection("notifications").deleteMany({ entityType: "order", entityId: { $in: orderIds.map(String) } }),
    ]),
    Order.deleteMany({ qaRunId: runId }),
    Restaurant.deleteMany({ qaRunId: runId }),
    Rider.deleteMany(riderFilter),
    CustomerAccount.deleteMany({ qaRunId: runId }),
    EmployeeAccount.deleteMany({ qaRunId: runId }),
  ]);
  console.log(JSON.stringify({ ok: true, dbName, runId, deleted: {
    orders: deletedOrders.deletedCount,
    linkedCollections: linked.map((result) => result.deletedCount),
    restaurants: restaurants.deletedCount,
    riders: riders.deletedCount,
    customers: customers.deletedCount,
    employees: employees.deletedCount,
  } }, null, 2));
} finally {
  await mongoose.disconnect();
}
