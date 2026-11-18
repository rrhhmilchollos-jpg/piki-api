import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { z } from "zod";

// Read source only: never import server.ts or initialize its services/configuration.
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const endpoint = "/api/v1/auth/employee/password-reset/request";
function compile(code: string, context: Record<string, any> = {}) {
  context = { z, ...context };
  return new Function(...Object.keys(context), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(context));
}
function variable(name: string) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
    if (declaration?.initializer) return compile(`return ${declaration.initializer.getText(source)};`);
  }
  throw new Error(`Missing variable ${name}`);
}
function helper(name: string, context: Record<string, any>) {
  const statement = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert(statement, `Missing helper ${name}`);
  return compile(`${statement.getText(source)}; return ${name};`, context);
}
function route() {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.expression.getText(source) !== "app" || call.expression.name.text !== "post") continue;
    if (call.arguments[0] && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === endpoint) return call;
  }
  throw new Error(`Missing POST ${endpoint}`);
}
const schema = variable("employeePasswordResetRequestSchema") as z.ZodType<{ email: string }>;
const passwordResetMessage = variable("passwordResetMessage") as string;
const email = "employee@example.test";
const account = (overrides: Record<string, any> = {}) => ({
  _id: "OFFLINE_EMPLOYEE", name: "Offline Employee", email,
  active: true, authorizationStatus: "approved", apiRole: "partner", sessionRoles: ["partner"],
  ...overrides,
});
function harness(options: { employee?: any; bindingValid?: boolean; sessionAllowed?: boolean; lookupFailure?: boolean; delivery?: "rejected" | "throws" } = {}) {
  const employee = options.employee === undefined ? account() : options.employee;
  const effects: string[] = [];
  const lookups: Record<string, any>[] = [];
  const roleChecks: any[][] = [];
  const bindingChecks: any[][] = [];
  const resets: any[][] = [];
  const deliveries: Record<string, any>[] = [];
  const warnings: any[][] = [];
  const kitchenAccessDependencies = { offline: true };
  const sendEmployeePasswordLink = helper("sendEmployeePasswordLink", {
    isPartnerEmployee: (current: any) => current.apiRole === "partner",
    partnerBindingForEmployee: async (...args: any[]) => {
      effects.push("binding"); bindingChecks.push(args);
      if (options.bindingValid === false) throw Object.assign(new Error("Offline invalid binding"), { code: "PARTNER_BINDING_INVALID" });
      return { offline: true };
    },
    kitchenAccessDependencies,
    createEmployeePasswordReset: async (...args: any[]) => {
      effects.push("reset"); resets.push(args);
      return { tokenHash: "OFFLINE_HASH", resetUrl: "https://offline.invalid/?reset=OFFLINE_TOKEN", expiresAt: new Date(0) };
    },
    employeeCredentialLabels: variable("employeeCredentialLabels"),
    escapeCorporateHtml: (value: string) => value,
    sendCorporateEmail: async (payload: Record<string, any>) => {
      effects.push("mail"); deliveries.push(payload);
      if (options.delivery === "throws") throw Object.assign(new Error("Offline SMTP failure"), { code: "EAUTH" });
      return options.delivery === "rejected" ? { sent: false, error: "OFFLINE_REJECTED" } : { sent: true };
    },
  });
  const handler = compile(`return ${route().arguments.at(-1)!.getText(source)};`, {
    employeePasswordResetRequestSchema: schema,
    employeeCredentialSurface: helper("employeeCredentialSurface", { employeeCredentialSurfaces: variable("employeeCredentialSurfaces") }),
    passwordResetMessage,
    EmployeeAccount: { findOne(filter: Record<string, any>) {
      effects.push("lookup"); lookups.push(filter);
      return { lean() { return this; }, async exec() {
        if (options.lookupFailure) throw new Error("Offline database failure");
        return employee && Object.entries(filter).every(([key, value]) => employee[key] === value) ? employee : null;
      } };
    } },
    employeeCanUseCredentialSurface: helper("employeeCanUseCredentialSurface", {
      sessionRole: (...args: any[]) => {
        effects.push("sessionRole"); roleChecks.push(args);
        return options.sessionAllowed !== false && args[0].sessionRoles.includes(args[1]) ? args[1] : null;
      },
    }),
    sendEmployeePasswordLink,
    console: { warn: (...args: any[]) => warnings.push(args) },
  });
  async function request(body: any, ...surfaces: unknown[]) {
    const surface = surfaces.length ? surfaces[0] : "partner";
    const response = { code: 200, body: null as any, status(code: number) { this.code = code; return this; }, json(body: any) { this.body = body; return this; } };
    await handler({ body, header: (name: string) => { assert.equal(name, "x-piki-surface"); return surface; } }, response);
    assert.equal(response.code, 202);
    assert.deepEqual(response.body, { message: passwordResetMessage });
    return response;
  }
  return { request, sendEmployeePasswordLink, employee, effects, lookups, roleChecks, bindingChecks, resets, deliveries, warnings, kitchenAccessDependencies };
}
function assertNoSend(h: ReturnType<typeof harness>) {
  assert.equal(h.resets.length, 0, "No reset token may be created");
  assert.equal(h.deliveries.length, 0, "No email may be sent");
}

