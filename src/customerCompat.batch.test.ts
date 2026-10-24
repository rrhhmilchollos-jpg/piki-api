import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { handleCustomerTrpc } from "./customerCompat.js";
import { Restaurant } from "./models.js";

const partner = {
  _id: "fixture-partner-001",
  slug: "sync-fixture-partner",
  name: "Partner de prueba de sincronización",
  cuisine: "Pruebas",
  category: "Pruebas",
  locality: "Xàtiva",
  availabilityStatus: "available",
  isActive: true,
  onboardingStatus: "approved",
  menu: [{ id: "sync-fixture-bowl-001", name: "Bowl de prueba", price: 8.5, available: true }],
};

async function invokeBatch(method: "GET" | "POST") {
  let statusCode = 200;
  let responseBody: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { responseBody = body; return this; },
    setHeader() { return this; },
  } as unknown as Response;
  const batchInput = {
    "0": { json: null, meta: { values: ["undefined"] } },
    "1": { json: { category: null, query: null }, meta: { values: { category: ["undefined"], query: ["undefined"] } } },
  };
  const input = JSON.stringify(batchInput);
  const request = {
    originalUrl: method === "GET"
      ? `/api/trpc/auth.me,catalog.list?batch=1&input=${encodeURIComponent(input)}`
      : "/api/trpc/auth.me,catalog.list?batch=1",
    url: "/api/trpc/auth.me,catalog.list",
    path: "/api/trpc/auth.me,catalog.list",
    params: { procedure: "auth.me,catalog.list" },
    query: method === "GET" ? { batch: "1", input } : { batch: "1" },
    body: method === "POST" ? batchInput : {},
    method,
    header: () => undefined,
  } as unknown as Request;
  await handleCustomerTrpc(request, response);
  return { statusCode, responseBody };
}

function assertCatalogBatchResponse(result: Awaited<ReturnType<typeof invokeBatch>>) {
  assert.equal(result.statusCode, 200);
  assert.ok(Array.isArray(result.responseBody));
  const results = result.responseBody as any[];
  assert.equal(results.length, 2);
  assert.equal(results[0]?.result?.data?.json, null);
  assert.equal(results[1]?.result?.data?.json?.[0]?.name, "Partner de prueba de sincronización");
  assert.equal(results[1]?.result?.data?.json?.[0]?.menu?.[0]?.id, "sync-fixture-bowl-001");
}

test("resuelve auth.me y catalog.list juntos en batches GET y POST", async () => {
  const originalFind = (Restaurant as any).find;
  (Restaurant as any).find = () => ({
    sort() { return this; },
    lean() { return this; },
    async exec() { return [partner]; },
  });

  try {
    assertCatalogBatchResponse(await invokeBatch("GET"));
    assertCatalogBatchResponse(await invokeBatch("POST"));
  } finally {
    (Restaurant as any).find = originalFind;
  }
});
