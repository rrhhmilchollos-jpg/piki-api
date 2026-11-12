import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { openingHoursSchema, normalizeOpeningHours, legacyOpeningHoursProjection, evaluateOpeningHours } from "./openingHours.js";
import { restaurantIsWithinOpeningHours } from "./customerCatalogPolicy.js";

const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compile(code: string, context: Record<string, any>) {
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${javascript}; return subject;`)(...Object.values(context));
}
function helper(name: string, context: Record<string, any>) {
  const node = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert(node); return compile(`${node.getText(source)}; const subject = ${name};`, context);
}
function handler(method: string, context: Record<string, any>) {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(source) === `app.${method}` && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === "/api/v1/partners/store/hours") return compile(`const subject = ${call.arguments[call.arguments.length - 1].getText(source)};`, context);
  }
  throw new Error(`Missing hours ${method}`);
}
const query = (value: any) => ({ select() { return this; }, lean() { return this; }, exec: async () => value });
async function roundtrip(input: unknown, allowed = true) {
  let writes = 0;
  const row = { _id: "64b000000000000000000001", name: "Offline", isActive: true, partnerProfile: { openingHours: {} as any } };
  const context = {
    openingHoursSchema,
    pikiManagedOpeningHours: helper("pikiManagedOpeningHours", { normalizeOpeningHours, legacyOpeningHoursProjection }),
    partnerIsOpenNow: helper("partnerIsOpenNow", {}),
    partnerRequestAccess: async () => ({ allowed, access: { restaurantIds: [row._id] } }), employeeRestaurant: async () => row._id,
    tenantScope: () => ({ tenantId: "64b000000000000000000002" }),
    Restaurant: { findOne: () => query(row), findOneAndUpdate: (filter: any, update: any) => { writes++; assert.equal(filter.tenantId, "64b000000000000000000002"); assert.equal(filter.onboardingStatus, "approved"); row.partnerProfile.openingHours = update.$set["partnerProfile.openingHours"]; return query(row); } },
    invalidateCatalogCache: () => undefined, publishCatalogUpdate: () => undefined,
  };
  let status = 200; let body: any;
  const res = { status(value: number) { status = value; return this; }, json(value: any) { body = value; return this; } };
  await handler("patch", context)({ body: { openingHours: input } }, res);
  const saved = body;
  if (status === 200) await handler("get", context)({}, res);
  return { status, saved, read: body, writes };
}

test("actual PATCH → GET hours preserves continuous legacy without inventing a second interval", async () => {
  const result = await roundtrip({ lunes: { open: "10:00", close: "00:00", closed: false } });
  assert.equal(result.status, 200); assert.equal(result.writes, 1);
  assert.deepEqual(result.saved.openingHours, result.read.openingHours);
  const hours = result.read.openingHours;
  assert.deepEqual(hours.regular.lunes, [{ open: "10:00", close: "00:00", endsNextDay: true }]);
  assert.equal(hours.timeZone, "Europe/Madrid"); assert.equal(hours.morning, undefined);
  assert.equal(Number(!hours.lunes.morning.closed) + Number(!hours.lunes.evening.closed), 1);
});

test("actual PATCH → GET split hours keeps noon break, individual/day closure and 00:00", async () => {
  const result = await roundtrip({
    lunes: { morning: { open: "12:00", close: "16:00", closed: false }, evening: { open: "19:00", close: "00:00", closed: false }, closed: false },
    martes: { morning: { open: "00:00", close: "03:00", closed: true }, evening: { open: "22:00", close: "02:00", closed: false }, closed: false },
    domingo: { morning: { open: "10:00", close: "14:00", closed: false }, evening: { open: "19:00", close: "23:00", closed: false }, closed: true },
  });
  assert.equal(result.status, 200); assert.deepEqual(result.read.openingHours, result.saved.openingHours);
  const hours = result.read.openingHours;
  assert.equal(hours.regular.lunes.length, 2); assert.equal(hours.lunes.evening.close, "00:00");
  assert.equal(hours.regular.martes.length, 1); assert.deepEqual(hours.regular.domingo, []);
  assert.equal(evaluateOpeningHours(hours, new Date("2026-11-09T16:30:00Z")).open, false);
  assert.equal(evaluateOpeningHours(hours, new Date("2026-11-09T22:59:00Z")).open, true);
  assert.equal(evaluateOpeningHours(hours, new Date("2026-11-11T00:30:00Z")).open, true);
});

test("hours permissions and invalid inputs still prevent any mocked write", async () => {
  const input = { lunes: { open: "25:00", close: "00:00", closed: false } };
  assert.deepEqual((await roundtrip(input)).writes, 0);
  assert.equal((await roundtrip(input)).status, 400);
  const denied = await roundtrip({}, false); assert.equal(denied.status, 403); assert.equal(denied.writes, 0);
});

test("Customer/checkout legacy 24h policy remains unchanged by split schedule normalization", () => {
  const hours = openingHoursSchema.parse({ lunes: { open: "10:00", close: "14:00", closed: true } });
  const now = new Date("2026-11-09T16:30:00Z");
  assert.equal(evaluateOpeningHours(hours, now).open, false);
  assert.equal(restaurantIsWithinOpeningHours(hours, now), true);
});
