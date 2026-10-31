import assert from "node:assert/strict";
import test from "node:test";
import { quoteDeliveryRoute } from "./coverage/routing.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.GOOGLE_MAPS_API_KEY;

test("a Google network error still falls back to a valid OSRM route", async () => {
  const requests: string[] = [];
  process.env.GOOGLE_MAPS_API_KEY = "test-only-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input); requests.push(url);
    if (url.includes("googleapis.com")) throw new Error("simulated network outage");
    return new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 900, duration: 300 }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const result = await quoteDeliveryRoute([-0.52131, 38.99131], [-0.52132, 38.99132]);
    assert.equal(requests.length, 2);
    assert.equal(result.routeProvider, "osrm");
    assert.equal(result.routeDistanceKm, 0.9);
    assert.equal(result.routingDegraded, false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  }
});

test("null route durations are rejected instead of being coerced to zero", async () => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 900, duration: null }] }), { status: 200 })) as typeof fetch;
  try {
    const result = await quoteDeliveryRoute([-0.52231, 38.99231], [-0.52232, 38.99232]);
    assert.equal(result.routeProvider, "unavailable");
    assert.equal(result.routingDegraded, true);
    assert.equal(result.routeDistanceKm, null);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GOOGLE_MAPS_API_KEY; else process.env.GOOGLE_MAPS_API_KEY = originalKey;
  }
});
