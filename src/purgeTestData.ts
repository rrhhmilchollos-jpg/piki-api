import mongoose from "mongoose";

const RUN_ID = "purge-test-data-v2";
const TEST_EMAIL = /(?:\.test|@example\.test)$/i;
const QA_RESTAURANT_NAMES = ["KFC XATIVA QA", "PIKI QA Kitchen"];
const QA_RESTAURANT_SLUGS = ["piki-qa-kitchen", "kfc-xativa-qa", "kfc-xativa-test"];
const QA_RESTAURANT_GROUPS = ["piki-qa"];
const QA_RIDER_EMAILS = ["qa-rider@pikidelivery.test"];
const QA_PARTNER_EMAILS = ["qa-partner@pikidelivery.test"];

const collection = (name: string) => mongoose.connection.collection(name) as any;

async function idsFor(name: string, filter: Record<string, unknown>) {
  const rows = await collection(name).find(filter, { projection: { _id: 1 } }).toArray();
  return rows.map((row: any) => row._id);
}

async function count(name: string, filter: Record<string, unknown>) {
  return collection(name).countDocuments(filter);
}

async function deleteByIds(name: string, ids: unknown[]) {
  if (!ids.length) return 0;
  return (await collection(name).deleteMany({ _id: { $in: ids } })).deletedCount;
}

/**
 * Purges only records with explicit QA/test markers. It never uses a broad
 * "old data" or status-based filter, so real production orders/accounts stay intact.
 * Enable only with PURGE_TEST_DATA_ON_BOOT=true and
 * PURGE_TEST_DATA_CONFIRM=PIKI_PURGE_TEST_DATA.
 */
