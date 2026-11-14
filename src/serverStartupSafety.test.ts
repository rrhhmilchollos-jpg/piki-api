import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute only the relevant statements from start(), not server imports,
// dotenv, MongoDB, workers, HTTP listeners or the actual mutation functions.
const source = ts.createSourceFile(
  "server.ts",
  readFileSync(new URL("./server.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.ES2022,
  true,
);
const start = source.statements.find(
  (statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === "start",
);
assert.ok(start?.body, "start() must exist");
const mongoBranch = start.body.statements.find(
  (statement): statement is ts.IfStatement =>
    ts.isIfStatement(statement) && statement.expression.getText(source) === "uri",
);
assert.ok(mongoBranch && ts.isBlock(mongoBranch.thenStatement), "MongoDB startup branch must exist");
const guardedStatements = mongoBranch.thenStatement.statements.filter((statement) =>
  /\b(purgeExpiredQaPartner|ensureMrRoosterOperational)\b/.test(statement.getText(source)),
);
assert.ok(guardedStatements.length > 0, "startup mutation statements must exist");
const isolatedStartup = ts.transpileModule(
  `(async () => {\n${guardedStatements.map((statement) => statement.getText(source)).join("\n")}\n})()`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } },
).outputText;

async function exerciseGuards(qaFlag: string | undefined, repairFlag: string | undefined) {
  const env: Record<string, string> = {};
  if (qaFlag !== undefined) env.PIKI_QA_EXPIRY_PURGE_ENABLED = qaFlag;
  if (repairFlag !== undefined) env.PIKI_BOOTSTRAP_DATA_REPAIR_ENABLED = repairFlag;
  const calls = { purge: 0, repair: 0, unref: 0 };
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  await runInNewContext(isolatedStartup, {
    process: { env },
    purgeExpiredQaPartner: async () => { calls.purge += 1; },
    ensureMrRoosterOperational: async () => { calls.repair += 1; },
    setInterval: (callback: () => void, delay: number) => {
      intervals.push({ callback, delay });
      return { unref: () => { calls.unref += 1; } };
    },
    console: { warn: () => assert.fail("unexpected purge failure") },
  });
  return { calls, intervals };
}

const disabledValues = [undefined, "", "false", "0", "1", "TRUE", "True", " true", "true "];

test("startup mutations and QA timer default off; only literal true enables each flag", async () => {
  const values = [...disabledValues, "true"];
  for (const qaFlag of values) {
    for (const repairFlag of values) {
      const { calls, intervals } = await exerciseGuards(qaFlag, repairFlag);
      const label = JSON.stringify({ qaFlag, repairFlag });
      assert.equal(calls.purge, qaFlag === "true" ? 1 : 0, label);
      assert.equal(calls.repair, repairFlag === "true" ? 1 : 0, label);
      assert.equal(intervals.length, qaFlag === "true" ? 1 : 0, label);
      assert.equal(calls.unref, intervals.length, label);
      if (intervals.length) {
        assert.equal(intervals[0].delay, 60_000, label);
        intervals[0].callback();
        await Promise.resolve();
        assert.equal(calls.purge, 2, label);
        assert.equal(calls.repair, repairFlag === "true" ? 1 : 0, label);
      }
    }
  }
});

test("legacy menu repair flag alone cannot enable the bootstrap repair", async () => {
  let repairCalls = 0;
  await runInNewContext(isolatedStartup, {
    process: { env: { REPAIR_MR_ROOSTER_MENU: "true" } },
    purgeExpiredQaPartner: async () => assert.fail("purge must remain disabled"),
    ensureMrRoosterOperational: async () => { repairCalls += 1; },
    setInterval: () => assert.fail("purge timer must remain disabled"),
  });
  assert.equal(repairCalls, 0);
});
