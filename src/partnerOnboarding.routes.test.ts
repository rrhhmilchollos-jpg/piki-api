import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import mongoose from "mongoose";
import ts from "typescript";
import { z } from "zod";
import { partnerSchema, manualPartnerSchema, allPartnerOnboardingDocumentsReceived, PARTNER_ONBOARDING_DOCUMENT_TYPES, partnerLegalProfileReadyForReview } from "./partnerOnboarding.js";
import { normalizeDocumentUpload, sanitizeUploadFileName, MalwareDetectedError, MalwareScannerUnavailableError } from "./fileSecurity.js";
import { Restaurant } from "./models.js";

// Read/compile only the callbacks. Never import server.ts, dotenv or runtime transports.
const source = ts.createSourceFile("server.ts", readFileSync(new URL("./server.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function compile(code: string, context: Record<string, any>) {
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), `${javascript}; return subject;`)(...Object.values(context));
}
function callback(path: string, method = "post") {
  for (const statement of source.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(source) === `app.${method}` && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === path) return call.arguments[call.arguments.length - 1].getText(source);
  }
  throw new Error(`Missing handler: ${path}`);
}
const normalizer = source.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === "normalizeAndScanOnboardingDocuments")!;
const paths = ["/api/v1/partners/onboarding", "/api/v1/admin/partners/manual", "/api/v1/employee/onboarding-requests"];
function application(change: Record<string, unknown> = {}) {
  const at = "2026-11-12T10:00:00Z";
  return { name: "Offline Partner", legalName: "Offline Legal", taxId: "TEST12345", legalForm: "sl", email: "offline@example.invalid", phone: "000000000", password: "OfflineTest12345", address: "Dirección de prueba", representativeName: "Representante", representativeRole: "Administrador", representativeDocument: "TEST12345", fiscalAddress: "Dirección fiscal", operatingAddress: "Dirección de prueba", postalCode: "46029", city: "Algemesí", province: "Valencia", iban: "ES0000000000000000000000", bankAccountHolder: "Offline Legal", cuisine: "Prueba", vatRate: 10, commissionAccepted: true, contractAccepted: true, termsAcceptedAt: at, privacyAccepted: true, dataProcessingAccepted: true, privacyAcceptedAt: at, dataProcessingAcceptedAt: at, pdaUnits: 2, pdaUnitCostCents: 20000, pdaCostAccepted: true, pdaCostAcceptedAt: at, openingHours: { lunes: { open: "10:00", close: "00:00", closed: false } }, documents: [], ...change };
}
function document(type: string = "tax_id", change: Record<string, unknown> = {}) {
  const bytes = Buffer.from("%PDF-1.7\nOffline test only\n");
  return { type, fileName: "test.pdf", mimeType: "application/pdf", sizeBytes: bytes.length, contentBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), ...change };
}
const query = (value: any) => ({ select() { return this; }, lean() { return this; }, exec: async () => value });
async function invoke(path: string, change: Record<string, unknown> = {}, scanError?: Error, role = "commercial") {
  const records: { model: string; data: any }[] = [];
  const updates: any[] = [];
  let scans = 0;
  const model = (name: string) => ({
    findOne: () => query(null), exists: async () => false,
    create: async (input: any) => { const data = Array.isArray(input) ? input[0] : input; records.push({ model: name, data }); const item = { ...data, _id: "64b000000000000000000001", id: "64b000000000000000000001", toObject: () => data }; return Array.isArray(input) ? [item] : item; },
    updateOne: (_filter: any, update: any) => { updates.push(update); return query({ matchedCount: 1 }); },
    findOneAndUpdate: () => query({}),
  });
  const scanUploadBuffers = async () => { scans++; if (scanError) throw scanError; };
  const normalizeAndScanOnboardingDocuments = compile(`${normalizer.getText(source)}\nconst subject = normalizeAndScanOnboardingDocuments;`, { normalizeDocumentUpload, sanitizeUploadFileName, scanUploadBuffers });
  const context = { z, partnerSchema, manualPartnerSchema, allPartnerOnboardingDocumentsReceived, normalizeAndScanOnboardingDocuments, MalwareDetectedError, MalwareScannerUnavailableError, Restaurant: model("restaurant"), EmployeeAccount: model("employee"), PartnerLocalityGroup: model("group"), OnboardingRequest: model("request"), publicOnboardingTenantScope: async () => ({ tenantId: "64b000000000000000000002" }), tenantScope: () => ({ tenantId: "64b000000000000000000002" }), employeeScope: async () => ({ _id: "64b000000000000000000003", jobRole: role, zoneSlugs: ["valencia"] }), onboardingRequestSchema: z.object({ requestType: z.enum(["partner", "fleet", "rider"]), payload: z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0) }), mongoose: { Types: mongoose.Types, startSession: async () => ({ withTransaction: async (fn: () => Promise<void>) => fn(), endSession: async () => undefined }) }, randomBytes, localityKey: (city: string) => city.toLowerCase(), hashPassword: () => "offline-hash", generateTemporaryPassword: () => "OfflineTest12345", employeeCodeFor: () => "OFFLINE-E", ensurePartnerOperationalLocation: async () => undefined, notifyOnboarding: async () => undefined, onboardingCode: () => "OFFLINE-P" };
  const handler = compile(`const subject = ${callback(path)};`, context);
  let status = 200; let response: any;
  const res = { status(code: number) { status = code; return this; }, json(body: any) { response = body; return this; } };
  const data = application(change);
  await handler({ body: path.includes("onboarding-requests") ? { requestType: "partner", payload: data } : data }, res);
  return { status, response, records, updates, scans };
}

