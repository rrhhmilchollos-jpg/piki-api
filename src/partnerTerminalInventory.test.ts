import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Express, Request, RequestHandler, Response } from "express";
import mongoose from "mongoose";
import { Restaurant } from "./models.js";
import {
  PARTNER_TERMINAL_INVENTORY_PATH, PartnerTerminalInventory,
  partnerTerminalInputSchema, partnerTerminalInventorySchema,
  registerPartnerTerminalInventoryRoutes, serializePartnerTerminal,
} from "./partnerTerminalInventory.js";

// Deliberately fictional identifiers: never use actual device/customer data here.
const SHOP = "aaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT = "bbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_SHOP = "cccccccccccccccccccccccc";
const OTHER_TENANT = "dddddddddddddddddddddddd";
const EMPLOYEE = "eeeeeeeeeeeeeeeeeeeeeeee";
const IMEI = "000000000001234";
const input = { model: "SUNMI_V2" as const, serialNumber: "fake-pda_01", imeiSim1: IMEI };
const normalized = partnerTerminalInputSchema.parse(input);
const now = new Date("2026-01-01T00:00:00.000Z");
function row(extra: Record<string, unknown> = {}): any {
  return { _id: "ffffffffffffffffffffffff", tenantId: TENANT, restaurantId: SHOP,
    ...normalized, imeiSim1Last4: "1234", provisioningStatus: "pending_configuration", kioskStatus: "unverified",
    createdByEmployeeId: EMPLOYEE, createdAt: now, updatedAt: now, ...extra };
}
function harness(t: TestContext, config: {
  restaurant?: any; existing?: any; records?: any[]; authenticatedTenant?: string | null;
  ownerDenied?: boolean; error?: unknown; race?: any; createError?: unknown;
} = {}) {
  const routes: Record<string, RequestHandler[]> = {};
  const calls = { restaurant: [] as any[], find: [] as any[], serial: [] as any[], create: [] as any[], selects: [] as string[], owner: 0 };
  let stored = config.existing ?? null;
  t.mock.method(PartnerTerminalInventory.collection, "createIndex", (async (fields: any, options: any) => {
    assert.deepEqual(fields, { serialNumber: 1 }); assert.equal(options.unique, true);
    return "serialNumber_1";
  }) as any);
  function query(value: any) {
    return { select(fields: string) { calls.selects.push(fields); return this; }, sort() { return this; }, lean() { return this; },
      async exec() { if (config.error) throw config.error; return value; } };
  }
  const restaurant = Object.hasOwn(config, "restaurant") ? config.restaurant : { _id: SHOP, tenantId: TENANT, name: "Fictional shop" };
  t.mock.method(Restaurant, "findOne", ((filter: any) => {
    calls.restaurant.push(filter);
    const allowed = restaurant && String(filter._id) === String(restaurant._id)
      && (!Object.hasOwn(filter, "tenantId") || String(filter.tenantId) === String(restaurant.tenantId));
    return query(allowed ? restaurant : null);
  }) as any);
  t.mock.method(PartnerTerminalInventory, "find", ((filter: any) => {
    calls.find.push(filter);
    return query((config.records ?? (stored ? [stored] : [])).filter((record: any) =>
      String(record.restaurantId) === String(filter.restaurantId) && String(record.tenantId) === String(filter.tenantId)));
  }) as any);
  t.mock.method(PartnerTerminalInventory, "findOne", ((filter: any) => { calls.serial.push(filter); return query(stored); }) as any);
  t.mock.method(PartnerTerminalInventory, "create", (async (document: any) => {
    calls.create.push(document);
    if (Object.hasOwn(config, "race")) { stored = config.race; throw { code: 11000, message: `private ${IMEI}` }; }
    if (config.createError) throw config.createError;
    stored = row(document);
    return new PartnerTerminalInventory(stored);
  }) as any);
  const owner: RequestHandler = (_req, res, next) => {
    calls.owner++;
    if (config.ownerDenied) { res.status(403).json({ error: "SUPERADMIN_ONLY" }); return; }
    next();
  };
  const app = Object.fromEntries(["get", "post"].map((method) => [method,
    (path: string, ...handlers: RequestHandler[]) => { assert.equal(path, PARTNER_TERMINAL_INVENTORY_PATH); routes[method] = handlers; },
  ])) as unknown as Pick<Express, "get" | "post">;
  registerPartnerTerminalInventoryRoutes(app, {
    ownerMiddleware: owner,
    restaurantScope: (_req, id) => config.authenticatedTenant === null ? { _id: id }
      : { _id: id, tenantId: config.authenticatedTenant ?? TENANT },
  });
  assert.equal(routes.get[0], owner); assert.equal(routes.post[0], owner);
  async function request(method: "get" | "post", body: unknown = input, id = SHOP) {
    const req = { params: { id }, body, auth: { employeeId: EMPLOYEE, role: "admin" } } as unknown as Request;
    const result = { status: 200, body: undefined as any, headers: {} as Record<string, unknown> };
    const res = { status(code: number) { result.status = code; return this; }, json(value: unknown) { result.body = value; return this; },
      setHeader(key: string, value: unknown) { result.headers[key] = value; } } as unknown as Response;
    let allowed = false;
    routes[method][0](req, res, () => { allowed = true; });
    if (allowed) await routes[method][1](req, res, () => { throw new Error("Unexpected next"); });
    return result;
  }
  return { request, calls };
}

