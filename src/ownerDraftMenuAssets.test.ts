import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { RequestHandler } from "express";
import ts from "typescript";
import { createScannerQueue, MIN_SCANNER_MEMORY_BYTES, scannerMemorySufficient, MalwareDetectedError, MalwareScannerUnavailableError } from "./fileSecurity.js";
import { OWNER_DRAFT_MENU_ASSETS_PATH, registerOwnerDraftMenuAssetRoutes, type OwnerDraftMenuAssetsDependencies } from "./ownerDraftMenuAssets.js";

// No server import, dotenv, HTTP listener, database, credentials or real uploads.
const serverSource = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const authSource = readFileSync(new URL("./auth.ts", import.meta.url), "utf8");
function functionCode(source: string, name: string) {
  const ast = ts.createSourceFile("subject.ts", source, ts.ScriptTarget.Latest, true);
  const node = ast.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert(node, `Missing actual guard ${name}`);
  return node.getText(ast).replace(/^export /, "");
}
function compile<T>(code: string, context: Record<string, unknown>): T {
  const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return new Function(...Object.keys(context), js)(...Object.values(context)) as T;
}
const ownerGuardCode = functionCode(authSource, "requireOwner");
const rootGuardCode = functionCode(serverSource, "hasExplicitPlatformSuperadminScope");
const restaurantId = "64b000000000000000000101";
const tenantId = "64b000000000000000000102";
const otherTenantId = "64b000000000000000000103";
const ownerId = "64b000000000000000000104";
const owner = { role: "admin", employeeId: ownerId, isRootOwner: true };
const maxImageBytes = 200 * 1024;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, ...Array(12).fill(0x11)]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x11]);
const webp = Buffer.from("RIFF\x10\x00\x00\x00WEBPVP8 ", "binary");
function input(bytes: Buffer = jpeg, mimeType = "image/jpeg", extra: Record<string, unknown> = {}) {
  return { fileName: "cropped-food.jpg", mimeType, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), contentBase64: bytes.toString("base64"), ...extra };
}
function matches(record: any, filter: any) {
  return Object.entries(filter).every(([key, value]: [string, any]) => {
    if (value && typeof value === "object" && value.$type === "date") return record[key] instanceof Date;
    return record[key] === value;
  });
}
function fixture(options: {
  stored?: Record<string, unknown>; principal?: any; protectedOwner?: boolean; scope?: Record<string, unknown>;
  scanError?: unknown; scanResult?: any; afterScan?: Record<string, unknown>; afterDedupe?: Record<string, unknown>;
  assets?: any[]; storageError?: unknown; blockedRate?: boolean; contextUnavailable?: boolean;
} = {}) {
  const stored: any = { _id: restaurantId, tenantId, name: "Offline only", locality: "Xàtiva", onboardingStatus: "pending_review", listingType: "official_partner", isActive: false, priceIncludesCommission: false, menuRevision: 11, menu: [{ id: "historic", allergens: null, available: false }], partnerProfile: { untouchedLegal: true }, availabilityStatus: "unavailable", ...options.stored };
  const records = [...(options.assets ?? [])];
  const calls: any = { guards: [], reads: [], scans: [], dedupe: [], writes: [], rates: 0, order: [] };
  let route: { path: string; handlers: RequestHandler[] };
  let presentedPrincipal: any = options.principal === undefined ? owner : options.principal;
  const actualRequireOwner = compile<() => RequestHandler>(`${ownerGuardCode}\nreturn requireOwner;`, {
    resolveRole: async () => presentedPrincipal,
    PIKI_OWNER_EMAIL: "rrhh.milchollos@gmail.com",
    EmployeeAccount: { findOne: (filter: any) => {
      calls.guards.push(filter);
      return { select() { return this; }, lean() { return this; }, exec: async () => options.protectedOwner === false ? null : { _id: ownerId } };
    } },
  });
  const actualRoot = compile<(req: any) => boolean>(`${rootGuardCode}\nreturn hasExplicitPlatformSuperadminScope;`, {});
  const deps: OwnerDraftMenuAssetsDependencies = {
    requireOwner: actualRequireOwner, isRootOwner: actualRoot,
    tenantScope: () => options.scope ?? {}, objectId: (id) => /^[a-f0-9]{24}$/.test(id) ? id : null,
    restaurants: { findOne: async (filter, opts) => {
      calls.order.push("restaurant"); calls.reads.push({ filter, opts });
      if (options.contextUnavailable) throw new Error("Secret database URI not disclosed");
      return matches(stored, filter) ? structuredClone(Object.fromEntries(Object.keys(opts.projection).filter((key) => Object.hasOwn(stored, key)).map((key) => [key, stored[key]]))) : null;
    } },
    assets: {
      findOne: async (filter) => {
        calls.order.push("dedupe"); calls.dedupe.push(filter);
        const result = records.find((record) => matches(record, filter)) ?? null;
        if (options.afterDedupe) Object.assign(stored, options.afterDedupe);
        return result;
      },
      storeCleanImage: async (filter, document) => {
        calls.order.push("store"); calls.writes.push({ filter, document });
        if (options.storageError) throw options.storageError;
        const existing = records.find((record) => matches(record, filter));
        if (existing) return existing;
        const created = structuredClone(document); records.push(created); return created;
      },
    },
    scanUploadBuffer: async (bytes, name) => {
      calls.order.push("scan"); calls.scans.push({ bytes, name });
      if (options.scanError) throw options.scanError;
      if (options.afterScan) Object.assign(stored, options.afterScan);
      return options.scanResult ?? { status: "clean", engine: "ClamAV", signature: null };
    },
    scanUploadBuffers: async (files) => {
      calls.order.push("scan-batch"); calls.scans.push({ batch: files });
      if (options.scanError) throw options.scanError;
      if (options.afterScan) Object.assign(stored, options.afterScan);
      return options.scanResult ?? { status: "clean", engine: "ClamAV", signature: null };
    },
    publicAssetUrl: (id) => `https://api.pikidelivery.com/api/v1/catalog/assets/${id}`,
    organizationFolder: (_locality, id) => `partners/xativa/${id}/menu`, maxImageBytes,
    uploadRateLimit: (_req, res, next) => { calls.rates++; if (options.blockedRate) return void res.status(429).json({ error: "RATE_LIMITED" }); next(); },
  };
  const app: any = { post: (path: string, ...handlers: RequestHandler[]) => { route = { path, handlers }; } };
  registerOwnerDraftMenuAssetRoutes(app, deps);
  async function invoke(body: any = input(), principal = presentedPrincipal, id = restaurantId) {
    presentedPrincipal = principal;
    const state: any = { status: 200, headers: {} };
    const res: any = { setHeader: (key: string, value: string) => { state.headers[key] = value; }, status: (code: number) => { state.status = code; return res; }, json: (value: unknown) => { state.body = value; return res; } };
    // Spoofed req.auth is overwritten by the real Owner guard, as in runtime.
    const req: any = { body, params: { id }, auth: owner };
    assert.equal(route.path, OWNER_DRAFT_MENU_ASSETS_PATH);
    for (const handler of route.handlers) {
      let proceed = false;
      await handler(req, res, () => { proceed = true; });
      if (!proceed) break;
    }
    return state;
  }
  return { stored, records, calls, invoke };
}
function assertNoStorage(f: ReturnType<typeof fixture>) { assert.equal(f.calls.writes.length, 0); }

