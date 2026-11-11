import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { Restaurant } from "./models.js";
import { controlledMenuImportSchema, planControlledMenuImport, rawMenuHash, registerControlledMenuImportRoutes, type MenuImportDependencies } from "./menuSafeImport.js";
import { normalizePartnerMenuItems, partnerMenuItemsSchema } from "./menuContract.js";
import { customerMenuForRestaurant } from "./customerCatalogPolicy.js";
import { parseMenuText } from "./menuImport.js";
import { handleCustomerTrpc } from "./customerCompat.js";

const restaurantId = "64b000000000000000000001";
const tenantId = "64b000000000000000000002";
const assetId = "64b000000000000000000003";
const assetUrl = `https://api.pikidelivery.com/api/v1/catalog/assets/${assetId}`;
function sourceItems() { return [{ id: "existing", name: "Fuente", price: 7.5, allergens: null }, { id: "stable-new", name: "Nuevo", price: 2, allergens: ["Leche"] }]; }
function requestBody(extra: Record<string, unknown> = {}) { return { priceBasis: "source", legacyPolicy: "retain_unchanged", items: sourceItems(), ...extra }; }
function fixture(options: { race?: boolean; badAsset?: boolean; tenant?: unknown; approved?: boolean; transactionUnavailable?: boolean } = {}) {
  const stored: any = { _id: restaurantId, tenantId: options.tenant === undefined ? tenantId : options.tenant, name: "Restaurante sintético", slug: "offline-only", onboardingStatus: options.approved === false ? "pending" : "approved", updatedAt: new Date("2026-11-01T00:00:00Z"), priceIncludesCommission: false, privateSecret: "not-exported", menu: [{ id: "existing", name: "Anterior", price: 10, allergens: ["Gluten"] }, { id: "legacy", name: "Histórico", price: 12.37, extraUnknown: { deeply: [{ preserve: true }] }, allergens: null, image: "legacy-url-unchanged" }] };
  const routes = new Map<string, (req: Request, res: Response) => Promise<unknown>>();
  const calls: any = { reads: [], writes: [], assetReads: [], sessions: 0, ended: 0, effects: 0, middleware: 0 };
  let pending: any = null;
  const session: any = { async withTransaction(fn: () => Promise<unknown>) { await fn(); if (pending) Object.assign(stored, pending); }, async endSession() { calls.ended++; } };
  const deps: MenuImportDependencies = {
    requireOwner: () => { calls.middleware++; return (_req, _res, next) => next(); },
    isRootOwner: (req) => req.auth?.role === "admin" && req.auth.isRootOwner === true,
    tenantScope: (req) => req.auth?.isRootOwner ? {} : { tenantId: req.auth?.tenantId },
    objectId: (value) => /^[a-f0-9]{24}$/.test(value) ? value : null,
    restaurants: {
      async findOne(filter, opts) {
        calls.reads.push({ filter, opts });
        if (filter._id !== stored._id || filter.onboardingStatus !== stored.onboardingStatus || (filter.tenantId && filter.tenantId !== stored.tenantId)) return null;
        return Object.fromEntries(Object.keys(opts.projection).filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]));
      },
      async updateOne(filter, update, opts) {
        calls.writes.push({ filter, update, opts });
        assert.equal(opts.session, session); assert.equal(opts.upsert, false);
        assert.equal(filter.tenantId, tenantId); assert.equal(filter.onboardingStatus, "approved");
        assert.deepEqual(Object.keys(update), ["$set"]); assert.deepEqual(Object.keys(update.$set).sort(), ["menu", "updatedAt"]);
        if (options.race) { stored.menu = [...stored.menu, { id: "concurrent", name: "Otro editor", price: 1 }]; return { matchedCount: 0, modifiedCount: 0 }; }
        assert.deepEqual(filter.menu.$eq, stored.menu); assert.deepEqual(filter.updatedAt.$eq, stored.updatedAt);
        pending = update.$set; return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    assets: { async findOne(filter, opts) { calls.assetReads.push({ filter, opts }); assert.equal(filter.restaurantId, restaurantId); assert.equal(filter.tenantId, tenantId); assert.equal(filter.scanStatus, "clean"); assert.equal(filter.kind, "menu_image"); return options.badAsset ? null : { _id: assetId }; } },
    startSession: async () => { calls.sessions++; if (options.transactionUnavailable) throw new Error("unsupported-no-secrets"); return session; },
    publicAssetUrl: (id) => `https://api.pikidelivery.com/api/v1/catalog/assets/${id}`,
    imageMimeTypes: ["image/webp", "image/jpeg", "image/png", "image/gif"],
    afterApply: () => { calls.effects++; },
  };
  const app: any = { get(path: string, _middleware: unknown, fn: any) { routes.set(`GET ${path}`, fn); }, post(path: string, _middleware: unknown, fn: any) { routes.set(`POST ${path}`, fn); } };
  registerControlledMenuImportRoutes(app, deps);
  const invoke = async (body = requestBody(), auth: any = { role: "admin", employeeId: "owner-session-fixture", isRootOwner: true }, raw = false) => {
    const state: any = { status: 200, headers: {} };
    const res: any = { setHeader(key: string, value: string) { state.headers[key] = value; }, status(code: number) { state.status = code; return res; }, json(value: unknown) { state.body = value; return res; } };
    await routes.get(raw ? "GET /api/v1/admin/restaurants/:id/menu/raw" : "POST /api/v1/admin/restaurants/:id/menu/import")!({ auth, body, params: { id: restaurantId } } as any, res);
    return state;
  };
  const applyBody = (extra: Record<string, unknown> = {}) => requestBody({ dryRun: false, expectedMenuHash: rawMenuHash(stored.menu), expectedUpdatedAt: stored.updatedAt.toISOString(), ...extra });
  return { stored, calls, invoke, applyBody };
}

