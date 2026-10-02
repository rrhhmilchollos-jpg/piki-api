import test from "node:test";
import assert from "node:assert/strict";
import { MalwareDetectedError, MalwareScannerUnavailableError } from "./fileSecurity.js";

test("malware scan errors have explicit safe failure types", () => {
  assert.equal(new MalwareDetectedError().name, "MalwareDetectedError");
  assert.equal(new MalwareScannerUnavailableError().name, "MalwareScannerUnavailableError");
});