for (const path of paths) {
  test(`${path}: zero/omitted optional documents accepted with new 200 EUR consent, pending only`, async () => {
    for (const documents of [[], undefined]) {
      const result = await invoke(path, { documents });
      assert.equal(result.status, 201); assert.equal(result.scans, 0);
      if (path.includes("onboarding-requests")) {
        assert.equal(result.records[0].data.status, "pending"); assert.deepEqual(result.records[0].data.payload.documents, []); assert.equal(result.records[0].data.payload.pdaUnitCostCents, 20000);
      } else {
        const restaurant = result.records.find((record) => record.model === "restaurant")!.data;
        assert.equal(restaurant.onboardingStatus, "pending_review"); assert.equal(restaurant.isActive, false);
        assert.deepEqual(restaurant.partnerProfile.documents, []); assert.equal(restaurant.partnerProfile.pdaUnitCostCents, 20000);
        assert.equal(restaurant.partnerProfile.pdaUnits * restaurant.partnerProfile.pdaUnitCostCents, 40000);
        const employee = result.records.find((record) => record.model === "employee")!.data;
        assert.equal(employee.authorizationStatus, "pending"); assert.equal(employee.active, false); assert.deepEqual(employee.roles, ["partner"]);
        if (restaurant.onboardingChecklist) assert.equal(restaurant.onboardingChecklist.documents, false);
        if (result.response.partner.checklist) assert.equal(result.response.partner.checklist.documents, false);
        for (const update of result.updates) assert.notEqual(update.$set?.["onboardingChecklist.documents"], true);
      }
    }
  });
  test(`${path}: reject old/incorrect/missing fee and missing consent before persistence`, async () => {
    for (const change of [{ pdaUnitCostCents: 30000 }, { pdaUnitCostCents: 19999 }, { pdaUnitCostCents: undefined }, { pdaCostAccepted: false }, { contractAccepted: false }, { privacyAccepted: false }, { dataProcessingAccepted: false }, { pdaUnits: 51 }, { pdaUnits: 1.5 }]) {
      const result = await invoke(path, change); assert.equal(result.status, 400); assert.equal(result.records.length, 0); assert.equal(result.scans, 0);
    }
  });
  test(`${path}: supplied invalid MIME/type/size/base64/checksum/duplicate rejected, never persisted`, async () => {
    for (const documents of [[document("tax_id", { mimeType: "text/html" })], [document("identity")], [document("tax_id", { sizeBytes: 2_500_001 })], [document("tax_id", { contentBase64: "%".repeat(24) })], [document("tax_id", { mimeType: "image/png" })], [document("tax_id", { sizeBytes: 1 })], [document("tax_id", { sha256: "a".repeat(64) })], [document(), document()]]) {
      const result = await invoke(path, { documents }); assert.equal(result.status, 400); assert.equal(result.records.length, 0); assert.equal(result.scans, 0);
    }
  });
  test(`${path}: one/five valid supplied uploads scanned and stored as received, not approved`, async () => {
    for (const documents of [[document()], PARTNER_ONBOARDING_DOCUMENT_TYPES.map((type) => document(type))]) {
      const result = await invoke(path, { documents }); assert.equal(result.status, 201); assert.equal(result.scans, 1);
      const data = result.records[0].data;
      const saved = data.payload?.documents ?? data.partnerProfile.documents;
      assert.equal(saved.length, documents.length);
      if (data.partnerProfile) assert(saved.every((item: any) => item.status === "received"));
      assert.equal(allPartnerOnboardingDocumentsReceived(saved), documents.length === 5);
    }
  });
  test(`${path}: malware/scanner unavailability remain fail-closed`, async () => {
    for (const [error, status] of [[new MalwareDetectedError(), 422], [new MalwareScannerUnavailableError(), 503]] as const) {
      const result = await invoke(path, { documents: [document()] }, error); assert.equal(result.status, status); assert.equal(result.records.length, 0);
    }
  });
}

