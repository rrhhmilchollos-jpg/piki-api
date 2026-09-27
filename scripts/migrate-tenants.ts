import "dotenv/config";
import mongoose from "mongoose";
import {
  AccessAuthorization,
  CashLedgerEntry,
  DispatchDecision,
  EmployeeAccount,
  Fleet,
  Order,
  PartnerAsset,
  PartnerLocalityGroup,
  Restaurant,
  Rider,
  RiderApplication,
  RiderIncident,
  RiderOrderMessage,
  RiderSlot,
  Tenant,
  TenantMembership,
  Zone,
} from "../src/models.js";

const ROOT_SLUG = process.env.PIKI_ROOT_TENANT_SLUG || "piki-platform";
const ROOT_NAME = process.env.PIKI_ROOT_TENANT_NAME || "PIKI Delivery";
const apply = process.argv.includes("--apply");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required");
  if (apply && process.env.ALLOW_TENANT_MIGRATION !== "true") {
    throw new Error("Refusing to apply migration. Set ALLOW_TENANT_MIGRATION=true explicitly.");
  }

  await mongoose.connect(uri, { dbName: process.env.MONGODB_DB || "piki" });
  const tenant = await Tenant.findOneAndUpdate(
    { slug: ROOT_SLUG },
    { $setOnInsert: { slug: ROOT_SLUG, name: ROOT_NAME, isPlatformTenant: true, status: "active" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean().exec() as any;
  const tenantId = tenant._id;

  const collections = [
    ["employee_accounts", EmployeeAccount],
    ["riders", Rider],
    ["fleets", Fleet],
    ["zones", Zone],
    ["restaurants", Restaurant],
    ["orders", Order],
    ["rider_applications", RiderApplication],
    ["partner_assets", PartnerAsset],
    ["partner_locality_groups", PartnerLocalityGroup],
    ["cash_ledger_entries", CashLedgerEntry],
    ["dispatch_decisions", DispatchDecision],
    ["rider_incidents", RiderIncident],
    ["rider_order_messages", RiderOrderMessage],
    ["rider_slots", RiderSlot],
    ["access_authorizations", AccessAuthorization],
  ] as const;

  const report: Record<string, number> = {};
  for (const [name, model] of collections) {
    report[name] = await model.countDocuments({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] });
  }
  const employees = await EmployeeAccount.find({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] }).select("_id apiRole jobRole").lean().exec() as any[];

  console.log(JSON.stringify({ mode: apply ? "apply" : "dry-run", tenant: { id: String(tenantId), slug: ROOT_SLUG }, pendingDocuments: report, pendingEmployees: employees.length }, null, 2));
  if (!apply) return;

  for (const [, model] of collections) {
    await model.updateMany({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] }, { $set: { tenantId } }).exec();
  }
  for (const employee of employees) {
    await TenantMembership.updateOne(
      { tenantId, employeeId: employee._id },
      { $set: { role: employee.jobRole === "zone_manager" ? "zone_manager" : employee.apiRole, status: "active" }, $setOnInsert: { scopes: [] } },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();
  }
  await TenantMembership.createIndex({ tenantId: 1, employeeId: 1 }, { unique: true });
  console.log(JSON.stringify({ completed: true, tenantId: String(tenantId), membershipsCreatedOrUpdated: employees.length }, null, 2));
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(async () => { await mongoose.disconnect(); });
