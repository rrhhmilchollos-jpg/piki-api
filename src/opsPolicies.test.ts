import assert from "node:assert/strict";
import test from "node:test";
import { deliveredConfirmationResponse, deliveryCredentialNotLockedFilter, deliveryFailureAtomicUpdate, DELIVERY_CREDENTIAL_FAILURE_LIMIT, nextDeliveryFailureState, parseDeliveryCredential } from "./deliveryConfirmation.js";
import { fleetPublicView } from "./fleetView.js";
import { evaluateOpeningHours } from "./openingHours.js";
import { activeRecruitmentProvinces, resolveRecruitmentSelection } from "./recruitmentAreas.js";
import { customerAvailability } from "./customerAvailability.js";

test("horario canónico considera la franja nocturna del día anterior en Europe/Madrid", () => {
  const monday = { timeZone: "Europe/Madrid", regular: { lunes: [{ open: "19:00", close: "02:00", endsNextDay: true }] }, overrides: [] };
  assert.equal(evaluateOpeningHours(monday, new Date("2026-10-26T23:30:00.000Z")).open, true); // martes 00:30 CET
});

test("horario nocturno conserva la hora local a ambos lados del cambio DST de otoño", () => {
  const sunday = { timeZone: "Europe/Madrid", regular: { domingo: [{ open: "01:30", close: "03:30", endsNextDay: false }] }, overrides: [] };
  assert.equal(evaluateOpeningHours(sunday, new Date("2026-10-25T00:30:00.000Z")).open, true); // 02:30 CEST
  assert.equal(evaluateOpeningHours(sunday, new Date("2026-10-25T01:30:00.000Z")).open, true); // 02:30 CET
});

test("horario canónico respeta un cierre especial y varias franjas", () => {
  const schedule = {
    timeZone: "Europe/Madrid",
    regular: { martes: [{ open: "09:00", close: "12:00" }, { open: "13:00", close: "16:00" }, { open: "19:00", close: "23:00" }] },
    overrides: [{ date: "2026-10-27", closed: true, intervals: [] }],
  };
  assert.equal(evaluateOpeningHours(schedule, new Date("2026-10-27T12:30:00.000Z")).open, false);
  assert.equal(evaluateOpeningHours({ ...schedule, overrides: [] }, new Date("2026-10-27T12:30:00.000Z")).open, true);
});

test("reclutamiento publica únicamente Xàtiva activa parcial y valida selección coherente", () => {
  assert.deepEqual(activeRecruitmentProvinces().map((province) => province.code), ["46"]);
  assert.deepEqual(resolveRecruitmentSelection({ city: "Xativa" }), {
    localityCode: "46145", localityName: "Xàtiva", provinceCode: "46", provinceName: "Valencia", requestedZoneSlug: "xativa-casco-urbano-fase-1",
  });
  assert.equal(resolveRecruitmentSelection({ city: "Xàtiva", localityCode: "46145", provinceCode: "46", requestedZoneSlug: "otra-zona" }), null);
  assert.equal(resolveRecruitmentSelection({ city: "Valencia" }), null);
});

test("excepción de apertura sustituye el horario regular cerrado", () => {
  const schedule = {
    timeZone: "Europe/Madrid",
    regular: { martes: [] },
    overrides: [{ date: "2026-10-27", closed: false, intervals: [{ open: "12:00", close: "15:00" }] }],
  };
  assert.equal(evaluateOpeningHours(schedule, new Date("2026-10-27T11:30:00.000Z")).open, true);
});

test("adaptador Customer prioriza los campos canónicos y explica pausa frente a cierre horario", () => {
  const hours = { timeZone: "Europe/Madrid", regular: { martes: [{ open: "12:00", close: "15:00" }] }, overrides: [] };
  const now = new Date("2026-10-27T11:00:00.000Z");
  assert.deepEqual(customerAvailability({ isActive: true, onboardingStatus: "approved", availabilityStatus: "available", openingHours: hours }, now), {
    canOrder: true, isOpen: true, withinHours: true, reason: "open", orderable: true,
  });
  const paused = customerAvailability({ isActive: false, onboardingStatus: "approved", availabilityStatus: "available", openingHours: hours }, now);
  assert.equal(paused.canOrder, false);
  assert.equal(paused.reason, "paused");
});

test("vista de Fleet conserva id/name y no expone datos de manager", () => {
  const view = fleetPublicView({ _id: "fleet-1", name: "Legacy Fleet", city: "Xàtiva", localityName: "Xàtiva", provinceName: "Valencia", serviceZones: ["xativa"], managerName: "No debe salir", managerDni: "123" } as any, { xativa: "Xàtiva centro" });
  assert.equal(view.name, "Legacy Fleet");
  assert.equal(view.displayName, "Flota Xàtiva · Valencia");
  assert.deepEqual(view.serviceZoneNames, ["Xàtiva centro"]);
  assert.equal("managerName" in view, false);
  assert.equal("managerDni" in view, false);
});

test("confirmación admite PIN o QR, conserva body legado, limita fallos e identifica reintento", () => {
  assert.deepEqual(parseDeliveryCredential({ deliveryQr: "ABC123" }), { method: "pin", credential: "ABC123", idempotencyKey: null, legacy: true });
  assert.deepEqual(parseDeliveryCredential({ deliveryQr: "https://example.test/?order_id=o1&delivery_token=a" }), { method: "qr", credential: "https://example.test/?order_id=o1&delivery_token=a", idempotencyKey: null, legacy: true });
  assert.deepEqual(parseDeliveryCredential({ method: "qr", credential: "https://example.test/?delivery_token=a", idempotencyKey: "12345678" }), { method: "qr", credential: "https://example.test/?delivery_token=a", idempotencyKey: "12345678", legacy: false });
  assert.equal(parseDeliveryCredential({ credential: "PIN", deliveryQr: "QR" }), null);
  assert.equal(parseDeliveryCredential({ method: "qr", credential: "ABC123" }), null);
  let state: any = null;
  for (let index = 0; index < DELIVERY_CREDENTIAL_FAILURE_LIMIT; index += 1) state = nextDeliveryFailureState(state, new Date("2026-10-27T10:00:00.000Z"));
  assert.ok(state.lockedUntil);
  const response = deliveredConfirmationResponse({ _id: "o1", publicCode: "PIKI-1", status: "delivered", deliveredAt: new Date(), paymentMethod: "cash", cashCollectedAt: new Date() }, true);
  assert.equal(response.idempotent, true);
  assert.equal(response.order.status, "delivered");
  assert.equal(response.idempotent, true, "a retry returns the stored result without repeating delivery side effects");
});

test("lockout de entrega usa filtro vigente y pipeline atómico, no un set desde snapshot", () => {
  const now = new Date("2026-10-27T10:00:00.000Z");
  const filter = deliveryCredentialNotLockedFilter(now);
  assert.deepEqual(filter, { $or: [
    { "deliveryCredentialFailures.lockedUntil": null },
    { "deliveryCredentialFailures.lockedUntil": { $exists: false } },
    { "deliveryCredentialFailures.lockedUntil": { $lte: now } },
  ] });
  const pipeline = deliveryFailureAtomicUpdate(now);
  assert.equal(Array.isArray(pipeline), true);
  assert.equal(pipeline.length, 1);
  const failureState: any = (pipeline[0] as any).$set.deliveryCredentialFailures;
  assert.ok(failureState.$let, "the mutation derives failures from the document held by Mongo");
  assert.match(JSON.stringify(pipeline), /nextCount/);
  assert.match(JSON.stringify(pipeline), /lockedUntil/);
});