export async function purgeTestDataIfEnabled() {
  if (process.env.PURGE_TEST_DATA_ON_BOOT !== "true") return { enabled: false };
  if (process.env.PURGE_TEST_DATA_CONFIRM !== "PIKI_PURGE_TEST_DATA") {
    throw new Error("PURGE_TEST_DATA_ON_BOOT requires PURGE_TEST_DATA_CONFIRM=PIKI_PURGE_TEST_DATA");
  }
  if (mongoose.connection.readyState !== 1) throw new Error("Cannot purge test data while MongoDB is not connected");

  const runs = collection("piki_cleanup_runs");
  const previous = await runs.findOne({ _id: RUN_ID });
  if (previous) {
    console.log(JSON.stringify({ event: "test_data_purge_skipped", runId: RUN_ID, previousRunAt: previous.completedAt }));
    return { enabled: true, skipped: true };
  }

  const demoRestaurantIds = await idsFor("restaurants", {
    $or: [
      { slug: { $in: QA_RESTAURANT_SLUGS } },
      { name: { $in: QA_RESTAURANT_NAMES } },
      { category: "QA" },
      { partnerGroupKey: { $in: QA_RESTAURANT_GROUPS } },
      { email: { $in: QA_PARTNER_EMAILS } },
    ],
  });
  const testRiderIds = await idsFor("riders", {
    $or: [
      { isTestRider: true },
      { email: { $in: QA_RIDER_EMAILS } },
      { email: TEST_EMAIL },
    ],
  });
  const testEmployeeIds = await idsFor("employee_accounts", {
    $or: [
      { email: { $in: [...QA_PARTNER_EMAILS, ...QA_RIDER_EMAILS] } },
      { email: TEST_EMAIL },
    ],
  });
  const testCustomerIds = await idsFor("customer_accounts", { email: TEST_EMAIL });

  const testOrderIds = await idsFor("orders", {
    $or: [
      { isTestOrder: true },
      { qaRiderId: { $in: testRiderIds } },
      { riderId: { $in: testRiderIds } },
      { restaurantId: { $in: demoRestaurantIds } },
    ],
  });
  const testSlotIds = await idsFor("rider_slots", { riderId: { $in: testRiderIds } });
  const testSessionIds = await idsFor("tracking_sessions", { riderId: { $in: testRiderIds } });

  const before = {
    restaurants: demoRestaurantIds.length,
    riders: testRiderIds.length,
    employees: testEmployeeIds.length,
    customers: testCustomerIds.length,
    orders: testOrderIds.length,
    riderSlots: testSlotIds.length,
    trackingSessions: testSessionIds.length,
    locationSamples: await count("location_samples", { riderId: { $in: testRiderIds } }),
  };
  console.log(JSON.stringify({ event: "test_data_purge_started", runId: RUN_ID, before }));

  const linkedFilters: Array<[string, Record<string, unknown>]> = [
    ["location_samples", { $or: [{ riderId: { $in: testRiderIds } }, { sessionId: { $in: testSessionIds } }] }],
    ["tracking_sessions", { riderId: { $in: testRiderIds } }],
    ["rider_slots", { riderId: { $in: testRiderIds } }],
    ["rider_assignment_reservations", { $or: [{ riderId: { $in: testRiderIds } }, { orderId: { $in: testOrderIds } }] }],
    ["dispatch_decisions", { $or: [{ riderId: { $in: testRiderIds } }, { orderId: { $in: testOrderIds } }] }],
    ["rider_order_messages", { $or: [{ riderId: { $in: testRiderIds } }, { orderId: { $in: testOrderIds } }] }],
    ["rider_incidents", { riderId: { $in: testRiderIds } }],
    ["cash_ledger_entries", { $or: [{ riderId: { $in: testRiderIds } }, { orderId: { $in: testOrderIds } }] }],
    ["rider_shift_incentive_metrics", { riderId: { $in: testRiderIds } }],
    ["rider_incentive_entries", { riderId: { $in: testRiderIds } }],
    ["rider_referral_profiles", { riderId: { $in: testRiderIds } }],
    ["rider_leads", { email: TEST_EMAIL }],
    ["rider_applications", { $or: [{ riderId: { $in: testRiderIds } }, { email: TEST_EMAIL }] }],
    ["push_subscriptions", { ownerId: { $in: [...testRiderIds, ...testEmployeeIds, ...testCustomerIds] } }],
    ["notifications", { recipientId: { $in: [...testRiderIds, ...testEmployeeIds, ...testCustomerIds] } }],
    ["realtime_events", { $or: [{ audienceKey: { $regex: /qa|test|demo/i } }, { "payload.riderId": { $in: testRiderIds.map(String) } }, { "payload.orderId": { $in: testOrderIds.map(String) } }] }],
    ["support_tickets", { $or: [{ riderId: { $in: testRiderIds } }, { reporterEmail: TEST_EMAIL }] }],
    ["document_requests", { $or: [{ recipientEmail: TEST_EMAIL }, { requestedBy: { $in: testEmployeeIds } }] }],
    ["signature_requests", { entityId: { $in: [...testRiderIds, ...testEmployeeIds] } }],
    ["access_authorizations", { employeeId: { $in: testEmployeeIds } }],
    ["tenant_memberships", { employeeId: { $in: testEmployeeIds } }],
    ["passkey_credentials", { ownerId: { $in: [...testRiderIds, ...testEmployeeIds, ...testCustomerIds] } }],
    ["partner_assets", { restaurantId: { $in: demoRestaurantIds } }],
    ["partner_locality_groups", { restaurantIds: { $in: demoRestaurantIds } }],
    ["onboarding_requests", { requestedBy: { $in: testEmployeeIds } }],
    ["orders", { _id: { $in: testOrderIds } }],
    ["riders", { _id: { $in: testRiderIds } }],
    ["customer_accounts", { _id: { $in: testCustomerIds } }],
    ["employee_accounts", { _id: { $in: testEmployeeIds } }],
    ["restaurants", { _id: { $in: demoRestaurantIds } }],
  ];

  const deleted: Record<string, number> = {};
  for (const [name, filter] of linkedFilters) {
    const result = await collection(name).deleteMany(filter);
    deleted[name] = result.deletedCount;
  }
  await runs.insertOne({ _id: RUN_ID, completedAt: new Date(), before, deleted, safeguards: ["explicit-test-markers-only", "real-employee-accounts-not-selected", "idempotent-run-marker"] });
  console.log(JSON.stringify({ event: "test_data_purge_completed", runId: RUN_ID, before, deleted }));
  return { enabled: true, skipped: false, before, deleted };
}
