import assert from "node:assert/strict";
import test from "node:test";
import { nativeReleasePolicy } from "./nativeReleasePolicy.js";

const web = { version: "0.2.14", minimumVersion: "0.2.14", buildId: "4054ee19e896", forceUpdate: true };

test("native clients keep the server minimum while exposing their installed build", () => {
  const previous = process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED;
  process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED = "true";
  const result = nativeReleasePolicy(web, "0.2.13", "75cfcc35104c");
  if (previous === undefined) delete process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED; else process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED = previous;
  assert.equal(result.version, "0.2.14");
  assert.equal(result.buildId, "75cfcc35104c");
  assert.equal(result.minimumVersion, "0.2.14");
  assert.equal(result.forceUpdate, true);
  assert.equal(result.buildId !== "75cfcc35104c", false);
  assert.deepEqual(web, { version: "0.2.14", minimumVersion: "0.2.14", buildId: "4054ee19e896", forceUpdate: true });
});

test("invalid or missing client identity keeps the authoritative policy", () => {
  for (const [version, build] of [[undefined, undefined], ["bad", "bad"], ["0.2.13", ""]]) {
    assert.deepEqual(nativeReleasePolicy(web, version, build), web);
  }
});

test("native clients are not trapped before a signed replacement is published", () => {
  const previous = process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED;
  delete process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED;
  const result = nativeReleasePolicy(web, "0.2.13", "75cfcc35104c");
  if (previous === undefined) delete process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED; else process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED = previous;
  assert.equal(result.minimumVersion, "0.0.0");
  assert.equal(result.forceUpdate, false);
  assert.equal(result.buildId, "75cfcc35104c");
});
