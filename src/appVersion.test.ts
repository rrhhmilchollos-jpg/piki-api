import assert from "node:assert/strict";
import test from "node:test";
import { requiresUpdate, type VersionPolicy } from "./appVersion.js";

const policy: VersionPolicy = {
  version: "0.2.11",
  minimumVersion: "0.2.11",
  buildId: "current-build",
  forceUpdate: true,
};

test("forces an older semantic version", () => {
  assert.equal(requiresUpdate(policy, "0.2.10", "old-build", "admin"), true);
});

test("forces a stale build at the same compatible version", () => {
  assert.equal(requiresUpdate(policy, "0.2.11", "old-build", "admin"), true);
});

test("does not force the current build or optional releases", () => {
  assert.equal(requiresUpdate(policy, "0.2.11", "current-build", "admin"), false);
  assert.equal(requiresUpdate({ ...policy, forceUpdate: false }, "0.2.11", "old-build", "customer"), false);
});
