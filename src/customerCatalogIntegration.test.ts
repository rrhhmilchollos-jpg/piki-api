import assert from "node:assert/strict";
import test from "node:test";
import type { Request, Response } from "express";
import { Restaurant } from "./models.js";
import { handleCustomerTrpc } from "./customerCompat.js";
import { CUSTOMER_CATALOG_RESTAURANT_FILTER } from "./customerCatalogPolicy.js";

const IDs = {
  primary: "64b000000000000000000001",
  profileLocality: "64b000000000000000000002",
  slugLookup: "64b000000000000000000003",
  xativaPizza: "64b000000000000000000004",
  xativaOther: "64b000000000000000000005",
  postalAddress: "64b000000000000000000006",
  menuOne: "64b000000000000000000007",
  menuTwo: "64b000000000000000000008",
} as const;

type RestaurantRow = Record<string, any>;
type CatalogResponse = { result: { data: { json: any } } };

function queryResult<T>(data: T) {
  return {
    select() { return this; },
    sort() { return this; },
    lean() { return this; },
    async exec() { return data; },
  };
}

function response() {
  const state: { statusCode: number; body: unknown; headers: Record<string, string | number | readonly string[]> } = {
    statusCode: 200,
    body: undefined,
    headers: {},
  };
  const value = {
    status(code: number) { state.statusCode = code; return this; },
    json(body: unknown) { state.body = body; return this; },
    setHeader(name: string, headerValue: string | number | readonly string[]) { state.headers[name] = headerValue; return this; },
  };
  return { state, value: value as unknown as Response };
}

function request(options: {
  procedure?: string;
  method?: "GET" | "POST";
  query?: Record<string, unknown>;
  body?: unknown;
} = {}) {
  const procedure = options.procedure || "catalog.list";
  const query = options.query || {};
  const search = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)])).toString();
  const path = `/api/trpc/${procedure}`;
  return {
    originalUrl: `${path}${search ? `?${search}` : ""}`,
    url: path,
    path,
    params: { procedure },
    query,
    body: options.body || {},
    method: options.method || "POST",
    header: () => undefined,
  } as unknown as Request;
}

function publicRestaurant(overrides: Partial<RestaurantRow> = {}): RestaurantRow {
  return {
    _id: IDs.primary,
    slug: "persisted-menu-xativa",
    name: "Carta persistida",
    cuisine: "Mediterránea",
    category: "Mediterránea",
    locality: "Xàtiva",
    address: "Carrer de la Pau 8, 46800 Xàtiva, Valencia",
    partnerProfile: { city: "Xàtiva", postalCode: "46800" },
    availabilityStatus: "available",
    isActive: true,
    onboardingStatus: "approved",
    cashPaymentsEnabled: true,
    menu: [{ id: "default-menu-item", name: "Producto", price: 8, available: true }],
    ...overrides,
  };
}

function jsonOf(body: unknown): any {
  return (body as CatalogResponse).result.data.json;
}

function normalized(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("es-ES")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function valueAt(row: RestaurantRow, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined, row);
}

/**
 * The mock implements the small Mongo query subset used by the catalog route.
 * Text equality is accent-insensitive to model the intended Xàtiva/Xativa
 * catalog behavior without opening a database connection.
 */
function matchesFilter(row: RestaurantRow, filter: unknown): boolean {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) return true;
  for (const [key, expected] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and") {
      if (!Array.isArray(expected) || !expected.every((part) => matchesFilter(row, part))) return false;
      continue;
    }
    if (key === "$or") {
      if (!Array.isArray(expected) || !expected.some((part) => matchesFilter(row, part))) return false;
      continue;
    }

    const actual = valueAt(row, key);
    if (expected instanceof RegExp) {
      const normalizedExpression = new RegExp(normalized(expected.source), expected.flags);
      if (!expected.test(String(actual ?? "")) && !normalizedExpression.test(normalized(actual))) return false;
      continue;
    }
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
      if (actual !== expected) return false;
      continue;
    }

    const condition = expected as Record<string, unknown>;
    const hasMongoOperator = "$exists" in condition || "$ne" in condition || "$in" in condition || "$nin" in condition;
    if ("$exists" in condition && Boolean(actual !== undefined) !== Boolean(condition.$exists)) return false;
    if ("$ne" in condition && actual === condition.$ne) return false;
    if (Array.isArray(condition.$in) && !condition.$in.some((value) => actual === value)) return false;
    if (Array.isArray(condition.$nin) && condition.$nin.some((value) => actual === value)) return false;
    if (hasMongoOperator) continue;
    if ("$regex" in condition) {
      const expression = new RegExp(String(condition.$regex), String(condition.$options || ""));
      const normalizedExpression = new RegExp(normalized(condition.$regex), String(condition.$options || ""));
      if (!expression.test(String(actual ?? "")) && !normalizedExpression.test(normalized(actual))) return false;
      continue;
    }
    if (!matchesFilter(actual as RestaurantRow, condition)) return false;
  }
  return true;
}

