import assert from "node:assert/strict";
import test from "node:test";
import mongoose from "mongoose";
import { CustomerAccount, EmployeeAccount, Order, Restaurant, Tenant, TenantMembership } from "./models.js";
import { EmployeeSession } from "./employeeSessions.js";
import { hashSessionToken } from "./employeeAuth.js";
import { handleCustomerTrpc } from "./customerCompat.js";
import { COMING_SOON_SLUGS, CUSTOMER_ORDERABLE_RESTAURANT_FILTER, customerCommissionRate } from "./customerCatalogPolicy.js";
import { searchLocalities } from "./localities.js";
import { preflightRestaurantCatalogIndexes } from "./catalogImportPreflight.js";
import { customerAvailability } from "./customerAvailability.js";

const restaurantId = "64b000000000000000000001";
const tenantId = "64b000000000000000000002";
const employeeId = "64b000000000000000000003";
const valueAt = (row: any, path: string): any => path.split(".").reduce((v, key) => v?.[key], row);
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, expected]: [string, any]) => {
    if (key === "$and") return expected.every((part: any) => matches(row, part));
    if (key === "$or") return expected.some((part: any) => matches(row, part));
    const actual = valueAt(row, key);
    if (!expected || typeof expected !== "object") return String(actual) === String(expected);
    if ("$elemMatch" in expected) return Array.isArray(actual) && actual.some((item) => matches(item, expected.$elemMatch));
    if ("$exists" in expected && (actual !== undefined) !== expected.$exists) return false;
    if ("$ne" in expected && String(actual) === String(expected.$ne)) return false;
    if (expected.$in && !expected.$in.includes(actual)) return false;
    if (expected.$nin && expected.$nin.includes(actual)) return false;
    return true;
  });
}
function query(data: any, onSelect?: (projection: string) => void) {
  return { select(projection: string) { onSelect?.(projection); return this; }, sort() { return this; }, lean() { return this; }, async exec() { return typeof data === "function" ? data() : data; } };
}
function response(): any {
  return { statusCode: 200, headers: {}, body: undefined, status(code: number) { this.statusCode = code; return this; }, json(value: unknown) { this.body = value; return this; }, setHeader(key: string, value: string) { this.headers[key] = value; } };
}
function fixture(overrides: any = {}): any {
  return { _id: restaurantId, tenantId, slug: "offline-partner", name: "Sintético", cuisine: "Test", category: "Test", listingType: "official_partner", isActive: true, onboardingStatus: "approved", availabilityStatus: "available", cashPaymentsEnabled: true, menuRevision: 0, menu: [{ id: "dish", name: "Plato", price: 10, available: true, modifiers: [{ id: "extra", name: "Extra", minSelections: 0, maxSelections: 1, options: [{ id: "stale", name: "No seleccionar", price: 9 }], optionItems: [{ id: "on", name: "Extra", price: 2, available: true }, { id: "off", name: "Pausada", price: 3, available: false }] }] }], ...overrides };
}
async function trpc(procedure: string, input: unknown) {
  const res = response();
  await handleCustomerTrpc({ originalUrl: `/api/trpc/${procedure}`, path: `/api/trpc/${procedure}`, params: { procedure }, query: {}, body: { json: input }, method: "POST", header: (name: string) => name === "x-piki-session" ? "offline-synthetic-session" : undefined } as any, res);
  return res;
}

