import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import ts from "typescript";
const source = ts.createSourceFile("corporateEmail.ts", readFileSync(new URL("./corporateEmail.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const statement = source.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === "sendCorporateEmail"); assert(statement);
test("HTTP provider rejection never logs credential idempotency key, token hash, URL or password", async () => {
  const logs: any[] = []; const resetHash = "a".repeat(64); const resetUrl = "https://example.test/?reset=OFFLINE_RESET_TOKEN";
  let requests = 0;
  const context = { createHash, corporateEmailConfiguration: () => ({ configured: true, provider: "resend", replyTo: "reply@example.test" }), corporateEmailSender: () => "from@example.test", process: { env: { RESEND_API_KEY: "OFFLINE_API_KEY" } }, console: { warn: (...args: any[]) => logs.push(args) }, fetch: async (_url: any, init: any) => { requests++; assert.equal(init.headers["Idempotency-Key"], createHash("sha256").update(`piki-employee-password-recovery-${resetHash}`).digest("hex")); return { ok: false, status: 503, json: async () => ({ token: "OFFLINE_RESET_TOKEN", password: "OFFLINE_PASSWORD" }) }; } };
  const code = `${statement.getText(source).replace("export ", "")}; return sendCorporateEmail;`;
  const send = new Function(...Object.keys(context), ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(...Object.values(context));
  const result = await send({ recipientEmail: "partner@example.test", department: "admin", subject: "OFFLINE_RECOVERY", text: `${resetUrl} OFFLINE_PASSWORD`, html: `<a href="${resetUrl}">reset</a>`, idempotencyKey: `piki-employee-password-recovery-${resetHash}` });
  assert.equal(result.sent, false); assert.equal(requests, 1); assert.deepEqual(logs, [["Corporate email delivery rejected", { status: 503, provider: "resend" }]]);
  const output = JSON.stringify({ logs, result }); for (const secret of [resetHash, resetUrl, "OFFLINE_RESET_TOKEN", "OFFLINE_PASSWORD", "OFFLINE_API_KEY", "piki-employee-password-recovery-"]) assert(!output.includes(secret));
});