function containsCatalogFilter(value: unknown): boolean {
  try {
    assert.deepEqual(value, CUSTOMER_CATALOG_RESTAURANT_FILTER);
    return true;
  } catch {
    if (!value || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    try {
      assert.deepEqual({ $or: record.$or }, CUSTOMER_CATALOG_RESTAURANT_FILTER);
      return true;
    } catch {
      return Object.values(record).some(containsCatalogFilter);
    }
  }
}

function containsField(value: unknown, field: string, expected: string): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (field in record && String(record[field]) === expected) return true;
  return Object.values(record).some((child) => containsField(child, field, expected));
}

test("single catalog.list batches are arrays for GET and POST while a bare call remains an object", async () => {
  const rows = [
    publicRestaurant({ _id: IDs.xativaPizza, slug: "pizza-needle", name: "Pizza Needle", category: "Pizza", cuisine: "Pizza" }),
    publicRestaurant({ _id: IDs.xativaOther, slug: "pizza-other", name: "Pizza Other", category: "Pizza", cuisine: "Pizza" }),
    publicRestaurant({ _id: IDs.postalAddress, slug: "other-category", name: "Needle elsewhere", category: "Hamburguesas", cuisine: "Hamburguesas" }),
  ];
  const originalFind = (Restaurant as any).find;
  const findFilters: unknown[] = [];
  (Restaurant as any).find = (filter: unknown) => {
    findFilters.push(filter);
    return queryResult(rows.filter((row) => matchesFilter(row, filter)));
  };

  const filters = { category: "Pizza", query: "needle" };
  const batchInput = { "0": { json: filters } };
  try {
    for (const method of ["GET", "POST"] as const) {
      const res = response();
      const req = method === "GET"
        ? request({ method, query: { batch: "1", input: JSON.stringify(batchInput) } })
        : request({ method, query: { batch: "1" }, body: batchInput });
      await handleCustomerTrpc(req, res.value);

      assert.equal(res.state.statusCode, 200);
      assert.ok(Array.isArray(res.state.body), `${method} single-procedure batch must return a tRPC result array`);
      assert.equal((res.state.body as unknown[]).length, 1);
      assert.deepEqual((jsonOf((res.state.body as unknown[])[0]) as any[]).map((row) => row.slug), ["pizza-needle"]);
    }

    assert.equal((findFilters as any[]).filter((filter) => containsField(filter, "category", "Pizza")).length, 2);

    const bare = response();
    await handleCustomerTrpc(request({ method: "POST", body: { json: filters } }), bare.value);
    assert.equal(Array.isArray(bare.state.body), false, "non-batch tRPC calls retain their object response envelope");
    assert.deepEqual((jsonOf(bare.state.body) as any[]).map((row) => row.slug), ["pizza-needle"]);
  } finally {
    (Restaurant as any).find = originalFind;
  }
});

