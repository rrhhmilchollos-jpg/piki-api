import assert from "node:assert/strict";
import test from "node:test";
import { nativeReleasePolicy } from "./nativeReleasePolicy.js";

const web = { version: "0.2.14", minimumVersion: "0.2.14", buildId: "4054ee19e896", forceUpdate: true };

test("legacy native shell receives its own identity and cannot enter the available web-build gate", () => {
  const result = nativeReleasePolicy(web, "0.2.13", "75cfcc35104c");
  assert.equal(result.version, "0.2.13");
  assert.equal(result.buildId, "75cfcc35104c");
  assert.equal(result.minimumVersion, "0.0.0");
  assert.equal(result.forceUpdate, false);
  assert.equal(result.buildId !== "75cfcc35104c", false);
  assert.deepEqual(web, { version: "0.2.14", minimumVersion: "0.2.14", buildId: "4054ee19e896", forceUpdate: true });
});

test("invalid or missing client identity is not echoed", () => {
  for (const [version, build] of [[undefined, undefined], ["bad", "bad"], ["0.2.13", ""]]) {
    assert.deepEqual(nativeReleasePolicy(web, version, build), { ...web, minimumVersion: "0.0.0", forceUpdate: false });
  }
});