test("null/ausencia desconocidos y arrays explícitos sobreviven Zod, normalización, Mongoose y catálogo", () => {
  const values = [undefined, null, [], ["Leche", "Gluten"]];
  for (const allergens of values) {
    const input = { id: "fixture", name: "Plato", price: 7.5, ...(allergens === undefined ? {} : { allergens }) };
    const parsed = normalizePartnerMenuItems(partnerMenuItemsSchema.parse([input]));
    assert.deepEqual(parsed[0].allergens, allergens ?? null);
    const doc: any = new Restaurant({ name: "Fixture", slug: "offline-only", menu: [input] });
    assert.deepEqual(doc.menu[0].toObject().allergens, allergens ?? null);
    for (const flag of [false, true]) assert.deepEqual(customerMenuForRestaurant({ menu: parsed, priceIncludesCommission: flag })[0].allergens, allergens ?? null);
  }
  for (const allergens of ["Gluten", [1], Array(31).fill("x")]) assert.equal(partnerMenuItemsSchema.safeParse([{ id: "x", name: "x", price: 1, allergens }]).success, false);
  assert.equal(parseMenuText("Plato 7,50 €").items[0].allergens, null);
});

test("respuesta tRPC Customer mantiene desconocidos y declaraciones originales", async () => {
  const original = Restaurant.find;
  const menu = [undefined, null, [], ["Leche"]].map((allergens, i) => ({ id: `item-${i}`, name: "Fixture", price: 1, ...(allergens === undefined ? {} : { allergens }) }));
  const row = { _id: restaurantId, name: "Fixture", slug: "offline-only", isActive: true, onboardingStatus: "approved", availabilityStatus: "available", menu };
  const query: any = { select() { return query; }, sort() { return query; }, limit() { return query; }, lean() { return query; }, async exec() { return [row]; } };
  (Restaurant as any).find = () => query;
  try {
    let body: any;
    const res: any = { status() { return res; }, json(value: unknown) { body = value; return res; }, setHeader() {} };
    await handleCustomerTrpc({ originalUrl: "/api/trpc/catalog.list", url: "/api/trpc/catalog.list", params: { procedure: "catalog.list" }, query: {}, body: { json: {} }, method: "POST", header: () => undefined } as any, res);
    assert.deepEqual(body.result.data.json[0].menu.map((item: any) => item.allergens), [null, null, [], ["Leche"]]);
  } finally { (Restaurant as any).find = original; }
});