test("catalog.list preserves public location and persisted menu fields without repricing or mutating paused items", async () => {
  const persistedMenu = [
    {
      id: "persisted-menu-item",
      name: "Menú de la casa",
      description: "Preparado al momento",
      price: 12.37,
      category: "Menús",
      image: "https://cdn.example.test/menu-de-la-casa.webp",
      requestOnly: true,
      available: true,
      modifiers: [{ id: "salsa", name: "Salsa", price: 0.4, required: true, maxSelections: 2, options: ["Suave", "Picante"] }],
    },
    {
      id: "paused-menu-item",
      name: "Producto pausado",
      price: 8.9,
      category: "Bebidas",
      image: "https://cdn.example.test/paused.webp",
      requestOnly: false,
      available: false,
    },
  ];
  const primary = publicRestaurant({
    _id: IDs.primary,
    slug: "carta-persistida-xativa",
    locality: "Xàtiva",
    partnerProfile: { city: "Otra ciudad", postalCode: "46800" },
    menu: persistedMenu,
  });
  const localityFallback = publicRestaurant({
    _id: IDs.profileLocality,
    slug: "perfil-localidad-canals",
    name: "Perfil Canals",
    locality: "",
    address: "Avinguda Jaume I 10, 46650 Canals, Valencia",
    partnerProfile: { city: "Canals" },
    menu: [{ id: "canals-item", name: "Producto Canals", price: 6.25, available: true }],
  });
  const originalMenu = structuredClone(persistedMenu);
  const originalFind = (Restaurant as any).find;
  (Restaurant as any).find = () => queryResult([primary, localityFallback]);

  try {
    const res = response();
    await handleCustomerTrpc(request(), res.value);
    const catalog = jsonOf(res.state.body) as any[];
    const presented = catalog.find((row) => row.slug === primary.slug);
    const fallback = catalog.find((row) => row.slug === localityFallback.slug);

    assert.equal(presented.id, IDs.primary);
    assert.equal(presented.slug, primary.slug);
    assert.equal(presented.locality, "Xàtiva", "the row locality takes precedence over partner profile city");
    assert.equal(presented.postalCode, "46800", "partner profile postal code is exposed");
    assert.equal(fallback.locality, "Canals", "partner profile city fills an empty row locality");
    assert.equal(fallback.postalCode, "46650", "a five-digit code is extracted from the stored address when profile data is absent");

    assert.deepEqual(presented.menu.map((item: any) => item.id), ["persisted-menu-item"], "paused products are not listed");
    const item = presented.menu[0];
    assert.equal(item.price, persistedMenu[0].price, "the customer catalog keeps the persisted price rather than applying a commission transform");
    assert.equal(item.category, "Menús");
    assert.equal(item.image, "https://cdn.example.test/menu-de-la-casa.webp");
    assert.equal(item.requestOnly, true);
    assert.deepEqual(item.modifierGroups, [{
      id: "salsa",
      name: "Salsa",
      description: undefined,
      minSelections: 1,
      maxSelections: 2,
      options: [
        { id: "suave", name: "Suave", price: 0.4 },
        { id: "picante", name: "Picante", price: 0.4 },
      ],
    }], "legacy string modifier options remain usable through modifierGroups");
    assert.deepEqual(persistedMenu, originalMenu, "presenting the catalog must not mutate stored prices or paused availability");
  } finally {
    (Restaurant as any).find = originalFind;
  }
});

test("catalog.byId resolves ObjectId and slug lookups only within the public catalog filter", async () => {
  const byObjectId = publicRestaurant({ _id: IDs.primary, slug: "object-id-store", name: "ObjectId store" });
  const bySlug = publicRestaurant({ _id: IDs.slugLookup, slug: "slug-only-store", name: "Slug store" });
  const originalFindOne = (Restaurant as any).findOne;
  const filters: unknown[] = [];
  (Restaurant as any).findOne = (filter: Record<string, unknown>) => {
    filters.push(filter);
    const row = containsField(filter, "_id", IDs.primary)
      ? byObjectId
      : containsField(filter, "slug", bySlug.slug)
        ? bySlug
        : null;
    return queryResult(row);
  };

  try {
    for (const id of [IDs.primary, bySlug.slug]) {
      const res = response();
      await handleCustomerTrpc(request({ procedure: "catalog.byId", body: { json: { id } } }), res.value);
      assert.equal(jsonOf(res.state.body).slug, id === IDs.primary ? byObjectId.slug : bySlug.slug);
    }

    assert.equal(filters.length, 2);
    assert.ok(containsCatalogFilter(filters[0]), "ObjectId lookup includes CUSTOMER_CATALOG_RESTAURANT_FILTER");
    assert.ok(containsCatalogFilter(filters[1]), "slug lookup includes CUSTOMER_CATALOG_RESTAURANT_FILTER");
    assert.ok(containsField(filters[0], "_id", IDs.primary));
    assert.ok(containsField(filters[1], "slug", bySlug.slug), "a slug must not be queried as an ObjectId");
    assert.equal(containsField(filters[0], "slug", bySlug.slug), false, "the ObjectId request remains isolated from the slug record");
  } finally {
    (Restaurant as any).findOne = originalFindOne;
  }
});

