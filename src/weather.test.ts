import test from "node:test";
import assert from "node:assert/strict";
import { adjustEtaLabel, conditionFromWeatherCode, deliveryPolicyFor, distanceKm, snapshotFromProvider } from "./weather.js";

test("los códigos WMO se agrupan en los estados que PIKI usa", () => {
  assert.equal(conditionFromWeatherCode(0), "clear");
  assert.equal(conditionFromWeatherCode(3), "cloudy");
  assert.equal(conditionFromWeatherCode(45), "cloudy");
  assert.equal(conditionFromWeatherCode(61), "rain");
  assert.equal(conditionFromWeatherCode(80), "rain");
  assert.equal(conditionFromWeatherCode(95), "storm");
  assert.equal(conditionFromWeatherCode(null), "clear");
});

test("la lluvia fuerte añade 15 minutos y prioriza cercanía", () => {
  const policy = deliveryPolicyFor("rain", 6, 20);
  assert.equal(policy.etaExtraMinutes, 15);
  assert.equal(policy.severity, 2);
  assert.equal(policy.preferNearby, true);
  assert.match(String(policy.banner), /15 minutos/);
});

test("la lluvia ligera añade 5 minutos", () => {
  const policy = deliveryPolicyFor("rain", 0.8, 10);
  assert.equal(policy.etaExtraMinutes, 5);
  assert.equal(policy.severity, 1);
});

test("el viento fuerte se trata como severidad máxima aunque no llueva", () => {
  const policy = deliveryPolicyFor("cloudy", 0, 65);
  assert.equal(policy.severity, 2);
  assert.equal(policy.etaExtraMinutes, 15);
});

test("un día despejado no añade retraso ni banner", () => {
  const policy = deliveryPolicyFor("clear", 0, 5);
  assert.equal(policy.etaExtraMinutes, 0);
  assert.equal(policy.banner, null);
  assert.equal(policy.preferNearby, false);
});

test("el snapshot del proveedor conserva temperatura y origen", () => {
  const snapshot = snapshotFromProvider({ current: { temperature_2m: 17.4, precipitation: 1.2, weather_code: 63, wind_speed_10m: 12 } });
  assert.equal(snapshot.condition, "rain");
  assert.equal(snapshot.temperatureC, 17.4);
  assert.equal(snapshot.source, "open-meteo");
  assert.equal(snapshot.etaExtraMinutes, 5);
});

test("el ETA se desplaza sin romper el rango", () => {
  assert.equal(adjustEtaLabel("20–35 min", 15), "35–50 min");
  assert.equal(adjustEtaLabel("25 min", 5), "30 min");
  assert.equal(adjustEtaLabel("20–35 min", 0), "20–35 min");
});

test("la distancia entre dos puntos de Xàtiva es plausible", () => {
  const distance = distanceKm({ lat: 38.9908, lon: -0.5185 }, { lat: 39.0, lon: -0.5185 });
  assert.ok(distance > 0.9 && distance < 1.2, `distancia inesperada: ${distance}`);
});
