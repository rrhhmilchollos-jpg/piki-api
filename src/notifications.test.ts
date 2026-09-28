import assert from "node:assert/strict";
import { test } from "node:test";
import { buildNoticeCopy } from "./notifications.js";
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

test("cash-wallet notices are limited to operational surfaces", () => {
  const input = event("cash.wallet_changed", { riderId: "66c5c6634d5bb12ea5500010", amountCents: 1668 }, "fleet");
  assert.equal(buildNoticeCopy(input, principal("rider"))?.category, "cash");
  assert.equal(buildNoticeCopy(input, principal("fleet"))?.category, "cash");
  assert.equal(buildNoticeCopy(input, principal("admin"))?.category, "cash");
  assert.equal(buildNoticeCopy(input, principal("customer")), null);
});