test("catalog.list keeps configured stores visible with incomplete postal metadata while preserving query and category filters", async () => {
  const rows = [
    publicRestaurant({
      _id: IDs.xativaPizza,
      slug: "pizza-xativa",
      name: "Pizza Xàtiva",
      cuisine: "Pizza",
      category: "Pizza",
      locality: "Xàtiva",
      partnerProfile: { city: "Xàtiva", postalCode: "46800" },
    }),
    publicRestaurant({
      _id: IDs.xativaOther,
      slug: "pizza-gandia",
      name: "Pizza Gandia",
      cuisine: "Pizza",
      category: "Pizza",
      locality: "Gandia",
      partnerProfile: { city: "Gandia", postalCode: "46700" },
    }),
    publicRestaurant({
      _id: IDs.postalAddress,
      slug: "postal-address-only",
      name: "Arroz Canals",
      cuisine: "Arroces",
      category: "Arroces",
      locality: "Canals",
      address: "Avinguda Jaume I 10, 46650 Canals, Valencia",
      partnerProfile: { city: "Canals" },
    }),
  ];
  const originalFind = (Restaurant as any).find;
  const filters: unknown[] = [];
  (Restaurant as any).find = (filter: unknown) => {
    filters.push(filter);
    return queryResult(rows.filter((row) => matchesFilter(row, filter)));
  };

  try {
    const locality = response();
    await handleCustomerTrpc(request({ body: { json: { locality: "Xativa", category: "Pizza", query: "pizza" } } }), locality.value);
    assert.deepEqual((jsonOf(locality.state.body) as any[]).map((row) => row.slug), ["pizza-xativa", "pizza-gandia"], "the repair retains existing delivery-area behavior and category/query narrowing");

    const postal = response();
    await handleCustomerTrpc(request({ body: { json: { postalCode: "46650" } } }), postal.value);
    assert.deepEqual((jsonOf(postal.state.body) as any[]).map((row) => row.slug), ["pizza-xativa", "pizza-gandia", "postal-address-only"], "postal input does not introduce a new visibility gate during a catalogue repair");

    assert.equal(filters.length, 2);
    assert.ok(containsCatalogFilter(filters[0]));
    assert.ok(containsCatalogFilter(filters[1]));
  } finally {
    (Restaurant as any).find = originalFind;
  }
});

test("catalog.list takes each restaurant menu exclusively from that persisted restaurant row", async () => {
  const firstMenu = [{ id: "first-persisted-only", name: "Primero", price: 4.25, available: true, category: "Entrantes", image: "first.webp" }];
  const secondMenu = [{ id: "second-persisted-only", name: "Segundo", price: 9.75, available: true, category: "Principales", image: "second.webp" }];
  const rows = [
    publicRestaurant({ _id: IDs.menuOne, slug: "menu-source-one", menu: firstMenu }),
    publicRestaurant({ _id: IDs.menuTwo, slug: "menu-source-two", menu: secondMenu }),
  ];
  const originalFind = (Restaurant as any).find;
  (Restaurant as any).find = () => queryResult(rows);

  try {
    const res = response();
    await handleCustomerTrpc(request(), res.value);
    const catalog = jsonOf(res.state.body) as any[];
    const first = catalog.find((row) => row.slug === "menu-source-one");
    const second = catalog.find((row) => row.slug === "menu-source-two");

    assert.deepEqual(first.menu.map((item: any) => item.id), ["first-persisted-only"]);
    assert.deepEqual(second.menu.map((item: any) => item.id), ["second-persisted-only"]);
    assert.equal(first.menu.some((item: any) => item.id === "second-persisted-only"), false);
    assert.equal(second.menu.some((item: any) => item.id === "first-persisted-only"), false);
  } finally {
    (Restaurant as any).find = originalFind;
  }
});