for (const [mime, bytes] of [["image/jpeg", jpeg], ["image/png", png], ["image/webp", webp]] as const) {
  test(`Owner ROOT stores validated ${mime} only after scan and final context check`, async () => {
    const f = fixture(); const before = structuredClone(f.stored);
    const r = await f.invoke(input(bytes, mime, { kind: "menu_image", fileName: "../food\u0000/photo.jpg", sha256: input(bytes).sha256.toUpperCase() }));
    assert.equal(r.status, 201); assert.equal(r.body.draftOnly, true);
    assert.equal(r.headers["Cache-Control"], "no-store"); assert.equal(r.headers.Vary, "Authorization, Cookie");
    assert.deepEqual(f.calls.order, ["restaurant", "scan", "dedupe", "restaurant", "store"]);
    assert.equal(f.calls.guards[0].email, "rrhh.milchollos@gmail.com");
    assert.deepEqual(f.calls.guards[0], { _id: ownerId, email: "rrhh.milchollos@gmail.com", active: true, authorizationStatus: "approved", accessLevel: "superadmin" });
    assert.equal(f.calls.reads[1].filter.tenantId, tenantId);
    const asset = f.records[0];
    assert.equal(asset.restaurantId, restaurantId); assert.equal(asset.tenantId, tenantId);
    assert.equal(asset.mimeType, mime); assert.equal(asset.kind, "menu_image");
    assert.equal(asset.scanStatus, "clean"); assert.equal(asset.scanEngine, "ClamAV"); assert(asset.scannedAt instanceof Date);
    assert.equal(asset.contentBase64, bytes.toString("base64")); assert.equal(asset.sha256, input(bytes).sha256);
    assert.equal(asset.fileName, f.calls.scans[0].name); assert(!asset.fileName.includes("/")); assert(!asset.fileName.includes("\u0000"));
    assert.equal(r.body.asset.url, `https://api.pikidelivery.com/api/v1/catalog/assets/${asset._id}`);
    assert.equal(r.body.asset.contentBase64, undefined); assert.equal(r.body.asset.partnerProfile, undefined);
    assert.deepEqual(f.stored, before); // No activation, profile, menu, SKU, allergen or availability mutations.
  });
}
for (const [name, options, status] of [
  ["unauthenticated", { principal: null }, 401], ["environment admin token without employee", { principal: { role: "admin", isRootOwner: true } }, 403],
  ["ordinary admin", { principal: { role: "admin", employeeId: ownerId, accessLevel: "superadmin" }, protectedOwner: false }, 403],
  ["protected Owner without explicit ROOT", { principal: { role: "admin", employeeId: ownerId } }, 403],
  ["partner", { principal: { role: "partner", employeeId: ownerId, isRootOwner: true } }, 403],
  ["temporary password", { principal: { ...owner, mustChangePassword: true } }, 428],
  ["rate limited", { blockedRate: true }, 429],
] as const) {
  test(`rejects ${name} without scan or storage even with spoofed request auth`, async () => {
    const f = fixture(options); const r = await f.invoke(); assert.equal(r.status, status); assert.equal(f.calls.scans.length, 0); assertNoStorage(f);
  });
}
test("strict body cannot select tenant, role, scanner flags, legal/financial docs or archives", async () => {
  for (const extra of [{ tenantId: otherTenantId }, { isRootOwner: true }, { scanStatus: "clean" }, { scannerDisabled: true }, { kind: "document" }, { kind: "menu_file" }, { kind: "restaurant_image" }, { legalDocuments: [] }, { financial: true }]) {
    const f = fixture(); const r = await f.invoke(input(jpeg, "image/jpeg", extra)); assert.equal(r.status, 400); assert.equal(f.calls.scans.length, 0); assertNoStorage(f);
  }
  for (const [mime, bytes] of [["application/zip", Buffer.from("PK\x03\x04archive")], ["application/pdf", Buffer.from("%PDF-1.7")], ["image/gif", Buffer.from("GIF89a")], ["image/jpeg", Buffer.from("PK\x03\x04archive")]]) {
    const f = fixture(); const r = await f.invoke(input(bytes as Buffer, mime as string)); assert.equal(r.status, 400); assertNoStorage(f); assert.equal(f.calls.scans.length, 0);
  }
});
test("MIME, magic, exact size, base64 and checksum checks precede scanner", async () => {
  for (const [extra, error] of [[{ mimeType: "image/png" }, "MENU_ASSET_CONTENT_TYPE_MISMATCH"], [{ sha256: "a".repeat(64) }, "MENU_ASSET_CHECKSUM_MISMATCH"], [{ contentBase64: "%%%%" }, "MENU_ASSET_BASE64_INVALID"], [{ contentBase64: "A" }, "MENU_ASSET_BASE64_INVALID"], [{ contentBase64: "AB==" }, "MENU_ASSET_BASE64_INVALID"], [{ sizeBytes: 1 }, "MENU_IMAGE_TOO_LARGE"], [{ contentBase64: `data:image/png;base64,${jpeg.toString("base64")}` }, "MENU_ASSET_CONTENT_TYPE_MISMATCH"]] as const) {
    const f = fixture(); const r = await f.invoke(input(jpeg, "image/jpeg", extra)); assert.equal(r.body.error, error); assert.equal(f.calls.scans.length, 0); assertNoStorage(f);
  }
});
test("200 KiB boundary and same-MIME data URLs; larger uploads rejected", async () => {
  const bytes = Buffer.concat([jpeg, Buffer.alloc(maxImageBytes - jpeg.length)]);
  const f = fixture(); const body = input(bytes); body.contentBase64 = `data:image/jpeg;base64,${body.contentBase64}`;
  assert.equal((await f.invoke(body)).status, 201);
  const tooBig = fixture(); assert.equal((await tooBig.invoke(input(Buffer.concat([bytes, Buffer.alloc(1)])))).status, 400); assert.equal(tooBig.calls.scans.length, 0); assertNoStorage(tooBig);
});
for (const changed of [{ isActive: true }, { onboardingStatus: "approved" }, { onboardingStatus: "rejected" }, { listingType: "directory_listing" }, { tenantId: null }, { tenantId: "invalid" }]) {
  test(`ineligible initial draft ${JSON.stringify(changed)} is fail-closed`, async () => {
    const f = fixture({ stored: changed }); const r = await f.invoke(); assert([404, 409].includes(r.status)); assert.equal(f.calls.scans.length, 0); assertNoStorage(f);
  });
}
test("invalid restaurant id and foreign request tenant scope remain denied", async () => {
  const f = fixture(); assert.equal((await f.invoke(input(), owner, "invalid")).status, 400); assertNoStorage(f);
  const foreign = fixture({ scope: { tenantId: otherTenantId } }); assert.equal((await foreign.invoke()).status, 404); assert.equal(foreign.calls.scans.length, 0); assertNoStorage(foreign);
});
for (const changed of [{ tenantId: otherTenantId }, { tenantId: null }, { isActive: true }, { onboardingStatus: "approved" }, { listingType: "directory_listing" }, { _id: "64b000000000000000000199" }]) {
  test(`context changed while scan/dedupe waits ${JSON.stringify(changed)} never stores`, async () => {
    for (const moment of ["afterScan", "afterDedupe"] as const) {
      const f = fixture({ [moment]: changed }); const r = await f.invoke(); assert([404, 409].includes(r.status)); assert.equal(f.calls.scans.length, 1); assertNoStorage(f);
    }
  });
}
for (const reason of ["MALWARE_SCANNER_UNAVAILABLE", "MALWARE_SCANNER_INSUFFICIENT_MEMORY", "MALWARE_SCANNER_BUSY", "MALWARE_SCANNER_TIMEOUT", "MALWARE_SCANNER_ERROR"]) {
  test(`scanner ${reason} safely diagnoses and never stores`, async () => {
    const f = fixture({ scanError: new MalwareScannerUnavailableError(reason) }); const r = await f.invoke(); assert.equal(r.status, 503); assert.equal(r.body.error, "MALWARE_SCANNER_UNAVAILABLE"); assert.equal(r.body.reason, reason); assertNoStorage(f); assert.equal(f.records.length, 0);
  });
}
test("malware, unexpected scanner errors and false scanner evidence never store", async () => {
  const infected = fixture({ scanError: new MalwareDetectedError() }); assert.equal((await infected.invoke()).status, 422); assertNoStorage(infected);
  for (const scanError of [new Error("secret token /private/path"), new MalwareScannerUnavailableError("SECRET_PATH /keys")]) {
    const f = fixture({ scanError }); const r = await f.invoke(); assert.equal(r.status, 503); assert.equal(r.body.reason, "MALWARE_SCANNER_ERROR"); assert(!JSON.stringify(r.body).includes("secret")); assert(!JSON.stringify(r.body).includes("/keys")); assertNoStorage(f);
  }
  for (const scanResult of [{ status: "rejected", engine: "ClamAV", signature: null }, { status: "clean", engine: "Fake", signature: null }, { status: "clean", engine: "ClamAV", signature: "infection" }, {}]) {
    const f = fixture({ scanResult }); const r = await f.invoke(); assert.equal(r.status, 503); assert.equal(r.body.reason, "MALWARE_SCANNER_INVALID_RESULT"); assertNoStorage(f);
  }
});
test("repeat checksum per restaurant reuses owned clean evidence and canonical URL without updates", async () => {
  const f = fixture(); const first = await f.invoke(); const original = structuredClone(f.records[0]);
  const second = await f.invoke(input(jpeg, "image/jpeg", { fileName: "renamed.jpg" }));
  assert.equal(second.status, 200); assert.equal(second.body.deduplicated, true); assert.equal(second.body.asset.url, first.body.asset.url);
  assert.equal(f.records.length, 1); assert.equal(f.calls.writes.length, 1); assert.equal(f.calls.scans.length, 2); assert.deepEqual(f.records[0], original);
});
test("simultaneous identical checksums have deterministic scoped id and atomic insert contract", async () => {
  const f = fixture(); const [a, b] = await Promise.all([f.invoke(), f.invoke()]);
  assert.equal(a.body.asset.url, b.body.asset.url); assert.equal(f.records.length, 1);
  for (const { filter, document } of f.calls.writes) {
    assert.equal(filter._id, document._id); assert.equal(filter.tenantId, tenantId); assert.equal(filter.restaurantId, restaurantId);
    assert.equal(filter.kind, "menu_image"); assert.equal(filter.sha256, input().sha256); assert.equal(filter.scanEngine, "ClamAV"); assert.equal(filter.scanStatus, "clean"); assert.deepEqual(filter.scannedAt, { $type: "date" });
  }
});
test("foreign, rejected, unscanned, non-ClamAV and wrong-kind assets never deduplicate or get deleted", async () => {
  const seed = fixture(); await seed.invoke(); const valid = seed.records[0];
  for (const changed of [{ tenantId: otherTenantId }, { restaurantId: "64b000000000000000000199" }, { kind: "document" }, { scanStatus: "rejected" }, { scannedAt: null }, { scanEngine: "Fake" }]) {
    const original = { ...valid, _id: "64b000000000000000000198", ...changed }; const before = structuredClone(original);
    const f = fixture({ assets: [original] }); const r = await f.invoke(); assert.equal(r.status, 201); assert.equal(r.body.deduplicated, false); assert.equal(f.records.length, 2); assert.deepEqual(f.records[0], before);
  }
  const other = fixture({ stored: { tenantId: otherTenantId } }); const r = await other.invoke(); assert.notEqual(r.body.asset.id, valid._id);
});
test("safe storage and context diagnostics do not disclose driver messages", async () => {
  for (const opts of [{ contextUnavailable: true }, { storageError: new Error("mongodb://secret@production/private") }]) {
    const f = fixture(opts); const r = await f.invoke(); assert.equal(r.status, 503); assert.deepEqual(r.body, { error: "DRAFT_MENU_ASSET_STORAGE_UNAVAILABLE" }); assert.equal(f.records.length, 0);
  }
});
test("minimal runtime registration uses real guards/scanner, original max, rate limiter and atomic insert only", () => {
  const ast = ts.createSourceFile("server.ts", serverSource, ts.ScriptTarget.Latest, true);
  const registrations = ast.statements.filter((node) => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === "registerOwnerDraftMenuAssetRoutes");
  assert.equal(registrations.length, 1); const code = registrations[0].getText(ast);
  assert(code.includes("requireOwner,")); assert(code.includes("isRootOwner: hasExplicitPlatformSuperadminScope")); assert(code.includes("scanUploadBuffer,"));
  assert(code.includes("restaurants: Restaurant.collection")); assert(code.includes("maxImageBytes: MAX_MENU_IMAGE_BYTES")); assert(code.includes('rateLimit(20, 60_000, "owner-draft-menu-assets")'));
  assert(code.includes("{ $setOnInsert: document }")); assert(code.includes("upsert: true")); assert(code.includes("runValidators: true")); assert(code.includes("timestamps: false"));
  for (const forbidden of ["PartnerLocalityGroup", "publishCatalogUpdate", "invalidateCatalogCache", "deleteOne", "scanDisabled", "process.env", "Restaurant.update"]) assert(!code.includes(forbidden));
});

