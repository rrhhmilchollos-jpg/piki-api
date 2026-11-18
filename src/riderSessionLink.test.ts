import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import ts from "typescript";
import { z } from "zod";
import { EmployeeAccount, Rider } from "./models.js";
import { EmployeeSession, RiderAccountNotLinkedError, issueEmployeeSession, resolveEmployeeSession, sessionRole } from "./employeeSessions.js";

const tenantA = "aaaaaaaaaaaaaaaaaaaaaaaa";
const tenantB = "bbbbbbbbbbbbbbbbbbbbbbbb";
function query(value: any): any {
  return { select() { return this; }, lean() { return this; }, exec: async () => value };
}
function harness(t: TestContext, linked: any = { email: "linked@example.test", tenantId: tenantA }) {
  const employee: any = { _id: "cccccccccccccccccccccccc", id: "cccccccccccccccccccccccc", email: "linked@example.test", tenantId: tenantA, active: true, authorizationStatus: "approved", apiRole: "admin", primaryRole: "admin", jobRole: "admin", roles: ["admin", "fleet", "rider"], passwordHash: "OFFLINE" };
  const sessions: any[] = [];
  const state = { linked, writes: 0, riderReads: 0, deleted: 0 };
  t.mock.method(mongoose.Query.prototype as any, "exec", () => { throw new Error("UNMOCKED_DB_FORBIDDEN"); });
  t.mock.method(Rider as any, "exists", async (filter: any) => {
    state.riderReads++;
    assert.deepEqual(filter, { email: employee.email, tenantId: tenantA });
    return state.linked?.email === filter.email && state.linked?.tenantId === filter.tenantId ? { _id: "dddddddddddddddddddddddd" } : null;
  });
  t.mock.method(EmployeeSession as any, "create", async (row: any) => { state.writes++; sessions.push({ ...row, _id: "eeeeeeeeeeeeeeeeeeeeeeee" }); return row; });
  t.mock.method(EmployeeAccount as any, "updateOne", () => { state.writes++; return query({ matchedCount: 1 }); });
  t.mock.method(EmployeeAccount as any, "findOne", () => query(employee));
  t.mock.method(EmployeeSession as any, "findOne", (filter: any) => query(sessions.find((s) => s.tokenHash === filter.tokenHash) || null));
  t.mock.method(EmployeeSession as any, "updateOne", () => query({ matchedCount: 1 }));
  t.mock.method(EmployeeSession as any, "deleteOne", () => { state.deleted++; return query({ deletedCount: 1 }); });
  return { employee, sessions, state };
}

test("linked multi-role admin/jobRole employee receives a Rider token valid on its first resolve", async (t) => {
  const h = harness(t);
  const issued = await issueEmployeeSession(h.employee, "rider");
  assert(issued); assert.equal(issued.role, "rider");
  assert.equal((await resolveEmployeeSession(issued.token))?.role, "rider");
  assert.equal(h.sessions[0].tenantId, tenantA);
  assert.equal(h.employee.apiRole, "admin"); assert.equal(h.employee.jobRole, "admin");
  assert.equal(h.state.riderReads, 2);
});
for (const [label, linked] of [
  ["missing Rider", null],
  ["Rider in another tenant", { email: "linked@example.test", tenantId: tenantB }],
  ["Rider with another email", { email: "other@example.test", tenantId: tenantA }],
] as const) {
  test(`issuance rejects ${label} without creating a session or updating lastLoginAt`, async (t) => {
    const h = harness(t, linked);
    await assert.rejects(issueEmployeeSession(h.employee, "rider"), (error: unknown) => error instanceof RiderAccountNotLinkedError && error.code === "RIDER_ACCOUNT_NOT_LINKED");
    assert.equal(h.state.writes, 0); assert.equal(h.sessions.length, 0);
  });
}
for (const surface of ["admin", "fleet"]) {
  test(`${surface} multi-role session does not require a Rider link or change jobRole`, async (t) => {
    const h = harness(t, null);
    const issued = await issueEmployeeSession(h.employee, surface);
    assert(issued); assert.equal(issued.role, surface);
    assert.equal((await resolveEmployeeSession(issued.token))?.role, surface);
    assert.equal(h.state.riderReads, 0); assert.equal(h.employee.jobRole, "admin");
  });
}
for (const change of ["delete", "rider-email", "employee-email"] as const) {
  test(`resolver remains strict after later ${change}`, async (t) => {
    const h = harness(t); const issued = await issueEmployeeSession(h.employee, "rider"); assert(issued);
    if (change === "delete") h.state.linked = null;
    else if (change === "rider-email") h.state.linked.email = "changed@example.test";
    else h.employee.email = "changed@example.test";
    assert.equal(await resolveEmployeeSession(issued.token), null);
  });
}
test("role and tenant denials still precede the Rider read and create no session", async (t) => {
  const h = harness(t, null);
  h.employee.roles = ["admin"];
  assert.equal(await issueEmployeeSession(h.employee, "rider", "rider"), null);
  h.employee.roles = ["admin", "rider"]; h.employee.tenantId = null;
  assert.equal(await issueEmployeeSession(h.employee, "rider"), null);
  assert.equal(h.state.riderReads, 0); assert.equal(h.state.writes, 0);
});

