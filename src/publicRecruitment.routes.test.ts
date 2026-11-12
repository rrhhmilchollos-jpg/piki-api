import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { partnerLeadSubmissionSchema, riderLeadSubmissionSchema, normalizeLeadEmail } from "./webLeads.js";
import { resolvePublicRecruitmentSelection } from "./publicRecruitment.js";

const text = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("server.ts", text, ts.ScriptTarget.Latest, true);
function handlerFor(path: string, records: Record<string, unknown>[], events: unknown[]) {
  let callback: ts.Expression | undefined;
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(source) !== "app.post" || !call.arguments[0] || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== path) continue;
    callback = call.arguments[call.arguments.length - 1];
  }
  assert(callback, `Missing handler ${path}`);
  const javascript = ts.transpileModule(`const handler = ${callback.getText(source)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const model = { create: async (data: Record<string, unknown>) => { records.push(data); return { _id: "000000000000000000000001", status: data.status }; } };
  return new Function("context", `const {partnerLeadSubmissionSchema,riderLeadSubmissionSchema,normalizeLeadEmail,resolvePublicRecruitmentSelection,PartnerLead,RiderLead,notifyOnboarding}=context; ${javascript}; return handler;`)({
    partnerLeadSubmissionSchema, riderLeadSubmissionSchema, normalizeLeadEmail, resolvePublicRecruitmentSelection,
    PartnerLead: model, RiderLead: model, notifyOnboarding: async (event: unknown) => { events.push(event); },
  }) as (req: { body: Record<string, unknown> }, res: { status(code: number): unknown; json(body: unknown): unknown }) => Promise<unknown>;
}
async function invoke(kind: "partner" | "rider", change: Record<string, unknown> = {}) {
  const records: Record<string, unknown>[] = [];
  const events: unknown[] = [];
  const body = { name: "Contacto de prueba", email: "APPLICANT@EXAMPLE.INVALID", phone: "000000000", address: "Dirección de prueba sin envío", city: "Madrid", localityCode: "28079", provinceCode: "28", vehicle: "bike", availability: "Información de prueba", privacyNoticeAccepted: true, website: "", ...change };
  let status = 200;
  let response: unknown;
  const res = { status(code: number) { status = code; return res; }, json(data: unknown) { response = data; return res; } };
  await handlerFor(`/api/v1/public/${kind}-leads`, records, events)({ body }, res);
  return { status, response, records, events };
}

test("Partner Madrid records only an initial unassigned lead and confirms its identity", async () => {
  const result = await invoke("partner", { tenantId: "injected", status: "qualified", roles: ["admin"] });
  assert.equal(result.status, 201);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].requestedZoneSlug, null);
  assert.equal(result.records[0].status, "new");
  assert.equal(result.records[0].tenantId, undefined);
  assert.equal(result.records[0].roles, undefined);
  assert.equal(result.records[0].email, "applicant@example.invalid");
  assert.deepEqual((result.response as { lead: unknown }).lead, { id: "000000000000000000000001", status: "new" });
  assert.equal(result.events.length, 1);
});
test("Rider Algemesí intake does not create an operational zone or an approved account", async () => {
  const result = await invoke("rider", { city: "Algemesí", localityCode: "46029", provinceCode: "46" });
  assert.equal(result.status, 201);
  assert.equal(result.records[0].requestedZoneSlug, null);
  assert.equal(result.records[0].status, "new");
  assert.equal(result.records[0].assignedFleetId, undefined);
});
test("both handlers reject inconsistent identity and invented zones before any mocked persistence", async () => {
  for (const kind of ["partner", "rider"] as const) for (const change of [{ provinceCode: "46" }, { requestedZoneSlug: "madrid-fake" }, { city: "Xàtiva" }]) {
    const result = await invoke(kind, change);
    assert.equal(result.status, 400);
    assert.equal(result.records.length, 0);
    assert.equal(result.events.length, 0);
  }
});
test("consent and anti-bot guards remain mandatory before receiving any lead", async () => {
  for (const kind of ["partner", "rider"] as const) for (const change of [{ privacyNoticeAccepted: false }, { website: "bot.example.invalid" }]) {
    const result = await invoke(kind, change);
    assert.equal(result.status, 400);
    assert.equal(result.records.length, 0);
  }
});
