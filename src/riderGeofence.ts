import { OPERATIONAL_AREAS } from "./coverage/operationalAreas.js";
import { nearestCoveredArea, type Coordinate } from "./coverage/territoryGeometry.js";

type GeofenceSource = "declared_locality" | "gps" | "assigned_zone" | "unknown";
export type RiderGeofence = {
  state: "inside" | "outside" | "unknown";
  source: GeofenceSource;
  localityCode: string | null;
  localityName: string | null;
  zoneSlug: string | null;
  checkedAt: Date;
};

const normalize = (value: unknown) => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();

export function resolveRiderGeofence(input: { declaredLocality?: unknown; assignedZoneSlug?: unknown; coordinates?: unknown; now?: Date }): RiderGeofence {
  const checkedAt = input.now || new Date();
  const declared = normalize(input.declaredLocality);
  const declaredArea = declared ? OPERATIONAL_AREAS.find((area) => normalize(area.municipalityName) === declared || normalize(area.name) === declared) : null;
  const coordinates = Array.isArray(input.coordinates) && input.coordinates.length >= 2 && Number.isFinite(Number(input.coordinates[0])) && Number.isFinite(Number(input.coordinates[1]))
    ? [Number(input.coordinates[0]), Number(input.coordinates[1])] as Coordinate
    : null;
  const gpsArea = coordinates ? nearestCoveredArea(coordinates, OPERATIONAL_AREAS) : null;
  const area = declaredArea || gpsArea;
  const source: GeofenceSource = declaredArea ? "declared_locality" : gpsArea ? "gps" : input.assignedZoneSlug ? "assigned_zone" : "unknown";
  return {
    state: area ? "inside" : source === "assigned_zone" ? "unknown" : "outside",
    source,
    localityCode: area?.municipalityCode || null,
    localityName: area?.municipalityName || (declared ? String(input.declaredLocality).trim() : null),
    zoneSlug: input.assignedZoneSlug ? String(input.assignedZoneSlug) : null,
    checkedAt,
  };
}
