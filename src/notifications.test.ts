import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNoticeCopy, notificationRecipientTenantId } from "./notifications.js";
import { tenantAudienceKey } from "./realtime.js";

const orderId = "66c5c6634d5bb12ea5500101";
const event = (type: string, payload: Record<string, unknown>, channel: "customer" | "partner" | "fleet" | "admin" | "rider" = "customer") => ({
  eventId: "66c5c6634d5bb12ea5500001",
  channel,
  audienceKey: "test-audience",
  tenantId: "66c5c6634d5bb12ea5500002",
  type,
  payload,
});
const principal = (surface: "customer" | "partner" | "fleet" | "admin" | "rider") => ({
  surface,
  ownerType: surface === "customer" ? "customer" as const : "employee" as const,
  ownerId: "66c5c6634d5bb12ea5500003",
  tenantId: surface === "customer" ? null : "66c5c6634d5bb12ea5500002",
});

test("admin and fleet realtime groups are isolated by tenant", () => {
  const tenantA = "66c5c6634d5bb12ea5500002";
  const tenantB = "66c5c6634d5bb12ea5500004";
  assert.equal(tenantAudienceKey(tenantA, "admin"), `tenant:${tenantA}:role:admin`);
  assert.equal(tenantAudienceKey(tenantA, "fleet"), `tenant:${tenantA}:role:fleet`);
  assert.notEqual(tenantAudienceKey(tenantA, "admin"), tenantAudienceKey(tenantB, "admin"));
  assert.equal(tenantAudienceKey(null, "fleet"), "tenant:default:role:fleet");
});

test("tenantless super-admin notifications stay in the super-admin inbox across tenants", () => {
  assert.equal(notificationRecipientTenantId(null), null);
  assert.equal(notificationRecipientTenantId(undefined), null);
  assert.equal(notificationRecipientTenantId("66c5c6634d5bb12ea5500002"), "66c5c6634d5bb12ea5500002");
});

test("a rider offer is visible only to the rider surface", () => {
  const input = event("order.rider_offer", { orderId, publicCode: "PIKI-836" }, "rider");
  assert.equal(buildNoticeCopy(input, principal("rider"))?.title, "Nuevo reparto asignado");
  assert.equal(buildNoticeCopy(input, principal("fleet")), null);
  assert.equal(buildNoticeCopy(input, principal("customer")), null);
});

test("customer status notification keeps its order link internal", () => {
  const input = event("order.status_changed", { orderId, publicCode: "PIKI-836", status: "on_the_way", message: "Tu pedido está en camino." });
  const notice = buildNoticeCopy(input, principal("customer"));
  assert.equal(notice?.body, "Tu pedido está en camino.");
  assert.equal(notice?.url, `/?order_id=${orderId}`);
  assert.equal(notice?.entityType, "order");
});

test("partner receives a new-order message without customer-facing details", () => {
  const input = event("order.awaiting_partner_acceptance", { orderId, publicCode: "PIKI-836" }, "partner");
  const notice = buildNoticeCopy(input, principal("partner"));
  assert.equal(notice?.title, "Nuevo pedido");
  assert.match(notice?.body || "", /PIKI-836/);
  assert.equal(buildNoticeCopy(input, principal("rider")), null);
});

test("onboarding notices deep-link to internal queues without exposing applicant PII", () => {
  const lead = event("onboarding.rider_lead.created", { entityId: "66c5c6634d5bb12ea5500012", email: "private@example.com", phone: "600000000" }, "admin");
  const leadNotice = buildNoticeCopy(lead, principal("admin"));
  assert.equal(leadNotice?.url, "/?section=Solicitudes%20web");
  assert.equal(leadNotice?.entityType, "rider_lead");
  assert.doesNotMatch(`${leadNotice?.title} ${leadNotice?.body}`, /private@example\.com|600000000/);

  const approval = event("onboarding.rider_application.approved", {
    applicationId: "66c5c6634d5bb12ea5500013",
    riderId: "66c5c6634d5bb12ea5500014",
    email: "private@example.com",
  }, "fleet");
  const adminNotice = buildNoticeCopy(approval, principal("admin"));
  const fleetNotice = buildNoticeCopy(approval, principal("fleet"));
  assert.equal(adminNotice?.url, "/?section=Riders");
  assert.equal(adminNotice?.entityId, "66c5c6634d5bb12ea5500013");
  assert.equal(fleetNotice?.entityId, "66c5c6634d5bb12ea5500014");
  assert.doesNotMatch(`${fleetNotice?.title} ${fleetNotice?.body}`, /private@example\.com/);
  assert.equal(buildNoticeCopy(approval, principal("partner")), null);
});

test("cash-wallet notices are limited to operational surfaces", () => {
  const input = event("cash.wallet_changed", { riderId: "66c5c6634d5bb12ea5500010", amountCents: 1668 }, "fleet");
  assert.equal(buildNoticeCopy(input, principal("rider"))?.category, "cash");
  assert.equal(buildNoticeCopy(input, principal("fleet"))?.category, "cash");
  assert.equal(buildNoticeCopy(input, principal("admin"))?.category, "cash");
  assert.equal(buildNoticeCopy(input, principal("customer")), null);
});

test("shift outside-hours alert is visible only to Fleet and Admin", () => {
  const input = event("security.rider_shift_out_of_hours", {
    riderId: "66c5c6634d5bb12ea5500011",
    riderName: "PIKI QA Rider",
    riderEmail: "rider@example.com",
    riderCode: "PIKI-R-123456",
    date: "2026-10-02",
    time: "03:03",
  }, "fleet");
  const fleet = buildNoticeCopy(input, principal("fleet"));
  const admin = buildNoticeCopy(input, principal("admin"));
  assert.equal(fleet?.category, "security");
  assert.equal(fleet?.entityType, "rider");
  assert.match(fleet?.body || "", /PIKI QA Rider.*PIKI-R-123456/);
  assert.match(fleet?.body || "", /2026-10-02 03:03/);
  assert.equal(admin?.title, "Intento de jornada fuera de horario");
  assert.equal(buildNoticeCopy(input, principal("rider")), null);
});
