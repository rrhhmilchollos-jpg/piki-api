import test from "node:test";
import assert from "node:assert/strict";
import { validateDocumentRequestSubmission } from "./onboardingDocumentPolicy.js";

const requirements = [
  { type: "identity", inputMode: "file" },
  { type: "tax_declaration", inputMode: "form" },
] as const;

test("el expediente acepta una entrega parcial que respeta el modo de cada requisito", () => {
  assert.deepEqual(
    validateDocumentRequestSubmission(requirements, {
      documents: [{ type: "identity" }],
      responses: [{ type: "tax_declaration" }],
    }),
    { ok: true, uploadedTypes: ["identity"], responseTypes: ["tax_declaration"] },
  );
});

test("un formulario no puede marcar como completado un requisito que exige archivo", () => {
  assert.deepEqual(
    validateDocumentRequestSubmission(requirements, { responses: [{ type: "identity" }] }),
    { ok: false, error: "FORM_RESPONSE_INPUT_MODE_MISMATCH" },
  );
});

test("la carga rechaza tipos no solicitados y duplicados para no sobrescribir el expediente", () => {
  assert.deepEqual(
    validateDocumentRequestSubmission(requirements, { documents: [{ type: "bank_certificate" }] }),
    { ok: false, error: "DOCUMENT_TYPE_NOT_REQUESTED" },
  );
  assert.deepEqual(
    validateDocumentRequestSubmission(requirements, { documents: [{ type: "identity" }, { type: "identity" }] }),
    { ok: false, error: "DUPLICATE_SUBMITTED_DOCUMENT_TYPE" },
  );
});

test("una solicitud solo de formulario puede enviarse sin adjuntar un fichero", () => {
  assert.deepEqual(
    validateDocumentRequestSubmission([{ type: "tax_declaration", inputMode: "form" }], { responses: [{ type: "tax_declaration" }] }),
    { ok: true, uploadedTypes: [], responseTypes: ["tax_declaration"] },
  );
});
