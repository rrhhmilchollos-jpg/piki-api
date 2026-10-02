#!/usr/bin/env node
/**
 * Staging smoke test: two support agents respond at exactly the same time.
 * Expected result: one request succeeds and the other receives 409 SUPPORT_TICKET_ASSIGNED.
 * Usage:
 *   API_URL=https://staging-api.example.com \
 *   TICKET_ID=<open-ticket-id> \
 *   AGENT_TOKEN_A=<token> \
 *   AGENT_TOKEN_B=<token> \
 *   node scripts/support-chat-concurrency.mjs
 */

const apiUrl = (process.env.API_URL || "http://localhost:4000").replace(/\/$/, "");
const ticketId = process.env.TICKET_ID;
const tokenA = process.env.AGENT_TOKEN_A;
const tokenB = process.env.AGENT_TOKEN_B;

if (!ticketId || !tokenA || !tokenB) {
  console.error("Faltan TICKET_ID, AGENT_TOKEN_A o AGENT_TOKEN_B.");
  process.exit(2);
}

async function respond(token, label) {
  const response = await fetch(`${apiUrl}/api/v1/admin/support/tickets/${ticketId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-PIKI-Surface": "admin",
    },
    body: JSON.stringify({ body: `STAGING CONCURRENCY TEST · ${label} · ${Date.now()}` }),
  });
  const body = await response.json().catch(() => ({}));
  return { label, status: response.status, body };
}

const results = await Promise.all([
  respond(tokenA, "AGENT_A"),
  respond(tokenB, "AGENT_B"),
]);

console.table(results.map(({ label, status, body }) => ({
  agent: label,
  http: status,
  result: body.error || (body.ticket ? "accepted" : "unknown"),
})));

const accepted = results.filter((result) => result.status >= 200 && result.status < 300);
const rejected = results.filter((result) => result.status === 409 && result.body?.error === "SUPPORT_TICKET_ASSIGNED");

if (accepted.length === 1 && rejected.length === 1) {
  console.log("PASS: un solo agente ha quedado asignado y el otro ha sido rechazado.");
  process.exit(0);
}

console.error("FAIL: el resultado esperado era 1 aceptación y 1 SUPPORT_TICKET_ASSIGNED.");
process.exit(1);
