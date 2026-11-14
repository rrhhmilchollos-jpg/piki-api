import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { CUSTOMER_CATALOG_RESTAURANT_FILTER, customerCatalogRestaurantName, customerMenuForRestaurant, presentCustomerCatalogRestaurant, restaurantIsWithinOpeningHours } from "./customerCatalogPolicy.js";
import { customerAvailability } from "./customerAvailability.js";
import { modifierGroupsForItem, usesReferenceAddOns } from "./menuModifiers.js";
import { canonicalRestaurantMenu } from "./menuContract.js";
import { isCashPaymentEnabledForRestaurant } from "./paymentPolicy.js";

// Execute only AST-extracted functions: no server/customerCompat/fulfillment
// module import, real Mongo query, socket, credentials or payment client.
function source(file: string) {
  return ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}
function declaration(file: ts.SourceFile, name: string): string {
  const statement = file.statements.find((node) => ts.isFunctionDeclaration(node) ? node.name?.text === name :
    ts.isVariableStatement(node) && node.declarationList.declarations.some((item) => ts.isIdentifier(item.name) && item.name.text === name));
  assert.ok(statement, `${file.fileName}: ${name} must exist`);
  return statement.getText(file);
}
function evaluate(text: string, expression: string, bindings: Record<string, unknown> = {}): any {
  const output = ts.transpileModule(text.replace(/^export\s+/gm, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  return new Function(...Object.keys(bindings), `${output}\nreturn (${expression});`)(...Object.values(bindings));
}
const fulfillmentSource = source("./fulfillment.ts");
const policy = evaluate(["METHODS", "isMethod", "DEFAULT_PAYMENT_METHODS", "allowedPaymentMethods", "isRiderPurchase", "paymentDecision"].map((name) => declaration(fulfillmentSource, name)).join("\n"), "({ allowedPaymentMethods, isRiderPurchase, paymentDecision })", { isCashPaymentEnabledForRestaurant });
const publicRestaurantPaymentCapabilities = evaluate(declaration(source("./publicRestaurantPaymentCapabilities.ts"), "publicRestaurantPaymentCapabilities"), "publicRestaurantPaymentCapabilities", policy);
const compatSource = source("./customerCompat.ts");
const restaurantView = evaluate(declaration(compatSource, "restaurantView"), "restaurantView", {
  publicRestaurantPaymentCapabilities, usesReferenceAddOns, restaurantIsWithinOpeningHours, customerAvailability,
  customerCatalogRestaurantName, customerMenuForRestaurant, isCashPaymentEnabledForRestaurant, modifierGroupsForItem,
});
const cases: Array<{ name: string; row: Record<string, any>; methods: string[]; bizumOnly?: boolean; model?: string }> = [
  { name: "legacy absent fields", row: {}, methods: ["stripe", "cash"] },
  { name: "Bizum precedence", row: { bizumOnly: true, paymentMethods: ["stripe", "unknown"] }, methods: ["bizum", "cash"], bizumOnly: true },
  { name: "configured Bizum", row: { paymentMethods: ["bizum"] }, methods: ["bizum", "cash"] },
  { name: "configured cash", row: { paymentMethods: ["cash"], cashPaymentsEnabled: false }, methods: ["cash"] },
  { name: "invalid configuration fallback", row: { paymentMethods: ["unknown"], bizumOnly: "true", fulfillmentModel: "unknown" }, methods: ["stripe", "cash"] },
  { name: "empty configuration fallback", row: { paymentMethods: [] }, methods: ["stripe", "cash"] },
  { name: "null legacy configuration", row: { paymentMethods: null, bizumOnly: null, fulfillmentModel: null }, methods: ["stripe", "cash"] },
  { name: "rider purchase", row: { paymentMethods: ["stripe", "bizum"], fulfillmentModel: "rider_purchase", fulfillmentMode: "partner_delivery" }, methods: ["stripe", "bizum", "cash"], model: "rider_purchase" },
  { name: "delivery mode is not fulfillment model", row: { fulfillmentMode: "assisted_purchase" }, methods: ["stripe", "cash"] },
];
function fixture(index: number, overrides: Record<string, any> = {}) {
  return { _id: String(index), slug: `synthetic-${index}`, name: `Synthetic ${index}`, isActive: true, onboardingStatus: "approved", availabilityStatus: "available", listingType: "official_partner", fulfillmentMode: "partner_delivery", priceIncludesCommission: true, menu: [{ id: "dish", name: "Dish", price: 12.37, available: true, allergens: null }], ...overrides };
}
const privateFields = { iban: "PRIVATE_IBAN", nif: "PRIVATE_NIF", stripeAccountId: "PRIVATE_STRIPE", bankDetails: { account: "PRIVATE_BANK" }, keys: "PRIVATE_KEYS", tenantId: "PRIVATE_TENANT", checkoutUrl: "PRIVATE_PAYMENT_URL", partnerProfile: { city: "Synthetic City", postalCode: "46800", iban: "PRIVATE_PROFILE_IBAN", documents: "PRIVATE_DOCUMENTS" } };
function assertCapabilities(dto: any, entry: typeof cases[number]) {
  assert.deepEqual(dto.allowedPaymentMethods, entry.methods, entry.name);
  assert.deepEqual(dto.paymentMethods, entry.methods, "compatibility alias is canonical, not raw configuration");
  assert.equal(dto.bizumOnly, entry.bizumOnly === true);
  assert.equal(typeof dto.bizumOnly, "boolean");
  assert.equal(dto.fulfillmentModel, entry.model || "partner_managed");
  assert.deepEqual(dto.allowedPaymentMethods, policy.allowedPaymentMethods(entry.row));
}
function response() {
  return { body: undefined as any, statusCode: 200, headers: {} as Record<string, unknown>, json(value: unknown) { this.body = value; return this; }, status(value: number) { this.statusCode = value; return this; }, setHeader(key: string, value: unknown) { this.headers[key] = value; return this; } };
}

test("public helper preserves canonical methods, strict boolean and existing fulfillment semantics", () => {
  for (const entry of cases) {
    const row = structuredClone(entry.row);
    assertCapabilities(publicRestaurantPaymentCapabilities(row), entry);
    assert.deepEqual(row, entry.row, "DTO must not mutate persisted configuration");
  }
  assertCapabilities(publicRestaurantPaymentCapabilities(null), cases[0]);
  assertCapabilities(publicRestaurantPaymentCapabilities(undefined), cases[0]);
  const dto = publicRestaurantPaymentCapabilities({ ...privateFields, bizumOnly: true });
  assert.deepEqual(Object.keys(dto).sort(), ["allowedPaymentMethods", "paymentMethods", "bizumOnly", "fulfillmentModel"].sort());
  dto.paymentMethods.push("stripe");
  assert.deepEqual(dto.allowedPaymentMethods, ["bizum", "cash"], "compatibility alias must not mutate canonical array");
});

test("DTO capabilities agree with the unchanged quote paymentDecision", () => {
  assert.match(declaration(compatSource, "handleCustomerTrpcSingle"), /const decision = paymentDecision\(restaurant, paymentMethod\)/);
  for (const entry of cases) {
    for (const method of ["stripe", "bizum", "cash"]) {
      const decision = policy.paymentDecision(entry.row, method);
      assert.deepEqual(decision.allowed, publicRestaurantPaymentCapabilities(entry.row).allowedPaymentMethods);
      assert.equal(decision.ok, entry.methods.includes(method), `${entry.name}: ${method}`);
    }
  }
  assert.equal(policy.paymentDecision({ bizumOnly: true }, "stripe").error, "PAYMENT_METHOD_NOT_ALLOWED");
  assert.equal(policy.paymentDecision({ bizumOnly: true }, "bizum").paymentState, "pending_bizum_confirmation");
});

test("actual restaurantView used by tRPC publishes capabilities without prices or private data changes", () => {
  for (const [index, entry] of cases.entries()) {
    const row = fixture(index, { ...privateFields, ...entry.row });
    const before = structuredClone(row);
    const dto = restaurantView(row);
    assertCapabilities(dto, entry);
    assert.equal(dto.fulfillmentMode, row.fulfillmentMode);
    assert.equal(dto.menu[0].price, 12.37);
    assert.equal(dto.menu[0].allergens, null);
    assert.equal(dto.cashPaymentsEnabled, true, "existing universal cash policy stays unchanged");
    assert.equal(JSON.stringify(dto).includes("PRIVATE_"), false);
    assert.deepEqual(row, before);
  }
});

test("tRPC catalog.list and catalog.byId execute real extracted handlers with synthetic rows", async () => {
  const rows = cases.map((entry, index) => fixture(index, { ...privateFields, ...entry.row }));
  const query = (value: unknown): any => ({ sort() { return this; }, lean() { return this; }, async exec() { return value; } });
  const handle = evaluate(["inputOf", "parseCustomerTrpcInput", "reply", "fail", "handleCustomerTrpcSingle"].map((name) => declaration(compatSource, name)).join("\n"), "handleCustomerTrpcSingle", {
    restaurantView, CUSTOMER_CATALOG_RESTAURANT_FILTER,
    Restaurant: { find(filter: unknown) { assert.deepEqual(filter, CUSTOMER_CATALOG_RESTAURANT_FILTER); return query(rows); }, findOne(filter: any) { assert.deepEqual(filter.$and[1], CUSTOMER_CATALOG_RESTAURANT_FILTER); return query(rows.find((row) => row.slug === filter.$and[0].slug)); } },
  });
  const call = async (procedure: string, input: unknown) => { const res = response(); await handle({ originalUrl: `/api/trpc/${procedure}`, params: { procedure }, query: {}, body: { json: input } }, res); assert.equal(res.statusCode, 200); return res.body.result.data.json; };
  const listed = await call("catalog.list", {});
  assert.equal(listed.length, cases.length);
  for (const [index, entry] of cases.entries()) {
    assertCapabilities(listed[index], entry);
    assert.deepEqual(await call("catalog.byId", { id: rows[index].slug }), listed[index]);
  }
  assert.equal(JSON.stringify(listed).includes("PRIVATE_"), false);
});

test("REST handler selects policy fields, publishes the same capabilities, and retains private-field exclusion", async () => {
  const file = source("./server.ts");
  const route = file.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(file) === "app.get" && node.expression.arguments[0]?.getText(file) === '"/api/v1/catalog/restaurants"');
  assert.ok(route && ts.isExpressionStatement(route) && ts.isCallExpression(route.expression));
  const callback = route.expression.arguments[1];
  const rows = cases.map((entry, index) => fixture(index, { ...privateFields, ...entry.row }));
  const before = structuredClone(rows);
  let selected = "";
  const handle = evaluate(`const handler = ${callback.getText(file)};`, "handler", {
    catalogCache: new Map(), CATALOG_CACHE_MS: 0, CUSTOMER_CATALOG_RESTAURANT_FILTER,
    Restaurant: { find(filter: unknown) { assert.deepEqual(filter, CUSTOMER_CATALOG_RESTAURANT_FILTER); return { select(value: string) { selected = value; return this; }, sort() { return this; }, lean() { return this; }, async exec() {
      // Apply the real inclusion projection to full synthetic rows, including
      // nested partnerProfile paths, so privacy tests cannot hide omissions.
      return rows.map((row: any) => { const projected: any = { _id: row._id }; for (const path of selected.split(" ")) { const [key, nested] = path.split("."); if (nested) { if (row[key]?.[nested] !== undefined) (projected[key] ||= {})[nested] = structuredClone(row[key][nested]); } else if (row[key] !== undefined) projected[key] = structuredClone(row[key]); } return projected; });
    } }; } },
    Order: { aggregate() { return { async exec() { return []; } }; } },
    presentCustomerCatalogRestaurant, canonicalRestaurantMenu, publicRestaurantPaymentCapabilities,
    FREE_DELIVERY_LAUNCH_LIMIT: 5, isFreeDeliveryLaunchWindow: () => false,
    process: { env: {} },
  });
  const res = response();
  await handle({ query: {} }, res);
  for (const key of ["fulfillmentModel", "paymentMethods", "bizumOnly"]) assert.ok(selected.split(" ").includes(key), `${key} must be fetched, not silently defaulted`);
  assert.equal(res.body.restaurants.length, cases.length);
  for (const [index, entry] of cases.entries()) {
    const dto = res.body.restaurants[index];
    assertCapabilities(dto, entry);
    assert.deepEqual(dto.allowedPaymentMethods, restaurantView(rows[index]).allowedPaymentMethods);
    assert.equal(dto.menu[0].price, 12.37);
    assert.equal(dto.menu[0].allergens, null);
    assert.equal(dto.fulfillmentMode, rows[index].fulfillmentMode);
    assert.equal(dto.cashPaymentsEnabled, true);
    assert.equal(dto.minimumOrderCents, 500);
  }
  assert.equal(JSON.stringify(res.body).includes("PRIVATE_"), false);
  assert.deepEqual(rows, before);
  assert.match(String(res.headers["Cache-Control"]), /no-store/);
});