for (const input of [email, `  ${email}  `, email.toUpperCase(), `\t ${email.toUpperCase()} \r\n`]) {
  test(`real reset schema/endpoint normalize lookup and recipient: ${JSON.stringify(input)}`, async () => {
    const h = harness();
    await h.request({ email: input });
    assert.equal(schema.parse({ email: input }).email, input.trim());
    assert.deepEqual(h.lookups, [{ email, active: true, authorizationStatus: "approved" }]);
    assert.deepEqual(h.roleChecks, [[h.employee, "partner"]]);
    assert.deepEqual(h.bindingChecks, [[h.employee, h.kitchenAccessDependencies]]);
    assert.deepEqual(h.resets, [[h.employee, "partner", 30 * 60_000]]);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0].recipientEmail, email);
    assert.equal(h.deliveries[0].department, "admin");
    assert.deepEqual(h.effects, ["lookup", "sessionRole", "binding", "reset", "mail"]);
  });
}

test("real mail helper also normalizes the stored account recipient", async () => {
  const h = harness({ employee: account({ email: `  ${email.toUpperCase()}  ` }) });
  await h.sendEmployeePasswordLink(h.employee, "partner", "recovery");
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].recipientEmail, email);
});

test("real schema keeps the 254-character limit after trimming", async () => {
  const prefix = `a@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.`;
  const maxEmail = prefix + "e".repeat(254 - prefix.length);
  assert.equal(maxEmail.length, 254);
  assert.equal(schema.safeParse({ email: ` ${maxEmail} ` }).success, true);
  assert.equal(schema.safeParse({ email: `${maxEmail}e` }).success, false);
});

test("invalid payloads always return the same 202 without lookup, tokens or mail", async () => {
  for (const body of [undefined, null, {}, { email: null }, { email: 42 }, { email: [] }, { email: "" }, { email: "   " }, { email: "not-an-email" }, { email: " employee @example.test " }, { email: `a@${"b".repeat(255)}.test` }]) {
    const h = harness();
    await h.request(body);
    assert.deepEqual(h.effects, []);
    assertNoSend(h);
  }
});

test("invalid surfaces always return the same 202 without lookup, tokens or mail", async () => {
  for (const surface of [undefined, null, "", "   ", "customer", "support", "unknown"]) {
    const h = harness();
    await h.request({ email: ` ${email} ` }, surface);
    assert.deepEqual(h.effects, []);
    assertNoSend(h);
  }
});

test("real surface helper preserves supported surfaces and the partners alias", async () => {
  for (const [header, surface] of [["admin", "admin"], [" PARTNERS ", "partner"], ["RIDER", "rider"], ["fleet", "fleet"]]) {
    const h = harness({ employee: account({ apiRole: surface, sessionRoles: [surface] }) });
    await h.request({ email }, header);
    assert.deepEqual(h.roleChecks, [[h.employee, surface]]);
    assert.deepEqual(h.resets, [[h.employee, surface, 30 * 60_000]]);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.bindingChecks.length, surface === "partner" ? 1 : 0);
  }
});

test("active and approved guards remain in the real lookup, including missing accounts", async () => {
  for (const employee of [null, account({ active: false }), account({ active: undefined }), account({ authorizationStatus: "pending" }), account({ authorizationStatus: "rejected" }), account({ authorizationStatus: undefined })]) {
    const h = harness({ employee });
    await h.request({ email: ` ${email.toUpperCase()} ` });
    assert.deepEqual(h.lookups, [{ email, active: true, authorizationStatus: "approved" }]);
    assert.deepEqual(h.effects, ["lookup"]);
    assertNoSend(h);
  }
});

test("sessionRole denial blocks reset and binding even for an active approved Partner", async () => {
  const h = harness({ sessionAllowed: false });
  await h.request({ email: ` ${email} ` });
  assert.deepEqual(h.roleChecks, [[h.employee, "partner"]]);
  assert.deepEqual(h.effects, ["lookup", "sessionRole"]);
  assertNoSend(h);
});

test("a valid but unauthorized surface does not bypass sessionRole", async () => {
  const h = harness();
  await h.request({ email }, "fleet");
  assert.deepEqual(h.roleChecks, [[h.employee, "fleet"]]);
  assert.deepEqual(h.effects, ["lookup", "sessionRole"]);
  assertNoSend(h);
});

test("invalid Partner binding blocks token and mail before returning the neutral 202", async () => {
  const h = harness({ bindingValid: false });
  await h.request({ email: ` ${email.toUpperCase()} ` });
  assert.deepEqual(h.bindingChecks, [[h.employee, h.kitchenAccessDependencies]]);
  assert.deepEqual(h.effects, ["lookup", "sessionRole", "binding"]);
  assert.equal(h.warnings.length, 1);
  assertNoSend(h);
});

test("database and mail failures keep the public response neutral", async () => {
  const lookup = harness({ lookupFailure: true });
  await lookup.request({ email });
  assertNoSend(lookup);
  assert.equal(lookup.warnings.length, 1);
  for (const delivery of ["rejected", "throws"] as const) {
    const h = harness({ delivery });
    await h.request({ email });
    assert.equal(h.resets.length, 1);
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.warnings.length, 1);
  }
});

test("the existing public reset rate limit remains unchanged", () => {
  assert.equal(route().arguments[1].getText(source), 'rateLimit(3, 15 * 60_000, "employee-password-reset")');
});
