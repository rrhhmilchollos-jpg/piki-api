import assert from "node:assert/strict";
import test from "node:test";
import { partnerReadinessBlockers } from "./partnerReadinessDiagnostics.js";

const readyRestaurant = () => ({
  slug: "kazoku-xativa",
  isActive: true,
  onboardingStatus: "approved",
  availabilityStatus: "available",
  listingType: "official_partner",
  marketplaceCompliance: { pikiStatus: "verified" },
  menu: [{ available: true, allergens: [] }],
});

test("ready restaurant has no blockers", () => {
  assert.deepEqual(partnerReadinessBlockers(readyRestaurant()), []);
});

test("reports compliance and allergen blockers separately without approving", () => {
  const restaurant = readyRestaurant();
  restaurant.marketplaceCompliance.pikiStatus = "pending";
  restaurant.menu[0].allergens = null as any;
  assert.deepEqual(partnerReadinessBlockers(restaurant), ["piki_compliance_not_verified", "menu_allergens_missing"]);
  assert.equal(restaurant.marketplaceCompliance.pikiStatus, "pending");
});

test("reports unavailable menu items and missing menus", () => {
  const restaurant = readyRestaurant();
  restaurant.menu = [{ available: false, allergens: [] }];
  assert.deepEqual(partnerReadinessBlockers(restaurant), ["menu_no_available_items"]);
  assert.deepEqual(partnerReadinessBlockers({ ...readyRestaurant(), menu: [] }), ["menu_empty"]);
});

test("preserves onboarding and pause blockers alongside menu blockers", () => {
  const restaurant = readyRestaurant();
  restaurant.onboardingStatus = "pending_review";
  restaurant.isActive = false;
  assert.deepEqual(partnerReadinessBlockers(restaurant), ["not_approved", "paused"]);
});

test("does not mark an unpublished/directory restaurant orderable", () => {
  const restaurant = { ...readyRestaurant(), listingType: "local_directory" };
  assert.deepEqual(partnerReadinessBlockers(restaurant), ["not_orderable"]);
});
