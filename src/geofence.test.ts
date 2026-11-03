import assert from "node:assert/strict";
import test from "node:test";
import { distanceToGeometryMeters, mergeGeometries, pointInGeometry, pointInRing } from "./geofence.js";

const square = {
  type: "Polygon" as const,
  coordinates: [[[-0.54, 38.98], [-0.50, 38.98], [-0.50, 39.01], [-0.54, 39.01], [-0.54, 38.98]]],
};

test("un punto dentro del polígono se detecta como dentro", () => {
  assert.equal(pointInRing(38.995, -0.52, square.coordinates[0]), true);
  assert.equal(pointInGeometry(38.995, -0.52, square), true);
});

test("un punto fuera del polígono se detecta como fuera", () => {
  assert.equal(pointInGeometry(39.05, -0.52, square), false);
  assert.equal(pointInGeometry(38.995, -0.30, square), false);
});

test("la distancia al borde se mide en metros", () => {
  const distance = distanceToGeometryMeters(39.02, -0.52, square);
  // 0,01º de latitud son unos 1.110 m.
  assert.ok(distance > 1000 && distance < 1200, `distancia inesperada: ${distance}`);
});

test("un agujero interior no cuenta como zona de reparto", () => {
  const withHole = {
    type: "Polygon" as const,
    coordinates: [
      square.coordinates[0],
      [[-0.527, 38.99], [-0.513, 38.99], [-0.513, 39.0], [-0.527, 39.0], [-0.527, 38.99]],
    ],
  };
  assert.equal(pointInGeometry(38.995, -0.52, withHole), false);
  assert.equal(pointInGeometry(38.985, -0.535, withHole), true);
});

test("varios polígonos se unen en una sola geometría", () => {
  const other = {
    type: "Polygon" as const,
    coordinates: [[[-0.56, 38.96], [-0.54, 38.96], [-0.54, 38.98], [-0.56, 38.98], [-0.56, 38.96]]],
  };
  const merged = mergeGeometries([square, other]);
  assert.equal(merged?.type, "MultiPolygon");
  assert.equal(pointInGeometry(38.97, -0.55, merged), true);
  assert.equal(pointInGeometry(38.995, -0.52, merged), true);
});