test("contrato exige IDs únicos, EUR fuente, policy explícita, CAS para aplicar y valida todos los items", () => {
  assert.equal(controlledMenuImportSchema.parse(requestBody()).dryRun, true);
  for (const body of [requestBody({ dryRun: false }), requestBody({ legacyPolicy: undefined }), requestBody({ priceBasis: "public" }), requestBody({ tenantId }), requestBody({ items: [sourceItems()[0], sourceItems()[0]] }), requestBody({ items: [{ ...sourceItems()[0], price: 1.001 }] }), requestBody({ items: [sourceItems()[0], { id: "bad", name: "Bad", price: -1 }] }), requestBody({ items: [{ ...sourceItems()[0], modifiers: [{ id: "same", name: "Bad", minSelections: 2, maxSelections: 1, options: ["Una"] }] }] })]) assert.equal(controlledMenuImportSchema.safeParse(body).success, false);
});

test("merge por ID conserva todo legacy, no recarga precios y nunca borra IDs", () => {
  const f = fixture();
  const legacy = f.stored.menu[1];
  const keep = planControlledMenuImport(f.stored.menu, controlledMenuImportSchema.parse(requestBody()));
  assert.deepEqual(keep.preview.counts, { before: 2, incoming: 2, matched: 1, created: 1, retainedLegacy: 1, after: 3, deleted: 0, availableAfter: 3, legacyAvailabilityChanged: 0, incomingUnknownAllergens: 1 });
  assert.equal(keep.menu[0].price, 7.5); assert.equal(keep.menu[2], legacy); assert.equal(keep.menu[2].price, 12.37);
  const pause = planControlledMenuImport(f.stored.menu, controlledMenuImportSchema.parse(requestBody({ legacyPolicy: "retain_ids_mark_unavailable" })));
  assert.deepEqual(pause.menu[2], { ...legacy, available: false }); assert.equal(legacy.available, undefined);
  assert.deepEqual(new Set(pause.menu.map((item) => item.id)), new Set(["existing", "stable-new", "legacy"]));
  assert.equal(rawMenuHash([{ b: 1, a: { z: 2, y: 3 } }]), rawMenuHash([{ a: { y: 3, z: 2 }, b: 1 }]));
  assert.notEqual(rawMenuHash([1, 2]), rawMenuHash([2, 1]));
  assert.throws(() => planControlledMenuImport([legacy, legacy], controlledMenuImportSchema.parse(requestBody())), /LEGACY_MENU_IDS/);
});

test("GET raw owner exporta menú completo y contexto/hash, no DB ni secretos", async () => {
  const f = fixture(); const r = await f.invoke(undefined, undefined, true);
  assert.equal(r.status, 200); assert.equal(r.headers["Cache-Control"], "no-store");
  assert.deepEqual(r.body.restaurant.menu, f.stored.menu); assert.equal(r.body.menuHash, rawMenuHash(f.stored.menu));
  assert.equal(r.body.restaurant.tenantId, tenantId); assert.equal(r.body.restaurant.priceIncludesCommission, false);
  assert.equal(r.body.restaurant.privateSecret, undefined); assert.equal(r.body.dbName, undefined); assert.equal(f.calls.middleware, 2);
  assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.sessions, 0);
});

test("dryRun por defecto devuelve matches/hash sin escrituras, sesiones ni notificaciones", async () => {
  const f = fixture(); const before = JSON.stringify(f.stored); const r = await f.invoke();
  assert.equal(r.status, 200); assert.equal(r.body.applied, false); assert.equal(r.body.dryRun, true);
  assert.deepEqual(r.body.matchedIds, ["existing"]); assert.deepEqual(r.body.retainedLegacyIds, ["legacy"]);
  assert.equal(JSON.stringify(f.stored), before); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.sessions, 0); assert.equal(f.calls.effects, 0);
});

