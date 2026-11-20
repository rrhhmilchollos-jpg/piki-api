import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";
import { confirmEmployeePasswordReset, type PasswordResetConfirmDependencies } from "./employeePasswordResetConfirm.js";
import { revokeEmployeeSessions, EmployeeSession } from "./employeeSessions.js";

const token = "OFFLINE_SYNTHETIC_TOKEN_".repeat(3);
const tokenHash = createHash("sha256").update(token).digest("hex");
const now = new Date("2026-11-20T12:00:00Z");
const input = { token, newPassword: "OfflinePassword123", surface: "partner" };
function harness(failure = "") {
  let db: any = { reset: { _id: "reset", employeeId: "employee", tokenHash, usedAt: null, expiresAt: new Date(now.getTime() + 30 * 60_000), surface: "partner", email: "partner@example.test" }, employee: { _id: "employee", email: "partner@example.test", active: true, authorizationStatus: "approved", passwordHash: "OLD_HASH", sessionHash: "OLD_LEGACY", mustChangePassword: true, passwordChangedAt: null }, sessions: ["SESSION_ONE", "SESSION_TWO"] };
  let version = 0;
  const effects: string[] = [];
  const state = (session: any) => { assert(session?.state, "All persistence must use the transaction session"); return session.state; };
  const deps: PasswordResetConfirmDependencies = {
    now: () => new Date(now),
    startSession: async () => {
      effects.push("start"); if (failure === "start") throw new Error("OFFLINE_TRANSACTIONS_UNAVAILABLE");
      const session: any = { state: null, async withTransaction(fn: () => Promise<void>, options: any) {
        assert.deepEqual(options.readConcern, { level: "snapshot" }); assert.deepEqual(options.writeConcern, { w: "majority" });
        if (failure === "transactions") throw new Error("Transaction numbers are only allowed on a replica set");
        for (let attempt = 0; attempt < 10; attempt++) {
          const snapshotVersion = version; session.state = structuredClone(db);
          try {
            await fn();
            if (failure === "commit") throw new Error("OFFLINE_COMMIT_FAILED");
            if (version !== snapshotVersion) { effects.push("conflict:retry"); continue; }
            db = session.state; version++; effects.push("commit"); return;
          } catch (error) { effects.push("rollback"); throw error; }
        }
        throw new Error("OFFLINE_RETRY_LIMIT");
      }, async endSession() { effects.push("end"); if (failure === "cleanup") throw new Error("OFFLINE_CLEANUP"); } };
      return session;
    },
    findReset: async (hash, time, session) => { effects.push("read:reset"); const row = state(session).reset; return row && row.tokenHash === hash && row.usedAt === null && row.expiresAt > time ? row : null; },
    findEmployee: async (employeeId, session) => { effects.push("read:employee"); const row = state(session).employee; return row?._id === employeeId ? row : null; },
    validateEmployee: async (_employee, _surface, session) => { state(session); effects.push("validate"); if (failure === "binding" || failure === "surface") return false; if (failure === "binding-read") throw new Error("OFFLINE_BINDING_DB_FAILURE"); return true; },
    claimReset: async (_reset, hash, time, session) => { effects.push("claim"); const row = state(session).reset; if (failure === "cas" || row.tokenHash !== hash || row.usedAt || row.expiresAt <= time) return false; row.usedAt = time; return true; },
    savePassword: async (employee, password, time, session) => { assert.equal(employee, state(session).employee); effects.push("save"); Object.assign(employee, { passwordHash: `OFFLINE_HASH:${password}`, sessionHash: null, mustChangePassword: false, passwordChangedAt: time }); if (failure === "save") throw new Error("OFFLINE_SAVE_FAILED"); },
    revokeEmployeeSessions: async (employeeId, session) => { assert.equal(employeeId, state(session).employee._id); effects.push("revoke"); state(session).sessions = []; if (failure === "revoke") throw new Error("OFFLINE_REVOKE_FAILED"); },
  };
  return { deps, effects, get db() { return db; }, run: (overrides = {}) => confirmEmployeePasswordReset({ ...input, ...overrides }, deps) };
}
test("success validates before CAS and atomically commits password plus revocation", async () => {
  const h = harness(); const result = await h.run(); assert.deepEqual(result, { status: 200, body: { changed: true } });
  assert.deepEqual(h.effects, ["start", "read:reset", "read:employee", "validate", "claim", "save", "revoke", "commit", "end"]);
  assert.deepEqual(h.db.sessions, []); assert.equal(h.db.employee.mustChangePassword, false); assert.equal(h.db.employee.sessionHash, null); assert.deepEqual(h.db.reset.usedAt, now); assert.deepEqual(h.db.employee.passwordChangedAt, now);
});
for (const name of ["expired", "expiry-exact", "invalid", "used", "employee-missing", "inactive", "not-approved", "wrong-surface", "email-changed", "surface", "binding", "cas"]) test(`${name} leaves all state intact`, async () => {
  const h = harness(name);
  if (name === "expired") h.db.reset.expiresAt = new Date(now.getTime() - 1);
  if (name === "expiry-exact") h.db.reset.expiresAt = new Date(now);
  if (name === "used") h.db.reset.usedAt = new Date(now.getTime() - 1);
  if (name === "employee-missing") h.db.employee = null;
  if (name === "inactive") h.db.employee.active = false;
  if (name === "not-approved") h.db.employee.authorizationStatus = "suspended";
  if (name === "email-changed") h.db.employee.email = "changed@example.test";
  const before = structuredClone(h.db);
  const result = await h.run(name === "invalid" ? { token: "invalid" } : name === "wrong-surface" ? { surface: "admin" } : {});
  assert.equal(result.status, 400); assert.deepEqual(h.db, before); assert(!h.effects.includes("save")); assert(!h.effects.includes("revoke")); assert(!h.effects.includes("commit"));
  if (name !== "cas") assert(!h.effects.includes("claim"));
});
for (const failure of ["start", "transactions", "save", "revoke", "commit", "binding-read"]) test(`${failure} fails closed with rollback and public safe message`, async () => {
  const h = harness(failure); const before = structuredClone(h.db); const result = await h.run();
  assert.equal(result.status, 503); assert.deepEqual(h.db, before); assert(!h.effects.includes("commit"));
  const publicResult = JSON.stringify(result); for (const value of [token, tokenHash, "OfflinePassword123", "OFFLINE_", "replica set", "OLD_HASH", "OLD_LEGACY"]) assert(!publicResult.includes(value));
});
test("save/revoke rollback leaves link reusable on retry", async () => {
  for (const failure of ["save", "revoke"]) {
    const h = harness(failure); const result = await h.run(); assert.equal(result.status, 503);
    const healthy = harness(); Object.assign(healthy.db, structuredClone(h.db)); assert.equal((await healthy.run()).status, 200);
  }
});
test("two concurrent confirmations commit once; losing retry cannot overwrite password", async () => {
  const h = harness(); const results = await Promise.all([h.run({ newPassword: "OfflineWinnerOne123" }), h.run({ newPassword: "OfflineWinnerTwo123" })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]); assert.equal(h.effects.filter((effect) => effect === "commit").length, 1); assert(h.effects.includes("conflict:retry"));
  const winner = results[0].status === 200 ? "OfflineWinnerOne123" : "OfflineWinnerTwo123"; assert.equal(h.db.employee.passwordHash, `OFFLINE_HASH:${winner}`); assert.deepEqual(h.db.sessions, []);
});
test("cleanup failure does not misreport a successful commit", async () => { const h = harness("cleanup"); assert.equal((await h.run()).status, 200); });
test("historical links without surface remain subject to employee surface validation", async () => {
  const h = harness(); h.db.reset.surface = null; assert.equal((await h.run()).status, 200);
  const bad = harness("surface"); bad.db.reset.surface = null; assert.equal((await bad.run()).status, 400); assert.equal(bad.db.reset.usedAt, null);
});
test("revokeEmployeeSessions passes the provided session and preserves old callers", async () => {
  const original = EmployeeSession.deleteMany; const calls: any[] = [];
  (EmployeeSession as any).deleteMany = (filter: any) => ({ session(session: any) { calls.push({ filter, session }); return this; }, exec: async () => { calls.push("exec"); } });
  const session = {} as any;
  try { await revokeEmployeeSessions("employee", session); await revokeEmployeeSessions("other"); assert.deepEqual(calls, [{ filter: { employeeId: "employee" }, session }, "exec", "exec"]); }
  finally { EmployeeSession.deleteMany = original; }
});
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
test("actual confirm handler validates request and calls DI transaction service only", async () => {
  const route = source.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.arguments[0]?.getText(source) === '"/api/v1/auth/employee/password-reset/confirm"') as ts.ExpressionStatement;
  assert(route && ts.isCallExpression(route.expression));
  let calls = 0;
  const deps = {};
  const context = { employeePasswordResetConfirmSchema: z.object({ token: z.string().min(40), newPassword: z.string().min(12).regex(/[A-Z]/).regex(/[a-z]/).regex(/[0-9]/) }), employeeCredentialSurface: (value: string) => value === "partner" ? "partner" : null, employeePasswordResetConfirmDependencies: deps, confirmEmployeePasswordReset: async (actual: any, dependency: any) => { calls++; assert.equal(dependency, deps); assert.equal(actual.surface, "partner"); return { status: 200, body: { changed: true } }; } };
  const code = `return ${route.expression.arguments.at(-1)!.getText(source)};`;
  const handler = new Function(...Object.keys(context), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(context));
  const response = () => ({ code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } });
  for (const body of [{ token: "short", newPassword: input.newPassword }, { token, newPassword: "weak" }]) { const res = response(); await handler({ body, header: () => "partner" }, res); assert.equal(res.code, 400); }
  const res = response(); await handler({ body: input, header: () => "wrong" }, res); assert.equal(res.code, 400); assert.equal(calls, 0);
  const ok = response(); await handler({ body: input, header: () => "partner" }, ok); assert.equal(ok.code, 200); assert.equal(calls, 1);
});

