import { OPERATIONAL_AREAS } from "./coverage/operationalAreas.js";
export type RecruitmentLocality = {
  code: string;
  name: string;
  provinceCode: string;
  zoneSlug: string;
  acceptingRiders: boolean;
  acceptingPartners: boolean;
  priorityRecruitment: boolean;
  priorityRecruitmentReason?: string;
  coverage: "partial" | "full";
  coverageCheck: "coordinates_required";
  municipalityName?: string;
};
export type RecruitmentProvince = { code: string; name: string; localities: RecruitmentLocality[] };
/** All entries are backed by the executable coverage geometry, not merely plans.
 * Alboi and Bixquert retain their parent's real INE code. The (code,zoneSlug)
 * tuple is the unique area identity; no fictitious municipality code is issued.
 * The flame is an explicit recruitment campaign, NOT a real-time demand metric.
 */
export function activeRecruitmentProvinces(): RecruitmentProvince[] {
  return [{ code: "46", name: "Valencia", localities: OPERATIONAL_AREAS.map((area) => ({
    code: area.municipalityCode, name: area.name, provinceCode: "46", zoneSlug: area.slug,
    acceptingRiders: true, acceptingPartners: true, priorityRecruitment: true,
    priorityRecruitmentReason: area.name === "Xàtiva" ? "Campaña explícita de lanzamiento de Xàtiva." : "Campaña de captación inicial de la ampliación territorial autorizada el 28/10/2026; no indica volumen de pedidos.",
    coverage: area.coverage, coverageCheck: "coordinates_required", municipalityName: area.municipalityName,
  })) }];
}
export type RecruitmentSelectionInput = { city?: unknown; localityCode?: unknown; provinceCode?: unknown; requestedZoneSlug?: unknown };
export type RecruitmentSelection = { localityCode: string; localityName: string; provinceCode: string; provinceName: string; requestedZoneSlug: string };
function comparable(value: unknown) {
  const name = String(value || "").trim().toLocaleLowerCase("es-ES").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return name === "alboy" ? "alboi" : name;
}
function allLocalities() {
  return activeRecruitmentProvinces().flatMap((province) => province.localities.map((locality) => ({ province, locality })));
}
export function resolveRecruitmentSelection(input: RecruitmentSelectionInput): RecruitmentSelection | null {
  const localityCode = String(input.localityCode || "").trim();
  const provinceCode = String(input.provinceCode || "").trim();
  const requestedZoneSlug = String(input.requestedZoneSlug || "").trim();
  const hasExplicit = Boolean(localityCode || provinceCode || requestedZoneSlug);
  let match: { province: RecruitmentProvince; locality: RecruitmentLocality } | undefined;
  if (hasExplicit) {
    if (!localityCode || !provinceCode || !requestedZoneSlug) return null;
    match = allLocalities().find(({ province, locality }) => locality.code === localityCode && province.code === provinceCode && locality.zoneSlug === requestedZoneSlug);
    if (!match) return null;
    const city = String(input.city || "").trim();
    if (city && comparable(city) !== comparable(match.locality.name)) return null;
  } else {
    const candidates = allLocalities().filter(({ locality }) => comparable(locality.name) === comparable(input.city));
    if (candidates.length !== 1) return null;
    match = candidates[0];
  }
  return { localityCode: match.locality.code, localityName: match.locality.name, provinceCode: match.province.code, provinceName: match.province.name, requestedZoneSlug: match.locality.zoneSlug };
}
