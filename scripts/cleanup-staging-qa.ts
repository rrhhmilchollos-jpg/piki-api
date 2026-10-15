import mongoose from "mongoose";
import "dotenv/config";
import { CustomerAccount, EmployeeAccount, Order, Restaurant, Rider } from "../src/models.js";

if (process.env.NODE_ENV !== "staging") throw new Error("NODE_ENV must be staging");
if (process.env.ALLOW_QA_SEED !== "true") throw new Error("Set ALLOW_QA_SEED=true explicitly for staging QA cleanup");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
const dbName = process.env.MONGODB_DB;
if (!dbName || !/staging|qa|test/i.test(dbName)) throw new Error("MONGODB_DB must explicitly name a staging/QA/test database");

await mongoose.connect(process.env.MONGODB_URI, { dbName, serverSelectionTimeoutMS: 10_000 });
try {
  const restaurant = await Restaurant.findOne({ slug: "piki-qa-kitchen" }).select("_id").lean() as { _id?: mongoose.Types.ObjectId } | null;
  const restaurantId = restaurant?._id;
  const orderFilter = restaurantId ? { $or: [{ isTestOrder: true }, { restaurantId }] } : { isTestOrder: true };
  const [orders, restaurants, riders, customers, employees] = await Promise.all([
    Order.deleteMany(orderFilter),
    Restaurant.deleteMany({ slug: "piki-qa-kitchen" }),
    Rider.deleteMany({ email: "qa-rider@pikidelivery.test" }),
    CustomerAccount.deleteMany({ email: "qa-customer@pikidelivery.test" }),
    EmployeeAccount.deleteMany({ email: { $in: ["qa-admin@pikidelivery.test", "qa-partner@pikidelivery.test", "qa-rider@pikidelivery.test", "qa-fleet@pikidelivery.test", "qa-support@pikidelivery.test"] } }),
  ]);
  console.log(JSON.stringify({ ok: true, dbName, deleted: { orders: orders.deletedCount, restaurants: restaurants.deletedCount, riders: riders.deletedCount, customers: customers.deletedCount, employees: employees.deletedCount } }, null, 2));
} finally {
  await mongoose.disconnect();
}