test("contratos de catálogo y carta con handlers reales, consultas en memoria y red bloqueada", async (t) => {
  assert.equal(process.env.PIKI_NO_LISTEN, "true", "Ejecutar con scripts/offline-validation.mjs test");
  t.mock.method(mongoose.Query.prototype as any, "exec", () => { throw new Error("UNMOCKED_DATABASE_QUERY"); });
  t.mock.method(mongoose, "connect", () => { throw new Error("DATABASE_CONNECTION_FORBIDDEN"); });
  const { app } = await import("./server.js");
  const route = (method: string, path: string) => {
    const layer = (app as any)._router.stack.find((entry: any) => entry.route?.path === path && entry.route.methods[method]);
    assert.ok(layer, `${method} ${path}`);
    return layer.route;
  };
  const handler = (method: string, path: string) => route(method, path).stack.at(-1).handle;
  let stored = fixture();
  let filters: any[] = [];
  let projections: string[] = [];
  let employee: any = { _id: employeeId, tenantId, restaurantId, apiRole: "partner", jobRole: "partner", roles: ["partner"], partnerRoles: ["partner_admin"], active: true, authorizationStatus: "approved", mustChangePassword: false };
  const bearer = "OFFLINE_CATALOG_PARTNER_SESSION";
  t.mock.method(EmployeeSession as any, "findOne", (filter: any) => query(filter.tokenHash === hashSessionToken(bearer) ? { employeeId, tenantId, role: "partner", surface: "partner", issuedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() + 60_000) } : null));
  t.mock.method(EmployeeAccount as any, "findOne", (filter: any) => query(matches(employee, filter) ? employee : null));
  t.mock.method(Tenant.collection as any, "findOne", async (filter: any) => String(filter._id) === tenantId && filter.status === "active" ? { _id: tenantId, status: "active" } : null);
  t.mock.method(TenantMembership.collection as any, "find", () => ({ toArray: async () => [] }));
  t.mock.method(Restaurant.collection as any, "findOne", async (filter: any) => matches(stored, filter) ? structuredClone(stored) : null);
  let writes: any[] = [];
  t.mock.method(Restaurant as any, "find", (filter: any) => {
    filters.push(filter);
    let projection = "";
    return query(() => {
      if (!matches(stored, filter)) return [];
      const row = structuredClone(stored);
      // Model the inclusion which caused the REST double markup defect.
      if (projection && !projection.split(" ").includes("priceIncludesCommission")) delete row.priceIncludesCommission;
      if (projection && !projection.split(" ").includes("partnerProfile.commissionRateBps")) delete row.partnerProfile?.commissionRateBps;
      return [row];
    }, (value) => { projection = value; projections.push(value); });
  });
  t.mock.method(Restaurant as any, "findOne", (filter: any) => { filters.push(filter); return query(matches(stored, filter) ? structuredClone(stored) : null); });
  t.mock.method(Restaurant as any, "findById", () => query(null));
  t.mock.method(Order as any, "aggregate", () => query([]));
  t.mock.method(Order as any, "create", () => { throw new Error("ORDER_WRITE_FORBIDDEN"); });
  t.mock.method(CustomerAccount as any, "findOne", () => query(null));
  t.mock.method(EmployeeAccount as any, "findById", () => query(employee));
  t.mock.method(Restaurant as any, "findOneAndUpdate", (filter: any, update: any, options: any) => {
    writes.push({ filter, update, options });
    if (!matches(stored, filter)) return query(null);
    assert.equal(options.new, true);
    assert.deepEqual(update.$inc, { menuRevision: 1 });
    if (update.$set.menu) stored.menu = structuredClone(update.$set.menu);
    if ("menu.$.available" in update.$set) {
      const item = stored.menu.find((entry: any) => matches(entry, filter.menu.$elemMatch));
      assert.ok(item); item.available = update.$set["menu.$.available"];
      assert.deepEqual(Object.keys(update.$set), ["menu.$.available"]);
    }
    stored.menuRevision = (stored.menuRevision ?? 0) + 1;
    return query(structuredClone(stored));
  });
  const menuRequest = (body: any = {}, params: any = {}, role = "partner", requested = restaurantId): any => ({ body, params, auth: { role, tenantId, employeeId }, header: (name: string) => name === "x-piki-restaurant-id" ? requested : name === "authorization" ? `Bearer ${bearer}` : undefined });
  const call = async (method: string, path: string, req: any) => { const res = response(); await handler(method, path)(req, res); return res; };

  for (const flag of [false, true]) for (const explicit of [undefined, 1800]) await t.test(`REST + tRPC + quote: final=${flag}, perfil=${explicit ?? "legacy20"}`, async () => {
    stored = fixture({ priceIncludesCommission: flag, partnerProfile: explicit === undefined ? {} : { commissionRateBps: explicit } });
    const before = structuredClone(stored);
    const rest = await call("get", "/api/v1/catalog/restaurants", { query: {} });
    const rpc = await trpc("catalog.byId", { id: restaurantId });
    const list = await trpc("catalog.list", {});
    const selection = [{ groupId: "extra", optionIds: ["on"] }];
    const quote = await trpc("order.quote", { restaurantId, items: [{ id: "dish", quantity: 1, selections: selection }] });
    const restItem = rest.body.restaurants[0].menu[0];
    const rpcItem = rpc.body.result.data.json.menu[0];
    const multiplier = flag ? 1 : 1 + (explicit ?? 2000) / 10000;
    assert.equal(restItem.price, Math.round(10 * multiplier * 100) / 100);
    assert.equal(rpcItem.price, restItem.price);
    assert.equal(list.body.result.data.json[0].menu[0].price, restItem.price);
    assert.deepEqual(rpcItem.modifierGroups, restItem.modifierGroups);
    assert.deepEqual(restItem.modifierGroups[0].options.map((option: any) => option.id), ["on"]);
    assert.equal(restItem.modifierGroups[0].options[0].price, Math.round(2 * multiplier * 100) / 100);
    assert.equal(quote.body.result.data.json.subtotalCents, Math.round(10 * multiplier * 100) + Math.round(2 * multiplier * 100));
    assert.ok(projections.at(-1)!.includes("priceIncludesCommission"));
    assert.ok(projections.at(-1)!.includes("partnerProfile.commissionRateBps"));
    const paused = await trpc("order.quote", { restaurantId, items: [{ id: "dish", quantity: 1, selections: [{ groupId: "extra", optionIds: ["off"] }] }] });
    assert.equal(paused.statusCode, 400);
    assert.equal(paused.body.error.json.data.code, "PRODUCT_UNAVAILABLE");
    assert.deepEqual(stored, before);
  });

  await t.test("legacy restaurant conserva catálogo y quote con todas las guardas antes de efectos", async () => {
    stored = fixture({ listingType: "restaurant" });
    assert.equal(matches(stored, CUSTOMER_ORDERABLE_RESTAURANT_FILTER), true);
    const rest = await call("get", "/api/v1/catalog/restaurants", { query: {} });
    const list = await trpc("catalog.list", {});
    const detail = await trpc("catalog.byId", { id: restaurantId });
    assert.equal(rest.body.restaurants.length, 1);
    assert.equal(list.body.result.data.json.length, 1);
    assert.equal(detail.body.result.data.json.canOrder, true);
    const input = { restaurantId, items: [{ id: "dish", quantity: 1 }] };
    assert.equal((await trpc("order.quote", input)).statusCode, 200);
    const body = { restaurantId, deliveryAddress: "Calle sintética 12", deliveryLocation: { latitude: 38.990276, longitude: -0.521111 }, items: [{ itemId: "dish", quantity: 1 }], paymentMethod: "cash" };
    assert.equal((await call("post", "/api/v1/orders", { body })).body.error, "RESTAURANT_LOCATION_UNAVAILABLE", "legacy llega a la guarda geográfica sin crear pedidos");
    for (const override of [{ internalDemo: true }, { isActive: false }, { onboardingStatus: "pending_review" }, { onboardingStatus: "rejected" }, { availabilityStatus: "paused" }, { menu: [] }, { fulfillmentMode: "assisted_purchase" }, { slug: "partner-test" }]) {
      stored = fixture({ listingType: "restaurant", ...override });
      assert.equal(matches(stored, CUSTOMER_ORDERABLE_RESTAURANT_FILTER), false, JSON.stringify(override));
      assert.equal((await trpc("order.quote", input)).statusCode, 404);
    }
    stored = fixture({ listingType: "local_directory" });
    assert.equal(matches(stored, CUSTOMER_ORDERABLE_RESTAURANT_FILTER), false);
    assert.equal(writes.length, 0);
  });

  await t.test("perfil válido prevalece incluso sobre slug legacy; inválido conserva defaults", () => {
    assert.equal(customerCommissionRate({ slug: "alibaba-kebab-xativa", partnerProfile: { commissionRateBps: 1800 } }), 0.18);
    assert.equal(customerCommissionRate({ slug: "alibaba-kebab-xativa" }), 0.20);
    assert.equal(customerCommissionRate({ partnerProfile: { commissionRateBps: 0 } }), 0);
    for (const value of [NaN, -1, 10001, 1.5, "1800", null]) assert.equal(customerCommissionRate({ partnerProfile: { commissionRateBps: value as any } }), 0.20);
  });

  await t.test("POST orders rechaza estados no operables y producto pausado antes de cualquier efecto", async () => {
    const body = { restaurantId, deliveryAddress: "Calle sintética 12", deliveryLocation: { latitude: 38.990276, longitude: -0.521111 }, items: [{ itemId: "dish", quantity: 1 }], paymentMethod: "cash" };
    for (const override of [{ availabilityStatus: "coming_soon" }, { listingType: "local_directory" }, { internalDemo: true }, { slug: "partner-test" }, { isActive: false }, { onboardingStatus: "pending_review" }, { onboardingStatus: "suspended" }, { menu: [] }, { listingType: null }]) {
      stored = fixture(override); filters = [];
      const res = await call("post", "/api/v1/orders", { body });
      assert.equal(res.statusCode, 404, JSON.stringify(override));
      assert.equal(res.body.error, "RESTAURANT_NOT_AVAILABLE");
      assert.deepEqual(filters[0], { _id: new mongoose.Types.ObjectId(restaurantId), ...CUSTOMER_ORDERABLE_RESTAURANT_FILTER });
    }
    stored = fixture({ fulfillmentMode: "assisted_purchase" }); delete stored.listingType;
    assert.equal((await call("post", "/api/v1/orders", { body })).statusCode, 404);
    stored = fixture(); delete stored.listingType;
    assert.equal((await call("post", "/api/v1/orders", { body })).body.error, "RESTAURANT_LOCATION_UNAVAILABLE", "legacy partner delivery reaches only the no-location guard, no IO");
    stored = fixture({ menu: [{ id: "dish", name: "Pausado", price: 10, available: false }] });
    assert.equal((await call("post", "/api/v1/orders", { body })).body.error, "INVALID_MENU_ITEM");
    assert.equal(writes.length, 0);
  });

  await t.test("assisted_purchase se veta globalmente en REST, tRPC y flags públicos", async (child) => {
    child.mock.method(CustomerAccount as any, "findOne", () => query({ _id: employeeId }));
    const body = { restaurantId, deliveryAddress: "Calle sintética 12", deliveryLocation: { latitude: 38.990276, longitude: -0.521111 }, items: [{ itemId: "dish", quantity: 1 }], paymentMethod: "stripe" };
    const before = writes.length;
    for (const legacy of [false, true]) {
      stored = fixture({ fulfillmentMode: "assisted_purchase" });
      if (legacy) delete stored.listingType;
      assert.equal(matches(stored, CUSTOMER_ORDERABLE_RESTAURANT_FILTER), false);
      const rest = await call("post", "/api/v1/orders", { body });
      assert.equal(rest.statusCode, 404);
      assert.equal(rest.body.error, "RESTAURANT_NOT_AVAILABLE");
      for (const procedure of ["order.quote", "order.create", "order.checkout"]) {
        const rpc = await trpc(procedure, { ...body, items: [{ id: "dish", quantity: 1 }] });
        assert.equal(rpc.statusCode, 404, `${legacy ? "legacy" : "official"}: ${procedure}`);
      }
      const flags = customerAvailability({ ...stored, hasMenu: true });
      assert.equal(flags.canOrder, false); assert.equal(flags.orderable, false);
      assert.equal(flags.reason, "not_orderable");
    }
    assert.equal(writes.length, before);
  });

  await t.test("Partner/Admin fullsave: pausa parcial/total/reactivación preservan requisitos", async (child) => {
    child.mock.method(CustomerAccount as any, "findOne", () => query({ _id: employeeId }));
    for (const role of ["partner", "admin"]) {
      stored = fixture({ menu: [{ id: "dish", name: "Menú obligatorio", price: 10, available: true, modifiers: [{ id: "required", name: "Dos opciones", required: true, minSelections: 2, maxSelections: 3, optionItems: ["a", "b", "c"].map((id) => ({ id, name: id.toUpperCase(), price: 0, available: true })) }] }] });
      const path = role === "partner" ? "/api/v1/partners/menu" : "/api/v1/admin/restaurants/:id/menu";
      for (const active of [3, 1, 0, 3]) {
        const draft = structuredClone(stored.menu);
        draft[0].modifiers[0].optionItems.forEach((option: any, i: number) => { option.available = i < active; });
        const unchanged = structuredClone(draft);
        const save = await call("put", path, menuRequest({ items: draft, expectedMenuRevision: stored.menuRevision }, { id: restaurantId }, role));
        assert.equal(save.statusCode, 200);
        assert.deepEqual(draft, unchanged, "normalización no muta input");
        // Actual Mongoose schema roundtrip, in memory, after the actual writer.
        stored.menu = new Restaurant({ ...stored, menu: stored.menu }).toObject().menu;
        const group = stored.menu[0].modifiers[0];
        assert.equal(group.minSelections, 2); assert.equal(group.maxSelections, 3); assert.equal(group.required, true);
        assert.equal(group.optionItems.length, 3);
        const publicItem = (await trpc("catalog.byId", { id: restaurantId })).body.result.data.json.menu[0];
        assert.equal(publicItem.orderable, active >= 2);
        assert.equal(publicItem.available, active >= 2);
        assert.equal(publicItem.modifierGroups[0].minSelections, 2);
        assert.equal(publicItem.modifierGroups[0].maxSelections, 3);
        assert.equal(publicItem.modifierGroups[0].options.length, active);
        const input = { restaurantId, items: [{ id: "dish", quantity: 1, selections: active >= 2 ? [{ groupId: "required", optionIds: ["a", "b"] }] : [] }] };
        const quote = await trpc("order.quote", input);
        assert.equal(quote.statusCode, active >= 2 ? 200 : 400);
        if (active < 2) {
          const checkout = await trpc("order.checkout", { ...input, paymentMethod: "stripe" });
          assert.equal(checkout.statusCode, 400);
          const rest = await call("post", "/api/v1/orders", { body: { restaurantId, deliveryAddress: "Calle sintética 12", deliveryLocation: { latitude: 38.990276, longitude: -0.521111 }, items: [{ itemId: "dish", quantity: 1 }], paymentMethod: "stripe" } });
          assert.equal(rest.body.error, "INVALID_MENU_ITEM");
        }
      }
    }
  });

  await t.test("REST y tRPC no publican directorios aprobados con carta, demos, borradores ni próximos", async () => {
    const before = writes.length;
    for (const override of [
      { listingType: "local_directory" }, { listingType: "local_directory", availabilityStatus: "coming_soon" },
      { listingType: null }, { listingType: "unknown" }, { internalDemo: true }, { slug: "partner-test" },
      { isActive: false }, { onboardingStatus: "draft" }, { onboardingStatus: "pending_review" },
      { onboardingStatus: "suspended" }, { onboardingStatus: "rejected" }, { menu: [] },
      { fulfillmentMode: "assisted_purchase" },
      ...COMING_SOON_SLUGS.map(slug => ({ slug, availabilityStatus: "coming_soon" })),
    ]) {
      stored = fixture(override);
      const unchanged = structuredClone(stored);
      assert.deepEqual((await call("get", "/api/v1/catalog/restaurants", { query: {} })).body.restaurants, [], JSON.stringify(override));
      assert.deepEqual((await trpc("catalog.list", {})).body.result.data.json, [], JSON.stringify(override));
      for (const id of [restaurantId, stored.slug]) assert.equal((await trpc("catalog.byId", { id })).body.result.data.json, null, JSON.stringify(override));
      assert.deepEqual(stored, unchanged);
    }
    for (const listingType of ["official_partner", "restaurant", undefined]) {
      stored = fixture({ listingType });
      if (listingType === undefined) delete stored.listingType;
      assert.equal((await call("get", "/api/v1/catalog/restaurants", { query: {} })).body.restaurants.length, 1);
      assert.equal((await trpc("catalog.list", {})).body.result.data.json.length, 1);
      for (const id of [restaurantId, stored.slug]) assert.equal((await trpc("catalog.byId", { id })).body.result.data.json.canOrder, true);
    }
    assert.equal(writes.length, before);
  });

  await t.test("PATCH por ID es atómico, preserva resto, replay no incrementa y PUT stale da 409", async () => {
    stored = fixture(); stored.menu.push({ id: "other", name: "Otro", price: 7, available: true });
    const old = structuredClone(stored.menu);
    const patchPath = "/api/v1/restaurants/:id/menu/items/:itemId/availability";
    const patch = await call("patch", patchPath, menuRequest({ available: false }, { id: restaurantId, itemId: "dish" }));
    assert.equal(patch.statusCode, 200); assert.equal(patch.body.menuRevision, 1); assert.equal(patch.body.changed, true);
    assert.deepEqual(stored.menu[1], old[1]); assert.equal(stored.menu[0].price, old[0].price);
    assert.equal(String(writes.at(-1).filter.tenantId), tenantId);
    const replay = await call("patch", patchPath, menuRequest({ available: false }, { id: restaurantId, itemId: "dish" }));
    assert.equal(replay.body.menuRevision, 1); assert.equal(replay.body.changed, false);
    const stale = await call("put", "/api/v1/partners/menu", menuRequest({ items: old, expectedMenuRevision: 0 }));
    assert.equal(stale.statusCode, 409); assert.equal(stale.body.error, "MENU_REVISION_CONFLICT"); assert.equal(stored.menu[0].available, false);
    const get = await call("get", "/api/v1/partners/menu", menuRequest());
    assert.equal(get.body.menuRevision, 1); assert.equal(get.body.restaurant.menuRevision, 1);
    const valid = await call("put", "/api/v1/partners/menu", menuRequest({ items: stored.menu, expectedMenuRevision: 1 }));
    assert.equal(valid.body.menuRevision, 2);
    const ownerStale = await call("put", "/api/v1/admin/restaurants/:id/menu", menuRequest({ items: old, expectedMenuRevision: 1 }, { id: restaurantId }, "admin"));
    assert.equal(ownerStale.statusCode, 409);
    const owner = await call("put", "/api/v1/admin/restaurants/:id/menu", menuRequest({ items: stored.menu, expectedMenuRevision: 2 }, { id: restaurantId }, "admin"));
    assert.equal(owner.body.menuRevision, 3);
    const legacy = await call("put", "/api/v1/partners/menu", menuRequest({ items: stored.menu }));
    assert.equal(legacy.body.menuRevision, 4, "omission preserves documented legacy LWW");
    const maintenancePath = "/api/v1/admin/maintenance/restaurants/:id/menu";
    const maintenanceStale = await call("put", maintenancePath, menuRequest({ items: old, expectedMenuRevision: 3 }, { id: restaurantId }, "admin"));
    assert.equal(maintenanceStale.statusCode, 409);
    const maintenance = await call("put", maintenancePath, menuRequest({ items: stored.menu, expectedMenuRevision: 4 }, { id: restaurantId }, "admin"));
    assert.equal(maintenance.body.menuRevision, 5);
  });

  await t.test("revisión ausente es cero; PATCH/PUT validan input, permisos y tenant", async () => {
    stored = fixture(); delete stored.menuRevision;
    const save = await call("put", "/api/v1/partners/menu", menuRequest({ items: stored.menu, expectedMenuRevision: 0 }));
    assert.equal(save.body.menuRevision, 1);
    const path = "/api/v1/restaurants/:id/menu/items/:itemId/availability";
    const params = { id: restaurantId, itemId: "dish" };
    for (const body of [{}, { available: "false" }, { available: false, menu: [] }]) assert.equal((await call("patch", path, menuRequest(body, params))).statusCode, 400);
    assert.equal((await call("patch", path, menuRequest({ available: false }, { ...params, itemId: "unknown" }))).body.error, "MENU_ITEM_NOT_FOUND");
    employee.partnerRoles = ["kitchen"]; employee.apiRole = "kitchen";
    const before = writes.length;
    assert.equal((await call("patch", path, menuRequest({ available: false }, params))).statusCode, 403);
    assert.equal(writes.length, before);
    employee.partnerRoles = ["partner_admin"]; employee.apiRole = "partner";
    assert.equal((await call("patch", path, menuRequest({ available: false }, params, "partner", "64b000000000000000000009"))).statusCode, 403);
    const wrongTenant = menuRequest({ available: false }, params); wrongTenant.auth.tenantId = "64b000000000000000000009";
    assert.equal((await call("patch", path, wrongTenant)).statusCode, 403, "fresh session rejects the changed request tenant before resource lookup");
    const noAuth = response();
    await route("patch", path).stack[0].handle({ path, header: () => undefined } as any, noAuth, () => { throw new Error("UNAUTHENTICATED_ACCESS"); });
    assert.equal(noAuth.statusCode, 401);
    const ownerCheck = response();
    await route("patch", path).stack[1].handle({ path, auth: { role: "admin" }, header: () => undefined } as any, ownerCheck, () => { throw new Error("OWNER_CHECK_BYPASSED"); });
    assert.equal(ownerCheck.statusCode, 401);
    stored = fixture(); delete stored.menu[0].available;
    const noop = await call("patch", path, menuRequest({ available: true }, params));
    assert.equal(noop.body.changed, false); assert.equal(noop.body.menuRevision, 0);
  });

  await t.test("búsqueda geográfica nacional conserva España sin sesgo regional ni coordenadas de fallback", async (child) => {
    const urls: URL[] = [];
    child.mock.method(globalThis, "fetch", async (input: any) => {
      const url = new URL(input); urls.push(url);
      if (url.hostname === "nominatim.openstreetmap.org") return { ok: true, json: async () => [] } as any;
      assert.equal(url.hostname, "photon.komoot.io");
      return { ok: true, json: async () => ({ features: [
        { properties: { name: "Dirección sintética", city: "Madrid", countrycode: "ES" }, geometry: { coordinates: [-3.7, 40.4] } },
        { properties: { name: "Sin punto geográfico", countrycode: "ES" } },
      ] }) } as any;
    });
    const result = await call("get", "/api/v1/locations/search", { query: { q: "Madrid Sintético 27" } });
    assert.equal(result.statusCode, 200); assert.equal(result.body.results.length, 1);
    assert.equal(urls[0].searchParams.get("countrycodes"), "es");
    assert.equal(urls[1].searchParams.get("countrycode"), "ES");
    for (const url of urls) {
      assert.equal(url.searchParams.get("q"), "Madrid Sintético 27, España");
      assert.equal(url.searchParams.has("viewbox"), false); assert.equal(url.searchParams.has("bounded"), false);
    }
    assert.equal(result.body.results[0].latitude, 40.4);
    assert.equal(result.body.results[0].longitude, -3.7);
  });

  await t.test("GET localities nacional valida límite y no consulta DB ni expone cobertura", async () => {
    const before = filters.length;
    const result = await call("get", "/api/v1/catalog/localities", { query: { q: "Algemesi", limit: "50" } });
    assert.equal(result.statusCode, 200); assert.equal(result.body.items[0].name, "Algemesí");
    assert.equal(result.body.source.count, 8132); assert.equal(result.body.source.populationYear, 2025);
    assert.equal(result.body.items[0].coverage, undefined); assert.equal(result.body.coverage, undefined);
    assert.equal(filters.length, before);
    for (const limit of ["0", "51", "1.5", "NaN", ["10"], "1000"]) assert.equal((await call("get", "/api/v1/catalog/localities", { query: { limit } })).statusCode, 400);
  });
});

