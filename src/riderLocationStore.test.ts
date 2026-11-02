import assert from "node:assert/strict";
import test from "node:test";
import { savePing, readPing, toDoc, riderOwnsOrder } from "./riderLocationStore.js";
import type { LocationDoc } from "./riderLocationStore.js";

function fake() {
  let stored: LocationDoc | null = null;
  const calls: any[] = [];
  const col = {
    async createIndex(spec: any, options: any) { calls.push([spec, options]); return "ok"; },
    async updateOne(filter: any, update: any, options: any) {
      stored = { ...(stored || {}), ...update.$set } as LocationDoc;
      calls.push([filter, options]);
      return "ok";
    },
    async findOne(filter: any) { return stored && stored.orderId === filter.orderId ? stored : null; },
  };
  return { col, calls, get: () => stored };
}

test("un ping se guarda y se puede leer", async () => {
  const f = fake();
  const ping = { orderId: "PIKI-1", riderId: "r1", latitude: 38.99, longitude: -0.51, at: new Date("2026-11-02T10:00:00Z") };
  await savePing(f.col as any, ping);
  const leido = await readPing(f.col as any, "PIKI-1");
  assert.equal(leido?.latitude, 38.99);
  assert.equal(leido?.riderId, "r1");
});

test("caduca a las 12 horas", () => {
  const doc = toDoc({ orderId: "P", riderId: "r", latitude: 1, longitude: 1, at: new Date("2026-11-02T10:00:00Z") });
  assert.equal(doc.expiresAt.getTime() - doc.at.getTime(), 12 * 3600 * 1000);
});

test("el ping se sobrescribe, no se acumula historico", async () => {
  const f = fake();
  await savePing(f.col as any, { orderId: "P", riderId: "r", latitude: 1, longitude: 1, at: new Date() });
  await savePing(f.col as any, { orderId: "P", riderId: "r", latitude: 2, longitude: 2, at: new Date() });
  const leido = await readPing(f.col as any, "P");
  assert.equal(leido?.latitude, 2);
});

test("solo el rider asignado puede escribir la posicion", () => {
  assert.equal(riderOwnsOrder({ riderId: "r1" }, "r1"), true);
  assert.equal(riderOwnsOrder({ riderId: "r1" }, "r2"), false);
  assert.equal(riderOwnsOrder(null, "r2"), true);
});
