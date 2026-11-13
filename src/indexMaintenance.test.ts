import assert from "node:assert/strict";
import test from "node:test";
import { syncIndexesWithIndexRaceRecovery } from "./indexMaintenance.js";

test("rebuilds schema indexes when another startup already removed an index", async () => {
  let createCalls = 0;
  const warnings: Array<{ message: string; details: unknown }> = [];
  const model = {
    modelName: "EmployeeAccount",
    async syncIndexes() {
      throw Object.assign(new Error("index not found with name [portfolioId_1]"), {
        code: 27,
        codeName: "IndexNotFound",
      });
    },
    async createIndexes() {
      createCalls += 1;
    },
  };

  await syncIndexesWithIndexRaceRecovery(model, (message, details) => warnings.push({ message, details }));

  assert.equal(createCalls, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Concurrent MongoDB index cleanup/);
  assert.deepEqual(warnings[0].details, {
    model: "EmployeeAccount",
    code: 27,
    codeName: "IndexNotFound",
  });
});

test("propagates non-index errors without rebuilding indexes", async () => {
  const failure = new Error("MongoDB is unavailable");
  let createCalls = 0;
  const model = {
    modelName: "Fleet",
    async syncIndexes() {
      throw failure;
    },
    async createIndexes() {
      createCalls += 1;
    },
  };

  await assert.rejects(syncIndexesWithIndexRaceRecovery(model), (error) => error === failure);
  assert.equal(createCalls, 0);
});
