import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Request, Response } from "express";
import { CatalogEventStream, publicCatalogUpdate } from "./catalogRealtime.js";

const restaurant = {
  _id: "6acad53e7f55ddba7e05c189", slug: "rooster-kebab-xativa",
  isActive: true, onboardingStatus: "approved", availabilityStatus: "available",
  menu: [{ id: "meal", price: 9 }], email: "private@example.com",
  partnerProfile: { documents: ["secret"], bankAccount: "private" }, tenantId: "private-tenant",
};

test("catalog update whitelists only public ids and reason", () => {
  assert.deepEqual(publicCatalogUpdate(restaurant, "menu.updated"), {
    type: "catalog.updated",
    payload: { restaurantId: restaurant._id, slug: restaurant.slug, reason: "menu.updated" },
  });
  assert.equal(JSON.stringify(publicCatalogUpdate(restaurant)).includes("private"), false);
});

test("hidden, paused and deleted restaurants invalidate without leaking identifiers", () => {
  for (const hidden of [null, { ...restaurant, internalDemo: true }, { ...restaurant, slug: "kings-tacos-xativa" }, { ...restaurant, isActive: false }, { ...restaurant, onboardingStatus: "rejected" }]) {
    assert.deepEqual(publicCatalogUpdate(hidden).payload, { reason: "restaurant.updated" });
  }
});

function client(stream: CatalogEventStream) {
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), {
    output: "", headers: {} as Record<string, string>, destroyed: false, writableEnded: false,
    statusCode: 200, body: null as unknown,
    status(status: number) { this.statusCode = status; return this; },
    json(body: unknown) { this.body = body; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    flushHeaders() {},
    write(value: string) { this.output += value; return true; },
  });
  stream.serve(request as Request, response as unknown as Response);
  return { request, response, close: () => response.emit("close") };
}

test("anonymous SSE receives ready, committed updates and cleans up on disconnect", () => {
  const stream = new CatalogEventStream();
  const first = client(stream);
  try {
    assert.match(first.response.output, /event: ready/);
    assert.equal(first.response.headers["Cache-Control"], "no-store, no-transform");
    stream.publish(publicCatalogUpdate(restaurant, "menu.updated"));
    assert.match(first.response.output, /event: catalog.updated/);
    assert.match(first.response.output, /menu.updated/);
    first.close();
    const closedOutput = first.response.output;
    stream.publish(publicCatalogUpdate(restaurant, "store.status_updated"));
    assert.equal(first.response.output, closedOutput);
    const reconnected = client(stream);
    try {
      assert.match(reconnected.response.output, /"type":"ready"/);
    } finally { reconnected.close(); }
  } finally { first.close(); }
});

test("Partner fixture menu update emits a public invalidation for Customers only", () => {
  const fixture = {
    _id: "fixture-partner-menu-sync",
    slug: "fixture-partner-menu-sync",
    isActive: true,
    onboardingStatus: "approved",
    availabilityStatus: "available",
    menu: [{ id: "sync-fixture-bowl-001", name: "Bowl de prueba de sincronización", price: 9.9 }],
  };
  const stream = new CatalogEventStream();
  const subscriber = client(stream);
  try {
    stream.publish(publicCatalogUpdate(fixture, "partner.menu.updated"));
    assert.match(subscriber.response.output, /"restaurantId":"fixture-partner-menu-sync"/);
    assert.match(subscriber.response.output, /partner\.menu\.updated/);
    assert.doesNotMatch(subscriber.response.output, /Bowl de prueba de sincronización|sync-fixture-bowl-001/);
  } finally { subscriber.close(); }
});

test("SSE connection limit is enforced and disconnected clients release their slot once", () => {
  const stream = new CatalogEventStream(2, 1);
  const first = client(stream);
  const blocked = client(stream);
  try {
    assert.equal(blocked.response.statusCode, 429);
    assert.equal(blocked.response.headers["Retry-After"], "20");
    first.close();
    first.request.emit("close");
    const replacement = client(stream);
    try {
      assert.equal(replacement.response.statusCode, 200);
      assert.match(replacement.response.output, /event: ready/);
    } finally { replacement.close(); }
  } finally { first.close(); blocked.close(); }
});
