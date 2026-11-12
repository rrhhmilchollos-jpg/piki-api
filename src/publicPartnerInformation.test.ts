import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { customerMenuForRestaurant, CUSTOMER_ORDERABLE_RESTAURANT_FILTER } from "./customerCatalogPolicy.js";
import { KAZOKU_INFORMATION_IDS, KAZOKU_INFORMATION_TENANT, PARTNER_INFORMATION_PATH, PARTNER_INFORMATION_PROJECTION, partnerInformationFilter, presentPublicPartnerInformation, registerPublicPartnerInformationRoute } from "./publicPartnerInformation.js";

// Full source acceptance runs when the supplied audit artifact is available.
// Standalone CI still runs all policy/route tests with non-production fixtures.
const sourcePath = new URL("../../piki-audit/kazoku-shared-draft-menu-payload.json", import.meta.url);
const hasSource = existsSync(sourcePath);
const source = hasSource ? JSON.parse(readFileSync(sourcePath, "utf8")).items : [
  { id: "kazoku-01", name: "Fixture 01", price: 6.9, allergens: null, available: false },
  { id: "kazoku-18", name: "Fixture 18", price: 4, allergens: null, available: false },
  { id: "kazoku-42", name: "Fixture 42", price: 5.95, allergens: null, available: false },
  { id: "kazoku-43", name: "Fixture illegible", price: 4.5, allergens: null, available: false },
];
function row(overrides: Record<string, any> = {}): any {
  return {
    _id: KAZOKU_INFORMATION_IDS[0], tenantId: KAZOKU_INFORMATION_TENANT, slug: "kazoku-xativa", name: "Kazoku Xàtiva",
    listingType: "official_partner", onboardingStatus: "pending_review", isActive: true, availabilityStatus: "available", promoted: true,
    locality: "Xàtiva", address: "Stored public address", phone: "Stored public phone", deliveryFeeCents: 399, menuRevision: 1,
    priceIncludesCommission: false, menu: structuredClone(source),
    partnerProfile: { commissionRateBps: 1800, city: "Xàtiva", postalCode: "46800", province: "Valencia", openingHours: { lunes: { morning: { open: "11:30", close: "16:30" }, evening: { open: "19:30", close: "00:00" }, closed: false } } },
    ...overrides,
  };
}

test("both exact authorized restaurants expose their own persisted drafts, never availability", { skip: !hasSource && "Authorized source101 artifact not supplied" }, () => {
  for (const id of KAZOKU_INFORMATION_IDS) {
    const input = row({ _id: id, name: `Stored ${id}`, slug: `stored-${id}` });
    const snapshot = structuredClone(input);
    const dto = presentPublicPartnerInformation(input)!;
    assert.equal(dto.id, id); assert.equal(dto.name, input.name); assert.equal(dto.slug, input.slug);
    assert.equal(dto.sourceItemCount, 101); assert.equal(dto.menu.length, 100);
    assert.deepEqual(dto.omittedItemIds, ["kazoku-43"]);
    assert.equal(dto.deliveryFeeCents, 399); assert.equal(Object.hasOwn(dto, "commissionRateBps"), false);
    assert.equal(dto.canOrder, false); assert.equal(dto.orderable, false); assert.equal(dto.informational, true);
    assert.equal(dto.menuStatus, "pending_validation");
    assert.equal(dto.menu.some(item => item.name.includes("texto no visible")), false);
    const readable = input.menu.filter((item: any) => item.id !== "kazoku-43");
    assert.deepEqual(dto.menu.map(item => item.name), readable.map((item: any) => item.name));
    assert.deepEqual(dto.menu.map(item => item.price), readable.map((item: any) => Math.ceil(item.price * 100 * 1.18 - 1e-9) / 100));
    assert.ok(dto.menu.every(item => item.allergens === null && item.available === false && item.orderable === false));
    assert.deepEqual(dto.menu.filter(item => item.informationPending).map(item => item.id), ["kazoku-18", "kazoku-42"]);
    assert.equal(dto.openingHours?.regular.lunes?.[1].endsNextDay, true);
    assert.deepEqual(input, snapshot, "no source mutation, including availability and prices");
    assert.deepEqual(customerMenuForRestaurant(input), [], "normal purchasing menu still excludes all draft items");
  }
});

test("fail closed on unauthorized IDs, tenants, states, directory and demo rows", () => {
  for (const override of [{ _id: "64b000000000000000000001" }, { tenantId: "64b000000000000000000001" }, { tenantId: undefined }, { listingType: "local_directory" }, { listingType: "restaurant" }, { listingType: undefined }, { onboardingStatus: "rejected" }, { onboardingStatus: "suspended" }, { onboardingStatus: "draft" }, { internalDemo: true }, { fulfillmentMode: "assisted_purchase" }, { name: "" }, { slug: undefined }]) {
    assert.equal(presentPublicPartnerInformation(row(override)), null, JSON.stringify(override));
  }
  for (const isActive of [true, false]) assert.ok(presentPublicPartnerInformation(row({ isActive })), "information does not activate a restaurant");
});