const publicKeys = ["id", "restaurantId", "model", "serialNumber", "imeiSim1Last4", "kioskRequested", "provisioningStatus", "kioskStatus", "createdAt", "updatedAt"].sort();
function assertPublic(record: any) {
  assert.deepEqual(Object.keys(record).sort(), publicKeys);
  assert.equal(record.provisioningStatus, "pending_configuration"); assert.equal(record.kioskStatus, "unverified");
  assert.equal(JSON.stringify(record).includes(IMEI), false);
}

test("strict input normalizes serial, supports only SUNMI models, defaults kiosk preference and validates boundaries", () => {
  assert.equal(normalized.serialNumber, "FAKE-PDA_01"); assert.equal(normalized.kioskRequested, true);
  assert.equal(partnerTerminalInputSchema.parse({ model: "SUNMI_V2S", serialNumber: "  fake_2  ", kioskRequested: false }).serialNumber, "FAKE_2");
  for (const serialNumber of ["short", "X".repeat(65), "FAKE PDA", "FAKE\nPDA", "FAKE/PDA", ""]) {
    assert.equal(partnerTerminalInputSchema.safeParse({ ...input, serialNumber }).success, false);
  }
  for (const serialNumber of ["X".repeat(6), "X".repeat(64)]) assert.equal(partnerTerminalInputSchema.safeParse({ ...input, serialNumber }).success, true);
  for (const imeiSim1 of ["0".repeat(14), "0".repeat(16), "abc000000001234", 1234, null]) {
    assert.equal(partnerTerminalInputSchema.safeParse({ ...input, imeiSim1 }).success, false);
  }
  for (const extra of [{ model: "UNKNOWN" }, { kioskRequested: "true" }, { tenantId: TENANT }, { restaurantId: SHOP },
    { provisioningStatus: "enrolled" }, { kioskStatus: "active" }, { kioskObserved: true }, { clientKioskConfirmed: true }, { token: "fake" }]) {
    assert.equal(partnerTerminalInputSchema.safeParse({ ...input, ...extra }).success, false);
  }
});

