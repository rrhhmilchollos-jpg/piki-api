import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { Types } from "mongoose";
import { buildPartnerRecoveryPreview, registerPartnerPasswordRecoveryRoutes, partnerRecoverySendRateLimit, PARTNER_PASSWORD_RECOVERY_PATH, type PartnerPasswordRecoveryDependencies } from "./partnerPasswordRecovery.js";
import { GovernanceAuditEvent } from "./models.js";
import { sessionRole } from "./employeeSessions.js";
import { PartnerBindingError } from "./employeePartnerBinding.js";
import { KitchenAccessError } from "./partnerKitchenAccess.js";
const ids = { tenant: "6ab891dbc9ebf588e74114f2", restaurant: "6acad53e7f55ddba7e05c18a", employee: "64c000000000000000000001", owner: "64c000000000000000000002", other: "64c000000000000000000003", second: "64c000000000000000000004" };
const target = { tenantId: ids.tenant, restaurantId: ids.restaurant };
const ownerEmail = "rrhh.milchollos@gmail.com";
const contact = "shanali1997@icloud.com";
const clone = <T>(v: T): T => structuredClone(v);
const response = () => ({ code: 200, body: null as any, headers: {} as Record<string, string>, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; }, setHeader(name: string, value: string) { this.headers[name] = value; return this; } });
const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const ownerStatement = authSource.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "requireOwner"); assert(ownerStatement);
const ownerCode = ts.transpileModule(ownerStatement.getText(authSource).replace("export ", ""), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function matches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: [string, any]) => {
    if (key === "$or") return value.some((v: any) => matches(row, v));
    if (value?.$in) return value.$in.some((candidate: any) => matches(row, { [key]: candidate }));
    if (Array.isArray(row?.[key])) return row[key].includes(value);
    return row?.[key] === value;
  });
}
function harness() {
  const db: any = {
    owner: { _id: ids.owner, email: ownerEmail, active: true, authorizationStatus: "approved", accessLevel: "superadmin" },
    tenants: [{ _id: ids.tenant, status: "active" }],
    restaurants: [{ _id: ids.restaurant, tenantId: ids.tenant, name: "OFFLINE Alibaba", email: " Shanali1997@icloud.com ", onboardingStatus: "approved", listingType: "official_partner", internalDemo: false }],
    employees: [{ _id: ids.employee, tenantId: ids.tenant, email: contact, name: "OFFLINE Partner", active: true, authorizationStatus: "approved", apiRole: "partner", jobRole: "partner", primaryRole: "partner", roles: ["partner"], partnerRoles: ["manager"], restaurantId: ids.restaurant, restaurantIds: [ids.restaurant], partnerBindingVersion: 1, accessLevel: "subadmin", passwordHash: "OFFLINE_PASSWORD_SECRET", sessionHash: "OFFLINE_SESSION_SECRET" }],
    memberships: [{ _id: ids.employee, tenantId: ids.tenant, employeeId: ids.employee, status: "active", role: "fleet", restaurantIds: [ids.restaurant], scopes: ["historical:fleet"] }],
  };
  const effects: any[] = [];
  const routes = new Map<string, any[]>();
  let sent = true; let mailThrows = false; let auditThrows = false;
  // Compile the actual persisted Owner guard, not a consent or mocked bypass.
  const requireOwner = new Function("resolveRole", "EmployeeAccount", "PIKI_OWNER_EMAIL", `${ownerCode}; return requireOwner;`)(
    async (req: any) => req.authCandidate || null,
    { findOne(filter: any) { effects.push({ ownerFilter: filter }); return { select() { return this; }, lean() { return this; }, exec: async () => db.owner && matches(db.owner, filter) ? db.owner : null }; } }, ownerEmail);
  const deps: PartnerPasswordRecoveryDependencies = {
    requireOwner, sendRateLimit: partnerRecoverySendRateLimit({ limit: 100 }), objectId: (id) => id,
    restaurant: async (filter) => { effects.push({ restaurantFilter: filter }); return clone(db.restaurants.find((row: any) => matches(row, filter)) || null); },
    employees: async (filter) => { effects.push({ employeeFilter: filter }); return clone(db.employees.filter((row: any) => matches(row, filter))); },
    binding: { ownerEmail, objectId: (id) => id,
      tenants: { findOne: async (filter) => clone(db.tenants.find((row: any) => matches(row, filter)) || null) },
      restaurants: { findOne: async (filter) => { effects.push({ bindingRestaurantFilter: filter }); return clone(db.restaurants.find((row: any) => matches(row, filter)) || null); } },
      memberships: { find: (filter) => ({ toArray: async () => clone(db.memberships.filter((row: any) => matches(row, filter))) }) },
    },
    canUsePartner: (employee) => sessionRole(employee, "partner") === "partner",
    sendEmployeePasswordLink: async (employee, surface, purpose) => { effects.push({ mail: { employee: clone(employee), surface, purpose } }); if (mailThrows) throw new Error("OFFLINE_SMTP_SECRET_WITH_TOKEN"); return { delivery: { sent }, reset: { tokenHash: "OFFLINE_TOKEN_HASH_SECRET", resetUrl: "https://example.test/reset?token=OFFLINE_TOKEN_SECRET" } } as any; },
    audit: async (event) => { effects.push({ audit: event }); if (auditThrows) throw new Error("OFFLINE_AUDIT_FAILURE"); },
  };
  registerPartnerPasswordRecoveryRoutes({ get: (path: string, ...handlers: any[]) => { routes.set(`get:${path}`, handlers); }, post: (path: string, ...handlers: any[]) => { routes.set(`post:${path}`, handlers); } } as any, deps);
  const owner = { role: "admin", employeeId: ids.owner, tenantId: ids.tenant, isRootOwner: true };
  async function request(method: string, suffix: string, data: any, authCandidate: any = owner) {
    const req: any = { authCandidate, body: method === "post" ? data : {}, query: method === "get" ? data : {}, header: () => "FORGED_HEADER_MUST_NOT_ENTER_KEYS" };
    const res = response(); const handlers = routes.get(`${method}:${PARTNER_PASSWORD_RECOVERY_PATH}/${suffix}`)!;
    for (const handler of handlers) { let next = false; await handler(req, res, () => { next = true; }); if (!next) break; }
    return res;
  }
  const preview = () => request("get", "preview", target);
  const send = async (overrides: any = {}, previewBody?: any) => { const body = previewBody || (await preview()).body; return request("post", "send", { ...target, employeeId: ids.employee, manifestHash: body.manifestHash, confirmation: "SEND_PARTNER_PASSWORD_RECOVERY", ...overrides }); };
  return { db, effects, deps, request, preview, send, setSent(value: boolean) { sent = value; }, setMailThrows(value: boolean) { mailThrows = value; }, setAuditThrows(value: boolean) { auditThrows = value; } };
}
test("preview contract is read-only, contact-normalized and exact-tenant/exact-association scoped", async () => {
  const h = harness(); const before = clone(h.db); const res = await h.preview();
  assert.equal(res.code, 200); assert.deepEqual(Object.keys(res.body).sort(), ["tenantId", "restaurant", "employee", "ready", "blockers", "manifestHash"].sort());
  assert.equal(res.body.ready, true); assert.deepEqual(res.body.employee, { id: ids.employee, name: "OFFLINE Partner", email: contact }); assert.deepEqual(res.body.restaurant, { id: ids.restaurant, name: "OFFLINE Alibaba" }); assert.deepEqual(res.body.blockers, []); assert.match(res.body.manifestHash, /^[a-f0-9]{64}$/); assert.equal(res.headers["Cache-Control"], "no-store");
  assert.deepEqual(h.db, before); assert(!h.effects.some((event) => event.mail || event.audit));
  assert.deepEqual(h.effects.find((event) => event.employeeFilter).employeeFilter, eligibilityFilter);
  for (const event of h.effects.filter((event) => event.restaurantFilter || event.bindingRestaurantFilter)) assert.equal((event.restaurantFilter || event.bindingRestaurantFilter).tenantId, ids.tenant);
});
test("send uses existing helper once with partner recovery, no credential mutation or secret response/audit", async () => {
  const h = harness(); const before = clone(h.db); const res = await h.send(); assert.equal(res.code, 200);
  assert.deepEqual(res.body, { sent: true, ...target, employeeId: ids.employee, recipient: contact, expiresInMinutes: 30 }); assert.deepEqual(h.db, before);
  const mails = h.effects.filter((event) => event.mail); assert.equal(mails.length, 1); assert.equal(mails[0].mail.surface, "partner"); assert.equal(mails[0].mail.purpose, "recovery");
  const publicData = JSON.stringify({ body: res.body, audit: h.effects.filter((event) => event.audit) }); assert(!/OFFLINE_(PASSWORD|SESSION|TOKEN|SMTP)|resetUrl|tokenHash|passwordHash/.test(publicData));
});
for (const mutate of ["employee-email-different", "employee-other-tenant", "employee-unassociated", "inactive", "pending", "nonpartner", "bad-membership", "bad-scopes", "tenant-inactive", "restaurant-other-tenant", "restaurant-missing", "restaurant-email-empty", "restaurant-email-invalid"]) test(`preview ${mutate} blocks without lookup outside tenant or mutations`, async () => {
  const h = harness(); const employee = h.db.employees[0]; const restaurant = h.db.restaurants[0];
  if (mutate === "employee-email-different") employee.email = "other-login@example.test";
  if (mutate === "employee-other-tenant") employee.tenantId = ids.other;
  if (mutate === "employee-unassociated") { employee.restaurantId = ids.second; employee.restaurantIds = [ids.second]; }
  if (mutate === "inactive") employee.active = false;
  if (mutate === "pending") employee.authorizationStatus = "pending";
  if (mutate === "nonpartner") { employee.apiRole = "rider"; employee.jobRole = "rider"; employee.roles = ["rider"]; }
  if (mutate === "bad-membership") h.db.memberships[0].restaurantIds = [ids.second];
  if (mutate === "bad-scopes") { h.db.memberships[0].role = "partner"; h.db.memberships[0].scopes = ["orders:read"]; }
  if (mutate === "tenant-inactive") h.db.tenants[0].status = "suspended";
  if (mutate === "restaurant-other-tenant") restaurant.tenantId = ids.other;
  if (mutate === "restaurant-missing") h.db.restaurants = [];
  if (mutate === "restaurant-email-empty") restaurant.email = "";
  if (mutate === "restaurant-email-invalid") restaurant.email = "invalid";
  const before = clone(h.db); const res = await h.preview(); assert.equal(res.code, 200); assert.equal(res.body.ready, false); assert.equal(res.body.employee, null); assert(res.body.blockers.length); assert.deepEqual(h.db, before);
  for (const event of h.effects.filter((event) => event.employeeFilter)) assert.equal(event.employeeFilter.tenantId, ids.tenant);
  const send = await h.send({}, res.body); assert.equal(send.code, 409); assert(!h.effects.some((event) => event.mail));
});
test("ambiguous eligible candidates return null rather than choosing first", async () => {
  const h = harness(); h.db.employees.push({ ...clone(h.db.employees[0]), _id: ids.second }); h.db.memberships.push({ ...clone(h.db.memberships[0]), _id: ids.second, employeeId: ids.second });
  const res = await h.preview(); assert.equal(res.body.ready, false); assert.equal(res.body.employee, null); assert.equal(res.body.blockers[0].code, "PARTNER_RECOVERY_ACCOUNT_AMBIGUOUS");
});
for (const mutate of ["name", "email", "role", "binding", "updatedAt", "restaurantName", "contact", "membership"]) test(`send rejects stale manifest after ${mutate} change`, async () => {
  const h = harness(); const preview = (await h.preview()).body;
  if (mutate === "name") h.db.employees[0].name = "CHANGED";
  if (mutate === "email") h.db.employees[0].email = "changed@example.test";
  if (mutate === "role") h.db.employees[0].partnerRoles = ["kitchen"];
  if (mutate === "binding") h.db.employees[0].restaurantIds = [];
  if (mutate === "updatedAt") h.db.employees[0].updatedAt = new Date();
  if (mutate === "restaurantName") h.db.restaurants[0].name = "CHANGED";
  if (mutate === "contact") h.db.restaurants[0].email = "changed@example.test";
  if (mutate === "membership") h.db.memberships[0].scopes = ["changed:fleet"];
  const res = await h.send({}, preview); assert.equal(res.code, 409); assert.equal(res.body.error, "PARTNER_RECOVERY_PREVIEW_CHANGED"); assert(!h.effects.some((event) => event.mail));
});
test("manifest is deterministic, whitespace/case normalized, and excludes secrets", async () => {
  const h = harness(); const first = await buildPartnerRecoveryPreview(target, h.deps);
  h.db.employees[0].passwordHash = "CHANGED_SECRET"; h.db.employees[0].sessionHash = "CHANGED_SESSION"; h.db.employees[0].tokenHash = "CHANGED_TOKEN"; h.db.restaurants[0].secret = "CHANGED_RESTAURANT_SECRET";
  const second = await buildPartnerRecoveryPreview(target, h.deps); assert.equal(second.preview.manifestHash, first.preview.manifestHash);
  const body = JSON.stringify(first.preview); assert(!body.includes("SECRET")); assert(!body.includes("passwordHash"));
});
for (const overrides of [{ confirmation: "YES" }, { employeeId: ids.other }, { employeeId: "invalid" }, { manifestHash: "invalid" }, { extra: true }, { tenantId: undefined }, { restaurantId: "invalid" }, { email: "injected@example.test" }, { resetUrl: "http://evil.test" }]) test(`strict send rejects ${JSON.stringify(overrides)}`, async () => {
  const h = harness(); const res = await h.send(overrides); assert([400, 409].includes(res.code)); assert(!h.effects.some((event) => event.mail));
});
for (const query of [{ restaurantId: ids.restaurant }, { tenantId: "invalid", restaurantId: ids.restaurant }, { ...target, extra: true }, { ...target, tenantId: [ids.tenant] }]) test(`root cannot preview without strict explicit tenant ${JSON.stringify(query)}`, async () => {
  const h = harness(); const res = await h.request("get", "preview", query); assert.equal(res.code, 400); assert(!h.effects.some((event) => event.restaurantFilter || event.employeeFilter));
});
for (const auth of [null, { role: "admin", isRootOwner: true }, { role: "partner", employeeId: ids.owner }, { role: "admin", employeeId: ids.other, isRootOwner: true }, { role: "admin", employeeId: ids.owner, mustChangePassword: true }]) test(`actual Owner guard rejects forged/shared/temporary auth ${JSON.stringify(auth)}`, async () => {
  const h = harness(); const res = await h.request("get", "preview", target, auth); assert([401, 403, 428].includes(res.code)); assert(!h.effects.some((event) => event.restaurantFilter || event.employeeFilter));
});
test("Owner guard rechecks persisted approved/active superadmin, not client consent", async () => {
  for (const field of ["active", "authorizationStatus", "accessLevel", "email"]) {
    const h = harness(); h.db.owner[field] = field === "active" ? false : "invalid";
    const res = await h.request("get", "preview", { ...target, consent: true }); assert.equal(res.code, 403); assert(!h.effects.some((event) => event.restaurantFilter));
  }
});
test("nonroot cannot target another tenant; real root still queries only explicit target", async () => {
  const h = harness(); const res = await h.request("get", "preview", target, { role: "admin", employeeId: ids.owner, tenantId: ids.other }); assert.equal(res.code, 403); assert(!h.effects.some((event) => event.restaurantFilter));
  const root = await h.request("get", "preview", target, { role: "admin", employeeId: ids.owner, isRootOwner: true }); assert.equal(root.code, 200); assert(root.body.ready);
});
for (const failure of ["sent-false", "mail-throw", "audit-after-send"]) test(`${failure} returns accurate delivery result with no provider secrets`, async () => {
  const h = harness(); h.setSent(failure !== "sent-false"); h.setMailThrows(failure === "mail-throw"); h.setAuditThrows(failure === "audit-after-send");
  const res = await h.send(); assert.equal(res.code, failure === "audit-after-send" ? 200 : 503); assert(!JSON.stringify(res.body).includes("OFFLINE_")); assert.equal(h.effects.filter((event) => event.mail).length, 1);
});
test("binding is revalidated immediately before helper; newly invalid binding never mails", async () => {
  const h = harness(); const preview = (await h.preview()).body; let reads = 0;
  h.deps.binding.memberships.find = () => ({ toArray: async () => { reads++; return reads === 1 ? clone(h.db.memberships) : []; } });
  const res = await h.send({}, preview); assert.equal(res.code, 503); assert(!h.effects.some((event) => event.mail));
});
test("rate limit ignores arbitrary surface/bearer/body secrets and limits actor and destination", async () => {
  let now = 1_000; const keys: string[] = []; const limit = partnerRecoverySendRateLimit({ limit: 2, now: () => now, windowMs: 1_000, increment: async (key) => { keys.push(key); return null; } });
  const invoke = async (employeeId = ids.owner, body: any = target) => { const res = response(); let allowed = false; await limit({ auth: { employeeId }, body, header: () => "OFFLINE_BEARER_SECRET", query: { surface: String(Math.random()) } } as any, res as any, () => { allowed = true; }); return { res, allowed }; };
  assert((await invoke()).allowed); assert((await invoke()).allowed); const denied = await invoke(); assert.equal(denied.res.code, 429); assert.equal(denied.allowed, false); assert.equal(denied.res.headers["Retry-After"], "1");
  now += 1_001; assert((await invoke()).allowed); assert((await invoke(ids.other)).allowed); assert.equal((await invoke(ids.second)).res.code, 429);
  assert(keys.every((key) => !key.includes("SECRET") && !key.includes("@") && !key.includes("surface"))); assert.equal(new Set(keys.filter((key) => key.includes(":actor:") && keys[0] === key)).size, 1);
});
test("send rate limit fallback is bounded and no owner cannot use it", async () => {
  const limit = partnerRecoverySendRateLimit({ limit: 1, increment: async () => { throw new Error("OFFLINE_COUNTER_UNAVAILABLE"); } }); const req: any = { auth: { employeeId: ids.owner }, body: target };
  let calls = 0; await limit(req, response() as any, () => { calls++; }); const res = response(); await limit(req, res as any, () => { calls++; }); assert.equal(calls, 1); assert.equal(res.code, 429);
  const missing = response(); await limit({ body: target } as any, missing as any, () => { throw new Error("Unexpected allow"); }); assert.equal(missing.code, 403);
});
test("server wiring uses real requireOwner and helper, not global tenantScope or consent bypass", () => {
  const code = readFileSync(new URL("./server.ts", import.meta.url), "utf8"); const start = code.indexOf("registerPartnerPasswordRecoveryRoutes(app, {"); const end = code.indexOf("registerPartnerTerminalInventoryRoutes(app", start); const wiring = code.slice(start, end);
  assert(wiring.includes("requireOwner, objectId")); assert(wiring.includes("sendEmployeePasswordLink,")); assert(!wiring.includes("tenantScope")); assert(!/req\.(headers|header).*authorization/.test(wiring)); assert(!wiring.includes("resetUrl")); assert(!wiring.includes("tokenHash"));
});