test("existing scanner memory preflight requires 3 GiB and never treats smaller limits as sufficient", () => {
  assert.equal(MIN_SCANNER_MEMORY_BYTES, 3 * 1024 ** 3);
  assert.equal(scannerMemorySufficient(MIN_SCANNER_MEMORY_BYTES - 1), false);
  assert.equal(scannerMemorySufficient(MIN_SCANNER_MEMORY_BYTES), true);
  assert.equal(scannerMemorySufficient(null), true);
});
test("existing scanner queue holds at most four jobs, rejects fifth and serializes work", async () => {
  const queued = createScannerQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const executed: number[] = [];
  const work = [0, 1, 2, 3].map((n) => queued(async () => { executed.push(n); if (n === 0) await gate; return n; }));
  await assert.rejects(queued(async () => 5), (error: unknown) => error instanceof MalwareScannerUnavailableError && error.message === "MALWARE_SCANNER_BUSY");
  assert.deepEqual(executed, [0]);
  release(); assert.deepEqual(await Promise.all(work), [0, 1, 2, 3]); assert.deepEqual(executed, [0, 1, 2, 3]);
  await assert.rejects(queued(async () => { throw new Error("offline failure"); }));
  assert.equal(await queued(async () => "queue recovered"), "queue recovered");
});

