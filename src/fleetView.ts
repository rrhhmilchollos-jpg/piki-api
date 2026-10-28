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
  const zoneNames = [...new Set(serviceZones.map((slug) => serviceZoneNames[slug]).filter(Boolean))];
  const suffix = [localityName, provinceName].filter(Boolean).join(" · ");
  const geographicFallback = zoneNames.length ? `${zoneNames.slice(0, 3).join(" / ")}${zoneNames.length > 3 ? ` (+${zoneNames.length - 3} zonas)` : ""}` : "sin localidad asignada";
  const testSuffix = /\b(pruebas|qa|test)\b/i.test(text(fleet.name)) ? " · Pruebas" : "";
  return {
    id: String(fleet._id),
    _id: fleet._id,
    // `name` is retained for old clients; use displayName for non-personal UI.
    name: text(fleet.name),
    displayName: `Flota ${suffix || geographicFallback}${testSuffix}`,
    city: text(fleet.city),
    localityCode: text(fleet.localityCode) || null,
    localityName: localityName || null,
    provinceCode: text(fleet.provinceCode) || null,
    provinceName: provinceName || null,
    vehicleTypes: Array.isArray(fleet.vehicleTypes) ? fleet.vehicleTypes : [],
    maxRiders: Number(fleet.maxRiders || 0),
    serviceZones,
    serviceZoneNames: zoneNames,
    isActive: fleet.isActive === true,
    createdAt: fleet.createdAt || null,
    updatedAt: fleet.updatedAt || null,
  };
}