test("transaction wrapper that never executes callback cannot report success", async () => {
  const h = harness(); h.deps.startSession = async () => ({ withTransaction: async () => undefined, endSession: async () => undefined });
  const before = structuredClone(h.db); assert.equal((await h.run()).status, 503); assert.deepEqual(h.db, before);
});
test("invalid expiry fails before any claim", async () => {
  const h = harness(); h.deps.findReset = async () => ({ employeeId: "employee", usedAt: null, expiresAt: "invalid" });
  assert.equal((await h.run()).status, 400); assert(!h.effects.includes("claim"));
});
test("production DI adapter puts token CAS, document save, session revoke and binding reads on one session", async () => {
  const statement = source.statements.find((s) => ts.isVariableStatement(s) && s.declarationList.declarations.some((d) => d.name.getText(source) === "employeePasswordResetConfirmDependencies")); assert(statement);
  const session = { withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined };
  const writes: any[] = []; const readFilters: any[] = []; let activeReads = 0; let maxReads = 0;
  const employee: any = { _id: "64c000000000000000000001", tenantId: "64c000000000000000000002", email: "partner@example.test", active: true, authorizationStatus: "approved", apiRole: "partner", save: async (options: any) => { assert.equal(options.session, session); writes.push("save"); } };
  const reset = { _id: "64c000000000000000000003", employeeId: employee._id, email: employee.email, usedAt: null, expiresAt: new Date(now.getTime() + 30 * 60_000), surface: "partner" };
  const query = (row: any) => ({ select() { return this; }, session(actual: any) { assert.equal(actual, session); return this; }, lean() { return this; }, exec: async () => row });
  const read = async (filter: any, options: any, value: any) => { assert.equal(options.session, session); readFilters.push(filter); activeReads++; maxReads = Math.max(maxReads, activeReads); await new Promise((resolve) => setImmediate(resolve)); activeReads--; return value; };
  const context = {
    mongoose: { startSession: async () => session },
    EmployeePasswordReset: { findOne: (filter: any) => { assert.equal(filter.tokenHash, tokenHash); assert.equal(filter.usedAt, null); assert(filter.expiresAt.$gt instanceof Date); return query(reset); }, findOneAndUpdate: (filter: any, update: any, options: any) => { assert.equal(options.session, session); assert.equal(filter._id, reset._id); assert.equal(filter.employeeId, employee._id); assert.equal(filter.tokenHash, tokenHash); assert.equal(filter.usedAt, null); assert(filter.expiresAt.$gt instanceof Date); assert(update.$set.usedAt instanceof Date); writes.push("cas"); return query({ _id: reset._id }); } },
    EmployeeAccount: { findOne: (filter: any) => { assert.deepEqual(filter, { _id: employee._id, active: true, authorizationStatus: "approved" }); return query(employee); } },
    employeeCanUseCredentialSurface: (_employee: any, surface: string) => surface === "partner",
    isPartnerEmployee: () => true,
    partnerBindingForEmployee: async (_employee: any, binding: any) => {
      await Promise.all([binding.tenants.findOne({ _id: employee.tenantId }), binding.restaurants.findOne({ _id: "restaurant", tenantId: employee.tenantId }), binding.memberships.find({ employeeId: employee._id }).toArray()]);
    },
    partnerBindingErrorResponse: () => null,
    ownerEmail: "owner@example.test", objectId: (value: string) => value,
    Tenant: { collection: { findOne: (filter: any, options: any) => read(filter, options, { status: "active" }) } },
    Restaurant: { collection: { findOne: (filter: any, options: any) => read(filter, options, {}) } },
    TenantMembership: { collection: { find: (filter: any, options: any) => ({ toArray: () => read(filter, options, []) }) } },
    hashPassword: (value: string) => `OFFLINE_HASH:${value}`,
    revokeEmployeeSessions: async (id: any, actual: any) => { assert.equal(id, employee._id); assert.equal(actual, session); writes.push("revoke"); },
  };
  const adapter = new Function(...Object.keys(context), ts.transpileModule(`${statement.getText(source)}; return employeePasswordResetConfirmDependencies;`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(context));
  adapter.now = () => now;
  assert.equal((await confirmEmployeePasswordReset(input, adapter)).status, 200); assert.deepEqual(writes, ["cas", "save", "revoke"]); assert.equal(maxReads, 1); assert.equal(readFilters.length, 3); assert.equal(employee.passwordHash, `OFFLINE_HASH:${input.newPassword}`); assert.equal(employee.sessionHash, null);
});