// Bounded batches reuse the real fileSecurity queue/directory scanner in production.
test("Owner batch validates all images and scans the complete batch once before storing", async () => {
  const f = fixture(); const before = structuredClone(f.stored);
  const second = Buffer.concat([jpeg, Buffer.from([0x22])]);
  const r = await f.invoke({ images: [input(), input(second)] });
  assert.equal(r.status, 201); assert.equal(r.body.batch, true); assert.equal(r.body.count, 2);
  assert.equal(f.calls.scans.length, 1); assert.equal(f.calls.scans[0].batch.length, 2);
  assert.deepEqual(f.calls.scans[0].batch.map((x: any) => x.buffer), [jpeg, second]);
  assert.equal(f.records.length, 2); assert.deepEqual(f.stored, before);
  for (const x of r.body.assets) { assert.equal(x.asset.scanEngine, "ClamAV"); assert.equal(x.asset.scanStatus, "clean"); assert.equal(x.asset.tenantId, tenantId); assert.equal(x.asset.restaurantId, restaurantId); assert(!Object.hasOwn(x.asset, "contentBase64")); }
});
for (const images of [[], Array.from({ length: 21 }, () => input())]) {
  test(`Owner rejects batch count ${images.length} before scanner or storage`, async () => {
    const f = fixture(); const r = await f.invoke({ images });
    assert.equal(r.status, 400); assert.equal(f.calls.scans.length, 0); assertNoStorage(f);
  });
}
test("Owner batch rejects one bad checksum before scanning any image", async () => {
  const f = fixture(); const r = await f.invoke({ images: [input(), input(jpeg, "image/jpeg", { sha256: "0".repeat(64) })] });
  assert.equal(r.status, 400); assert.equal(r.body.error, "MENU_ASSET_CHECKSUM_MISMATCH"); assert.equal(f.calls.scans.length, 0); assertNoStorage(f);
});
test("Owner batch rejects content MIME mismatch before scanning any image", async () => {
  const f = fixture(); const r = await f.invoke({ images: [input(), input(png, "image/jpeg")] });
  assert.equal(r.status, 400); assert.equal(r.body.error, "MENU_ASSET_CONTENT_TYPE_MISMATCH"); assert.equal(f.calls.scans.length, 0); assertNoStorage(f);
});
for (const error of [new MalwareDetectedError(), new MalwareScannerUnavailableError("MALWARE_SCANNER_BUSY"), new MalwareScannerUnavailableError("MALWARE_SCANNER_INSUFFICIENT_MEMORY")]) {
  test(`Owner batch fail-closes on ${error.message} without storing any asset`, async () => {
    const f = fixture({ scanError: error }); const r = await f.invoke({ images: [input(), input()] });
    assert([422, 503].includes(r.status)); assertNoStorage(f);
  });
}
for (const scanResult of [{ status: "clean", engine: "mock", signature: null }, { status: "clean", engine: "ClamAV", signature: "not-null" }]) {
  test(`Owner batch refuses artificial scanner result ${scanResult.engine}/${scanResult.signature}`, async () => {
    const f = fixture({ scanResult }); const r = await f.invoke({ images: [input()] }); assert.equal(r.status, 503); assertNoStorage(f);
  });
}
for (const afterScan of [{ isActive: true }, { onboardingStatus: "approved" }, { tenantId: otherTenantId }]) {
  test(`Owner batch revalidates draft and tenant after queue/scan ${JSON.stringify(afterScan)}`, async () => {
    const f = fixture({ afterScan }); const r = await f.invoke({ images: [input(), input()] }); assert([404, 409].includes(r.status)); assertNoStorage(f);
  });
}
test("Owner batch retries are scoped and idempotent, with no restaurant mutation", async () => {
  const f = fixture(); const before = structuredClone(f.stored);
  const body = { images: [input(), input(Buffer.concat([jpeg, Buffer.from([0x33])]))] };
  const one = await f.invoke(body), two = await f.invoke(body);
  assert.equal(one.status, 201); assert.equal(two.status, 201); assert.equal(f.records.length, 2);
  assert(two.body.assets.every((x: any) => x.deduplicated));
  assert.deepEqual(two.body.assets.map((x: any) => x.asset.id), one.body.assets.map((x: any) => x.asset.id));
  assert.deepEqual(f.stored, before);
});
test("Batch remains protected by actual Owner guard and the upload limiter", async () => {
  const f = fixture({ principal: { role: "partner", employeeId: ownerId, isRootOwner: true } });
  assert.equal((await f.invoke({ images: [input()] })).status, 403); assertNoStorage(f); assert.equal(f.calls.scans.length, 0);
  const limited = fixture({ blockedRate: true }); assert.equal((await limited.invoke({ images: [input()] })).status, 429); assertNoStorage(limited);
});
