import assert from "node:assert/strict";
import test from "node:test";
import { COD_AUTHORIZATION_TTL_MS, COD_RELEASE_MARGIN_MS } from "./stripePayments.js";
import {
  planCodHoldSweep,
  tallyCodHoldDecisions,
  type CodHoldCandidate,
} from "./codHoldSweep.js";
import type { OrderSnapshot } from "./orderReferences.js";

const NOW = new Date("2026-11-02T10:00:00.000Z");
const CREATED = new Date(NOW.getTime() - 60 * 60 * 1000);
const EXPIRES = new Date(CREATED.getTime() + COD_AUTHORIZATION_TTL_MS);

function hold(overrides: Partial<CodHoldCandidate> = {}): CodHoldCandidate {
  return {
    reference: "MW7GLU1",
    amountCents: 498,
    paymentIntentId: "pi_test_1",
    status: "authorized",
    expiresAt: EXPIRES,
    createdAt: CREATED,
    ...overrides,
  };
}

function order(overrides: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    orderId: "650000000000000000000001",
    reference: "PIKI-MW7GLU1",
    paymentState: "pending",
    status: "on_the_way",
    cashCollectedAt: null,
    deliveredAt: null,
    cancelledAt: null,
    createdAt: CREATED,
    ...overrides,
  };
}

function plan(holds: CodHoldCandidate[], orders: OrderSnapshot[] = [], extra: Record<string, number> = {}) {
  return planCodHoldSweep({
    now: NOW,
    holds,
    orders: new Map(orders.map((item) => [item.reference.replace(/^PIKI-/i, ""), item])),
    ...extra,
  });
}

test("una retención recién creada no se toca", () => {
  const [decision] = plan([hold()]);
  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "espera_turno");
});

test("no se libera por proximidad del plazo: solo avisa para revisión", () => {
  const marginStart = new Date(EXPIRES.getTime() - COD_RELEASE_MARGIN_MS);
  const justBefore = new Date(marginStart.getTime() - 60_000);
  const [early] = planCodHoldSweep({
    now: justBefore,
    holds: [hold()],
    orders: new Map(),
  });
  assert.equal(early.action, "skip");

  const [atMargin] = planCodHoldSweep({
    now: marginStart,
    holds: [hold()],
    orders: new Map(),
  });
  assert.equal(atMargin.action, "review");
  assert.equal(atMargin.reason, "retencion_a_punto_de_caducar");
});

test("una retención pasada de fecha se libera marcada como vencida", () => {
  const [late] = planCodHoldSweep({
    now: new Date(EXPIRES.getTime() + 60_000),
    holds: [hold()],
    orders: new Map(),
  });
  assert.equal(late.action, "release");
  assert.equal(late.reason, "retencion_vencida");
});

test("si el pedido consta cobrado en efectivo se libera sin esperar al plazo", () => {
  const [decision] = plan([hold()], [order({ paymentState: "paid", cashCollectedAt: NOW, status: "delivered" })]);
  assert.equal(decision.action, "release");
  assert.equal(decision.reason, "pedido_cobrado_en_efectivo");
  assert.equal(decision.orderId, "650000000000000000000001");
  assert.equal(decision.orphan, false);
});

test("si el pedido se canceló la garantía se libera", () => {
  const [decision] = plan([hold()], [order({ status: "cancelled", cancelledAt: NOW })]);
  assert.equal(decision.action, "release");
  assert.equal(decision.reason, "pedido_anulado");
});

test("un pedido reembolsado también libera la retención", () => {
  const [decision] = plan([hold()], [order({ paymentState: "refunded" })]);
  assert.equal(decision.reason, "pedido_reembolsado");
  assert.equal(decision.action, "release");
});

test("entregado sin cobro no se captura solo: queda en revisión", () => {
  const [decision] = plan([hold()], [order({ status: "delivered", deliveredAt: NOW, paymentState: "pending" })]);
  assert.equal(decision.action, "review");
  assert.equal(decision.reason, "entregado_sin_cobro");
  assert.equal(tallyCodHoldDecisions([decision]).needsReview, 1);
});

test("entregado sin cobro sigue en revisión aunque pase el plazo: no se libera solo", () => {
  const [decision] = planCodHoldSweep({
    now: EXPIRES,
    holds: [hold()],
    orders: new Map([["MW7GLU1", order({ status: "delivered", deliveredAt: NOW, paymentState: "pending" })]]),
  });
  assert.equal(decision.action, "review");
  assert.equal(decision.reason, "entregado_sin_cobro");
});

test("la garantía se suelta cuando el rider confirma la entrega en efectivo", () => {
  const [decision] = plan([hold()], [order({ status: "delivered", deliveredAt: NOW, paymentState: "paid", cashCollectedAt: NOW })]);
  assert.equal(decision.action, "release");
  assert.equal(decision.reason, "pedido_cobrado_en_efectivo");
});

test("una garantía huérfana no se adelanta por defecto", () => {
  const [decision] = plan([hold({ createdAt: new Date(NOW.getTime() - 48 * 36e5) })]);
  assert.equal(decision.action, "skip");
  assert.equal(decision.orphan, true);
});

test("con la antelación de huérfanas activada, la referencia sin pedido se libera", () => {
  const old = new Date(NOW.getTime() - 30 * 36e5);
  const [decision] = plan([hold({ createdAt: old, expiresAt: new Date(old.getTime() + COD_AUTHORIZATION_TTL_MS) })], [], {
    orphanReleaseHours: 24,
  });
  assert.equal(decision.action, "release");
  assert.equal(decision.reason, "referencia_huerfana");
  assert.equal(decision.orphan, true);
});

test("una retención ya resuelta nunca se vuelve a tocar", () => {
  const [decision] = plan([hold({ status: "captured" })], [], {});
  assert.equal(decision.action, "skip");
  assert.equal(decision.reason, "ya_resuelta");
});

test("el recuento separa lo liberado de lo que sólo se revisa", () => {
  const decisions = plan([hold(), hold({ reference: "ABC123", paymentIntentId: "pi_2" })], [
    order({ cashCollectedAt: NOW, paymentState: "paid" }),
  ]);
  const tally = tallyCodHoldDecisions(decisions);
  assert.equal(tally.inspected, 2);
  assert.equal(tally.released, 1);
  assert.equal(tally.releasedCents, 498);
  assert.equal(tally.skipped, 1);
  assert.equal(tally.orphans, 1);
});
