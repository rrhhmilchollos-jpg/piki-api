import type { Express, Request, RequestHandler, Response } from "express";
import mongoose, { type InferSchemaType, type Model, Schema } from "mongoose";
import { z } from "zod";
import { Restaurant } from "./models.js";
import { isObjectIdLike } from "./tenantScope.js";

/** Administrative registry only: no hardware binding, enrollment, DPC or verified kiosk. */
export const PARTNER_TERMINAL_INVENTORY_PATH = "/api/v1/admin/restaurants/:id/terminals";
export const partnerTerminalInputSchema = z.object({
  model: z.enum(["SUNMI_V2", "SUNMI_V2S"]),
  serialNumber: z.string().trim().toUpperCase().min(6).max(64).regex(/^[A-Z0-9_-]+$/),
  imeiSim1: z.string().regex(/^\d{15}$/).optional(),
  kioskRequested: z.boolean().default(true),
}).strict();
export type PartnerTerminalInput = z.infer<typeof partnerTerminalInputSchema>;
export type PartnerTerminalInventoryOptions = {
  ownerMiddleware: RequestHandler;
  restaurantScope: (req: Request, id: string) => Record<string, unknown>;
};

export const partnerTerminalInventorySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: "Tenant", required: true, immutable: true },
  restaurantId: { type: Schema.Types.ObjectId, ref: "Restaurant", required: true, immutable: true },
  model: { type: String, enum: ["SUNMI_V2", "SUNMI_V2S"], required: true, immutable: true },
  serialNumber: { type: String, required: true, trim: true, uppercase: true, minlength: 6, maxlength: 64, match: /^[A-Z0-9_-]+$/, immutable: true },
  imeiSim1: { type: String, match: /^\d{15}$/, select: false, immutable: true },
  imeiSim1Last4: { type: String, match: /^\d{4}$/, default: null, immutable: true },
  kioskRequested: { type: Boolean, default: true, immutable: true },
  provisioningStatus: { type: String, enum: ["pending_configuration"], default: "pending_configuration", immutable: true },
  kioskStatus: { type: String, enum: ["unverified"], default: "unverified", immutable: true },
  createdByEmployeeId: { type: Schema.Types.ObjectId, ref: "EmployeeAccount", immutable: true },
}, { timestamps: true, collection: "partner_terminal_inventory", strict: "throw" });
// Global uniqueness prevents a serial from being silently reassigned between shops/tenants.
partnerTerminalInventorySchema.index({ serialNumber: 1 }, { unique: true });
partnerTerminalInventorySchema.index({ tenantId: 1, restaurantId: 1, createdAt: -1 });
type TerminalFields = InferSchemaType<typeof partnerTerminalInventorySchema>;
export type PartnerTerminalInventoryRecord = TerminalFields & { _id: unknown };
export const PartnerTerminalInventory: Model<TerminalFields> =
  (mongoose.models.PartnerTerminalInventory as Model<TerminalFields> | undefined)
  || mongoose.model("PartnerTerminalInventory", partnerTerminalInventorySchema);

