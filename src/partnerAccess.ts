export const partnerPermissions = [
  "store:write",
  "orders:read",
  "orders:write",
  "orders:prepare",
  "orders:cancel",
  "menu:read",
  "menu:write",
  "metrics:read",
] as const;

export type PartnerPermission = (typeof partnerPermissions)[number];

type PartnerEmployee = {
  apiRole?: unknown;
  jobRole?: unknown;
  roles?: unknown;
  partnerRoles?: unknown;
};

const fullAccessRoles = new Set(["owner", "partner_admin", "admin", "administrator", "propietario", "partner"]);
const managerRoles = new Set(["area_manager", "zone_manager", "manager", "gerente", "store_manager"]);

export function partnerRolesForEmployee(employee: PartnerEmployee | null | undefined): string[] {
  const roleSource = Array.isArray(employee?.partnerRoles) && employee.partnerRoles.length ? employee.partnerRoles : employee?.roles;
  const configured = Array.isArray(roleSource)
    ? roleSource.filter((role): role is string => typeof role === "string" && Boolean(role.trim())).map((role) => role.trim())
    : [];
  if (configured.length) return [...new Set(configured)];

  const fallback = typeof employee?.jobRole === "string" ? employee.jobRole : employee?.apiRole;
  return fallback === "partner" ? ["partner_admin"] : typeof fallback === "string" && fallback ? [fallback] : [];
}

export function permissionsForPartnerRoles(roles: string[]): Set<string> {
  const permissions = new Set<string>();
  for (const role of roles.map((value) => value.toLowerCase())) {
    if (fullAccessRoles.has(role)) permissions.add("*");
    else if (managerRoles.has(role)) {
      for (const permission of partnerPermissions) permissions.add(permission);
    } else if (["cashier", "cajero"].includes(role)) {
      permissions.add("orders:read");
      permissions.add("orders:write");
    } else if (["kitchen", "cocina", "cook"].includes(role)) {
      permissions.add("orders:read");
      permissions.add("orders:prepare");
    } else if (["catalog", "catalogue", "menu_manager"].includes(role)) {
      permissions.add("menu:read");
      permissions.add("menu:write");
    } else if (["viewer", "read_only", "solo_lectura"].includes(role)) {
      permissions.add("orders:read");
      permissions.add("metrics:read");
    }
  }
  return permissions;
}

export function partnerCan(roles: string[], permission: PartnerPermission): boolean {
  const permissions = permissionsForPartnerRoles(roles);
  return permissions.has("*") || permissions.has(permission);
}
