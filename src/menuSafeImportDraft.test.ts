import assert from "node:assert/strict";
import test from "node:test";
import type { Request, RequestHandler, Response } from "express";
import { rawMenuHash, registerControlledMenuImportRoutes, type MenuImportDependencies } from "./menuSafeImport.js";

const restaurantId = "64b000000000000000000101";
const tenantId = "64b000000000000000000102";
const otherTenantId = "64b000000000000000000103";
const assetId = "64b000000000000000000104";
const assetUrl = `https://api.pikidelivery.com/api/v1/catalog/assets/${assetId}`;
const owner = { role: "admin", employeeId: "synthetic-owner-session", isRootOwner: true };
const draftGet = "GET /api/v1/admin/restaurants/:id/menu/raw-draft";
const draftPost = "POST /api/v1/admin/restaurants/:id/menu/draft-import";
function items() {
  return [
    { id: "source-1", name: "Synthetic source item", price: 7.5, image: "", available: false, allergens: null },
    { id: "source-2", name: "Synthetic unknown allergens", price: 12.37, image: "", available: false },
  ];
}
function body(extra: Record<string, unknown> = {}) {
  return { priceBasis: "source", legacyPolicy: "retain_ids_mark_unavailable", items: items(), ...extra };
}
function fixture(options: {
  stored?: Record<string, unknown>;
  scope?: Record<string, unknown>;
  writeRace?: boolean;
  duringTransaction?: Record<string, unknown>;
  badAsset?: boolean;
  transactionUnavailable?: boolean;
} = {}) {
  const stored: any = {
    _id: restaurantId, tenantId, name: "Offline synthetic partner", slug: "offline-only",
    listingType: "official_partner", onboardingStatus: "pending_review", isActive: false,
    priceIncludesCommission: false, updatedAt: new Date("2026-11-01T00:00:00.000Z"), menuRevision: 9,
    marketplaceCompliance: { status: "pending", nestedUnknown: { retain: true } },
    contract: { commissionBps: 1800, deliveryFeeCents: 399 },
    roles: ["unchanged"], payment: { status: "unchanged" }, privateSecret: "never-exported",
    menu: [{ id: "legacy", name: "Historic", price: 12.37, allergens: null, available: true, image: "historic-url", custom: { deep: [{ historical: true }] } }],
    ...options.stored,
  };
  const calls: any = { reads: [], writes: [], assets: [], sessions: 0, ended: 0, effects: 0, middleware: 0 };
  const routes = new Map<string, { middleware: RequestHandler; handler: (req: Request, res: Response) => Promise<unknown> }>();
  let pending: any;
  const matches = (filter: any) => Object.entries(filter).every(([key, value]: [string, any]) =>
    value && typeof value === "object" && Object.hasOwn(value, "$eq")
      ? JSON.stringify(stored[key]) === JSON.stringify(value.$eq)
      : stored[key] === value);
  const session: any = {
    async withTransaction(fn: () => Promise<unknown>) {
      if (options.duringTransaction) Object.assign(stored, structuredClone(options.duringTransaction));
      await fn();
      if (pending) Object.assign(stored, pending);
    },
    async endSession() { calls.ended++; },
  };
  const deps: MenuImportDependencies = {
    requireOwner: () => {
      calls.middleware++;
      return (req, res, next) => {
        if (!req.auth) return void res.status(401).json({ error: "AUTHENTICATION_REQUIRED" });
        if (req.auth.role !== "admin" || !req.auth.employeeId) return void res.status(403).json({ error: "SUPERADMIN_ONLY" });
        if (req.auth.mustChangePassword) return void res.status(428).json({ error: "PASSWORD_CHANGE_REQUIRED" });
        next();
      };
    },
    isRootOwner: (req) => req.auth?.role === "admin" && req.auth?.isRootOwner === true,
    tenantScope: () => options.scope ?? {},
    objectId: (id) => /^[a-f0-9]{24}$/.test(id) ? id : null,
    restaurants: {
      async findOne(filter, opts) {
        calls.reads.push({ filter, opts });
        if (!matches(filter)) return null;
        return structuredClone(Object.fromEntries(Object.keys(opts.projection).filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]])));
      },
      async updateOne(filter, update, opts) {
        calls.writes.push({ filter, update, opts });
        assert.equal(opts.session, session);
        assert.equal(opts.upsert, false);
        assert.deepEqual(Object.keys(update).sort(), ["$inc", "$set"]);
        assert.deepEqual(Object.keys(update.$set).sort(), ["menu", "updatedAt"]);
        assert.deepEqual(update.$inc, { menuRevision: 1 });
        if (options.writeRace) stored.menu.push({ id: "concurrent", price: 1, available: false });
        if (!matches(filter)) return { matchedCount: 0, modifiedCount: 0 };
        pending = { ...update.$set, menuRevision: stored.menuRevision + 1 };
        return { matchedCount: 1, modifiedCount: 1 };
      },
    },
    assets: {
      async findOne(filter, opts) {
        calls.assets.push({ filter, opts });
        assert.deepEqual(filter, {
          _id: assetId, restaurantId, tenantId, kind: "menu_image",
          mimeType: { $in: ["image/webp", "image/jpeg", "image/png", "image/gif"] },
          scanStatus: "clean", scanEngine: "ClamAV", scannedAt: { $type: "date" },
        });
        return options.badAsset ? null : { _id: assetId };
      },
    },
    startSession: async () => {
      calls.sessions++;
      if (options.transactionUnavailable) throw new Error("Synthetic unsupported transaction");
      return session;
    },
    publicAssetUrl: (id) => `https://api.pikidelivery.com/api/v1/catalog/assets/${id}`,
    imageMimeTypes: ["image/webp", "image/jpeg", "image/png", "image/gif"],
    afterApply: () => { calls.effects++; },
  };
  const app: any = {
    get(path: string, middleware: RequestHandler, handler: any) { routes.set(`GET ${path}`, { middleware, handler }); },
    post(path: string, middleware: RequestHandler, handler: any) { routes.set(`POST ${path}`, { middleware, handler }); },
  };
  registerControlledMenuImportRoutes(app, deps);
  async function invoke(input: any = body(), auth: any = owner, path = draftPost, id = restaurantId, runMiddleware = true) {
    const state: any = { status: 200, headers: {} };
    const res: any = {
      setHeader(key: string, value: string) { state.headers[key] = value; },
      status(code: number) { state.status = code; return res; },
      json(value: unknown) { state.body = value; return res; },
    };
    const req: any = { body: input, auth, params: { id } };
    const route = routes.get(path)!;
    if (runMiddleware) {
      let allowed = false;
      await route.middleware(req, res, () => { allowed = true; });
      if (!allowed) return state;
    }
    await route.handler(req, res);
    return state;
  }
  function applyBody(extra: Record<string, unknown> = {}) {
    return body({ dryRun: false, expectedMenuHash: rawMenuHash(stored.menu), expectedUpdatedAt: stored.updatedAt?.toISOString(), ...extra });
  }
  return { stored, calls, routes, invoke, applyBody };
}

