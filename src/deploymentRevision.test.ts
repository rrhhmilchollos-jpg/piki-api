import test from "node:test";
import assert from "node:assert/strict";
import { renderDeploymentCommit } from "./deploymentRevision.js";

test("deployment revision returns only the validated Render Git commit", () => {
  const commit = "a".repeat(40);
  assert.equal(renderDeploymentCommit({ RENDER_GIT_COMMIT: commit }), commit);
  assert.equal(renderDeploymentCommit({ RENDER_GIT_COMMIT: commit.toUpperCase() }), commit);
});
test("missing or malformed revision never exposes environment values", () => {
  assert.equal(renderDeploymentCommit({}), null);
  for (const value of ["rnd_example", "mongodb://example.invalid/db", "not-a-commit", "a".repeat(39)]) assert.equal(renderDeploymentCommit({ RENDER_GIT_COMMIT: value }), null);
  assert.equal(renderDeploymentCommit({ RENDER_API_KEY: "placeholder", GITHUB_SHA: "b".repeat(40) }), null);
});