test("commercial request preserves role scope; no unscoped registration", async () => {
  const result = await invoke(paths[2], {}, undefined, "partner"); assert.equal(result.status, 403); assert.equal(result.records.length, 0);
});

test("persisted Mongoose profile permits new 200 and historical 300 without default or repricing", () => {
  const profileSchema = (Restaurant.schema.path("partnerProfile") as any).schema;
  const Profile = mongoose.model("OfflineOnboardingProfile", profileSchema);
  for (const fee of [20000, 30000]) {
    const input = application({ pdaUnitCostCents: fee });
    const profile = new Profile({ ...input, contractAcceptedAt: input.termsAcceptedAt });
    assert.equal(profile.validateSync(), undefined); assert.equal(profile.pdaUnitCostCents, fee);
  }
  assert.equal(profileSchema.path("pdaUnitCostCents").defaultValue, undefined);
  assert(partnerSchema.safeParse(application()).success);
  assert.equal(partnerSchema.safeParse(application({ pdaUnitCostCents: 30000 })).success, false);
});

const authSource = ts.createSourceFile("auth.ts", readFileSync(new URL("./auth.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const requireRoleSource = authSource.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "requireRole")!;
async function review(path: string, documents: any[], status: string, accountPresent = true, profileChange: Record<string, unknown> = {}, options: { previousStatus?: string; role?: string | null; accountStatus?: string; outsideTenant?: boolean } = {}) {
  const writes: any[] = [];
  const effects: string[] = [];
  const reads: any[] = [];
  const tenantId = "64b000000000000000000002";
  const existing = { _id: "64b000000000000000000001", tenantId, partnerProfile: { ...application(), contractAcceptedAt: "2026-11-12T10:00:00Z", documents, ...profileChange }, onboardingStatus: path.endsWith("/status") && !path.includes("/compliance/") ? options.previousStatus || "pending_review" : "approved", onboardingReviewedAt: "2025-01-01T00:00:00Z", marketplaceCompliance: { pikiStatus: path.includes("/compliance/") ? options.previousStatus || "in_review" : "verified", reviewedAt: "2025-01-01T00:00:00Z", stripeStatus: "not_created", chargesEnabled: false, payoutsEnabled: false } };
  const restaurant = { findOne: (filter: any) => { reads.push(filter); assert.equal(filter.tenantId, tenantId); return query(options.outsideTenant ? null : existing); }, findOneAndUpdate: (_filter: any, update: any) => { writes.push(update); return query(existing); }, updateOne: (_filter: any, update: any) => { writes.push(update); return query({}); } };
  const employee = { findOne: (filter: any) => { reads.push(filter); assert.equal(filter.tenantId, tenantId); assert.equal(filter.apiRole, "partner"); return query(accountPresent ? { _id: "64b000000000000000000004", authorizationStatus: options.accountStatus || "pending" } : null); }, findOneAndUpdate: (_filter: any, update: any) => { writes.push(update); return query({}); } };
  const effect = (name: string) => async () => { effects.push(name); };
  const handler = compile(`const subject = ${callback(path, "patch")};`, { z, partnerLegalProfileReadyForReview, Restaurant: restaurant, EmployeeAccount: employee, objectId: (id: string) => id, tenantScope: () => ({ tenantId }), notifyOnboarding: effect("notify"), AccessAuthorization: { create: effect("audit") }, revokeEmployeeSessions: effect("revoke"), invalidateCatalogCache: () => { effects.push("invalidate"); }, publishCatalogUpdate: effect("publish") });
  const role = options.role === undefined ? "admin" : options.role;
  const requireRole = compile(`${requireRoleSource.getText(authSource).replace(/^export\s+/, "")}\nconst subject = requireRole;`, { resolveRole: async () => role ? { role, employeeId: "64b000000000000000000003", tenantId } : null, isTemporaryPasswordAllowedPath: () => false });
  const route = source.statements.find((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(source) === "app.patch" && ts.isStringLiteral(node.expression.arguments[0]) && node.expression.arguments[0].text === path) as ts.ExpressionStatement;
  const middleware = compile(`const subject = ${(route.expression as ts.CallExpression).arguments[1].getText(source)};`, { requireRole });
  let code = 200; let body: any;
  const res = { status(value: number) { code = value; return this; }, json(value: any) { body = value; return this; }, setHeader() {} };
  const req = { params: { id: existing._id }, path, body: { status } };
  await middleware(req, res, () => handler(req, res));
  return { code, body, writes, effects, reads, existing };
}

test("manual human approval/KYB does not require absent uploads or synthesize document approval", async () => {
  for (const [path, status] of [["/api/v1/admin/restaurants/:id/status", "approved"], ["/api/v1/admin/restaurants/:id/compliance/status", "verified"]]) {
    const result = await review(path, [], status); assert.equal(result.code, 200); assert.deepEqual(result.existing.partnerProfile.documents, []);
    assert(result.writes.every((write) => Object.keys(write.$set).every((key) => !key.startsWith("partnerProfile.documents"))));
    assert.equal(result.existing.marketplaceCompliance.chargesEnabled, false); assert.equal(result.existing.marketplaceCompliance.stripeStatus, "not_created");
  }
});
test("human approval retains review/rejection gates for supplied documents and missing account", async () => {
  const path = "/api/v1/admin/restaurants/:id/status";
  assert.equal((await review(path, [{ status: "received" }], "approved")).code, 409);
  assert.equal((await review(path, [{ status: "rejected" }], "approved")).code, 409);
  assert.equal((await review(path, [], "approved", false)).body.error, "PARTNER_ACCOUNT_MISSING");
  const kyb = await review("/api/v1/admin/restaurants/:id/compliance/status", [{ status: "received" }], "verified");
  assert.equal(kyb.code, 409); assert.equal(kyb.writes.length, 0);
});


test("optional documents never waive legal/bank information or stored consent during human review", async () => {
  for (const [path, status] of [["/api/v1/admin/restaurants/:id/status", "approved"], ["/api/v1/admin/restaurants/:id/compliance/status", "verified"]]) {
    for (const change of [{ legalName: "" }, { taxId: "" }, { iban: "" }, { bankAccountHolder: "" }, { commissionAccepted: false }, { contractAcceptedAt: null }, { privacyAcceptedAt: null }, { dataProcessingAcceptedAt: undefined }, { pdaCostAcceptedAt: null }]) {
      const result = await review(path, [], status, true, change);
      assert.equal(result.code, 409); assert.equal(result.body.error, "PARTNER_LEGAL_PROFILE_REQUIRED"); assert.equal(result.writes.length, 0);
    }
    const historical = await review(path, [], status, true, { pdaUnitCostCents: 30000 });
    assert.equal(historical.code, 200); assert.equal(historical.existing.partnerProfile.pdaUnitCostCents, 30000);
    assert(historical.writes.every((write) => Object.keys(write.$set).every((key) => !key.includes("pda"))));
  }
});


test("new intake accepts exactly zero through five supported document types, never six", () => {
  for (let count = 0; count <= 5; count++) {
    const documents = PARTNER_ONBOARDING_DOCUMENT_TYPES.slice(0, count).map((type) => document(type));
    assert(partnerSchema.safeParse(application({ documents })).success);
  }
  const documents = [...PARTNER_ONBOARDING_DOCUMENT_TYPES.map((type) => document(type)), document()];
  assert.equal(partnerSchema.safeParse(application({ documents })).success, false);
});

const reviewRoutes = [["/api/v1/admin/restaurants/:id/status", "approved"], ["/api/v1/admin/restaurants/:id/compliance/status", "verified"]] as const;

test("new intake rejects whitespace-padded underlength legal values before scanning or persistence", async () => {
  const minimums: Record<string, number> = { legalName: 2, representativeName: 2, representativeRole: 2, representativeDocument: 5, fiscalAddress: 5, operatingAddress: 5, city: 2, province: 2, bankAccountHolder: 2, cuisine: 2 };
  for (const path of paths) {
    for (const [field, minimum] of Object.entries(minimums)) {
      const result = await invoke(path, { [field]: ` ${"A".repeat(minimum - 1)} ` });
      assert.equal(result.status, 400, `${path} ${field}`); assert.equal(result.records.length, 0); assert.equal(result.scans, 0); assert.equal(result.updates.length, 0);
    }
    const result = await invoke(path, { legalName: "  Offline Legal  ", representativeName: "  Representante  " });
    assert.equal(result.status, 201);
    const profile = result.records[0].data.payload ?? result.records[0].data.partnerProfile;
    assert.equal(profile.legalName, "Offline Legal"); assert.equal(profile.representativeName, "Representante");
  }
  assert.equal(partnerSchema.safeParse(application({ legalName: " A " })).success, false);
});

test("real REST retries of historical approved/verified preserve 30000 and all metadata without writes/providers", async () => {
  const Profile = mongoose.models.OfflineOnboardingProfile || mongoose.model("OfflineOnboardingProfile", (Restaurant.schema.path("partnerProfile") as any).schema);
  const profile = new Profile({ ...application({ legalName: " A ", pdaUnitCostCents: 30000 }), contractAcceptedAt: "2025-01-01T00:00:00Z" });
  assert.equal(profile.validateSync(), undefined); assert.equal(profile.legalName, "A");
  assert.equal(partnerLegalProfileReadyForReview(profile.toObject()), false); // Synthetic string is not a legal validity assertion.
  for (const [path, status] of reviewRoutes) {
    const result = await review(path, [], status, true, { ...profile.toObject(), documents: [{ status: "approved" }] }, { previousStatus: status, accountStatus: "approved" });
    assert.equal(result.code, 200); assert.deepEqual(result.writes, []); assert.deepEqual(result.effects, []);
    assert.equal(result.existing.partnerProfile.pdaUnitCostCents, 30000); assert.equal(result.existing.partnerProfile.legalName, "A");
    assert.equal(result.existing.onboardingReviewedAt, "2025-01-01T00:00:00Z"); assert.equal(result.existing.marketplaceCompliance.reviewedAt, "2025-01-01T00:00:00Z");
    assert.equal(result.existing.marketplaceCompliance.stripeStatus, "not_created"); assert.equal(result.existing.marketplaceCompliance.chargesEnabled, false);
    if (status === "approved") { assert.equal(result.body.restaurant.onboardingStatus, "approved"); assert.equal(result.body.partnerAccount.access, "enabled"); }
    else assert.equal(result.body.compliance.pikiStatus, "verified");
    for (const previousStatus of ["pending_review", "in_review", "rejected", "suspended"]) {
      const transition = await review(path, [], status, true, profile.toObject(), { previousStatus, accountStatus: "approved" });
      assert.equal(transition.code, 409); assert.equal(transition.body.error, "PARTNER_LEGAL_PROFILE_REQUIRED"); assert.deepEqual(transition.writes, []); assert.deepEqual(transition.effects, []);
    }
  }
});

test("same-state retries cannot silently authorize missing/pending Partner accounts or supplied unreviewed files", async () => {
  const approved = reviewRoutes[0];
  const missing = await review(approved[0], [], approved[1], false, { legalName: "A", pdaUnitCostCents: 30000 }, { previousStatus: "approved" });
  assert.equal(missing.code, 409); assert.equal(missing.body.error, "PARTNER_ACCOUNT_MISSING"); assert.deepEqual(missing.writes, []); assert.deepEqual(missing.effects, []);
  const pending = await review(approved[0], [], approved[1], true, { legalName: "A", pdaUnitCostCents: 30000 }, { previousStatus: "approved", accountStatus: "pending" });
  assert.equal(pending.code, 200); assert.equal(pending.body.partnerAccount.access, "disabled"); assert.deepEqual(pending.writes, []); assert.deepEqual(pending.effects, []);
  for (const [path, status] of reviewRoutes) {
    for (const documentStatus of ["received", "rejected"]) {
      const blocked = await review(path, [{ status: documentStatus }], status, true, {}, { previousStatus: status, accountStatus: "approved" });
      assert.equal(blocked.code, 409); assert.deepEqual(blocked.writes, []); assert.deepEqual(blocked.effects, []);
      const newApproval = await review(path, [{ status: documentStatus }], status);
      assert.equal(newApproval.code, 409); assert.deepEqual(newApproval.writes, []); assert.deepEqual(newApproval.effects, []);
    }
  }
  const newMissing = await review(approved[0], [], approved[1], false);
  assert.equal(newMissing.code, 409); assert.deepEqual(newMissing.writes, []); assert.deepEqual(newMissing.effects, []);
});

test("actual route requireRole middleware still blocks unauthenticated/cross-role retries before any handler reads", async () => {
  for (const [path, status] of reviewRoutes) {
    for (const role of [null, "partner", "commercial", "rider", "fleet"]) {
      const result = await review(path, [], status, true, { legalName: "A", pdaUnitCostCents: 30000 }, { previousStatus: status, role });
      assert.equal(result.code, role === null ? 401 : 403); assert.deepEqual(result.reads, []); assert.deepEqual(result.writes, []); assert.deepEqual(result.effects, []);
    }
    const result = await review(path, [], status, true, {}, { previousStatus: status, outsideTenant: true });
    assert.equal(result.code, 404); assert.deepEqual(result.writes, []); assert.deepEqual(result.effects, []);
  }
});
