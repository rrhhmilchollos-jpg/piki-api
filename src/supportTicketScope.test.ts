import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLegacyRiderSupportTicketFilter,
  buildRiderSupportTicketFilter,
} from "./supportTicketScope.js";

test("a tenant-scoped Rider can see only its own legacy unscoped support tickets", () => {
  const filter = buildRiderSupportTicketFilter({
    tenantId: "tenant-a",
    riderId: "rider-a",
    reporterEmail: "rider@example.test",
    ticketId: "ticket-a",
  });

  assert.equal(filter._id, "ticket-a");
  assert.equal(filter.reporterEmail, "rider@example.test");
  assert.deepEqual(filter.$or, [
    { tenantId: "tenant-a" },
    {
      _id: "ticket-a",
      tenantId: null,
      reporterEmail: "rider@example.test",
      sourceSurface: "rider",
      actions: {
        $elemMatch: {
          action: "rider_ticket_created",
          "metadata.riderId": "rider-a",
        },
      },
    },
  ]);
});

test("legacy ticket repair requires null tenant, matching reporter, source and exact rider id", () => {
  assert.deepEqual(
    buildLegacyRiderSupportTicketFilter({
      riderId: "rider-a",
      reporterEmail: "rider@example.test",
      ticketId: "ticket-a",
    }),
    {
      _id: "ticket-a",
      tenantId: null,
      reporterEmail: "rider@example.test",
      sourceSurface: "rider",
      actions: {
        $elemMatch: {
          action: "rider_ticket_created",
          "metadata.riderId": "rider-a",
        },
      },
    },
  );
});

test("platform-wide Rider ticket lookup does not add a legacy tenant fallback", () => {
  assert.deepEqual(
    buildRiderSupportTicketFilter({
      riderId: "rider-a",
      reporterEmail: "rider@example.test",
      ticketId: "ticket-a",
    }),
    { _id: "ticket-a", reporterEmail: "rider@example.test" },
  );
});