function assertNoApply(f: ReturnType<typeof fixture>) {
  assert.equal(f.calls.writes.length, 0);
  assert.equal(f.calls.effects, 0);
}

test("draft endpoints are mounted with the same Owner middleware as approved endpoints", () => {
  const f = fixture();
  assert.equal(f.routes.size, 4);
  assert.equal(f.calls.middleware, 2);
  assert.equal(f.routes.get(draftGet)!.middleware, f.routes.get("GET /api/v1/admin/restaurants/:id/menu/raw")!.middleware);
  assert.equal(f.routes.get(draftPost)!.middleware, f.routes.get("POST /api/v1/admin/restaurants/:id/menu/import")!.middleware);
});

test("raw-draft exposes only authorized source context, raw hash and timestamp without effects", async () => {
  const f = fixture();
  const before = structuredClone(f.stored);
  const r = await f.invoke(undefined, owner, draftGet);
  assert.equal(r.status, 200);
  assert.equal(r.headers["Cache-Control"], "no-store");
  assert.equal(r.headers.Vary, "Authorization, Cookie");
  assert.equal(r.body.source, "authorized_owner_raw_draft_menu_export");
  assert.equal(r.body.menuHash, rawMenuHash(f.stored.menu));
  assert.equal(r.body.restaurant.updatedAt, f.stored.updatedAt.toISOString());
  assert.equal(r.body.restaurant.tenantId, tenantId);
  assert.equal(r.body.restaurant.priceIncludesCommission, false);
  assert.equal(r.body.restaurant.priceIncludesCommissionPresent, true);
  assert.equal(r.body.restaurant.onboardingStatus, "pending_review");
  assert.equal(r.body.restaurant.isActive, false);
  assert.equal(r.body.restaurant.listingType, "official_partner");
  assert.deepEqual(r.body.restaurant.menu, f.stored.menu);
  for (const field of ["privateSecret", "marketplaceCompliance", "payment", "roles", "contract"]) assert.equal(r.body.restaurant[field], undefined);
  assert.deepEqual(f.stored, before);
  assertNoApply(f);
  assert.equal(f.calls.sessions, 0);
});

