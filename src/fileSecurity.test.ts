import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { InvalidDocumentUploadError, normalizeDocumentUpload, sanitizePdfFileName, sanitizeUploadFileName } from "./fileSecurity.js";

function pdfInput(overrides: Partial<{ contentBase64: string; sizeBytes: number; mimeType: string; sha256: string }> = {}) {
  const bytes = Buffer.from("%PDF-1.7\nPIKI test\n", "utf8");
  return {
    contentBase64: bytes.toString("base64"),
    sizeBytes: bytes.length,
    mimeType: "application/pdf",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
}

test("normaliza un PDF con data URL después de verificar tamaño, contenido y sha256", () => {
  const input = pdfInput();
  const normalized = normalizeDocumentUpload({ ...input, contentBase64: `data:application/pdf;base64,${input.contentBase64}` });
  assert.equal(normalized.bytes.toString("utf8"), "%PDF-1.7\nPIKI test\n");
  assert.equal(normalized.contentBase64, input.contentBase64);
});

test("rechaza MIME declarado falso y checksum que no corresponde a los bytes", () => {
  assert.throws(() => normalizeDocumentUpload(pdfInput({ mimeType: "image/png" })), (error: unknown) => error instanceof InvalidDocumentUploadError && error.code === "DOCUMENT_CONTENT_TYPE_MISMATCH");
  assert.throws(() => normalizeDocumentUpload(pdfInput({ sha256: "a".repeat(64) })), (error: unknown) => error instanceof InvalidDocumentUploadError && error.code === "DOCUMENT_CHECKSUM_MISMATCH");
});

test("rechaza base64 inválido y discrepancias de tamaño antes de que el archivo se persista", () => {
  assert.throws(() => normalizeDocumentUpload(pdfInput({ contentBase64: "%%%%" })), (error: unknown) => error instanceof InvalidDocumentUploadError && error.code === "DOCUMENT_BASE64_INVALID");
  assert.throws(() => normalizeDocumentUpload(pdfInput({ sizeBytes: 1 })), (error: unknown) => error instanceof InvalidDocumentUploadError && error.code === "DOCUMENT_SIZE_MISMATCH");
});

test("sanea separadores de ruta y caracteres de control en el nombre original", () => {
  assert.equal(sanitizeUploadFileName("../DNI\u0000/foto.pdf"), ".._DNI_foto.pdf");
  assert.equal(sanitizeUploadFileName("\n\t"), "document");
});

test("conserva solo la extensión PDF para expedientes de alta", () => {
  assert.equal(sanitizePdfFileName("../DNI\u0000/foto.jpg"), ".._DNI_foto.pdf");
  assert.equal(sanitizePdfFileName("certificado"), "certificado.pdf");
});