test("production audit row satisfies actual GovernanceAuditEvent schema with no credential fields", async () => {
  const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
  const statement = source.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(source) === "registerPartnerPasswordRecoveryRoutes"); assert(statement);
  let deps: PartnerPasswordRecoveryDependencies | undefined; const rows: any[] = [];
  const context = {
    registerPartnerPasswordRecoveryRoutes: (_app: any, dependency: any) => { deps = dependency; }, app: {},
    requireOwner: () => undefined, objectId: (id: string) => id, kitchenAccessDependencies: {},
    partnerRecoverySendRateLimit: () => undefined, incrementDistributedRateLimit: async () => null, incrementMongoRateLimit: async () => null,
    Restaurant: {}, EmployeeAccount: {}, employeeCanUseCredentialSurface: () => true, sendEmployeePasswordLink: async () => ({ delivery: { sent: true } }),
    GovernanceAuditEvent: { create: async (row: any) => { await new GovernanceAuditEvent(row).validate(); rows.push(row); } },
  };
  new Function(...Object.keys(context), ts.transpileModule(statement.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(context));
  assert(deps?.audit);
  await deps.audit({ ...target, employeeId: ids.employee, actorEmployeeId: ids.owner, sent: true });
  await deps.audit({ ...target, employeeId: ids.employee, actorEmployeeId: ids.owner, sent: false });
  assert.equal(rows.length, 2); assert.equal(rows[0].action, "partner_password_recovery_sent"); assert.equal(rows[1].action, "partner_password_recovery_delivery_unconfirmed");
  for (const row of rows) { assert.equal(row.tenantId, ids.tenant); assert.equal(row.targetType, "employee"); assert.equal(row.targetId, ids.employee); assert.equal(row.actorEmployeeId, ids.owner); assert.deepEqual(Object.keys(row.after).sort(), ["restaurantId", "sent"]); assert(!/token|passwordHash|resetUrl|recipient|email/.test(JSON.stringify(row))); }
});

