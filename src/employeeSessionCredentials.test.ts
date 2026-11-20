import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import ts from "typescript";
import { z } from "zod";
import { EmployeeAccount, Rider } from "./models.js";
import { hashPassword, hashSessionToken, verifyPassword } from "./employeeAuth.js";
import { OWNER_EMAIL, EmployeeSession, RiderAccountNotLinkedError, adoptLegacyRootOwnerSession, employeeCredentialFingerprint, issueEmployeeSession, resolveEmployeeSession, revokeEmployeeSessions, sessionCredentialsMatchEmployee, sessionRole } from "./employeeSessions.js";
import { confirmEmployeePasswordReset, type PasswordResetConfirmDependencies } from "./employeePasswordResetConfirm.js";

// Only actual functions/AST-compiled route callbacks, with synthetic persistence.
// The offline runner forbids sockets, Mongo, dotenv and application bootstrap.
const ids = { employee: "65a000000000000000000001", tenant: "65a000000000000000000002", other: "65a000000000000000000003" };
const oldPassword = "OfflineOldPassword123";
const newPassword = "OfflineNewPassword456";
const resetToken = "OFFLINE_RESET_TOKEN_".repeat(4);
const initialTime = Date.parse("2026-11-20T12:00:00Z");
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function route(path: string, context: Record<string, any>) {
  const statement = source.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.arguments[0]?.getText(source) === JSON.stringify(path)) as ts.ExpressionStatement;
  assert(statement && ts.isCallExpression(statement.expression));
  const callback = statement.expression.arguments.at(-1)!;
  const js = ts.transpileModule(`return ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), js)(...Object.values(context));
}
function response() {
  return { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
}
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: [string, any]) => {
    if (key === "$or") return value.some((branch: any) => matches(row, branch));
    if (value && typeof value === "object" && !(value instanceof Date)) {
      if ("$gt" in value) return row[key] > value.$gt;
      if ("$ne" in value) return row[key] !== value.$ne;
      if ("$exists" in value) return Object.hasOwn(row, key) === value.$exists;
    }
    return String(row[key]) === String(value);
  });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date"], now: initialTime });
  let db: any = {
    employee: { _id: ids.employee, id: ids.employee, email: "offline@example.test", tenantId: ids.tenant, active: true, authorizationStatus: "approved", jobRole: "admin", apiRole: "admin", roles: ["admin", "rider", "fleet"], primaryRole: "admin", mustChangePassword: false, passwordHash: hashPassword(oldPassword), passwordChangedAt: null, sessionHash: null },
    sessions: [], reset: { _id: "offline-reset", employeeId: ids.employee, email: "offline@example.test", surface: "rider", tokenHash: hashSessionToken(resetToken), usedAt: null, expiresAt: new Date(initialTime + 60_000) },
  };
  const reads: Array<{ kind: string; selection: string }> = [];
  const query = (kind: string, execute: (state: any, selection: string) => any): any => {
    let transaction: any; let selection = "";
    return { select(value: string) { selection = value; return this; }, lean() { return this; }, session(value: any) { transaction = value; return this; }, async exec() {
      reads.push({ kind, selection }); return execute(transaction?.state || db, selection);
    } };
  };
  t.mock.method(mongoose.Query.prototype as any, "exec", () => { throw new Error("UNMOCKED_DB_FORBIDDEN"); });
  t.mock.method(EmployeeAccount as any, "findOne", (filter: any) => query("employee", (state, selection) => {
    if (!state.employee || !matches(state.employee, filter)) return null;
    const result = structuredClone(state.employee);
    if (!selection.includes("+passwordHash")) delete result.passwordHash;
    return result;
  }));
  t.mock.method(EmployeeAccount as any, "findById", (id: any) => query("employee", (state, selection) => {
    if (id !== state.employee._id) return null;
    const result = structuredClone(state.employee);
    if (!selection.includes("+passwordHash")) delete result.passwordHash;
    result.save = async () => { const { save, ...persisted } = result; db.employee = structuredClone(persisted); };
    return result;
  }));
  t.mock.method(EmployeeAccount as any, "updateOne", (filter: any, update: any) => query("employee-update", (state) => {
    if (!matches(state.employee, filter)) return { matchedCount: 0 };
    Object.assign(state.employee, update.$set); return { matchedCount: 1 };
  }));
  t.mock.method(EmployeeSession as any, "create", async (row: any) => { db.sessions.push({ _id: `offline-session-${db.sessions.length}`, ...structuredClone(row) }); return row; });
  t.mock.method(EmployeeSession as any, "findOne", (filter: any) => query("session", (state, selection) => {
    const row = state.sessions.find((candidate: any) => matches(candidate, filter));
    if (!row) return null;
    const result = structuredClone(row);
    if (!selection.includes("+credentialFingerprint")) delete result.credentialFingerprint;
    return result;
  }));
  t.mock.method(EmployeeSession as any, "updateOne", (filter: any, update: any, options: any) => query("session-update", (state) => {
    let row = state.sessions.find((candidate: any) => matches(candidate, filter));
    if (!row && options?.upsert) { row = { _id: "offline-adopted", ...filter, ...structuredClone(update.$setOnInsert) }; state.sessions.push(row); }
    if (!row) return { matchedCount: 0 };
    if (update.$set) Object.assign(row, structuredClone(update.$set));
    return { matchedCount: 1 };
  }));
  for (const method of ["deleteMany", "deleteOne"] as const) t.mock.method(EmployeeSession as any, method, (filter: any) => query("session-delete", (state) => {
    const previous = state.sessions.length;
    state.sessions = state.sessions.filter((candidate: any) => !matches(candidate, filter));
    return { deletedCount: previous - state.sessions.length };
  }));
  const riderState = { hook: async () => {} };
  t.mock.method(Rider as any, "exists", async (filter: any) => { assert.equal(filter.tenantId, ids.tenant); await riderState.hook(); return { _id: ids.other }; });
  const deps: PasswordResetConfirmDependencies = {
    startSession: async () => {
      const session: any = { state: null, async withTransaction(fn: () => Promise<void>) { session.state = structuredClone(db); await fn(); db = session.state; }, async endSession() {} };
      return session;
    },
    findReset: async (hash, now, transaction: any) => { const row = transaction.state.reset; return row.tokenHash === hash && row.usedAt === null && row.expiresAt > now ? row : null; },
    findEmployee: async (_id, transaction: any) => transaction.state.employee,
    validateEmployee: async () => true,
    claimReset: async (reset, _hash, now) => { reset.usedAt = now; return true; },
    savePassword: async (employee, password, now) => { Object.assign(employee, { passwordHash: hashPassword(password), passwordChangedAt: now, sessionHash: null, mustChangePassword: false }); },
    revokeEmployeeSessions: (id, transaction) => revokeEmployeeSessions(id, transaction as any),
  };
  const context = { z, EmployeeAccount, EmployeeSession, RiderAccountNotLinkedError, employeeCredentialFingerprint, issueEmployeeSession, sessionRole, verifyPassword, hashPassword, hashSessionToken, employeeSessionRoles: ["admin", "rider", "fleet"], ownerEmail: OWNER_EMAIL, tenantScope: () => ({ tenantId: ids.tenant }), employeeCodeFor: () => "OFFLINE_EMPLOYEE", employeeLoginSchema: z.object({ email: z.string(), password: z.string(), role: z.string().optional() }) };
  const login = async (password = oldPassword, surface = "rider") => {
    const res = response(); await route("/api/v1/auth/employee/login", context)({ body: { email: db.employee.email, password }, headers: { "x-piki-surface": surface } }, res); return res;
  };
  const reset = () => confirmEmployeePasswordReset({ token: resetToken, newPassword, surface: "rider" }, deps);
  const switchRole = async (token: string) => {
    const res = response(); await route("/api/v1/auth/employee/switch-role", context)({ body: { role: "rider" }, auth: { employeeId: ids.employee }, headers: { authorization: `Bearer ${token}`, "x-piki-surface": "rider" } }, res); return res;
  };
  return { get db() { return db; }, reads, riderState, context, login, reset, switchRole };
}

for (const offset of [0, 1000]) test(`verified old login inserted after committed reset is denied even when issuedAt is reset + ${offset}ms`, async (t) => {
  const h = harness(t); const entered = deferred(); const resume = deferred();
  h.riderState.hook = async () => { entered.resolve(); await resume.promise; };
  const pending = h.login(); await entered.promise;
  assert.equal((await h.reset()).status, 200); assert.equal(h.db.sessions.length, 0);
  t.mock.timers.setTime(initialTime + offset); resume.resolve();
  const oldLogin = await pending; assert.equal(oldLogin.code, 200);
  const stale = h.db.sessions[0]; assert.equal(stale.issuedAt.getTime(), h.db.employee.passwordChangedAt.getTime() + offset);
  assert.notEqual(stale.credentialFingerprint, employeeCredentialFingerprint(h.db.employee.passwordHash));
  assert.equal(await resolveEmployeeSession(oldLogin.body.accessToken), null);
  assert.equal((await h.login(oldPassword)).code, 401);
  const fresh = await h.login(newPassword); assert.equal(fresh.code, 200);
  const resolved = await resolveEmployeeSession(fresh.body.accessToken); assert.equal(resolved?.role, "rider"); assert.equal(resolved?.tenantId, ids.tenant);
  for (const output of [oldLogin.body, fresh.body, resolved]) {
    const publicValue = JSON.stringify(output);
    for (const secret of [oldPassword, newPassword, h.db.employee.passwordHash, stale.credentialFingerprint, "credentialFingerprint", "passwordHash"]) assert(!publicValue.includes(secret));
  }
  assert(h.reads.some((read) => read.kind === "session" && read.selection.includes("+credentialFingerprint")));
  assert(h.reads.some((read) => read.kind === "employee" && read.selection.includes("+passwordHash")));
});

test("normal mandatory password change refreshes only the current session snapshot and preserves its access", async (t) => {
  const h = harness(t); h.db.employee.mustChangePassword = true;
  const current = await h.login(); const other = await h.login(); assert.equal(h.db.sessions.length, 2);
  assert.equal((await resolveEmployeeSession(current.body.accessToken))?.mustChangePassword, true);
  t.mock.timers.setTime(initialTime + 1000);
  const res = response(); await route("/api/v1/auth/employee/change-password", h.context)({ body: { currentPassword: oldPassword, newPassword }, auth: { employeeId: ids.employee }, headers: { authorization: `Bearer ${current.body.accessToken}` } }, res);
  assert.deepEqual(res.body, { changed: true }); assert.equal(h.db.sessions.length, 1);
  assert.equal(h.db.sessions[0].credentialFingerprint, employeeCredentialFingerprint(h.db.employee.passwordHash));
  assert.equal((await resolveEmployeeSession(current.body.accessToken))?.mustChangePassword, false);
  assert.equal(await resolveEmployeeSession(other.body.accessToken), null);
  assert(verifyPassword(newPassword, h.db.employee.passwordHash));
});

for (const changed of [false, true]) test(`legacy session without fingerprint retains timestamp compatibility: changed=${changed}`, async (t) => {
  const h = harness(t); const login = await h.login(); delete h.db.sessions[0].credentialFingerprint;
  h.db.employee.passwordChangedAt = new Date(initialTime + (changed ? 1 : 0));
  delete h.db.employee.passwordHash; // Historical validation does not require it.
  assert.equal(Boolean(await resolveEmployeeSession(login.body.accessToken)), !changed);
  assert.equal(Object.hasOwn(h.db.sessions[0], "credentialFingerprint"), false);
});

for (const fingerprint of [null, "", "malformed", "0".repeat(64)]) test(`present invalid fingerprint never takes the legacy fallback: ${String(fingerprint)}`, async (t) => {
  const h = harness(t); const login = await h.login(); h.db.sessions[0].credentialFingerprint = fingerprint;
  assert.equal(await resolveEmployeeSession(login.body.accessToken), null);
});

test("new issuance without its verified passwordHash fails closed, without re-reading current credentials", async (t) => {
  const h = harness(t); const employee = structuredClone(h.db.employee); delete employee.passwordHash;
  assert.equal(await issueEmployeeSession(employee, "admin"), null); assert.equal(h.db.sessions.length, 0); assert.equal(h.reads.length, 0);
});

test("role switch is credential-bound, carries tenant/roles, and hides both hashes", async (t) => {
  const h = harness(t); const login = await h.login(oldPassword, "admin");
  const switched = await h.switchRole(login.body.accessToken); assert.equal(switched.code, 200);
  assert.deepEqual(switched.body.roles, ["admin", "rider", "fleet"]);
  assert.equal(await resolveEmployeeSession(login.body.accessToken), null);
  assert.equal((await resolveEmployeeSession(switched.body.accessToken))?.role, "rider");
  assert.equal((await resolveEmployeeSession(switched.body.accessToken))?.tenantId, ids.tenant);
  const publicValue = JSON.stringify(switched.body); assert(!publicValue.includes("credentialFingerprint")); assert(!publicValue.includes(h.db.employee.passwordHash));
  assert(h.reads.some((read) => read.kind === "employee" && read.selection.includes("passwordChangedAt") && read.selection.includes("+passwordHash")));
});

test("reset committed between middleware auth and role-switch employee read cannot renew the revoked token", async (t) => {
  const h = harness(t); const login = await h.login(oldPassword, "admin");
  assert(await resolveEmployeeSession(login.body.accessToken)); assert.equal((await h.reset()).status, 200);
  const result = await h.switchRole(login.body.accessToken); assert.equal(result.code, 403); assert.equal(result.body.accessToken, undefined); assert.equal(h.db.sessions.length, 0);
});

test("role switch paused after source validation cannot resurrect credentials after reset", async (t) => {
  const h = harness(t); const login = await h.login(oldPassword, "admin");
  const entered = deferred(); const resume = deferred(); h.riderState.hook = async () => { entered.resolve(); await resume.promise; };
  const pending = h.switchRole(login.body.accessToken); await entered.promise;
  assert.equal((await h.reset()).status, 200); t.mock.timers.setTime(initialTime + 1000); resume.resolve();
  const switched = await pending; assert.equal(switched.code, 200); assert.equal(await resolveEmployeeSession(switched.body.accessToken), null);
});

test("legacy role switch remains allowed until timestamp invalidation; wrong employee/tenant never grants a token", async (t) => {
  const h = harness(t); const login = await h.login(oldPassword, "admin"); const old = structuredClone(h.db.sessions[0]); delete old.credentialFingerprint;
  h.db.sessions = [structuredClone(old)]; assert.equal((await h.switchRole(login.body.accessToken)).code, 200);
  for (const override of [{ employeeId: ids.other }, { tenantId: ids.other }]) {
    h.db.sessions = [{ ...structuredClone(old), ...override }]; assert.equal((await h.switchRole(login.body.accessToken)).code, 403);
  }
  h.db.sessions = [old]; h.db.employee.passwordChangedAt = new Date(initialTime + 1);
  assert.equal((await h.switchRole(login.body.accessToken)).code, 403);
});

test("root legacy adoption snapshots the hash it actually authenticated and remains private", async (t) => {
  const h = harness(t); const token = "OFFLINE_LEGACY_OWNER";
  Object.assign(h.db.employee, { email: OWNER_EMAIL, ownerProtected: true, accessLevel: "superadmin", sessionHash: hashSessionToken(token) });
  const resolved = await adoptLegacyRootOwnerSession(token); assert.equal(resolved?.isRootOwner, true);
  assert.equal(h.db.employee.sessionHash, null); assert.equal(h.db.sessions[0].credentialFingerprint, employeeCredentialFingerprint(h.db.employee.passwordHash));
  assert(!JSON.stringify(resolved).includes("credentialFingerprint"));
  h.db.employee.passwordHash = hashPassword(newPassword); h.db.employee.passwordChangedAt = new Date(initialTime - 1000);
  assert.equal(await resolveEmployeeSession(token), null); // Not dependent on the clock.
});

test("root adoption paused before insert cannot resurrect its old snapshot after reset", async (t) => {
  const h = harness(t); const token = "OFFLINE_LEGACY_OWNER";
  Object.assign(h.db.employee, { email: OWNER_EMAIL, ownerProtected: true, accessLevel: "superadmin", sessionHash: hashSessionToken(token) });
  h.db.reset.email = OWNER_EMAIL;
  const original = EmployeeSession.updateOne; const entered = deferred(); const resume = deferred();
  t.mock.method(EmployeeSession as any, "updateOne", (filter: any, update: any, options: any) => {
    const q: any = (original as any).call(EmployeeSession, filter, update, options);
    if (update.$setOnInsert) { const exec = q.exec; q.exec = async () => { entered.resolve(); await resume.promise; return exec(); }; }
    return q;
  });
  const pending = adoptLegacyRootOwnerSession(token); await entered.promise;
  assert.equal((await h.reset()).status, 200); t.mock.timers.setTime(initialTime + 1000); resume.resolve();
  assert.equal(await pending, null); assert.equal(await resolveEmployeeSession(token), null);
});

test("credential snapshot is internal by schema default and JSON serialization", () => {
  assert.equal(EmployeeSession.schema.path("credentialFingerprint").options.select, false);
  const fingerprint = employeeCredentialFingerprint("OFFLINE_SYNTHETIC_HASH"); assert.match(fingerprint!, /^[a-f0-9]{64}$/);
  const row = new EmployeeSession({ tokenHash: "OFFLINE_TOKEN_HASH", employeeId: ids.employee, tenantId: ids.tenant, role: "admin", surface: "admin", issuedAt: new Date(), expiresAt: new Date(), credentialFingerprint: fingerprint });
  assert(!JSON.stringify(row).includes(fingerprint!)); assert(!JSON.stringify(row).includes("credentialFingerprint"));
  assert.equal(sessionCredentialsMatchEmployee({ credentialFingerprint: fingerprint }, { passwordHash: "OFFLINE_SYNTHETIC_HASH" }), true);
  assert.equal(sessionCredentialsMatchEmployee({ credentialFingerprint: fingerprint }, {}), false);
});