test("pure model has global unique serial, private IMEI, immutable ownership and inventory-only defaults", () => {
  assert.equal(mongoose.connection.readyState, 0);
  assert.equal(PartnerTerminalInventory.collection.name, "partner_terminal_inventory");
  assert.equal(partnerTerminalInventorySchema.path("imeiSim1").options.select, false);
  assert.equal(partnerTerminalInventorySchema.path("restaurantId").options.immutable, true);
  assert.equal(partnerTerminalInventorySchema.path("tenantId").options.immutable, true);
  assert(partnerTerminalInventorySchema.indexes().some(([fields, options]) => fields.serialNumber === 1 && options.unique === true));
  const document = new PartnerTerminalInventory({ tenantId: TENANT, restaurantId: SHOP, model: "SUNMI_V2S", serialNumber: " fake_2 " });
  assert.equal(document.validateSync(), undefined); assert.equal(document.serialNumber, "FAKE_2");
  assert.equal(document.provisioningStatus, "pending_configuration"); assert.equal(document.kioskStatus, "unverified");
  assert.equal(document.kioskRequested, true); assert.equal(document.imeiSim1Last4, null);
  assertPublic(serializePartnerTerminal(row({ credentials: "fake", token: "fake", nativeBound: true })));
});

test("owner middleware precedes both route handlers and denied owners trigger no model access", async (t) => {
  const h = harness(t, { ownerDenied: true });
  for (const method of ["get", "post"] as const) assert.equal((await h.request(method)).status, 403);
  assert.equal(h.calls.owner, 2); assert.equal(h.calls.restaurant.length, 0); assert.equal(h.calls.create.length, 0);
});

test("invalid IDs are rejected before querying either model", async (t) => {
  const h = harness(t);
  for (const method of ["get", "post"] as const) {
    const result = await h.request(method, input, "not-an-object-id");
    assert.equal(result.status, 400); assert.equal(result.body.error, "INVALID_RESTAURANT_ID");
  }
  assert.equal(h.calls.restaurant.length, 0); assert.equal(h.calls.find.length, 0); assert.equal(h.calls.serial.length, 0);
});

test("foreign restaurants remain indistinguishable from absent scoped restaurants", async (t) => {
  const h = harness(t, { restaurant: { _id: SHOP, tenantId: OTHER_TENANT } });
  for (const method of ["get", "post"] as const) {
    const result = await h.request(method); assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: "RESTAURANT_NOT_FOUND" });
  }
  assert.deepEqual(h.calls.restaurant[0], { _id: SHOP, tenantId: TENANT });
  assert.equal(h.calls.create.length, 0); assert.equal(h.calls.find.length, 0); assert.equal(h.calls.serial.length, 0);
});

test("root scope cannot invent a missing restaurant tenant", async (t) => {
  for (const tenantId of [undefined, null, "invalid"]) {
    const h = harness(t, { restaurant: { _id: SHOP, tenantId }, authenticatedTenant: null });
    for (const method of ["get", "post"] as const) {
      const result = await h.request(method); assert.equal(result.status, 409); assert.equal(result.body.error, "TENANT_CONTEXT_REQUIRED");
    }
    assert.equal(h.calls.find.length, 0); assert.equal(h.calls.create.length, 0);
    t.mock.restoreAll();
  }
});

test("POST creates from scoped restaurant tenant; replay never writes or changes timestamps", async (t) => {
  const h = harness(t, { restaurant: { _id: SHOP, tenantId: OTHER_TENANT }, authenticatedTenant: null });
  const created = await h.request("post", { ...input, serialNumber: "  fake-pda_01  " });
  assert.equal(created.status, 201); assert.equal(created.body.created, true); assertPublic(created.body.terminal);
  assert.equal(h.calls.create[0].tenantId, OTHER_TENANT); assert.equal(h.calls.create[0].createdByEmployeeId, EMPLOYEE);
  assert.equal(h.calls.create[0].imeiSim1Last4, "1234");
  const replay = await h.request("post"); assert.equal(replay.status, 200); assert.equal(replay.body.created, false);
  assert.equal(h.calls.create.length, 1); assert.deepEqual(replay.body.terminal, created.body.terminal);
});