const eligibilityFilter = { tenantId: ids.tenant, email: contact, $or: [{ restaurantId: { $in: [ids.restaurant, ids.restaurant] } }, { restaurantIds: { $in: [ids.restaurant, ids.restaurant] } }] };
const diagnosticFilter = { tenantId: ids.tenant, email: contact };
function assertBlockedDiagnostic(body: any, code: string) {
  assert.equal(body.ready, false); assert.equal(body.employee, null);
  assert.equal(body.blockers[0].code, "PARTNER_RECOVERY_ACCOUNT_NOT_ELIGIBLE");
  assert(body.blockers.some((blocker: any) => blocker.code === code), JSON.stringify(body.blockers));
  for (const blocker of body.blockers) assert.deepEqual(Object.keys(blocker).sort(), ["code", "message"]);
  assert.equal(new Set(body.blockers.map((blocker: any) => blocker.code)).size, body.blockers.length);
  const publicData = JSON.stringify(body);
  for (const privateValue of [ids.employee, ids.second, ids.other, contact, "OFFLINE_PASSWORD_SECRET", "OFFLINE_SESSION_SECRET", "OFFLINE_INTERNAL_SECRET", "other-login@example.test", "foreign@example.test"]) assert(!publicData.includes(privateValue), privateValue);
}
async function assertReadOnlyBlocked(h: ReturnType<typeof harness>, code: string) {
  const before = clone(h.db); const res = await h.preview(); assert.equal(res.code, 200);
  assertBlockedDiagnostic(res.body, code); assert.deepEqual(h.db, before);
  const send = await h.send({}, res.body); assert.equal(send.code, 409); assert.equal(send.body.error, "PARTNER_RECOVERY_BLOCKED");
  assert.deepEqual(send.body.blockers, res.body.blockers); assert.deepEqual(h.db, before);
  assert(!h.effects.some((event) => event.mail || event.audit));
  return res.body;
}
for (const [fault, code] of [
  ["inactive", "ACCOUNT_INACTIVE"], ["not-approved", "ACCOUNT_NOT_APPROVED"],
  ["not-partner", "ACCOUNT_NOT_PARTNER"], ["surface", "ACCOUNT_PARTNER_SURFACE_NOT_ALLOWED"],
] as const) test(`diagnostic candidate ${fault} has a fixed safe reason and no fallback lookup`, async () => {
  const h = harness(); const employee = h.db.employees[0];
  if (fault === "inactive") employee.active = false;
  if (fault === "not-approved") employee.authorizationStatus = "pending";
  if (fault === "not-partner") { employee.apiRole = "rider"; employee.jobRole = "rider"; employee.roles = ["rider"]; }
  if (fault === "surface") { employee.roles = ["rider"]; employee.primaryRole = "rider"; }
  const body = await assertReadOnlyBlocked(h, code);
  assert.equal(body.blockers.length, 2);
  assert(h.effects.filter((event) => event.employeeFilter).every((event) => JSON.stringify(event.employeeFilter) === JSON.stringify(eligibilityFilter)));
});
test("candidate reasons are deduplicated, count-safe and never expose account details", async () => {
  const h = harness(); h.db.employees[0].active = false; h.db.employees[0].authorizationStatus = "revoked";
  h.db.employees.push({ ...clone(h.db.employees[0]), _id: ids.second, name: "OFFLINE_INTERNAL_SECRET" });
  const body = await assertReadOnlyBlocked(h, "ACCOUNT_INACTIVE"); assertBlockedDiagnostic(body, "ACCOUNT_NOT_APPROVED");
  assert.deepEqual(body.blockers.map((blocker: any) => blocker.code), ["PARTNER_RECOVERY_ACCOUNT_NOT_ELIGIBLE", "ACCOUNT_INACTIVE", "ACCOUNT_NOT_APPROVED"]);
});
test("one eligible associated account remains eligible despite a rejected same-contact candidate", async () => {
  const h = harness(); h.db.employees.push({ ...clone(h.db.employees[0]), _id: ids.second, active: false });
  const res = await h.preview(); assert.equal(res.body.ready, true); assert.equal(res.body.employee.id, ids.employee); assert.deepEqual(res.body.blockers, []);
  assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter]);
});
for (const fault of ["no-account", "other-email", "other-tenant"]) test(`zero associated candidates diagnose ${fault} only by exact contact and tenant`, async () => {
  const h = harness();
  if (fault === "no-account") h.db.employees = [];
  if (fault === "other-email") h.db.employees[0].email = "other-login@example.test";
  if (fault === "other-tenant") h.db.employees[0].tenantId = ids.other;
  h.deps.canUsePartner = () => { throw new Error("Diagnostic must not run eligibility"); };
  h.deps.binding.tenants.findOne = async () => { throw new Error("Diagnostic must not validate binding"); };
  const body = await assertReadOnlyBlocked(h, "ACCOUNT_NOT_FOUND_IN_TENANT"); assert.equal(body.blockers.length, 2);
  assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter, diagnosticFilter, eligibilityFilter, diagnosticFilter]);
});
test("fully active approved Partner in exact tenant and contact but unassociated can never become eligible", async () => {
  const h = harness(); const employee = h.db.employees[0]; employee.restaurantId = ids.second; employee.restaurantIds = [ids.second];
  h.db.employees.push({ ...clone(employee), _id: ids.other, email: "foreign@example.test", restaurantId: ids.restaurant, restaurantIds: [ids.restaurant] });
  h.deps.canUsePartner = () => { throw new Error("Unassociated diagnostic must not run eligibility"); };
  h.deps.binding.tenants.findOne = async () => { throw new Error("Unassociated diagnostic must not validate binding"); };
  await assertReadOnlyBlocked(h, "ACCOUNT_RESTAURANT_ASSOCIATION_MISSING");
  assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter, diagnosticFilter, eligibilityFilter, diagnosticFilter]);
});
test("ambiguous contact-only accounts have a specific count-safe reason, not first-match selection", async () => {
  const h = harness(); delete h.db.employees[0].restaurantId; h.db.employees[0].restaurantIds = [];
  h.db.employees.push({ ...clone(h.db.employees[0]), _id: ids.second, name: "OFFLINE_INTERNAL_SECRET" });
  const body = await assertReadOnlyBlocked(h, "ACCOUNT_AMBIGUOUS_IN_TENANT"); assert.equal(body.blockers.length, 2);
  assert(!body.blockers.some((blocker: any) => blocker.code === "ACCOUNT_RESTAURANT_ASSOCIATION_MISSING"));
});
test("a discrepant contact-only lookup returning an associated account is diagnostic only, not proof of a race", async () => {
  const h = harness(); h.deps.employees = async (filter) => { h.effects.push({ employeeFilter: filter }); return filter.$or ? [] : clone(h.db.employees); };
  h.deps.canUsePartner = () => { throw new Error("Contact-only rows must not be eligibility candidates"); };
  const body = await assertReadOnlyBlocked(h, "ACCOUNT_LOOKUP_CHANGED");
  const message = body.blockers.find((blocker: any) => blocker.code === "ACCOUNT_LOOKUP_CHANGED").message;
  assert.match(message, /no coinciden/); assert(!/cambió|concurrencia/.test(message));
  assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter, diagnosticFilter, eligibilityFilter, diagnosticFilter]);
});
for (const fault of ["tenant", "email", "association"]) test(`candidate postfilter rejects unexpected ${fault} scope without repair lookup`, async () => {
  const h = harness();
  if (fault === "tenant") h.db.employees[0].tenantId = ids.other;
  if (fault === "email") h.db.employees[0].email = "other-login@example.test";
  if (fault === "association") { delete h.db.employees[0].restaurantId; h.db.employees[0].restaurantIds = []; }
  h.deps.employees = async (filter) => { h.effects.push({ employeeFilter: filter }); return clone(h.db.employees); };
  await assertReadOnlyBlocked(h, "ACCOUNT_LOOKUP_SCOPE_CONFLICT");
  assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter, eligibilityFilter]);
});
test("contact diagnostic independently rejects out-of-tenant and alternate-email rows returned by adapter", async () => {
  const h = harness(); const base = h.db.employees[0];
  const outside = [{ ...clone(base), tenantId: ids.other }, { ...clone(base), _id: ids.second, email: "foreign@example.test" }];
  h.deps.employees = async (filter) => { h.effects.push({ employeeFilter: filter }); return filter.$or ? [] : outside; };
  const body = await assertReadOnlyBlocked(h, "ACCOUNT_NOT_FOUND_IN_TENANT"); assertBlockedDiagnostic(body, "ACCOUNT_LOOKUP_SCOPE_CONFLICT");
  assert(!body.blockers.some((blocker: any) => blocker.code === "ACCOUNT_AMBIGUOUS_IN_TENANT"));
});
for (const [fault, code] of [
  ["identity", "PARTNER_TENANT_BINDING_REQUIRED"], ["assignment", "PARTNER_RESTAURANT_ASSIGNMENT_INVALID"],
  ["tenant", "PARTNER_TENANT_NOT_ACTIVE"], ["restaurant-missing", "PARTNER_RESTAURANT_NOT_FOUND_IN_TENANT"],
  ["restaurant-setup", "PARTNER_RESTAURANT_SETUP_INVALID"], ["membership", "PARTNER_MEMBERSHIP_BINDING_REQUIRED"],
  ["roles", "PARTNER_ROLES_REQUIRED"], ["scopes", "PARTNER_MEMBERSHIP_SCOPE_CONFLICT"],
  ["kitchen-account", "KITCHEN_ACCOUNT_BINDING_CONFLICT"], ["kitchen-tenant", "KITCHEN_TENANT_NOT_ACTIVE"],
  ["kitchen-restaurant", "KITCHEN_RESTAURANT_SETUP_INVALID"], ["kitchen-membership", "KITCHEN_MEMBERSHIP_CONFLICT"],
] as const) test(`persisted binding fault ${fault} exposes only its whitelisted fixed code`, async () => {
  const h = harness(); const employee = h.db.employees[0]; const restaurant = h.db.restaurants[0]; const member = h.db.memberships[0];
  if (fault.startsWith("kitchen-")) {
    Object.assign(employee, { kitchenAccessSetupVersion: 1, partnerRoles: ["kitchen"] });
    Object.assign(member, { role: "partner", scopes: ["orders:read", "orders:prepare"] });
  }
  if (fault === "identity") employee._id = "OFFLINE_INTERNAL_SECRET";
  if (fault === "assignment") employee.restaurantIds.push("OFFLINE_INTERNAL_SECRET");
  if (fault === "tenant" || fault === "kitchen-tenant") h.db.tenants[0].status = "suspended";
  if (fault === "restaurant-missing") employee.restaurantIds.push(ids.second);
  if (fault === "restaurant-setup" || fault === "kitchen-restaurant") restaurant.internalDemo = true;
  if (fault === "membership") member.status = "suspended";
  if (fault === "roles") employee.partnerRoles = ["invalid"];
  if (fault === "scopes") { member.role = "partner"; member.scopes = ["orders:read"]; }
  if (fault === "kitchen-account") employee.ownerProtected = true;
  if (fault === "kitchen-membership") member.scopes = ["orders:read"];
  const body = await assertReadOnlyBlocked(h, code); assert.equal(body.blockers.length, 2);
  assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter, eligibilityFilter]);
});
for (const [ErrorClass, codes] of [
  [PartnerBindingError, ["PARTNER_TENANT_BINDING_REQUIRED", "EMPLOYEE_NOT_APPROVED", "PARTNER_RESTAURANT_ASSIGNMENT_INVALID", "PARTNER_RESTAURANT_NOT_ASSIGNED", "PARTNER_TENANT_NOT_ACTIVE", "PARTNER_RESTAURANT_NOT_FOUND_IN_TENANT", "PARTNER_RESTAURANT_SETUP_INVALID", "PARTNER_MEMBERSHIP_BINDING_REQUIRED", "PARTNER_ROLES_REQUIRED", "PARTNER_MEMBERSHIP_SCOPE_CONFLICT"]],
  [KitchenAccessError, ["KITCHEN_ACCOUNT_BINDING_CONFLICT", "KITCHEN_TENANT_NOT_ACTIVE", "KITCHEN_RESTAURANT_NOT_FOUND_IN_TENANT", "KITCHEN_RESTAURANT_SETUP_INVALID", "KITCHEN_RESTAURANT_CONTACT_CONFLICT", "KITCHEN_MEMBERSHIP_CONFLICT"]],
] as const) for (const code of codes) test(`existing binding response helper accepts only fixed diagnostic message for ${code}`, async () => {
  const h = harness();
  h.deps.binding.tenants.findOne = async () => { const error = new ErrorClass(409, code); error.message = "OFFLINE_INTERNAL_SECRET"; throw error; };
  const body = await assertReadOnlyBlocked(h, code); assert.equal(body.blockers.length, 2);
});
for (const error of [
  new Error("OFFLINE_INTERNAL_SECRET"), Object.assign(new Error("OFFLINE_INTERNAL_SECRET"), { code: "PARTNER_TENANT_NOT_ACTIVE" }),
  new PartnerBindingError(409, "OFFLINE_INTERNAL_SECRET"), new KitchenAccessError(409, "OFFLINE_INTERNAL_SECRET"),
  new PartnerBindingError(409, "PARTNER_BINDING_CHANGED"), new KitchenAccessError(409, "KITCHEN_ACCESS_UNIQUE_INDEX_REQUIRED"),
  Object.assign(new Error("OFFLINE_INTERNAL_SECRET"), { code: 11000 }), new PartnerBindingError(409, "__proto__"),
]) test(`unknown, unbranded or write-only binding error ${error.constructor.name}/${(error as any).code || "none"} fails closed`, async () => {
  const h = harness(); h.deps.binding.tenants.findOne = async () => { throw error; };
  const body = await assertReadOnlyBlocked(h, "ACCOUNT_BINDING_VALIDATION_UNAVAILABLE"); assert.equal(body.blockers.length, 2);
});
test("unassociated diagnostic whitelist fields affect manifest while credentials and arbitrary fields do not", async () => {
  const h = harness(); h.db.employees[0].restaurantId = ids.second; h.db.employees[0].restaurantIds = [ids.second];
  const first = (await h.preview()).body; assertBlockedDiagnostic(first, "ACCOUNT_RESTAURANT_ASSOCIATION_MISSING");
  Object.assign(h.db.employees[0], { passwordHash: "CHANGED_SECRET", tokenHash: "CHANGED_SECRET", sessionHash: "CHANGED_SECRET", resetUrl: "CHANGED_SECRET", arbitraryInternal: "CHANGED_SECRET" });
  const secretsChanged = (await h.preview()).body; assert.equal(secretsChanged.manifestHash, first.manifestHash);
  h.db.employees[0].active = false;
  const persistedChanged = (await h.preview()).body; assert.notEqual(persistedChanged.manifestHash, first.manifestHash);
  assert.deepEqual(persistedChanged.blockers, first.blockers); assert.equal(persistedChanged.employee, null);
  const send = await h.send({}, first); assert.equal(send.code, 409); assert.equal(send.body.error, "PARTNER_RECOVERY_PREVIEW_CHANGED");
  assert(!h.effects.some((event) => event.mail || event.audit));
});
test("diagnostic hash and codes are independent of account ordering and include validated fault changes", async () => {
  const h = harness(); h.db.employees[0].active = false;
  h.db.employees.push({ ...clone(h.db.employees[0]), _id: ids.second, active: true, authorizationStatus: "pending" });
  const first = (await h.preview()).body; h.db.employees.reverse(); const reordered = (await h.preview()).body;
  assert.equal(reordered.manifestHash, first.manifestHash); assert.deepEqual(reordered.blockers, first.blockers);
  h.db.employees[0].authorizationStatus = "revoked"; const changed = (await h.preview()).body; assert.notEqual(changed.manifestHash, first.manifestHash);
  assert.deepEqual(changed.blockers, first.blockers);
});
for (const endpoint of ["preview", "send"]) test(`strict ${endpoint} still rejects alternate loginEmail without any repair query`, async () => {
  const h = harness(); const input = endpoint === "preview" ? { ...target, loginEmail: "injected@example.test" }
    : { ...target, employeeId: ids.employee, manifestHash: "0".repeat(64), confirmation: "SEND_PARTNER_PASSWORD_RECOVERY", loginEmail: "injected@example.test" };
  const res = await h.request(endpoint === "preview" ? "get" : "post", endpoint, input); assert.equal(res.code, 400);
  assert(!h.effects.some((event) => event.restaurantFilter || event.employeeFilter || event.mail || event.audit));
});
test("associated candidate plus unassociated duplicate never triggers contact-only diagnosis or wider eligibility", async () => {
  const h = harness(); h.db.employees.push({ ...clone(h.db.employees[0]), _id: ids.second, restaurantId: ids.other, restaurantIds: [ids.other] });
  const res = await h.preview(); assert.equal(res.body.ready, true); assert.equal(res.body.employee.id, ids.employee);
  assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter]);
});
test("contact-only diagnostic read failure returns safe 503 without sends or invented reason", async () => {
  const h = harness(); h.deps.employees = async (filter) => { h.effects.push({ employeeFilter: filter }); if (filter.$or) return []; throw new Error("OFFLINE_INTERNAL_SECRET"); };
  const res = await h.preview(); assert.equal(res.code, 503); assert.deepEqual(res.body, { error: "PARTNER_RECOVERY_UNAVAILABLE", message: "No se pudo verificar el destino. Inténtalo más tarde." });
  assert(!h.effects.some((event) => event.mail || event.audit)); assert.deepEqual(h.effects.filter((event) => event.employeeFilter).map((event) => event.employeeFilter), [eligibilityFilter, diagnosticFilter]);
});

