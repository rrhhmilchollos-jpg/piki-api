import assert from "node:assert/strict";
import test from "node:test";
import { RELEASE_METADATA_URLS, requiresUpdate, syncVersionPolicy, type VersionPolicy } from "./appVersion.js";

const policy: VersionPolicy = {
  version: "0.2.11",
  minimumVersion: "0.2.11",
  buildId: "current-build",
  forceUpdate: true,
};

test("Admin release sync fetches and applies metadata from its canonical public domain", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = String(input);
    return {
      ok: true,
      json: async () => ({
        surface: "admin",
        publishedAt: "2026-11-13T13:31:37.612Z",
        version: "1.0.7",
        minimumVersion: "1.0.7",
        buildId: "b653f6ebc4ab",
        forceUpdate: true,
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const synced = await syncVersionPolicy("admin");
    assert.equal(RELEASE_METADATA_URLS.admin, "https://admin.pikidelivery.com/release.json");
    assert.equal(requestedUrl, "https://admin.pikidelivery.com/release.json");
    assert.equal(synced.version, "1.0.7");
    assert.equal(synced.minimumVersion, "1.0.7");
    assert.equal(synced.forceUpdate, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("forces an older semantic version", () => {
  assert.equal(requiresUpdate(policy, "0.2.10", "old-build", "admin"), true);
});

test("does not force a different build at the same compatible version", () => {
  assert.equal(requiresUpdate(policy, "0.2.11", "old-build", "admin"), false);
});

test("does not force the current build or optional releases", () => {
  assert.equal(requiresUpdate(policy, "0.2.11", "current-build", "admin"), false);
  assert.equal(requiresUpdate({ ...policy, forceUpdate: false }, "0.2.11", "old-build", "customer"), false);
});