test("GET returns only scoped terminals without opting into IMEI", async (t) => {
  const h = harness(t, { records: [row(), row({ restaurantId: OTHER_SHOP }), row({ tenantId: OTHER_TENANT })] });
  const result = await h.request("get"); assert.equal(result.status, 200); assert.equal(result.body.count, 1);
  assertPublic(result.body.terminals[0]); assert.deepEqual(h.calls.find[0], { tenantId: TENANT, restaurantId: SHOP });
  assert.equal(h.calls.selects.includes("+imeiSim1"), false); assert.equal(h.calls.selects[0], "_id tenantId name");
  assert.equal(result.headers["Cache-Control"], "private, no-store");
});

test("unknown fields cannot forge ownership/provisioning/kiosk or leak validation input", async (t) => {
  const h = harness(t);
  for (const field of ["tenantId", "restaurantId", "provisioningStatus", "kioskStatus", "kioskObserved", "clientKioskConfirmed"]) {
    const result = await h.request("post", { ...input, [field]: IMEI });
    assert.equal(result.status, 400); assert.deepEqual(result.body, { error: "INVALID_TERMINAL_INPUT" });
  }
  assert.equal(h.calls.create.length, 0); assert.equal(h.calls.serial.length, 0);
});

test("same serial with another restaurant/tenant/model/IMEI/preference conflicts without overwrites", async (t) => {
  for (const extra of [{ restaurantId: OTHER_SHOP }, { tenantId: OTHER_TENANT }, { model: "SUNMI_V2S" },
    { imeiSim1: "000000000009999" }, { imeiSim1: undefined }, { kioskRequested: false }]) {
    const h = harness(t, { existing: row(extra) });
    const result = await h.request("post"); assert.equal(result.status, 409);
    assert.deepEqual(result.body, { error: "TERMINAL_INVENTORY_CONFLICT" }); assert.equal(h.calls.create.length, 0);
    t.mock.restoreAll();
  }
  const h = harness(t, { existing: row() });
  assert.equal((await h.request("post", { model: input.model, serialNumber: input.serialNumber })).status, 409);
});

test("no-IMEI creation/replay returns null last4 and false preference unchanged", async (t) => {
  const h = harness(t); const body = { model: "SUNMI_V2S", serialNumber: "FAKE-PDA_02", kioskRequested: false };
  const result = await h.request("post", body); assert.equal(result.status, 201); assert.equal(result.body.terminal.imeiSim1Last4, null);
  assert.equal(result.body.terminal.kioskRequested, false); assert.equal((await h.request("post", body)).status, 200);
});

test("duplicate-key race replays exact winner but conflicting/absent winners return generic 409", async (t) => {
  for (const winner of [row(), row({ restaurantId: OTHER_SHOP }), row({ tenantId: OTHER_TENANT }), row({ kioskRequested: false }), null]) {
    const h = harness(t, { race: winner }); const result = await h.request("post");
    const identical = winner?.restaurantId === SHOP && winner?.tenantId === TENANT && winner?.kioskRequested === true;
    assert.equal(result.status, identical ? 200 : 409); assert.equal(h.calls.create.length, 1); assert.equal(h.calls.serial.length, 2);
    if (identical) { assert.equal(result.body.created, false); assertPublic(result.body.terminal); }
    else assert.deepEqual(result.body, { error: "TERMINAL_INVENTORY_CONFLICT" });
    t.mock.restoreAll();
  }
});

test("query and create failures expose only generic service-unavailable codes", async (t) => {
  for (const config of [{ error: new Error(`private ${IMEI}`) }, { createError: new Error(`private ${IMEI}`) }]) {
    const h = harness(t, config); const result = await h.request("post");
    assert.equal(result.status, 503); assert.deepEqual(result.body, { error: "TERMINAL_INVENTORY_UNAVAILABLE" });
    t.mock.restoreAll();
  }
  const h = harness(t, { error: new Error(`private ${IMEI}`) });
  assert.deepEqual((await h.request("get")).body, { error: "TERMINAL_INVENTORY_UNAVAILABLE" });
});