// Model Mongo equality without coercion: a 24hex string is NOT an ObjectId.
const bsonEqual = (a: unknown, b: unknown) => a instanceof Types.ObjectId || b instanceof Types.ObjectId
  ? a instanceof Types.ObjectId && b instanceof Types.ObjectId && a.equals(b) : a === b;
function bsonMatches(row: any, filter: any): boolean {
  return Object.entries(filter).every(([key, value]: [string, any]) => {
    if (key === "$or") return value.some((branch: any) => bsonMatches(row, branch));
    const values = Array.isArray(row?.[key]) ? row[key] : [row?.[key]];
    return values.some((stored: any) => value?.$in ? value.$in.some((candidate: any) => bsonEqual(stored, candidate)) : bsonEqual(stored, value));
  });
}
const serverSource = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compileServerCode(code: string, context: Record<string, any>) {
  return new Function(...Object.keys(context), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(context));
}
function productionRecoveryDependencies(employeeModel: any): PartnerPasswordRecoveryDependencies {
  const statement = serverSource.statements.find((s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression) && s.expression.expression.getText(serverSource) === "registerPartnerPasswordRecoveryRoutes");
  assert(statement);
  let dependencies: PartnerPasswordRecoveryDependencies | undefined;
  compileServerCode(statement.getText(serverSource), {
    registerPartnerPasswordRecoveryRoutes: (_app: any, deps: PartnerPasswordRecoveryDependencies) => { dependencies = deps; }, app: {},
    requireOwner: () => undefined, objectId: (id: string) => new Types.ObjectId(id), kitchenAccessDependencies: {},
    partnerRecoverySendRateLimit: () => undefined, incrementDistributedRateLimit: async () => null, incrementMongoRateLimit: async () => null,
    Restaurant: {}, EmployeeAccount: employeeModel, employeeCanUseCredentialSurface: (employee: any, surface: any) => Boolean(sessionRole(employee, surface)),
    sendEmployeePasswordLink: async () => ({ delivery: { sent: true } }), GovernanceAuditEvent: {},
  });
  assert(dependencies); return dependencies;
}
const projectionKeys = "_id name email tenantId active authorizationStatus apiRole jobRole primaryRole roles partnerRoles restaurantId restaurantIds accessLevel ownerProtected kitchenAccessSetupVersion partnerBindingVersion fleetId zoneSlugs updatedAt kitchenAccessRevision".split(" ");
function bsonHarness() {
  const h = harness(); const nativeReads: { filter: any; projection: Record<string, number>; matched: any[] }[] = []; const bindingReads: any[] = [];
  for (const rows of [h.db.tenants, h.db.restaurants, h.db.employees, h.db.memberships]) for (const row of rows) {
    for (const key of ["_id", "tenantId", "employeeId", "restaurantId"]) if (row[key]) row[key] = new Types.ObjectId(row[key]);
    if (row.restaurantIds) row.restaurantIds = row.restaurantIds.map((id: string) => new Types.ObjectId(id));
  }
  const employeeModel = {
    find() { throw new Error("MONGOOSE_RECAST_FORBIDDEN"); },
    collection: { find(filter: any, options: any) {
      assert.deepEqual(Object.keys(options), ["projection"]);
      assert.deepEqual(Object.keys(options.projection).sort(), [...projectionKeys].sort());
      assert(Object.values(options.projection).every((value) => value === 1));
      const matched = h.db.employees.filter((row: any) => bsonMatches(row, filter));
      nativeReads.push({ filter, projection: options.projection, matched });
      return { toArray: async () => matched.map((row: any) => Object.fromEntries(Object.keys(options.projection).filter((key) => Object.hasOwn(row, key)).map((key) => [key, row[key]]))) };
    } },
  };
  const production = productionRecoveryDependencies(employeeModel);
  h.deps.objectId = (id) => new Types.ObjectId(id);
  h.deps.employees = production.employees;
  h.deps.canUsePartner = production.canUsePartner;
  h.deps.restaurant = async (filter) => h.db.restaurants.find((row: any) => bsonMatches(row, filter)) || null;
  h.deps.binding = {
    ownerEmail, objectId: h.deps.objectId,
    tenants: { findOne: async (filter) => { bindingReads.push({ tenant: filter }); return h.db.tenants.find((row: any) => bsonMatches(row, filter)) || null; } },
    restaurants: { findOne: async (filter) => { bindingReads.push({ restaurant: filter }); return h.db.restaurants.find((row: any) => bsonMatches(row, filter)) || null; } },
    memberships: { find: (filter) => ({ toArray: async () => { bindingReads.push({ membership: filter }); return h.db.memberships.filter((row: any) => bsonMatches(row, filter)); } }) },
  };
  return { ...h, nativeReads, bindingReads };
}
function assertBsonEligibilityFilter(filter: any) {
  assert.deepEqual(Object.keys(filter).sort(), ["$or", "email", "tenantId"]);
  assert(filter.tenantId instanceof Types.ObjectId); assert.equal(String(filter.tenantId), ids.tenant); assert.equal(filter.email, contact);
  assert.equal(filter.$or.length, 2);
  for (const [index, key] of ["restaurantId", "restaurantIds"].entries()) {
    assert.deepEqual(Object.keys(filter.$or[index]), [key]);
    assert.deepEqual(Object.keys(filter.$or[index][key]), ["$in"]);
    const alternatives = filter.$or[index][key].$in;
    assert.equal(alternatives.length, 2); assert(alternatives[0] instanceof Types.ObjectId);
    assert.equal(String(alternatives[0]), ids.restaurant); assert.equal(alternatives[1], ids.restaurant); assert.equal(typeof alternatives[1], "string");
  }
}
for (const representation of ["scalar-string", "scalar-objectid", "array-string", "array-objectid", "mixed"]) test(`native exact BSON query accepts persisted ${representation} association with unchanged binding/send`, async () => {
  const h = bsonHarness(); const employee = h.db.employees[0];
  employee.restaurantId = representation === "scalar-string" || representation === "mixed" ? ids.restaurant : representation === "scalar-objectid" ? new Types.ObjectId(ids.restaurant) : null;
  employee.restaurantIds = representation === "array-string" ? [ids.restaurant] : representation === "array-objectid" || representation === "mixed" ? [new Types.ObjectId(ids.restaurant)] : [];
  const before = JSON.stringify(h.db); const res = await h.preview();
  assert.equal(res.code, 200); assert.equal(res.body.ready, true); assert.equal(res.body.employee.id, ids.employee); assert.deepEqual(res.body.blockers, []);
  assert.equal(h.nativeReads.length, 1); assertBsonEligibilityFilter(h.nativeReads[0].filter); assert.equal(h.nativeReads[0].matched.length, 1);
  const resolved = await buildPartnerRecoveryPreview(target, h.deps);
  assert(resolved.employee._id instanceof Types.ObjectId); assert(resolved.employee.tenantId instanceof Types.ObjectId);
  assert.equal(typeof resolved.employee.restaurantId, typeof employee.restaurantId);
  assert.deepEqual(resolved.employee.restaurantIds, employee.restaurantIds);
  assert.equal(resolved.employee.passwordHash, undefined); assert.equal(resolved.employee.sessionHash, undefined);
  const send = await h.send({}, res.body); assert.equal(send.code, 200); assert.equal(h.effects.filter((event) => event.mail).length, 1);
  for (const read of h.nativeReads) assertBsonEligibilityFilter(read.filter);
  assert(h.bindingReads.some((read) => read.tenant)); assert(h.bindingReads.some((read) => read.membership)); assert(h.bindingReads.some((read) => read.restaurant));
  assert.equal(JSON.stringify(h.db), before);
});
test("BSON native eligibility excludes other tenant/email/restaurants and string tenant without widening or ambiguity", async () => {
  const h = bsonHarness(); const employee = h.db.employees[0]; employee.restaurantId = ids.restaurant; employee.restaurantIds = [];
  h.db.employees.push(
    { ...employee, _id: new Types.ObjectId(ids.second), tenantId: new Types.ObjectId(ids.other) },
    { ...employee, _id: new Types.ObjectId(ids.second), email: "foreign@example.test" },
    { ...employee, _id: new Types.ObjectId(ids.second), restaurantId: ids.other, restaurantIds: [new Types.ObjectId(ids.other)] },
    { ...employee, _id: new Types.ObjectId(ids.second), restaurantId: new Types.ObjectId(ids.other), restaurantIds: [ids.other] },
    { ...employee, _id: new Types.ObjectId(ids.second), tenantId: ids.tenant },
  );
  const res = await h.preview(); assert.equal(res.body.ready, true); assert.equal(res.body.employee.id, ids.employee);
  assert.equal(h.nativeReads.length, 1); assertBsonEligibilityFilter(h.nativeReads[0].filter); assert.deepEqual(h.nativeReads[0].matched, [employee]);
});
for (const fault of ["role", "tenant", "membership", "restaurant"]) test(`raw legacy association still fails unchanged persisted ${fault} validation`, async () => {
  const h = bsonHarness(); h.db.employees[0].restaurantId = ids.restaurant; h.db.employees[0].restaurantIds = [];
  if (fault === "role") h.db.employees[0].partnerRoles = ["invalid"];
  if (fault === "tenant") h.db.tenants[0].status = "suspended";
  if (fault === "membership") h.db.memberships[0].restaurantIds = [new Types.ObjectId(ids.other)];
  if (fault === "restaurant") h.db.restaurants[0].internalDemo = true;
  const code = { role: "PARTNER_ROLES_REQUIRED", tenant: "PARTNER_TENANT_NOT_ACTIVE", membership: "PARTNER_MEMBERSHIP_BINDING_REQUIRED", restaurant: "PARTNER_RESTAURANT_SETUP_INVALID" }[fault]!;
  const res = await h.preview(); assertBlockedDiagnostic(res.body, code); assert.equal(h.nativeReads.length, 1); assertBsonEligibilityFilter(h.nativeReads[0].filter);
  const send = await h.send({}, res.body); assert.equal(send.code, 409); assert(!h.effects.some((event) => event.mail || event.audit));
});
test("production native adapter uses inclusion whitelist for eligibility AND diagnostics, preserving raw IDs without secrets", async () => {
  const h = bsonHarness(); const employee = h.db.employees[0]; employee.restaurantId = ids.other; employee.restaurantIds = [ids.other];
  Object.assign(employee, { tokenHash: "OFFLINE_TOKEN_SECRET", resetUrl: "OFFLINE_URL_SECRET", sessions: ["OFFLINE_SESSION_SECRET"], arbitrary: "OFFLINE_INTERNAL_SECRET" });
  const resolved = await buildPartnerRecoveryPreview(target, h.deps); assertBlockedDiagnostic(resolved.preview, "ACCOUNT_RESTAURANT_ASSOCIATION_MISSING");
  assert.equal(h.nativeReads.length, 2); assertBsonEligibilityFilter(h.nativeReads[0].filter);
  assert.deepEqual(Object.keys(h.nativeReads[1].filter).sort(), ["email", "tenantId"]); assert(h.nativeReads[1].filter.tenantId instanceof Types.ObjectId);
  assert.equal(String(h.nativeReads[1].filter.tenantId), ids.tenant); assert.equal(h.nativeReads[1].filter.email, contact);
  const rows = await h.deps.employees(h.nativeReads[1].filter); assert.equal(rows.length, 1); assert.equal(rows[0].restaurantId, ids.other); assert(rows[0]._id instanceof Types.ObjectId);
  for (const key of ["passwordHash", "sessionHash", "tokenHash", "resetUrl", "sessions", "arbitrary"]) { assert.equal(rows[0][key], undefined); assert(!projectionKeys.includes(key)); }
  assert(!JSON.stringify(rows).includes("SECRET")); assert.equal(h.bindingReads.length, 0);
});
test("existing real sendEmployeePasswordLink accepts projected native plain employee and revalidates binding before offline reset/mail mocks", async () => {
  const h = bsonHarness(); h.db.employees[0].restaurantId = ids.restaurant; h.db.employees[0].restaurantIds = [];
  const { employee } = await buildPartnerRecoveryPreview(target, h.deps); assert(employee); assert.equal(Object.getPrototypeOf(employee), Object.prototype); assert.equal(employee.save, undefined);
  const statement = serverSource.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "sendEmployeePasswordLink"); assert(statement);
  const bindingStatement = serverSource.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "createEmployeePasswordReset"); assert(bindingStatement);
  const resets: any[] = []; const mails: any[] = []; const order: string[] = []; const before = JSON.stringify(h.db);
  const { isPartnerEmployee, partnerBindingForEmployee } = await import("./employeePartnerBinding.js");
  const helper = compileServerCode(`${statement.getText(serverSource)}; return sendEmployeePasswordLink;`, {
    isPartnerEmployee, kitchenAccessDependencies: h.deps.binding,
    partnerBindingForEmployee: async (row: any, deps: any) => { order.push("binding"); return partnerBindingForEmployee(row, deps); },
    createEmployeePasswordReset: async (row: any, surface: any, ttl: any) => { order.push("reset"); resets.push({ row, surface, ttl }); return { tokenHash: "OFFLINE_HASH", resetUrl: "https://offline.invalid/?reset=OFFLINE_TOKEN" }; },
    employeeCredentialLabels: { partner: "PIKI Partner Orders" }, escapeCorporateHtml: (value: string) => value,
    sendCorporateEmail: async (payload: any) => { order.push("mail"); mails.push(payload); return { sent: true }; },
  });
  const result = await helper(employee, "partner", "recovery"); assert.equal(result.delivery.sent, true);
  assert.deepEqual(order, ["binding", "reset", "mail"]); assert.equal(resets[0].row, employee); assert.equal(resets[0].surface, "partner"); assert.equal(resets[0].ttl, 30 * 60_000);
  assert.equal(mails[0].recipientEmail, contact); assert.equal(JSON.stringify(h.db), before);
  // The reset helper also reads only raw _id/email, never employee document methods.
  assert(!/employee\.(save|toObject|set|markModified)\(/.test(bindingStatement.getText(serverSource)));
  h.db.memberships[0].status = "suspended";
  await assert.rejects(() => helper(employee, "partner", "recovery"), /PARTNER_MEMBERSHIP_BINDING_REQUIRED/);
  assert.equal(resets.length, 1); assert.equal(mails.length, 1);
});
