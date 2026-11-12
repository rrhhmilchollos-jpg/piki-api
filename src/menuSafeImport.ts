import { createHash } from "node:crypto";
import type { Express, Request, RequestHandler, Response } from "express";
import { z } from "zod";
import { normalizePartnerMenuItems, partnerMenuItemSchema, type PartnerMenuItem } from "./menuContract.js";
import { modifierGroupsForItem } from "./menuModifiers.js";
import { buildTenantScope, isObjectIdLike } from "./tenantScope.js";

export const controlledMenuImportSchema = z.object({
  dryRun: z.boolean().default(true),
  // Prices here are storage/source prices, never the marked-up public GET.
  priceBasis: z.literal("source"),
  items: z.array(partnerMenuItemSchema.strict()).min(1).max(500),
  legacyPolicy: z.enum(["retain_unchanged", "retain_ids_mark_unavailable"]),
  expectedMenuHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  expectedUpdatedAt: z.iso.datetime().optional(),
}).strict().superRefine((body, ctx) => {
  if (!body.dryRun) {
    if (!body.expectedMenuHash) ctx.addIssue({ code: "custom", path: ["expectedMenuHash"], message: "Obligatorio para aplicar" });
    if (!body.expectedUpdatedAt) ctx.addIssue({ code: "custom", path: ["expectedUpdatedAt"], message: "Obligatorio para aplicar" });
  }
  const ids = new Set<string>();
  body.items.forEach((item, index) => {
    if (!item.id.trim() || item.id !== item.id.trim() || ids.has(item.id)) ctx.addIssue({ code: "custom", path: ["items", index, "id"], message: "ID estable, no vacío y único requerido" });
    ids.add(item.id);
    const centPrices = [item.price, ...item.modifiers.flatMap((g) => [g.price, ...[...g.options, ...g.optionItems].flatMap((o) => typeof o === "string" ? [] : [o.price])])];
    if (centPrices.some((p) => Math.abs(p * 100 - Math.round(p * 100)) > 1e-8)) ctx.addIssue({ code: "custom", path: ["items", index, "price"], message: "Los precios fuente deben representar céntimos EUR exactos" });
    const groupIds = new Set<string>();
    for (const [groupIndex, group] of item.modifiers.entries()) {
      const path = ["items", index, "modifiers", groupIndex];
      if (groupIds.has(group.id)) ctx.addIssue({ code: "custom", path, message: "Grupo repetido" });
      groupIds.add(group.id);
      const options = group.optionItems.length ? group.optionItems : group.options;
      const optionIds = options.map((o) => typeof o === "string" ? o : o.id);
      const available = options.filter((o) => typeof o === "string" || o.available).length;
      if (new Set(optionIds).size !== optionIds.length || !available || group.minSelections > group.maxSelections || group.maxSelections > available || (group.required && group.minSelections < 1)) ctx.addIssue({ code: "custom", path, message: "Opciones o límites inconsistentes; no se corrigen silenciosamente" });
    }
    // Reuse checkout's actual normalization to catch collisions/lost groups.
    const normalized = normalizePartnerMenuItems([item])[0];
    const quotedGroups = modifierGroupsForItem(normalized);
    if (quotedGroups.length !== normalized.modifiers.length || new Set(quotedGroups.map((g) => g.id)).size !== quotedGroups.length || quotedGroups.some((g, gi) => g.id !== normalized.modifiers[gi].id || new Set(g.options.map((o) => o.id)).size !== g.options.length || g.options.some((o, oi) => o.id !== (normalized.modifiers[gi].options[oi] as { id: string }).id))) ctx.addIssue({ code: "custom", path: ["items", index, "modifiers"], message: "IDs de opciones deben ser estables y compatibles con checkout" });
  });
});

export type ControlledMenuImport = z.infer<typeof controlledMenuImportSchema>;
export class MenuImportError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

/** SHA256 of UTF-8 JSON: sorted object keys recursively, array order unchanged. */
export function rawMenuHash(menu: unknown[]): string {
  const json = JSON.stringify(menu, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
    : value);
  return createHash("sha256").update(json).digest("hex");
}

