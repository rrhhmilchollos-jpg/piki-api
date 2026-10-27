import { XATIVA_COVERAGE_POLICY } from "./coverage/xativaPolicy.js";

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
};

export type RecruitmentProvince = { code: string; name: string; localities: RecruitmentLocality[] };

/**
 * This list intentionally has one entry. It is derived from the single
 * executable coverage policy, not from MunicipalExpansion plans or fleet
 * polygons. Xàtiva is partial: the transaction still verifies coordinates
 * against the municipality boundary and the 3 km launch radius.
 */
export function activeRecruitmentProvinces(): RecruitmentProvince[] {
  if (XATIVA_COVERAGE_POLICY.phase2Enabled) throw new Error("Unexpected Xàtiva phase-2 recruitment publication");
  return [{
    code: "46",
    name: "Valencia",
    localities: [{
      code: "46145",
      name: XATIVA_COVERAGE_POLICY.city,
      provinceCode: "46",
      zoneSlug: XATIVA_COVERAGE_POLICY.slug,
      acceptingRiders: true,
      acceptingPartners: true,
      priorityRecruitment: true,
      priorityRecruitmentReason: "Campaña explícita de lanzamiento de Xàtiva.",
      coverage: "partial",
      coverageCheck: "coordinates_required",
    }],
  }];
}

export type RecruitmentSelectionInput = {
  city?: unknown;
  localityCode?: unknown;
  provinceCode?: unknown;
  requestedZoneSlug?: unknown;
};

export type RecruitmentSelection = {
  localityCode: string;
  localityName: string;
  provinceCode: string;
  provinceName: string;
  requestedZoneSlug: string;
};

function comparable(value: unknown) {
  return String(value || "").trim().toLocaleLowerCase("es-ES").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function allLocalities() {
  return activeRecruitmentProvinces().flatMap((province) => province.localities.map((locality) => ({ province, locality })));
}

/**
 * Explicit code/zone selections must agree exactly. For a legacy city-only
 * submission, inference is deliberately limited to a unique canonical name;
 * notably, it never infers all of Valencia from a province string.
 */
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
    const city = comparable(input.city);
    const candidates = allLocalities().filter(({ locality }) => comparable(locality.name) === city);
    if (candidates.length !== 1) return null;
    match = candidates[0];
  }

  return {
    localityCode: match.locality.code,
    localityName: match.locality.name,
    provinceCode: match.province.code,
    provinceName: match.province.name,
    requestedZoneSlug: match.locality.zoneSlug,
  };
}
