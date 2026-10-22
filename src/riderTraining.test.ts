import assert from "node:assert/strict";
import test from "node:test";
import { publicTrainingQuestions, scoreTrainingAnswers, trainingToken, trainingTokenHash } from "./riderTraining.js";

test("PIKI 1 no expone la clave de respuestas", () => {
  assert.ok(publicTrainingQuestions.length > 5);
  assert.equal(JSON.stringify(publicTrainingQuestions).includes("answerIndex"), false);
});

test("PIKI 1 exige todas las preguntas y el umbral", () => {
  const incomplete = scoreTrainingAnswers({});
  assert.equal(incomplete.passedKnowledgeThreshold, false);
  assert.equal(incomplete.answered, 0);
  assert.equal(incomplete.total, publicTrainingQuestions.length);
});

test("los enlaces usan hashes de token y no contraseñas en claro", () => {
  const token = trainingToken();
  assert.ok(token.length > 20);
  assert.notEqual(trainingTokenHash(token), token);
  assert.equal(trainingTokenHash(token), trainingTokenHash(token));
});
