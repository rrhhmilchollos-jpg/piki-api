import assert from "node:assert/strict";
import test from "node:test";
import { setVersionPolicy, type VersionPolicy } from "./appVersion.js";

const web: VersionPolicy = { version: "1.0.15", minimumVersion: "1.0.15", buildId: "fixture-web-115", forceUpdate: true };
function response() {
  const state: { status: number; body?: any } = { status: 200 };
  const res: any = { status(code: number) { state.status = code; return res; }, json(body: unknown) { state.body = body; return res; }, setHeader() {} };
  return { state, res };
}

test("Rider release contract — real policy route, version middleware and authentication, all I/O mocked", async (t) => {
  // The offline-validation launcher blocks sockets, listeners, mongoose and payments.
  // Only public release metadata is represented by this in-memory fetch fixture.
  t.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => ({ surface: "rider", ...web }) }) as any);
  const { app } = await import("./server.js");
  const stack = (app as any)._router.stack;
  const versionRoute = stack.find((layer: any) => layer.route?.path === "/api/v1/app-version").route;
  const policyHandler = versionRoute.stack[versionRoute.stack.length - 1].handle;
  const policyWriteIndex = stack.findIndex((layer: any) => layer.route?.path === "/api/v1/app-version/policy");
  const middleware = stack[policyWriteIndex + 1];
  assert.ok(!middleware.route && String(middleware.regexp).includes("api"), "must exercise the real /api/v1 release middleware");
  const endpoints = [
    { method: "GET", path: "/riders/session", route: "/api/v1/riders/session" },
    { method: "GET", path: "/riders/000000000000000000000001/shift", route: "/api/v1/riders/:id/shift" },
    { method: "POST", path: "/riders/000000000000000000000001/shift/start", route: "/api/v1/riders/:id/shift/start" },
  ];
  const prior = process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED;
  t.after(() => { if (prior === undefined) delete process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED; else process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED = prior; });

  for (const entry of [
    { name: "legacy unmarked Rider 1.0.14 is not blocked by the web release", surface: "rider", version: "1.0.14", build: "fixture-native-114", native: false, hard: false, blocked: false },
    { name: "current Rider 1.0.15 is compatible even with another build", surface: "rider", version: "1.0.15", build: "fixture-other-build", native: false, hard: false, blocked: false },
    { name: "native Rider retains existing soft policy without a published replacement", surface: "rider", version: "1.0.14", build: "fixture-native-114", native: true, hard: false, blocked: false },
    { name: "explicit native hard block is preserved", surface: "rider", version: "1.0.14", build: "fixture-native-114", native: true, hard: true, blocked: true },
    { name: "invalid native identity does not bypass authoritative policy", surface: "rider", version: "1.0.14", build: "x", native: true, hard: false, blocked: true },
    { name: "other surfaces keep their enforced compatibility policy", surface: "admin", version: "1.0.14", build: "fixture-admin-114", native: false, hard: false, blocked: true },
  ]) await t.test(entry.name, async () => {
    setVersionPolicy(entry.surface as "rider" | "admin", web);
    process.env.PIKI_NATIVE_FORCE_UPDATE_ENABLED = String(entry.hard);
    const headers: Record<string, string> = { "x-piki-surface": entry.surface, "x-piki-client-version": entry.version, "x-piki-client-build": entry.build };
    if (entry.native) headers["x-piki-native-container"] = "capacitor";
    const request: any = { path: "/riders/session", query: { surface: entry.surface, clientVersion: entry.version, clientBuildId: entry.build }, header: (name: string) => headers[name.toLowerCase()] };
    const policy = response();
    await policyHandler(request, policy.res);
    assert.equal(policy.state.body.updateRequired, entry.blocked);
    for (const endpoint of endpoints) {
      request.path = endpoint.path;
      request.method = endpoint.method;
      let passed = false;
      const result = response();
      await middleware.handle(request, result.res, () => { passed = true; });
      assert.equal(result.state.status, entry.blocked ? 426 : 200, `${endpoint.method} ${endpoint.route}: operational middleware must agree with the announced policy`);
      assert.equal(passed, !entry.blocked);
      if (!entry.blocked) {
        const authentication = response();
        const route = stack.find((layer: any) => layer.route?.path === endpoint.route).route;
        await route.stack[0].handle(request, authentication.res, () => { throw new Error("UNAUTHENTICATED_RIDER_MUST_NOT_REACH_DB_HANDLER"); });
        assert.equal(authentication.state.status, 401);
        assert.equal(authentication.state.body.error, "AUTHENTICATION_REQUIRED");
      }
    }
  });
});