test("pending inactive real partner draft dry run accepts unknown allergens without changing state", async () => {
  const f = fixture();
  const before = structuredClone(f.stored);
  const r = await f.invoke();
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.applied, false);
  assert.equal(r.body.draftOnly, true);
  assert.equal(r.body.counts.incomingUnknownAllergens, 2);
  assert.equal(r.body.counts.availableAfter, 0);
  assert.equal(r.body.counts.retainedLegacy, 1);
  assert.deepEqual(f.stored, before);
  assertNoApply(f);
  assert.equal(f.calls.sessions, 0);
  assert.equal(f.calls.assets.length, 0);
});

test("draft apply uses snapshot tenant plus menu/timestamp CAS; only menu, timestamp and revision change", async () => {
  const f = fixture();
  const before = structuredClone(f.stored);
  const r = await f.invoke(f.applyBody());
  assert.equal(r.status, 200);
  assert.equal(r.body.applied, true);
  assert.equal(r.body.menuRevision, 10);
  assert.equal(f.stored.menuRevision, 10);
  assert.deepEqual(f.stored.menu.map((item: any) => item.id), ["source-1", "source-2", "legacy"]);
  assert.ok(f.stored.menu.every((item: any) => item.available === false));
  assert.deepEqual(f.stored.menu.map((item: any) => item.allergens), [null, null, null]);
  assert.deepEqual(f.stored.menu.map((item: any) => item.price), [7.5, 12.37, 12.37]);
  assert.deepEqual(f.stored.menu[2], { ...before.menu[0], available: false });
  for (const key of Object.keys(before).filter((key) => !["menu", "updatedAt", "menuRevision"].includes(key))) assert.deepEqual(f.stored[key], before[key]);
  assert.ok(f.stored.updatedAt.getTime() > before.updatedAt.getTime());
  const write = f.calls.writes[0];
  assert.equal(write.filter.tenantId, tenantId);
  assert.equal(write.filter.listingType, "official_partner");
  assert.equal(write.filter.onboardingStatus, "pending_review");
  assert.equal(write.filter.isActive, false);
  assert.equal(write.filter.priceIncludesCommission, false);
  assert.deepEqual(write.filter.menu, { $eq: before.menu });
  assert.deepEqual(write.filter.updatedAt, { $eq: before.updatedAt });
  assert.equal(f.calls.effects, 1);
  assert.equal(f.calls.ended, 1);
});

test("empty-menu pending partner can store a base-price draft with all incoming items unavailable", async () => {
  const f = fixture({ stored: { menu: [], menuRevision: 0 } });
  const r = await f.invoke(f.applyBody());
  assert.equal(r.status, 200);
  assert.equal(r.body.counts.retainedLegacy, 0);
  assert.equal(r.body.counts.availableAfter, 0);
  assert.equal(f.stored.menu.length, 2);
  assert.equal(f.stored.priceIncludesCommission, false);
  assert.equal(f.stored.onboardingStatus, "pending_review");
  assert.equal(f.stored.isActive, false);
});

