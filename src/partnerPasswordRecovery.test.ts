import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { buildPartnerRecoveryPreview, registerPartnerPasswordRecoveryRoutes, partnerRecoverySendRateLimit, PARTNER_PASSWORD_RECOVERY_PATH, type PartnerPasswordRecoveryDependencies } from "./partnerPasswordRecovery.js";
import { GovernanceAuditEvent } from "./models.js";
import { sessionRole } from "./employeeSessions.js";
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
  assert.deepEqual(h.effects.find((event) => event.employeeFilter).employeeFilter, { tenantId: ids.tenant, email: contact, $or: [{ restaurantId: ids.restaurant }, { restaurantIds: ids.restaurant }] });
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
