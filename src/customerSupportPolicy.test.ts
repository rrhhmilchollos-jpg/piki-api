import assert from "node:assert/strict";
import { test } from "node:test";
import { customerSupportCreateSchema, customerSupportTicketNumber, customerSupportTicketView } from "./customerSupportPolicy.js";

test("customer support accepts the PIKI Plus account-access request", () => {
  const parsed = customerSupportCreateSchema.safeParse({
    category: "account",
    priority: "normal",
    subject: "PIKI Plus · solicitud de acceso piloto",
    description: "Quiero participar en el piloto PIKI Plus de Xàtiva.",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.category, "account");
    assert.equal(parsed.data.priority, "normal");
    assert.equal(parsed.data.orderRef, undefined);
  }
});

test("customer support rejects malformed or out-of-range tickets", () => {
  assert.equal(customerSupportCreateSchema.safeParse({ category: "owner", subject: "No", description: "OK" }).success, false);
  assert.equal(customerSupportCreateSchema.safeParse({ category: "account", priority: "urgent", subject: "Solicitud válida", description: "Detalle suficiente" }).success, false);
  assert.equal(customerSupportCreateSchema.safeParse({ category: "account", subject: "Solicitud válida", description: "x".repeat(4001) }).success, false);
});

test("customer support ticket numbers are dated and collision-resistant", () => {
  const now = new Date("2026-10-11T03:00:00.000Z");
  const first = customerSupportTicketNumber(now);
  const second = customerSupportTicketNumber(now);
  assert.match(first, /^SUP-20261011-[A-F0-9]{8}$/);
  assert.notEqual(first, second);
});

test("customer ticket projection excludes internal data and includes support replies", () => {
  const view = customerSupportTicketView({
    _id: "ticket-id",
    ticketNumber: "SUP-20261011-1234ABCD",
    subject: "PIKI Plus pilot",
    description: "Access request",
    category: "account",
    priority: "normal",
    status: "in_progress",
    reporterEmail: "private@example.com",
    actions: [{ action: "internal" }],
    messages: [{ senderRole: "support", senderName: "Agente", body: "Te contactaremos", createdAt: "2026-10-11T03:00:00.000Z", senderEmployeeId: "private-id" }],
  } as never);
  assert.equal(view._id, "ticket-id");
  assert.equal(view.messages[0]?.body, "Te contactaremos");
  assert.equal("reporterEmail" in view, false);
  assert.equal("actions" in view, false);
});
