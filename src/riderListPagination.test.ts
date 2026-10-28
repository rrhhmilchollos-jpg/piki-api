import assert from "node:assert/strict";
import test from "node:test";
import { MAX_RIDER_LIST_PAGE_SIZE, parseRiderListPagination } from "./riderListPagination.js";

test("Rider pagination preserves legacy defaults when query parameters are absent", () => {
  assert.deepEqual(parseRiderListPagination(undefined, undefined, 200), { limit: 200, offset: 0 });
  assert.deepEqual(parseRiderListPagination(undefined, undefined, 500), { limit: 500, offset: 0 });
});

test("Rider pagination parses an explicit bounded page", () => {
  assert.deepEqual(parseRiderListPagination("250", "500", 200), { limit: 250, offset: 500 });
  assert.deepEqual(parseRiderListPagination(String(MAX_RIDER_LIST_PAGE_SIZE), "0", 200), { limit: 500, offset: 0 });
});

test("Rider pagination rejects zero or overlarge page sizes", () => {
  assert.equal(parseRiderListPagination("0", "0", 200), null);
  assert.equal(parseRiderListPagination("501", "0", 200), null);
});

test("Rider pagination rejects malformed, fractional, and negative query values", () => {
  assert.equal(parseRiderListPagination("many", "0", 200), null);
  assert.equal(parseRiderListPagination("20.5", "0", 200), null);
  assert.equal(parseRiderListPagination("20", "-1", 200), null);
});

test("Rider pagination rejects unsafe offsets and invalid defaults", () => {
  assert.equal(parseRiderListPagination("20", "9007199254740991", 200), null);
  assert.equal(parseRiderListPagination(undefined, undefined, 0), null);
  assert.equal(parseRiderListPagination(undefined, undefined, 501), null);
});
