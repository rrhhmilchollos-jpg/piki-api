import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { MalwareDetectedError, MalwareScannerUnavailableError, type scanUploadBuffer, type scanUploadBuffers } from "./fileSecurity.js";
import { buildTenantScope, isObjectIdLike } from "./tenantScope.js";

export const DRAFT_MENU_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const OWNER_DRAFT_MENU_ASSETS_PATH = "/api/v1/admin/restaurants/:id/menu/draft-assets";
type Collection = { findOne(filter: any, options?: any): Promise<any> };
export type OwnerDraftMenuAssetsDependencies = {
  requireOwner: () => RequestHandler;
  isRootOwner: (req: Request) => boolean;
  tenantScope: (req: Request) => Record<string, unknown>;
  objectId: (value: string) => unknown | null;
  restaurants: Collection;
  assets: Collection & { storeCleanImage(filter: any, document: any): Promise<any> };
  scanUploadBuffer: typeof scanUploadBuffer;
  scanUploadBuffers?: typeof scanUploadBuffers;
  publicAssetUrl: (id: string) => string;
  organizationFolder: (locality: string, restaurantId: string) => string;
  maxImageBytes: number;
  uploadRateLimit: RequestHandler;
};
class DraftAssetError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const projection = { _id: 1, tenantId: 1, onboardingStatus: 1, listingType: 1, isActive: 1, locality: 1 };
const eligibility = { onboardingStatus: "pending_review", listingType: "official_partner", isActive: false };
function rootScope(req: Request, deps: OwnerDraftMenuAssetsDependencies) {
  // requireOwner re-resolves the protected principal from credentials first;
  // this check is additionally identical to the controlled draft importer.
  if (!req.auth?.employeeId || !deps.isRootOwner(req)) throw new DraftAssetError(403, "SUPERADMIN_ONLY");
  const id = deps.objectId(String(req.params.id));
  if (!id) throw new DraftAssetError(400, "INVALID_RESTAURANT_ID");
  return { ...deps.tenantScope(req), _id: id, ...eligibility };
}
function assertDraft(restaurant: any, expectedTenant?: unknown) {
  if (!restaurant) throw new DraftAssetError(404, "RESTAURANT_NOT_FOUND_OR_NOT_DRAFT_ELIGIBLE");
  if (restaurant.onboardingStatus !== eligibility.onboardingStatus || restaurant.listingType !== eligibility.listingType || restaurant.isActive !== false || !isObjectIdLike(restaurant.tenantId)) throw new DraftAssetError(409, "RESTAURANT_DRAFT_CONTEXT_REQUIRED");
  if (expectedTenant !== undefined && String(restaurant.tenantId) !== String(expectedTenant)) throw new DraftAssetError(409, "RESTAURANT_DRAFT_CONTEXT_CHANGED");
}
function imageMime(bytes: Buffer): string | null {
  if (bytes.length >= 12 && bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}
function safeFileName(value: string) {
  const cleaned = value.normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "").slice(0, 160);
  return cleaned || "menu-image";
}
function assetResponse(asset: any, deps: OwnerDraftMenuAssetsDependencies) {
  // No defaults for scanner evidence; never export bytes or private profile data.
  if (!isObjectIdLike(asset?._id) || asset.kind !== "menu_image" || !DRAFT_MENU_IMAGE_MIME_TYPES.includes(asset.mimeType) || asset.scanStatus !== "clean" || asset.scanEngine !== "ClamAV" || !(asset.scannedAt instanceof Date) || !Number.isFinite(asset.scannedAt.getTime())) throw new DraftAssetError(503, "DRAFT_MENU_ASSET_STORAGE_UNAVAILABLE");
  return { id: String(asset._id), restaurantId: String(asset.restaurantId), tenantId: String(asset.tenantId), fileName: asset.fileName, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, sha256: asset.sha256, folderKey: asset.folderKey, locality: asset.locality, kind: asset.kind, scanStatus: asset.scanStatus, scanEngine: asset.scanEngine, scannedAt: asset.scannedAt, createdAt: asset.createdAt || null, url: deps.publicAssetUrl(String(asset._id)) };
}
function scanErrorResponse(res: Response, error: unknown) {
  if (error instanceof MalwareDetectedError) return res.status(422).json({ error: "MALWARE_DETECTED", message: "El archivo ha sido rechazado por el analizador antivirus." });
  const allowedReasons = new Set(["MALWARE_SCANNER_UNAVAILABLE", "MALWARE_SCANNER_INSUFFICIENT_MEMORY", "MALWARE_SCANNER_BUSY", "MALWARE_SCANNER_TIMEOUT", "MALWARE_SCANNER_ERROR", "MALWARE_SCANNER_INVALID_RESULT"]);
  const reason = error instanceof MalwareScannerUnavailableError && allowedReasons.has(error.message) ? error.message : "MALWARE_SCANNER_ERROR";
  // Only allowlisted diagnostics: no paths, signatures, scanner output or secrets.
  return res.status(503).json({ error: "MALWARE_SCANNER_UNAVAILABLE", reason, message: "La subida queda bloqueada hasta que ClamAV pueda completar el análisis. No se ha guardado ningún activo." });
}

