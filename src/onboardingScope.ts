import mongoose from "mongoose";
import { Tenant } from "./models.js";
import { ROOT_TENANT_SLUG } from "./tenantMigration.js";
import type { Request } from "express";

// Las altas públicas antiguas tienen tenantId=null. Solo la plataforma
// propietaria puede gestionarlas; nunca se incluyen en un tenant externo.
export function buildOnboardingScope(tenantId: string | undefined, isPlatformTenant: boolean): Record<string, unknown> {
  if (!tenantId) return { _id: null };
  if (!mongoose.isValidObjectId(tenantId)) return { _id: null };
  const id = new mongoose.Types.ObjectId(tenantId);
  return isPlatformTenant ? { $or: [{ tenantId: id }, { tenantId: null }] } : { tenantId: id };
}

export async function onboardingScope(req: Request): Promise<Record<string, unknown>> {
  const tenantId = req.auth?.tenantId;
  if (!tenantId || !mongoose.isValidObjectId(tenantId)) return buildOnboardingScope(tenantId, false);
  const platform = await Tenant.exists({ _id: tenantId, slug: ROOT_TENANT_SLUG, isPlatformTenant: true });
  return buildOnboardingScope(tenantId, Boolean(platform));
}