export function planControlledMenuImport(rawMenu: unknown[], body: ControlledMenuImport) {
  const ids = new Set<string>();
  for (const value of rawMenu) {
    const item = value as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !item.id || ids.has(item.id)) throw new MenuImportError(409, "LEGACY_MENU_IDS_INVALID_OR_DUPLICATE");
    ids.add(item.id);
  }
  const incoming = normalizePartnerMenuItems(body.items);
  const incomingIds = new Set(incoming.map((item) => item.id));
  const matchedIds = incoming.filter((item) => ids.has(item.id)).map((item) => item.id);
  const createdIds = incoming.filter((item) => !ids.has(item.id)).map((item) => item.id);
  // Do not validate/cast legacy records through Zod or Mongoose: preserve every
  // unknown/nested field, original price, allergens and historical reference.
  const retained = (rawMenu as Record<string, any>[]).filter((item) => !incomingIds.has(item.id));
  const legacy: Record<string, any>[] = body.legacyPolicy === "retain_unchanged" ? retained : retained.map((item) => ({ ...item, available: false }));
  const menu: Record<string, any>[] = [...incoming, ...legacy];
  if (menu.length > 500) throw new MenuImportError(400, "MERGED_MENU_TOO_LARGE");
  return {
    menu,
    preview: {
      counts: { before: rawMenu.length, incoming: incoming.length, matched: matchedIds.length, created: createdIds.length, retainedLegacy: legacy.length, after: menu.length, deleted: 0, availableAfter: menu.filter((item) => item.available !== false).length, legacyAvailabilityChanged: retained.filter((item) => body.legacyPolicy === "retain_ids_mark_unavailable" && item.available !== false).length, incomingUnknownAllergens: incoming.filter((item) => item.allergens === null).length },
      matchedIds, createdIds, retainedLegacyIds: retained.map((item) => item.id),
      legacyPolicy: body.legacyPolicy,
      resultingMenuHash: rawMenuHash(menu),
    },
  };
}