test("approved public partners use only the normal lane; approved nonpublic rows remain read-only", () => {
  assert.equal(presentPublicPartnerInformation(row({ onboardingStatus: "approved", menu: [{ id: "ready", name: "Stored ready", price: 6, available: true, allergens: ["soja"] }] })), null);
  assert.equal(presentPublicPartnerInformation(row({ onboardingStatus: "approved" }))?.canOrder, false, "approval alone does not discard an entirely unavailable draft");
  assert.equal(presentPublicPartnerInformation(row({ onboardingStatus: "approved", isActive: false }))?.canOrder, false);
  assert.equal(CUSTOMER_ORDERABLE_RESTAURANT_FILTER.onboardingStatus, "approved");
  assert.equal(CUSTOMER_ORDERABLE_RESTAURANT_FILTER.isActive, true);
});

test("exact prices apply commission once and unknown financial/allergen inputs never get invented", () => {
  const included = presentPublicPartnerInformation(row({ priceIncludesCommission: true }))!;
  assert.deepEqual(included.menu.map(item => item.price), source.filter((item: any) => item.id !== "kazoku-43").map((item: any) => item.price));
  for (const override of [{ priceIncludesCommission: undefined }, { partnerProfile: {} }, { partnerProfile: { commissionRateBps: -1 } }]) assert.ok(presentPublicPartnerInformation(row(override))!.menu.every(item => item.price === null));
  const dto = presentPublicPartnerInformation(row({ deliveryFeeCents: undefined, menu: [
    { id: "a", name: "Stored A", price: 3, allergens: null }, { id: "b", name: "Stored B", price: 3, allergens: [] },
    { id: "c", name: "Stored C", price: 3 }, { id: "d", name: "Stored D", price: 3, allergens: ["soja"] },
  ] }))!;
  assert.equal(dto.deliveryFeeCents, null);
  assert.deepEqual(dto.menu.map(item => item.allergens), [null, [], null, ["soja"]]);
});

test("allowlist DTO and projection exclude legal, bank, account, tokens and private schedule source", () => {
  const input = row({ email: "PRIVATE_SENTINEL", bank: "PRIVATE_SENTINEL", accounts: ["PRIVATE_SENTINEL"], token: "PRIVATE_SENTINEL", menu: [{ id: "safe", name: "Stored", price: 3, allergens: null, token: "PRIVATE_SENTINEL", modifiers: [{ token: "PRIVATE_SENTINEL" }] }] });
  input.partnerProfile.iban = "PRIVATE_SENTINEL";
  input.partnerProfile.legalName = "PRIVATE_SENTINEL";
  input.partnerProfile.openingHours = { timeZone: "Europe/Madrid", regular: { lunes: [{ open: "11:30", close: "16:30", token: "PRIVATE_SENTINEL" }] }, overrides: [], source: { mode: "google", revision: "PRIVATE_SENTINEL" }, token: "PRIVATE_SENTINEL" };
  const json = JSON.stringify(presentPublicPartnerInformation(input));
  assert.equal(json.includes("PRIVATE_SENTINEL"), false);
  assert.equal(json.includes(KAZOKU_INFORMATION_TENANT), false);
  assert.equal(json.includes('"isActive"'), false);
  assert.equal(json.includes('"commissionRateBps"'), false, "negotiated rate stays server-only");
  assert.ok(!PARTNER_INFORMATION_PROJECTION.split(" ").includes("partnerProfile"));
  assert.doesNotMatch(PARTNER_INFORMATION_PROJECTION, /iban|legalName|email|bank|token|accounts|compliance|documents/);
});

test("GET-only route ignores caller targeting and reads scoped projection; failures are 503, not fixtures", async () => {
  let handler: any;
  const registered: string[] = [];
  const app = { get(path: string, fn: any) { registered.push(path); handler = fn; } } as any;
  const calls: any[] = [];
  let fail = false;
  registerPublicPartnerInformationRoute(app, { objectId: id => `OID:${id}`, findRows: async (filter, projection) => { calls.push({ filter, projection }); if (fail) throw new Error("PRIVATE_ERROR"); return [row(), row({ _id: "unauthorized" })]; } });
  assert.deepEqual(registered, [PARTNER_INFORMATION_PATH]);
  const response = () => ({ code: 200, body: undefined as any, headers: {} as any, setHeader(k: string, v: string) { this.headers[k] = v; }, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } });
  const res = response();
  await handler({ query: { id: "unauthorized", tenantId: "unauthorized" }, body: { isActive: true } }, res);
  assert.equal(res.body.partners.length, 1); assert.equal(res.code, 200);
  assert.deepEqual(calls[0], { filter: partnerInformationFilter(id => `OID:${id}`), projection: PARTNER_INFORMATION_PROJECTION });
  assert.deepEqual(calls[0].filter._id.$in, KAZOKU_INFORMATION_IDS.map(id => `OID:${id}`));
  assert.equal(calls[0].filter.tenantId, `OID:${KAZOKU_INFORMATION_TENANT}`);
  assert.match(res.headers["Cache-Control"], /no-store/);
  fail = true;
  const failed = response(); await handler({}, failed);
  assert.equal(failed.code, 503); assert.deepEqual(failed.body, { error: "PARTNER_INFORMATION_UNAVAILABLE" });
});
