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
  RiderAssignmentReservation,
  PushSubscription,
  RealtimeEvent,
  Tenant,
  TenantMembership,
  Zone,
} from "./models.js";

export const ROOT_TENANT_SLUG = process.env.PIKI_ROOT_TENANT_SLUG || "piki-platform";
export const ROOT_TENANT_NAME = process.env.PIKI_ROOT_TENANT_NAME || "PIKI Delivery";

const collections = [
  ["employee_accounts", EmployeeAccount], ["riders", Rider], ["fleets", Fleet], ["zones", Zone],
  ["restaurants", Restaurant], ["orders", Order], ["rider_applications", RiderApplication],
  ["partner_assets", PartnerAsset], ["partner_locality_groups", PartnerLocalityGroup],
  ["cash_ledger_entries", CashLedgerEntry], ["dispatch_decisions", DispatchDecision],
  ["rider_incidents", RiderIncident], ["rider_order_messages", RiderOrderMessage],
  ["rider_slots", RiderSlot], ["rider_assignment_reservations", RiderAssignmentReservation], ["push_subscriptions", PushSubscription], ["realtime_events", RealtimeEvent], ["access_authorizations", AccessAuthorization],
] as const;

export async function runTenantMigration() {
  const tenant = await Tenant.findOneAndUpdate(
    { slug: ROOT_TENANT_SLUG },
    { $setOnInsert: { slug: ROOT_TENANT_SLUG, name: ROOT_TENANT_NAME, isPlatformTenant: true, status: "active" } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean().exec() as any;
  const tenantId = tenant._id;
  const pending: Record<string, number> = {};
  for (const [name, model] of collections) pending[name] = await model.countDocuments({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] });
  const employees = await EmployeeAccount.find({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] }).select("_id apiRole jobRole").lean().exec() as any[];
  for (const [, model] of collections) await model.updateMany({ $or: [{ tenantId: null }, { tenantId: { $exists: false } }] }, { $set: { tenantId } }).exec();
  for (const employee of employees) await TenantMembership.updateOne(
    { tenantId, employeeId: employee._id },
    { $set: { role: employee.jobRole === "zone_manager" ? "zone_manager" : employee.apiRole, status: "active" }, $setOnInsert: { scopes: [] } },
    { upsert: true, setDefaultsOnInsert: true },
  ).exec();
  return { tenantId: String(tenantId), tenantSlug: ROOT_TENANT_SLUG, pending, membershipsCreatedOrUpdated: employees.length };
}