type Session = { withTransaction<T>(fn: () => Promise<T>): Promise<unknown>; endSession(): Promise<unknown> };
type Collection = { findOne(filter: any, options?: any): Promise<any>; updateOne(filter: any, update: any, options?: any): Promise<{ matchedCount: number; modifiedCount: number }> };
export type MenuImportDependencies = {
  requireOwner: () => RequestHandler;
  isRootOwner: (req: Request) => boolean;
  tenantScope: (req: Request) => Record<string, unknown>;
  objectId: (value: string) => unknown | null;
  restaurants: Collection;
  assets: Pick<Collection, "findOne">;
  startSession: () => Promise<Session>;
  publicAssetUrl: (id: string) => string;
  imageMimeTypes: readonly string[];
  afterApply: (restaurantId: unknown) => void;
};
const projection = { _id: 1, tenantId: 1, slug: 1, name: 1, menu: 1, menuRevision: 1, updatedAt: 1, onboardingStatus: 1, priceIncludesCommission: 1 };
function timestamp(restaurant: any): string | null {
  return restaurant.updatedAt instanceof Date && Number.isFinite(restaurant.updatedAt.getTime()) ? restaurant.updatedAt.toISOString() : null;
}
function assertRawContext(restaurant: any, draftOnly = false) {
  if (!restaurant) throw new MenuImportError(404, draftOnly ? "RESTAURANT_NOT_FOUND_OR_NOT_DRAFT_ELIGIBLE" : "RESTAURANT_NOT_FOUND_OR_NOT_APPROVED");
  if (draftOnly) {
    if (restaurant.onboardingStatus !== "pending_review" || restaurant.isActive !== false || restaurant.listingType !== "official_partner" || !isObjectIdLike(restaurant.tenantId)) throw new MenuImportError(409, "RESTAURANT_DRAFT_CONTEXT_REQUIRED");
    // This route accepts base/source prices only. Missing, null, legacy or
    // commission-inclusive flags are not evidence of a compatible price basis.
    if (!Object.hasOwn(restaurant, "priceIncludesCommission") || restaurant.priceIncludesCommission !== false) throw new MenuImportError(409, "DRAFT_SOURCE_BASE_PRICE_CONTEXT_REQUIRED");
  } else if (restaurant.onboardingStatus !== "approved" || !isObjectIdLike(restaurant.tenantId)) throw new MenuImportError(409, "RESTAURANT_TENANT_OR_APPROVAL_REQUIRED");
  if (!Array.isArray(restaurant.menu)) throw new MenuImportError(409, "RAW_MENU_ARRAY_REQUIRED");
}
function rootAccess(req: Request, deps: MenuImportDependencies, draftOnly = false) {
  if (!req.auth?.employeeId || !deps.isRootOwner(req)) throw new MenuImportError(403, "SUPERADMIN_ONLY");
  const id = deps.objectId(String(req.params.id));
  if (!id) throw new MenuImportError(400, "INVALID_RESTAURANT_ID");
  return { _id: id, ...deps.tenantScope(req), ...(draftOnly ? { onboardingStatus: "pending_review", listingType: "official_partner", isActive: false } : { onboardingStatus: "approved" }) };
}
function checkExpected(restaurant: any, body: ControlledMenuImport) {
  if (body.expectedMenuHash && body.expectedMenuHash !== rawMenuHash(restaurant.menu)) throw new MenuImportError(409, "MENU_IMPORT_CONFLICT");
  if (body.expectedUpdatedAt && body.expectedUpdatedAt !== timestamp(restaurant)) throw new MenuImportError(409, "MENU_IMPORT_CONFLICT");
  if (!body.dryRun && !timestamp(restaurant)) throw new MenuImportError(409, "RESTAURANT_UPDATED_AT_REQUIRED");
}
async function validateIncomingAssets(restaurant: any, items: PartnerMenuItem[], deps: MenuImportDependencies, session?: Session) {
  for (const url of new Set(items.map((item) => item.image).filter(Boolean))) {
    const match = /\/api\/v1\/catalog\/assets\/([a-f0-9]{24})$/i.exec(url);
    const id = match && deps.objectId(match[1]);
    if (!match || !id || url !== deps.publicAssetUrl(match[1])) throw new MenuImportError(400, "INVALID_MENU_ASSET_URL");
    const asset = await deps.assets.findOne({ _id: id, restaurantId: restaurant._id, ...buildTenantScope(restaurant.tenantId), kind: "menu_image", mimeType: { $in: [...deps.imageMimeTypes] }, scanStatus: "clean", scanEngine: "ClamAV", scannedAt: { $type: "date" } }, { projection: { _id: 1 }, ...(session ? { session } : {}) });
    if (!asset) throw new MenuImportError(400, "MENU_ASSET_NOT_OWNED_OR_NOT_CLEAN");
  }
}
function errorResponse(res: Response, error: unknown) {
  if (error instanceof MenuImportError) return res.status(error.status).json({ error: error.code });
  const mongo = error as { code?: number; hasErrorLabel?: (label: string) => boolean };
  if (mongo?.code === 112 || mongo?.hasErrorLabel?.("TransientTransactionError")) return res.status(409).json({ error: "MENU_IMPORT_CONFLICT" });
  // Never return database names, driver messages, snapshots or credentials.
  return res.status(503).json({ error: "MENU_IMPORT_UNAVAILABLE" });
}