// Compile only the actual handler, never import server.ts or start its workers.
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function handler(path: string, context: Record<string, any>) {
  let callback: ts.ArrowFunction | undefined;
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "app" && node.expression.name.text === "post" && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && node.arguments[0].text === path) {
      callback = node.arguments.find(ts.isArrowFunction) as ts.ArrowFunction;
    }
    ts.forEachChild(node, visit);
  }
  visit(source); assert(callback);
  const js = ts.transpileModule(`const subject = ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${js}; return subject;`)(...Object.values(context));
}
function response() {
  return { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
}
function routeContext(verify = true) {
  return { z, employeeSessionRoles: ["admin", "partner", "rider", "fleet", "commercial", "gerente_comercial_zona", "finance", "support"], employeeLoginSchema: z.object({ email: z.string(), password: z.string(), role: z.string().optional() }), ownerEmail: "owner@example.test", EmployeeAccount, EmployeeSession, RiderAccountNotLinkedError, issueEmployeeSession, sessionRole, verifyPassword: () => verify, tenantScope: () => ({ tenantId: tenantA }), employeeCodeFor: () => "PIKI-E-OFFLINE", hashSessionToken: () => "OFFLINE_HASH" };
}
const request = { body: { email: "linked@example.test", password: "OFFLINE_PASSWORD", role: "rider" }, headers: { "x-piki-surface": "rider", authorization: "Bearer OLD_OFFLINE_TOKEN" }, auth: { employeeId: "cccccccccccccccccccccccc" } };
for (const route of ["login", "switch-role"]) {
  test(`${route} maps missing Rider to a clear 403 without issuing or deleting sessions`, async (t) => {
    const h = harness(t, null); const res = response();
    await handler(`/api/v1/auth/employee/${route}`, routeContext())(request, res);
    assert.equal(res.code, 403); assert.equal(res.body.error, "RIDER_ACCOUNT_NOT_LINKED"); assert.match(res.body.message, /Administración/);
    assert.equal(h.state.writes, 0); assert.equal(h.state.deleted, 0); assert.equal(res.body.accessToken, undefined);
  });
  test(`${route} rethrows technical database errors instead of misclassifying them as a link denial`, async (t) => {
    harness(t); const failure = new Error("OFFLINE_DB_FAILURE"); const context = routeContext();
    context.issueEmployeeSession = async () => { throw failure; };
    await assert.rejects(handler(`/api/v1/auth/employee/${route}`, context)(request, response()), (error) => error === failure);
  });
}
test("invalid credentials are rejected before revealing or querying a Rider link", async (t) => {
  const h = harness(t, null); const res = response();
  await handler("/api/v1/auth/employee/login", routeContext(false))(request, res);
  assert.equal(res.code, 401); assert.equal(res.body.error, "INVALID_CREDENTIALS"); assert.equal(h.state.riderReads, 0); assert.equal(h.state.writes, 0);
});
test("linked login preserves persisted admin membership and primaryRole while exposing the Rider session", async (t) => {
  const h = harness(t); const res = response();
  await handler("/api/v1/auth/employee/login", routeContext())(request, res);
  assert.equal(res.code, 200); assert.equal(res.body.employee.apiRole, "rider"); assert.equal(res.body.employee.primaryRole, "admin");
  assert.deepEqual(res.body.employee.roles, ["admin", "fleet", "rider"]); assert.equal(h.employee.jobRole, "admin");
  assert.equal((await resolveEmployeeSession(res.body.accessToken))?.role, "rider");
});
test("linked switch-role issues a valid Rider token before removing the old session", async (t) => {
  const h = harness(t); const res = response();
  await handler("/api/v1/auth/employee/switch-role", routeContext())(request, res);
  assert.equal(res.code, 200); assert.equal(res.body.role, "rider"); assert.equal(h.sessions.length, 1); assert.equal(h.state.deleted, 1);
  assert.equal((await resolveEmployeeSession(res.body.accessToken))?.role, "rider");
  assert.deepEqual(h.employee.roles, ["admin", "fleet", "rider"]); assert.equal(h.employee.jobRole, "admin");
});
