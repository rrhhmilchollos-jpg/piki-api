export type DocumentRequirement = Readonly<{
  type: string;
  inputMode?: "file" | "form" | string;
}>;

export type SubmittedDocument = Readonly<{ type: string }>;
export type SubmittedResponse = Readonly<{ type: string }>;

export type DocumentSubmissionValidation =
  | { ok: true; uploadedTypes: string[]; responseTypes: string[] }
  | {
    ok: false;
    error:
      | "EMPTY_DOCUMENT_SUBMISSION"
      | "DUPLICATE_SUBMITTED_DOCUMENT_TYPE"
      | "DUPLICATE_SUBMITTED_RESPONSE_TYPE"
      | "DOCUMENT_TYPE_NOT_REQUESTED"
      | "FORM_RESPONSE_TYPE_NOT_REQUESTED"
      | "DOCUMENT_INPUT_MODE_MISMATCH"
      | "FORM_RESPONSE_INPUT_MODE_MISMATCH";
  };

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return [...duplicate];
}

/**
 * Checks that a public upload is a partial answer to the exact requirements
 * encoded in its server-side DocumentRequest. It intentionally allows a
 * partial answer, but never lets an arbitrary type complete a requirement.
 */
export function validateDocumentRequestSubmission(
  requirements: readonly DocumentRequirement[],
  submission: Readonly<{ documents?: readonly SubmittedDocument[]; responses?: readonly SubmittedResponse[] }>,
): DocumentSubmissionValidation {
  const uploadedTypes = (submission.documents || []).map((document) => document.type);
  const responseTypes = (submission.responses || []).map((response) => response.type);

  if (!uploadedTypes.length && !responseTypes.length) return { ok: false, error: "EMPTY_DOCUMENT_SUBMISSION" };
  if (duplicates(uploadedTypes).length) return { ok: false, error: "DUPLICATE_SUBMITTED_DOCUMENT_TYPE" };
  if (duplicates(responseTypes).length) return { ok: false, error: "DUPLICATE_SUBMITTED_RESPONSE_TYPE" };

  const requirementsByType = new Map(requirements.map((requirement) => [requirement.type, requirement]));
  for (const type of uploadedTypes) {
    const requirement = requirementsByType.get(type);
    if (!requirement) return { ok: false, error: "DOCUMENT_TYPE_NOT_REQUESTED" };
    if ((requirement.inputMode || "file") !== "file") return { ok: false, error: "DOCUMENT_INPUT_MODE_MISMATCH" };
  }
  for (const type of responseTypes) {
    const requirement = requirementsByType.get(type);
    if (!requirement) return { ok: false, error: "FORM_RESPONSE_TYPE_NOT_REQUESTED" };
    if ((requirement.inputMode || "file") !== "form") return { ok: false, error: "FORM_RESPONSE_INPUT_MODE_MISMATCH" };
  }
  return { ok: true, uploadedTypes, responseTypes };
}