export function registerControlledMenuImportRoutes(app: Pick<Express, "get" | "post">, deps: MenuImportDependencies) {
  const readOwner = deps.requireOwner();
  const writeOwner = deps.requireOwner();
  // Shared implementation, separate eligibility: never widen approved routes.
  function register(draftOnly: boolean) {
    const contextProjection = draftOnly ? { ...projection, listingType: 1, isActive: 1 } : projection;
    app.get(`/api/v1/admin/restaurants/:id/menu/${draftOnly ? "raw-draft" : "raw"}`, readOwner, async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Vary", "Authorization, Cookie");
      try {
        const scope = rootAccess(req, deps, draftOnly);
        const restaurant = await deps.restaurants.findOne(scope, { projection: contextProjection });
        assertRawContext(restaurant, draftOnly);
        return res.json({ source: draftOnly ? "authorized_owner_raw_draft_menu_export" : "authorized_owner_raw_menu_export", capturedAt: new Date().toISOString(), restaurant: { _id: String(restaurant._id), tenantId: String(restaurant.tenantId), slug: restaurant.slug, name: restaurant.name, onboardingStatus: restaurant.onboardingStatus, ...(draftOnly ? { listingType: restaurant.listingType, isActive: restaurant.isActive } : {}), updatedAt: timestamp(restaurant), priceIncludesCommission: restaurant.priceIncludesCommission ?? null, priceIncludesCommissionPresent: Object.hasOwn(restaurant, "priceIncludesCommission"), menu: restaurant.menu }, menuHash: rawMenuHash(restaurant.menu), hashAlgorithm: "sha256-sorted-json-v1", priceBasis: "stored_source_not_public" });
      } catch (error) { return errorResponse(res, error); }
    });
    app.post(`/api/v1/admin/restaurants/:id/menu/${draftOnly ? "draft-import" : "import"}`, writeOwner, async (req: Request, res: Response) => {
      res.setHeader("Cache-Control", "no-store");
      let session: Session | undefined;
      try {
        const scope = rootAccess(req, deps, draftOnly);
        const parsed = controlledMenuImportSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ error: "INVALID_MENU_IMPORT", details: parsed.error.flatten() });
        const body = parsed.data;
        if (draftOnly && (body.items.some((item) => item.available !== false) || body.legacyPolicy !== "retain_ids_mark_unavailable")) throw new MenuImportError(400, "DRAFT_IMPORT_UNAVAILABLE_ITEMS_AND_LEGACY_POLICY_REQUIRED");
        const snapshot = await deps.restaurants.findOne(scope, { projection: contextProjection });
        assertRawContext(snapshot, draftOnly);
        checkExpected(snapshot, body);
        const plan = planControlledMenuImport(snapshot.menu, body);
        const response = { restaurantId: String(snapshot._id), tenantId: String(snapshot.tenantId), currentMenuHash: rawMenuHash(snapshot.menu), currentUpdatedAt: timestamp(snapshot), priceBasis: "source", priceIncludesCommission: snapshot.priceIncludesCommission ?? null, ...(draftOnly ? { draftOnly: true, onboardingStatus: snapshot.onboardingStatus, isActive: snapshot.isActive } : {}), ...plan.preview };
        if (body.dryRun) {
          await validateIncomingAssets(snapshot, body.items, deps);
          return res.json({ dryRun: true, applied: false, ...response });
        }
        session = await deps.startSession();
        await session.withTransaction(async () => {
          // Exact real tenant from the authorised snapshot; no client tenant input.
          const actualScope = { ...scope, ...buildTenantScope(snapshot.tenantId), ...(draftOnly ? { priceIncludesCommission: false } : {}) };
          const current = await deps.restaurants.findOne(actualScope, { projection: contextProjection, session });
          assertRawContext(current, draftOnly);
          checkExpected(current, body);
          if (rawMenuHash(current.menu) !== response.currentMenuHash || timestamp(current) !== timestamp(snapshot)) throw new MenuImportError(409, "MENU_IMPORT_CONFLICT");
          await validateIncomingAssets(current, body.items, deps, session);
          const result = await deps.restaurants.updateOne({ ...actualScope, menu: { $eq: snapshot.menu }, updatedAt: { $eq: snapshot.updatedAt } }, { $set: { menu: plan.menu, updatedAt: new Date(Math.max(Date.now(), snapshot.updatedAt.getTime() + 1)) }, $inc: { menuRevision: 1 } }, { session, upsert: false });
          if (result.matchedCount !== 1) throw new MenuImportError(409, "MENU_IMPORT_CONFLICT");
        });
        deps.afterApply(snapshot._id);
        return res.json({ dryRun: false, applied: true, ...response, menuRevision: (snapshot.menuRevision ?? 0) + 1 });
      } catch (error) { return errorResponse(res, error); }
      finally { if (session) await session.endSession(); }
    });
  }
  register(false);
  register(true);
}