export function registerOwnerDraftMenuAssetRoutes(app: Pick<Express, "post">, deps: OwnerDraftMenuAssetsDependencies) {
  const schema = z.object({
    fileName: z.string().min(1).max(180), mimeType: z.enum(DRAFT_MENU_IMAGE_MIME_TYPES),
    sizeBytes: z.number().int().positive().max(deps.maxImageBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    contentBase64: z.string().min(1).max(Math.ceil(deps.maxImageBytes / 3) * 4 + 64),
    kind: z.literal("menu_image").default("menu_image"),
  }).strict();
  const batchSchema = z.object({ images: z.array(schema).min(1).max(20) }).strict();
  app.post(OWNER_DRAFT_MENU_ASSETS_PATH, deps.requireOwner(), deps.uploadRateLimit, async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Vary", "Authorization, Cookie");
    try {
      const scope = rootScope(req, deps);
      if (Array.isArray(req.body?.images)) {
        const parsedBatch = batchSchema.safeParse(req.body);
        if (!parsedBatch.success) return res.status(400).json({ error: "INVALID_MENU_ASSET_BATCH", maxImages: 20, maxImageBytes: deps.maxImageBytes, details: parsedBatch.error.flatten() });
        const decoded = parsedBatch.data.images.map((input) => {
          const dataUrl = /^data:([^;]+);base64,/i.exec(input.contentBase64);
          if (dataUrl && dataUrl[1].toLowerCase() !== input.mimeType) throw new DraftAssetError(400, "MENU_ASSET_CONTENT_TYPE_MISMATCH");
          const raw = dataUrl ? input.contentBase64.slice(dataUrl[0].length) : input.contentBase64;
          if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) throw new DraftAssetError(400, "MENU_ASSET_BASE64_INVALID");
          const bytes = Buffer.from(raw, "base64");
          if (bytes.toString("base64").replace(/=+$/, "") !== raw.replace(/=+$/, "")) throw new DraftAssetError(400, "MENU_ASSET_BASE64_INVALID");
          if (bytes.length !== input.sizeBytes || bytes.length > deps.maxImageBytes) throw new DraftAssetError(413, "MENU_IMAGE_TOO_LARGE");
          if (imageMime(bytes) !== input.mimeType) throw new DraftAssetError(400, "MENU_ASSET_CONTENT_TYPE_MISMATCH");
          const digest = createHash("sha256").update(bytes).digest("hex");
          if (digest !== input.sha256.toLowerCase()) throw new DraftAssetError(400, "MENU_ASSET_CHECKSUM_MISMATCH");
          return { input, bytes, digest };
        });
        const snapshot = await deps.restaurants.findOne(scope, { projection });
        assertDraft(snapshot);
        let scannedAt: Date;
        try {
          if (!deps.scanUploadBuffers) throw new MalwareScannerUnavailableError("MALWARE_SCANNER_UNAVAILABLE");
          const result = await deps.scanUploadBuffers(decoded.map(({ bytes, input }) => ({ buffer: bytes, originalName: safeFileName(input.fileName) })));
          if (!result || result.status !== "clean" || result.engine !== "ClamAV" || result.signature !== null) throw new MalwareScannerUnavailableError("MALWARE_SCANNER_INVALID_RESULT");
          scannedAt = new Date();
        } catch (error) { return scanErrorResponse(res, error); }
        const assets = [];
        for (const { input, bytes, digest } of decoded) {
          const assetScope = { restaurantId: snapshot._id, ...buildTenantScope(snapshot.tenantId), kind: "menu_image", sha256: digest, mimeType: input.mimeType, sizeBytes: bytes.length };
          const existing = await deps.assets.findOne({ ...assetScope, scanStatus: "clean", scanEngine: "ClamAV", scannedAt: { $type: "date" } }, { projection: { contentBase64: 0 } });
          // Every object keeps the same server-resolved tenant and restaurant;
          // readiness is re-read before each write, not trusted from the batch.
          const current = await deps.restaurants.findOne({ ...scope, ...buildTenantScope(snapshot.tenantId) }, { projection });
          assertDraft(current, snapshot.tenantId);
          if (String(current._id) !== String(snapshot._id)) throw new DraftAssetError(409, "RESTAURANT_DRAFT_CONTEXT_CHANGED");
          if (existing) { assets.push({ deduplicated: true, asset: assetResponse(existing, deps) }); continue; }
          const id = deps.objectId(createHash("sha256").update(`owner-draft-menu-image-v1\0${String(current.tenantId)}\0${String(current._id)}\0${digest}`).digest("hex").slice(0, 24));
          if (!id) throw new DraftAssetError(503, "DRAFT_MENU_ASSET_STORAGE_UNAVAILABLE");
          const locality = current.locality || "Sin localidad";
          const stored = await deps.assets.storeCleanImage({ _id: id, ...assetScope, scanStatus: "clean", scanEngine: "ClamAV", scannedAt: { $type: "date" } }, {
            _id: id, ...assetScope, organizationKey: String(current._id), folderKey: deps.organizationFolder(locality, String(current._id)), locality,
            fileName: safeFileName(input.fileName), contentBase64: bytes.toString("base64"), scanStatus: "clean", scanEngine: "ClamAV", scannedAt, createdAt: scannedAt, updatedAt: scannedAt,
          });
          assets.push({ deduplicated: false, asset: assetResponse(stored, deps) });
        }
        return res.status(201).json({ draftOnly: true, batch: true, count: assets.length, assets });
      }
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: "INVALID_MENU_ASSET", maxImageBytes: deps.maxImageBytes, allowedTypes: DRAFT_MENU_IMAGE_MIME_TYPES, details: parsed.error.flatten() });
      const input = parsed.data;
      const dataUrl = /^data:([^;]+);base64,/i.exec(input.contentBase64);
      if (dataUrl && dataUrl[1].toLowerCase() !== input.mimeType) throw new DraftAssetError(400, "MENU_ASSET_CONTENT_TYPE_MISMATCH");
      const rawBase64 = dataUrl ? input.contentBase64.slice(dataUrl[0].length) : input.contentBase64;
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(rawBase64) || rawBase64.length % 4 === 1) throw new DraftAssetError(400, "MENU_ASSET_BASE64_INVALID");
      const bytes = Buffer.from(rawBase64, "base64");
      if (bytes.toString("base64").replace(/=+$/, "") !== rawBase64.replace(/=+$/, "")) throw new DraftAssetError(400, "MENU_ASSET_BASE64_INVALID");
      if (bytes.length !== input.sizeBytes || bytes.length > deps.maxImageBytes) return res.status(413).json({ error: "MENU_IMAGE_TOO_LARGE", maxBytes: deps.maxImageBytes });
      if (imageMime(bytes) !== input.mimeType) throw new DraftAssetError(400, "MENU_ASSET_CONTENT_TYPE_MISMATCH");
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== input.sha256.toLowerCase()) throw new DraftAssetError(400, "MENU_ASSET_CHECKSUM_MISMATCH");
      const snapshot = await deps.restaurants.findOne(scope, { projection });
      assertDraft(snapshot);
      let scannedAt: Date;
      try {
        // Production is wired directly to fileSecurity.scanUploadBuffer. Its
        // existing memory preflight, timeout and bounded queue remain intact.
        const scan = await deps.scanUploadBuffer(bytes, safeFileName(input.fileName));
        if (!scan || scan.status !== "clean" || scan.engine !== "ClamAV" || scan.signature !== null) throw new MalwareScannerUnavailableError("MALWARE_SCANNER_INVALID_RESULT");
        scannedAt = new Date();
      } catch (error) { return scanErrorResponse(res, error); }
      const assetScope = { restaurantId: snapshot._id, ...buildTenantScope(snapshot.tenantId), kind: "menu_image", sha256: digest, mimeType: input.mimeType, sizeBytes: bytes.length };
      const existing = await deps.assets.findOne({ ...assetScope, scanStatus: "clean", scanEngine: "ClamAV", scannedAt: { $type: "date" } }, { projection: { contentBase64: 0 } });
      // Revalidate using the *server-read* tenant after scan/queue and dedupe,
      // immediately before storage. Never mutate the restaurant or its tenant.
      const current = await deps.restaurants.findOne({ ...scope, ...buildTenantScope(snapshot.tenantId) }, { projection });
      assertDraft(current, snapshot.tenantId);
      if (String(current._id) !== String(snapshot._id)) throw new DraftAssetError(409, "RESTAURANT_DRAFT_CONTEXT_CHANGED");
      if (existing) return res.status(200).json({ draftOnly: true, deduplicated: true, asset: assetResponse(existing, deps) });
      const locality = current.locality || "Sin localidad";
      // Deterministic, tenant+restaurant+checksum-scoped ObjectId plus atomic
      // $setOnInsert makes concurrent/retried uploads idempotent across replicas
      // without new indexes, migrations or deleting/updating foreign assets.
      const id = deps.objectId(createHash("sha256").update(`owner-draft-menu-image-v1\0${String(current.tenantId)}\0${String(current._id)}\0${digest}`).digest("hex").slice(0, 24));
      if (!id) throw new DraftAssetError(503, "DRAFT_MENU_ASSET_STORAGE_UNAVAILABLE");
      const asset = await deps.assets.storeCleanImage({ _id: id, ...assetScope, scanStatus: "clean", scanEngine: "ClamAV", scannedAt: { $type: "date" } }, {
        _id: id, ...assetScope, organizationKey: String(current._id), folderKey: deps.organizationFolder(locality, String(current._id)), locality,
        fileName: safeFileName(input.fileName), contentBase64: bytes.toString("base64"), scanStatus: "clean", scanEngine: "ClamAV", scannedAt,
        createdAt: scannedAt, updatedAt: scannedAt,
      });
      return res.status(201).json({ draftOnly: true, deduplicated: false, asset: assetResponse(asset, deps) });
    } catch (error) {
      if (error instanceof DraftAssetError) return res.status(error.status).json({ error: error.code });
      return res.status(503).json({ error: "DRAFT_MENU_ASSET_STORAGE_UNAVAILABLE" });
    }
  });
}
