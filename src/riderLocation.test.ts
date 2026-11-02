import assert from "node:assert/strict";
import test from "node:test";
import { sanitizePing, isFresh, presentForCustomer, estimateArrival, distanceMeters } from "./riderLocation.js";

const centro = { latitude: 38.9906, longitude: -0.5189 };

test("un ping valido se acepta", () => {
  const r = sanitizePing({ orderId: "PIKI-1", riderId: "r1", latitude: 38.99, longitude: -0.51, accuracyMeters: 12 });
  assert.equal(r.ok, true);
});

test("sin pedido o sin rider se rechaza", () => {
  assert.equal(sanitizePing({ latitude: 38.99, longitude: -0.51, riderId: "r1" }).ok, false);
  assert.equal(sanitizePing({ latitude: 38.99, longitude: -0.51, orderId: "P" }).ok, false);
});

test("precision mala o coordenadas imposibles se rechazan", () => {
  assert.equal(sanitizePing({ orderId: "P", riderId: "r", latitude: 38.9, longitude: -0.5, accuracyMeters: 500 }).ok, false);
  assert.equal(sanitizePing({ orderId: "P", riderId: "r", latitude: 120, longitude: -0.5 }).ok, false);
});

test("una posicion vieja no se considera fresca", () => {
  const ahora = new Date("2026-11-02T10:00:00Z");
  assert.equal(isFresh(new Date("2026-11-02T09:59:30Z"), ahora), true);
  assert.equal(isFresh(new Date("2026-11-02T09:55:00Z"), ahora), false);
});

test("sin ping el cliente ve sin senal", () => {
  assert.equal(presentForCustomer(null, centro).status, "sin_senal");
});

test("cerca del domicilio se marca llegando", () => {
  const ping = { orderId: "P", riderId: "r", latitude: 38.9907, longitude: -0.5189, at: new Date() };
  const vista = presentForCustomer(ping, centro);
  assert.equal(vista.status, "llegando");
  assert.equal(vista.visible, true);
});

test("la distancia y la eta son razonables en ciudad", () => {
  const lejos = { latitude: 38.9996, longitude: -0.5189 };
  const { distanceMeters: m } = estimateArrival({ from: lejos, to: centro });
  assert.ok(m > 900 && m < 1100, `distancia ${m}`);
  assert.equal(distanceMeters(centro, centro), 0);
});
