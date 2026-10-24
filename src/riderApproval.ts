export type RiderApplicationOperationalInput = {
  name: string;
  email: string;
  phone: string;
  city: string;
  availability: string;
  vehicle: string;
};

type RiderEmployeeSnapshot = {
  tenantId?: unknown;
  jobRole?: unknown;
  apiRole?: unknown;
  primaryRole?: unknown;
  roles?: unknown;
  ownerProtected?: unknown;
};

export type RiderEmployeeProvisioningConflict =
  | "EMPLOYEE_EMAIL_OWNED_BY_ANOTHER_TENANT"
  | "EMPLOYEE_EMAIL_ROLE_INCOMPATIBLE";

function scopedId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized && normalized !== "null" && normalized !== "undefined" ? normalized : null;
}

/**
 * Employee e-mail is globally unique. Only an existing, non-protected Rider
 * account in the same tenant can be reused when an application is approved.
 * This deliberately fails closed for mixed or privileged roles so an approval
 * cannot silently repurpose a staff account as a Rider login.
 */
export function riderEmployeeProvisioningConflict(
  existing: RiderEmployeeSnapshot | null | undefined,
  tenantId: unknown,
): RiderEmployeeProvisioningConflict | null {
  if (!existing) return null;
  if (scopedId(existing.tenantId) !== scopedId(tenantId)) return "EMPLOYEE_EMAIL_OWNED_BY_ANOTHER_TENANT";

  const declaredRoles = Array.isArray(existing.roles) && existing.roles.length
    ? existing.roles
    : [existing.apiRole];
  const riderOnly = existing.ownerProtected !== true
    && existing.jobRole === "rider"
    && existing.apiRole === "rider"
    && (existing.primaryRole === null || existing.primaryRole === undefined || existing.primaryRole === "rider")
    && declaredRoles.length > 0
    && declaredRoles.every((role) => role === "rider");
  return riderOnly ? null : "EMPLOYEE_EMAIL_ROLE_INCOMPATIBLE";
}

/** Fields that must be persisted for a Rider manual-login account. */
export function buildRiderEmployeeProvisioningFields(input: {
  name: string;
  email: string;
  tenantId: unknown;
  fleetId: unknown;
  authorizedBy: unknown;
  authorizedAt: Date;
}) {
  return {
    tenantId: input.tenantId ?? null,
    name: input.name.trim(),
    email: input.email.trim().toLowerCase(),
    jobRole: "rider",
    apiRole: "rider",
    primaryRole: "rider",
    roles: ["rider"],
    accessLevel: "subadmin",
    authorizationStatus: "approved",
    authorizedAt: input.authorizedAt,
    authorizedBy: input.authorizedBy ?? null,
    authorizationReason: "Alta de RiderApplication validada documentalmente.",
    fleetId: input.fleetId ?? null,
    active: true,
    mustChangePassword: true,
  };
}

/** Whitelist only operational contact fields; never copy identity, bank or Social Security documents into the Fleet profile. */
export function buildApprovedRiderOperationalProfile(application: RiderApplicationOperationalInput) {
  return {
    name: application.name.trim(),
    email: application.email.trim().toLowerCase(),
    phone: application.phone.trim(),
    city: application.city.trim(),
    availability: application.availability.trim(),
    vehicle: application.vehicle,
  };
}
