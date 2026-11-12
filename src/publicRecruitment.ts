import dataset from "./data/spain-localities.json" with { type: "json" };
import { activeRecruitmentProvinces, resolveRecruitmentSelection, type RecruitmentLocality, type RecruitmentSelectionInput } from "./recruitmentAreas.js";

export type PublicRecruitmentLocality = Omit<RecruitmentLocality, "zoneSlug" | "coverage" | "coverageCheck"> & {
  zoneSlug: string | null;
  coverage: "partial" | "full" | "not_operational";
  coverageCheck: "coordinates_required" | "not_operational";
  intakeMode: "operational_area" | "national_interest";
  aliases: string[];
};
export type PublicRecruitmentProvince = { code: string; name: string; localities: PublicRecruitmentLocality[] };
const normalize = (value: unknown) => String(value ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("es-ES").replace(/\s+/g, " ");
const municipalities = new Map(dataset.municipalities.map((item) => [item.code, item]));
let cachedProvinces: PublicRecruitmentProvince[] | undefined;

/** Public contact intake is not coverage, enrollment or permission to work. */
export function publicRecruitmentProvinces(): PublicRecruitmentProvince[] {
  if (cachedProvinces) return cachedProvinces;
  const provinces = new Map<string, PublicRecruitmentProvince>();
  const active = activeRecruitmentProvinces();
  const activeCodes = new Set(active.flatMap((province) => province.localities.map((locality) => locality.code)));
  for (const municipality of dataset.municipalities) {
    const code = municipality.code.slice(0, 2);
    if (!provinces.has(code)) provinces.set(code, { code, name: municipality.province, localities: [] });
    if (activeCodes.has(municipality.code)) continue;
    provinces.get(code)!.localities.push({
      code: municipality.code, name: municipality.name, provinceCode: code,
      zoneSlug: null, acceptingRiders: true, acceptingPartners: true,
      priorityRecruitment: false, coverage: "not_operational", coverageCheck: "not_operational",
      intakeMode: "national_interest", aliases: [...municipality.aliases],
    });
  }
  for (const province of active) {
    const target = provinces.get(province.code);
    if (!target) throw new Error("Operational recruitment province is not in the official municipality catalogue");
    for (const locality of province.localities) {
      const municipality = municipalities.get(locality.code);
      if (!municipality || locality.code.slice(0, 2) !== province.code) throw new Error("Operational recruitment locality has an invalid official code");
      target.localities.push({
        ...locality, intakeMode: "operational_area",
        aliases: normalize(locality.name) === normalize(locality.municipalityName ?? municipality.name) ? [...municipality.aliases] : [],
      });
    }
  }
  const collator = new Intl.Collator("es-ES", { sensitivity: "base" });
  cachedProvinces = [...provinces.values()].map((province) => ({ ...province, localities: province.localities.sort((a, b) => collator.compare(a.name, b.name)) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  for (const province of cachedProvinces) {
    for (const locality of province.localities) { Object.freeze(locality.aliases); Object.freeze(locality); }
    Object.freeze(province.localities); Object.freeze(province);
  }
  Object.freeze(cachedProvinces);
  return cachedProvinces;
}

export function resolvePublicRecruitmentSelection(input: RecruitmentSelectionInput) {
  const zoneSlug = String(input.requestedZoneSlug ?? "").trim();
  const localityCode = String(input.localityCode ?? "").trim();
  const provinceCode = String(input.provinceCode ?? "").trim();
  // Preserve existing area identity/legacy requests. An arbitrary zone must
  // never fall through to national intake or create an operational permission.
  if (zoneSlug || (!localityCode && !provinceCode)) {
    const active = resolveRecruitmentSelection(input);
    return active ? { ...active, intakeMode: "operational_area" as const } : null;
  }
  if (!/^\d{5}$/.test(localityCode) || !/^\d{2}$/.test(provinceCode) || localityCode.slice(0, 2) !== provinceCode) return null;
  const municipality = municipalities.get(localityCode);
  if (!municipality) return null;
  const city = normalize(input.city);
  if (!city || ![municipality.name, ...municipality.aliases].some((name) => normalize(name) === city)) return null;
  return {
    localityCode, localityName: municipality.name, provinceCode, provinceName: municipality.province,
    requestedZoneSlug: null, intakeMode: "national_interest" as const,
  };
}