test("aplicación hace CAS nativo exacto dentro de transacción y sólo modifica menu/updatedAt", async () => {
  const f = fixture(); const legacy = f.stored.menu[1]; const r = await f.invoke(f.applyBody({ legacyPolicy: "retain_ids_mark_unavailable", items: [{ ...sourceItems()[0], image: assetUrl }, sourceItems()[1]] }));
  assert.equal(r.status, 200); assert.equal(r.body.applied, true);
  assert.deepEqual(f.stored.menu[2], { ...legacy, available: false }); assert.equal(f.stored.priceIncludesCommission, false); assert.equal(f.stored.privateSecret, "not-exported");
  assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.effects, 1); assert.equal(f.calls.ended, 1);
  assert.equal(f.calls.reads[1].filter.tenantId, tenantId); assert.equal(f.calls.assetReads.length, 1); assert.ok(f.calls.assetReads[0].opts.session);
});

test("race de otro editor rechaza 409 sin aplicar ni emitir efectos", async () => {
  const f = fixture({ race: true }); const r = await f.invoke(f.applyBody());
  assert.equal(r.status, 409); assert.equal(r.body.error, "MENU_IMPORT_CONFLICT");
  assert.deepEqual(f.stored.menu.map((item: any) => item.id), ["existing", "legacy", "concurrent"]);
  assert.equal(f.stored.menu[0].price, 10); assert.equal(f.calls.effects, 0); assert.equal(f.calls.ended, 1);
});

test("hash/fecha obsoletos, assets ajenos/no clean y URL fabricada no escriben", async () => {
  for (const extra of [{ expectedMenuHash: "0".repeat(64) }, { expectedUpdatedAt: "2026-10-01T00:00:00.000Z" }]) {
    const f = fixture(); const r = await f.invoke(f.applyBody(extra)); assert.equal(r.status, 409); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.sessions, 0);
  }
  for (const dryRun of [true, false]) {
    const f = fixture({ badAsset: true }); const r = await f.invoke(f.applyBody({ dryRun, items: [{ ...sourceItems()[0], image: assetUrl }] }));
    assert.equal(r.status, 400); assert.equal(r.body.error, "MENU_ASSET_NOT_OWNED_OR_NOT_CLEAN"); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.effects, 0);
  }
  const f = fixture(); const r = await f.invoke(requestBody({ items: [{ ...sourceItems()[0], image: `${assetUrl}?fabricated=1` }] })); assert.equal(r.status, 400); assert.equal(f.calls.assetReads.length, 0);
});

test("sólo sesión root owner y restaurante existente aprobado con tenant real", async () => {
  for (const auth of [{ role: "partner", employeeId: "owner", isRootOwner: true }, { role: "admin", employeeId: "ordinary-admin" }, { role: "admin", isRootOwner: true }]) {
    const f = fixture(); const r = await f.invoke(undefined, auth); assert.equal(r.status, 403); assert.equal(f.calls.reads.length, 0);
  }
  for (const options of [{ tenant: null }, { tenant: "not-a-tenant" }, { approved: false }]) {
    const f = fixture(options); const r = await f.invoke(); assert.ok([404, 409].includes(r.status)); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.effects, 0);
  }
  const f = fixture({ transactionUnavailable: true }); const r = await f.invoke(f.applyBody()); assert.equal(r.status, 503); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.effects, 0);
});

test("importar server con arranque seguro monta rutas sin DB/HTTP/puertos", async () => {
  const { app } = await import("./server.js");
  const stack = (app as any)._router.stack;
  assert.ok(stack.some((layer: any) => layer.route?.path === "/api/v1/admin/restaurants/:id/menu/raw"));
  assert.ok(stack.some((layer: any) => layer.route?.path === "/api/v1/admin/restaurants/:id/menu/import"));
});
