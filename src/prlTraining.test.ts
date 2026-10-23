import test from "node:test";
import assert from "node:assert/strict";
import { PRL_COURSE_VERSION, PRL_PASS_MARK, createPrlToken, hashPrlToken, prlQuestions } from "./prlTraining.js";

test("los enlaces PRL usan un token aleatorio verificable por hash", () => {
  const first = createPrlToken();
  const second = createPrlToken();
  assert.notEqual(first.token, second.token);
  assert.equal(hashPrlToken(first.token), first.tokenHash);
  assert.notEqual(hashPrlToken(first.token), second.tokenHash);
});

test("el curso PRL tiene preguntas por módulos y una nota de aprobado explícita", () => {
  assert.equal(PRL_COURSE_VERSION, "2026.10");
  assert.equal(PRL_PASS_MARK, 80);
  assert.equal(prlQuestions.length, 5);
  assert.deepEqual([...new Set(prlQuestions.map((question) => question.module))].sort(), [1, 2, 3, 4]);
  assert.ok(prlQuestions.every((question) => question.options.length >= 3));
});
