export type FleetViewInput = {
  _id: unknown;
  name?: unknown;
  city?: unknown;
  localityCode?: unknown;
  localityName?: unknown;
  provinceCode?: unknown;
  provinceName?: unknown;
  vehicleTypes?: unknown;
  maxRiders?: unknown;
  serviceZones?: unknown;
  isActive?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};

function text(value: unknown) { return typeof value === "string" ? value.trim() : ""; }

/** Public/operational whitelist. Deliberately excludes managerName, managerDni and contacts. */
export function fleetPublicView(fleet: FleetViewInput, serviceZoneNames: Record<string, string>) {
  const localityName = text(fleet.localityName) || text(fleet.city);
  const provinceName = text(fleet.provinceName);
  const serviceZones = Array.isArray(fleet.serviceZones) ? fleet.serviceZones.filter((slug): slug is string => typeof slug === "string") : [];
  const suffix = [localityName, provinceName].filter(Boolean).join(" · ");
  return {
    id: String(fleet._id),
    _id: fleet._id,
    // `name` is retained for old clients; use displayName for non-personal UI.
    name: text(fleet.name),
    displayName: suffix ? `Flota ${suffix}` : `Flota ${text(fleet.name) || "operativa"}`,
    city: text(fleet.city),
    localityCode: text(fleet.localityCode) || null,
    localityName: localityName || null,
    provinceCode: text(fleet.provinceCode) || null,
    provinceName: provinceName || null,
    vehicleTypes: Array.isArray(fleet.vehicleTypes) ? fleet.vehicleTypes : [],
    maxRiders: Number(fleet.maxRiders || 0),
    serviceZones,
    serviceZoneNames: serviceZones.map((slug) => serviceZoneNames[slug]).filter(Boolean),
    isActive: fleet.isActive === true,
    createdAt: fleet.createdAt || null,
    updatedAt: fleet.updatedAt || null,
  };
}