/** Explicit public allowlist: never return the raw document, IMEI or employee identity. */
export function serializePartnerTerminal(record: PartnerTerminalInventoryRecord) {
  return {
    id: String(record._id),
    restaurantId: String(record.restaurantId),
    model: record.model,
    serialNumber: record.serialNumber,
    imeiSim1Last4: record.imeiSim1Last4 ?? null,
    kioskRequested: record.kioskRequested,
    provisioningStatus: "pending_configuration" as const,
    kioskStatus: "unverified" as const,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

class InventoryError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
function privateResponse(res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Vary", "Authorization, Cookie");
}
function errorResponse(res: Response, error: unknown) {
  if (error instanceof InventoryError) return res.status(error.status).json({ error: error.code });
  // No raw exceptions, validation values, serials or IMEI diagnostics in responses/logs.
  return res.status(503).json({ error: "TERMINAL_INVENTORY_UNAVAILABLE" });
}
async function scopedRestaurant(req: Request, options: PartnerTerminalInventoryOptions) {
  const id = String(req.params.id);
  if (!/^[a-f\d]{24}$/i.test(id)) throw new InventoryError(400, "INVALID_RESTAURANT_ID");
  const restaurant = await Restaurant.findOne(options.restaurantScope(req, id))
    .select("_id tenantId name").lean<{ _id: mongoose.Types.ObjectId; tenantId?: mongoose.Types.ObjectId | null; name?: string }>().exec();
  if (!restaurant) throw new InventoryError(404, "RESTAURANT_NOT_FOUND");
  if (!isObjectIdLike(restaurant.tenantId)) throw new InventoryError(409, "TENANT_CONTEXT_REQUIRED");
  return restaurant;
}
// Only this private POST helper opts into the complete IMEI for exact replay comparison.
async function existingSerial(serialNumber: string) {
  return PartnerTerminalInventory.findOne({ serialNumber }).select("+imeiSim1").lean().exec();
}
function assertReplay(
  record: PartnerTerminalInventoryRecord,
  restaurant: { _id: unknown; tenantId?: unknown },
  input: PartnerTerminalInput,
) {
  if (String(record.restaurantId) !== String(restaurant._id)
    || String(record.tenantId) !== String(restaurant.tenantId)
    || record.serialNumber !== input.serialNumber
    || record.model !== input.model
    || (record.imeiSim1 ?? undefined) !== input.imeiSim1
    || record.kioskRequested !== input.kioskRequested) {
    throw new InventoryError(409, "TERMINAL_INVENTORY_CONFLICT");
  }
  return record;
}
function isDuplicateKey(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === 11000;
}

export function registerPartnerTerminalInventoryRoutes(
  app: Pick<Express, "get" | "post">,
  options: PartnerTerminalInventoryOptions,
): void {
  app.get(PARTNER_TERMINAL_INVENTORY_PATH, options.ownerMiddleware, async (req: Request, res: Response) => {
    privateResponse(res);
    try {
      const restaurant = await scopedRestaurant(req, options);
      const records = await PartnerTerminalInventory.find({ tenantId: restaurant.tenantId, restaurantId: restaurant._id })
        .select("_id restaurantId model serialNumber imeiSim1Last4 kioskRequested provisioningStatus kioskStatus createdAt updatedAt")
        .sort({ createdAt: -1 }).lean().exec();
      const terminals = records.map(serializePartnerTerminal);
      return res.status(200).json({ count: terminals.length, terminals });
    } catch (error) { return errorResponse(res, error); }
  });
  app.post(PARTNER_TERMINAL_INVENTORY_PATH, options.ownerMiddleware, async (req: Request, res: Response) => {
    privateResponse(res);
    try {
      const restaurant = await scopedRestaurant(req, options);
      const parsed = partnerTerminalInputSchema.safeParse(req.body);
      if (!parsed.success) throw new InventoryError(400, "INVALID_TERMINAL_INPUT");
      const input = parsed.data;
      // Explicit, idempotent index creation also protects deployments with autoIndex disabled.
      // Fail closed before any data write if MongoDB cannot guarantee global serial uniqueness.
      await PartnerTerminalInventory.collection.createIndex({ serialNumber: 1 }, { unique: true });
      const existing = await existingSerial(input.serialNumber);
      if (existing) {
        return res.status(200).json({ created: false, terminal: serializePartnerTerminal(assertReplay(existing, restaurant, input)) });
      }
      try {
        const record = await PartnerTerminalInventory.create({
          tenantId: restaurant.tenantId,
          restaurantId: restaurant._id,
          model: input.model,
          serialNumber: input.serialNumber,
          imeiSim1: input.imeiSim1,
          imeiSim1Last4: input.imeiSim1?.slice(-4) ?? null,
          kioskRequested: input.kioskRequested,
          provisioningStatus: "pending_configuration",
          kioskStatus: "unverified",
          ...(isObjectIdLike(req.auth?.employeeId) ? { createdByEmployeeId: req.auth!.employeeId } : {}),
        });
        return res.status(201).json({ created: true, terminal: serializePartnerTerminal(record) });
      } catch (error) {
        if (!isDuplicateKey(error)) throw error;
        // A concurrent winner can only be replayed, never overwritten/reset.
        const winner = await existingSerial(input.serialNumber);
        if (!winner) throw new InventoryError(409, "TERMINAL_INVENTORY_CONFLICT");
        return res.status(200).json({ created: false, terminal: serializePartnerTerminal(assertReplay(winner, restaurant, input)) });
      }
    } catch (error) { return errorResponse(res, error); }
  });
}