test("unauthed, non-root, employee-less, partner and temporary-password requests fail closed", async () => {
  for (const auth of [null, { role: "admin", employeeId: "ordinary-admin" }, { role: "admin", isRootOwner: true }, { role: "partner", employeeId: "partner", isRootOwner: true }, { ...owner, mustChangePassword: true }]) {
    for (const path of [draftGet, draftPost]) {
      const f = fixture();
      const r = await f.invoke(undefined, auth, path);
      assert.ok([401, 403, 428].includes(r.status));
      assert.equal(f.calls.reads.length, 0);
      assertNoApply(f);
    }
  }
  const f = fixture();
  const r = await f.invoke(undefined, null, draftPost, restaurantId, false);
  assert.equal(r.status, 403); // Root guard independently rejects absent auth.
  assert.equal(f.calls.reads.length, 0);
});

test("active, approved, rejected, non-partner, missing states or invalid tenant are draft-ineligible", async () => {
  for (const stored of [
    { isActive: true }, { isActive: undefined }, { isActive: null },
    { onboardingStatus: "approved" }, { onboardingStatus: "rejected" }, { onboardingStatus: "pending" },
    { listingType: "local_directory" }, { listingType: undefined },
    { tenantId: null }, { tenantId: "not-a-tenant" },
  ]) {
    for (const path of [draftGet, draftPost]) {
      const f = fixture({ stored });
      const r = await f.invoke(undefined, owner, path);
      assert.ok([404, 409].includes(r.status));
      assertNoApply(f);
    }
  }
});

test("tenant scope is retained; cross-tenant predicates and client tenant input cannot widen access", async () => {
  for (const scope of [{ tenantId: otherTenantId }, { _id: null }]) {
    const f = fixture({ scope });
    for (const path of [draftGet, draftPost]) assert.equal((await f.invoke(undefined, owner, path)).status, 404);
    assertNoApply(f);
  }
  const f = fixture({ scope: { tenantId } });
  assert.equal((await f.invoke(f.applyBody())).status, 200);
  assert.ok(f.calls.reads.every((read: any) => read.filter.tenantId === tenantId));
  const forged = fixture();
  assert.equal((await forged.invoke(forged.applyBody({ tenantId: otherTenantId }))).status, 400);
  assertNoApply(forged);
});

test("draft rejects available true or omitted, unsafe legacy policy and activation/price-flag fields", async () => {
  for (const extra of [
    { items: [{ ...items()[0], available: true }] },
    { items: [{ id: "omitted", name: "Unavailable must be explicit", price: 1 }] },
    { legacyPolicy: "retain_unchanged" }, { isActive: true }, { onboardingStatus: "approved" },
    { priceIncludesCommission: false }, { commissionBps: 1800 }, { marketplaceCompliance: { status: "approved" } },
    { priceBasis: "public" }, { items: [{ ...items()[0], price: 1.001 }] },
  ]) {
    const f = fixture();
    assert.equal((await f.invoke(f.applyBody(extra))).status, 400);
    assertNoApply(f);
    assert.equal(f.calls.sessions, 0);
  }
});

test("draft price context must be explicit stored false, never uncertain or commission-inclusive", async () => {
  for (const flag of [undefined, null, true, "false", 0]) {
    for (const path of [draftGet, draftPost]) {
      const f = fixture({ stored: { priceIncludesCommission: flag } });
      const r = await f.invoke(undefined, owner, path);
      assert.equal(r.status, 409);
      assert.equal(r.body.error, "DRAFT_SOURCE_BASE_PRICE_CONTEXT_REQUIRED");
      assertNoApply(f);
      assert.equal(f.stored.priceIncludesCommission, flag);
    }
  }
  const f = fixture();
  delete f.stored.priceIncludesCommission;
  assert.equal((await f.invoke()).status, 409);
  assert.equal(Object.hasOwn(f.stored, "priceIncludesCommission"), false);
});

