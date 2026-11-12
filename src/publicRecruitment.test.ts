import test from "node:test";
import assert from "node:assert/strict";
import dataset from "./data/spain-localities.json" with { type: "json" };
import { publicRecruitmentProvinces, resolvePublicRecruitmentSelection } from "./publicRecruitment.js";
import { activeRecruitmentProvinces, resolveRecruitmentSelection } from "./recruitmentAreas.js";

test("public intake covers all official municipalities without assigning fictional zones", () => {
  const provinces = publicRecruitmentProvinces();
  assert.equal(provinces.length, 52);
  const localities = provinces.flatMap((province) => province.localities);
  assert.equal(new Set(localities.map((locality) => locality.code)).size, 8132);
  for (const municipality of dataset.municipalities) {
    assert(localities.some((locality) => locality.code === municipality.code));
  }
  for (const locality of localities.filter((locality) => locality.intakeMode === "national_interest")) {
    assert.equal(locality.zoneSlug, null);
    assert.equal(locality.coverage, "not_operational");
    assert.equal(locality.priorityRecruitment, false);
  }
});

test("Madrid and Algemesí are interest only, and the operational resolver remains closed", () => {
  for (const [code, name] of [["28079", "Madrid"], ["46029", "Algemesí"]]) {
    const input = { city: name, localityCode: code, provinceCode: code.slice(0, 2) };
    const resolved = resolvePublicRecruitmentSelection(input);
    assert.equal(resolved?.intakeMode, "national_interest");
    assert.equal(resolved?.requestedZoneSlug, null);
    assert.equal(resolveRecruitmentSelection(input), null);
  }
});

test("all official national names resolve only under their real code/province", () => {
  for (const municipality of dataset.municipalities) {
    const resolved = resolvePublicRecruitmentSelection({ city: municipality.name, localityCode: municipality.code, provinceCode: municipality.code.slice(0, 2) });
    assert.equal(resolved?.localityCode, municipality.code);
    assert.equal(resolved?.requestedZoneSlug, null);
  }
});

test("malformed province, municipality, city and invented zone fail closed", () => {
  assert.equal(resolvePublicRecruitmentSelection({ city: "Madrid", localityCode: "28079", provinceCode: "46" }), null);
  assert.equal(resolvePublicRecruitmentSelection({ city: "Madrid", localityCode: "99999", provinceCode: "99" }), null);
  assert.equal(resolvePublicRecruitmentSelection({ city: "Xàtiva", localityCode: "28079", provinceCode: "28" }), null);
  assert.equal(resolvePublicRecruitmentSelection({ city: "Madrid", localityCode: "28079", provinceCode: "28", requestedZoneSlug: "madrid-fake" }), null);
  assert.equal(resolvePublicRecruitmentSelection({ city: "Madrid" }), null);
  assert.equal(resolvePublicRecruitmentSelection({ localityCode: "28079", provinceCode: "28" }), null);
});

test("existing real zones and shared-code districts remain distinct", () => {
  const before = JSON.stringify(activeRecruitmentProvinces());
  for (const province of activeRecruitmentProvinces()) for (const locality of province.localities) {
    const input = { city: locality.name, localityCode: locality.code, provinceCode: province.code, requestedZoneSlug: locality.zoneSlug };
    const resolved = resolvePublicRecruitmentSelection(input);
    assert.equal(resolved?.requestedZoneSlug, locality.zoneSlug);
    assert.equal(resolved?.intakeMode, "operational_area");
  }
  publicRecruitmentProvinces();
  assert.equal(JSON.stringify(activeRecruitmentProvinces()), before);
});