test("catálogo municipal nacional: alias, tildes, provincia, código y vacío", () => {
  const result = (q: string) => { const found = searchLocalities({ q }); assert.equal(found.ok, true); return found.ok ? found.body.items : []; };
  assert.equal(result("A Coruna").some((item) => item.code === "15030"), true);
  assert.equal(result("28079")[0].name, "Madrid");
  assert.equal(result("Madrid")[0].code, "28079", "la coincidencia exacta no desaparece tras 50 coincidencias provinciales");
  assert.equal(result("Madrid").some((item) => item.province === "Madrid"), true);
  assert.equal(result("Ceuta")[0].code, "51001");
  assert.equal(result("Melilla")[0].code, "52001");
  assert.equal(result("").length, 50);
  assert.deepEqual(result("no-existe-localidad-sintetica"), []);
});

test("preflight de importadores sólo lee índices Restaurant y falla cerrado sin unicidad slug", async () => {
  let reads = 0;
  const reader = (indexes: any[]) => ({ listIndexes: () => ({ toArray: async () => { reads++; return indexes; } }) });
  await preflightRestaurantCatalogIndexes(reader([{ key: { slug: 1 }, unique: true }]));
  for (const indexes of [[], [{ key: { slug: 1 } }], [{ key: { slug: 1 }, unique: true, sparse: true }], [{ key: { slug: 1 }, unique: true, partialFilterExpression: { isActive: true } }]]) await assert.rejects(preflightRestaurantCatalogIndexes(reader(indexes)), /RESTAURANT_UNIQUE_SLUG_INDEX_REQUIRED/);
  assert.equal(reads, 5);
});