test("apply requires exact expected raw hash and timestamp before starting a transaction", async () => {
  for (const extra of [
    { expectedMenuHash: undefined }, { expectedUpdatedAt: undefined },
    { expectedMenuHash: "0".repeat(64) }, { expectedUpdatedAt: "2026-10-01T00:00:00.000Z" },
  ]) {
    const f = fixture();
    const r = await f.invoke(f.applyBody(extra));
    assert.ok([400, 409].includes(r.status));
    assertNoApply(f);
    assert.equal(f.calls.sessions, 0);
  }
});

test("CAS race at update refuses import without activation or after-apply effects", async () => {
  const f = fixture({ writeRace: true });
  const r = await f.invoke(f.applyBody());
  assert.equal(r.status, 409);
  assert.equal(r.body.error, "MENU_IMPORT_CONFLICT");
  assert.deepEqual(f.stored.menu.map((item: any) => item.id), ["legacy", "concurrent"]);
  assert.equal(f.stored.menu[0].available, true);
  assert.equal(f.stored.menuRevision, 9);
  assert.equal(f.stored.isActive, false);
  assert.equal(f.calls.effects, 0);
  assert.equal(f.calls.ended, 1);
});

test("transaction re-read blocks concurrent hash/timestamp changes and tenant/state/price changes", async () => {
  for (const mutation of [
    { menu: [{ id: "another-editor", price: 1, available: false }] },
    { updatedAt: new Date("2026-11-02T00:00:00.000Z") },
    { tenantId: otherTenantId }, { onboardingStatus: "approved" }, { isActive: true },
    { listingType: "local_directory" }, { priceIncludesCommission: true },
  ]) {
    const f = fixture({ duringTransaction: mutation });
    const r = await f.invoke(f.applyBody());
    assert.ok([404, 409].includes(r.status));
    assertNoApply(f);
    assert.equal(f.calls.ended, 1);
  }
});

test("draft reuses canonical owned clean asset validation in dry run and transactional apply", async () => {
  for (const dryRun of [true, false]) {
    const good = fixture();
    const r = await good.invoke(good.applyBody({ dryRun, items: [{ ...items()[0], image: assetUrl }] }));
    assert.equal(r.status, 200);
    assert.equal(good.calls.assets.length, 1);
    assert.equal(Boolean(good.calls.assets[0].opts.session), !dryRun);
    const bad = fixture({ badAsset: true });
    const rejected = await bad.invoke(bad.applyBody({ dryRun, items: [{ ...items()[0], image: assetUrl }] }));
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "MENU_ASSET_NOT_OWNED_OR_NOT_CLEAN");
    assertNoApply(bad);
  }
  const f = fixture();
  assert.equal((await f.invoke(body({ items: [{ ...items()[0], image: `${assetUrl}?forged=1` }] }))).status, 400);
  assert.equal(f.calls.assets.length, 0);
  assertNoApply(f);
});

test("invalid legacy IDs fail rather than discard historical entries; unsupported transactions do not fall back", async () => {
  for (const menu of [[{ id: "same" }, { id: "same" }], [{ name: "Missing ID" }], null]) {
    const f = fixture({ stored: { menu } });
    assert.equal((await f.invoke()).status, 409);
    assertNoApply(f);
  }
  const f = fixture({ transactionUnavailable: true });
  assert.equal((await f.invoke(f.applyBody())).status, 503);
  assertNoApply(f);
  assert.equal((await fixture().invoke(undefined, owner, draftGet, "invalid-id")).status, 400);
});

test("existing approved raw/import routes still reject pending partners and retain original approval scope", async () => {
  const f = fixture();
  for (const path of ["GET /api/v1/admin/restaurants/:id/menu/raw", "POST /api/v1/admin/restaurants/:id/menu/import"]) {
    assert.equal((await f.invoke(undefined, owner, path)).status, 404);
  }
  assert.ok(f.calls.reads.every((read: any) => read.filter.onboardingStatus === "approved"));
  assertNoApply(f);
});
