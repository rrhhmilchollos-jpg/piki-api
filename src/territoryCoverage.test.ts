import test from "node:test";
import assert from "node:assert/strict";
import { OPERATIONAL_AREAS } from "./coverage/operationalAreas.js";
import { evaluateXativaCoverage, withinSameOperationalCity } from "./coverage/xativaPolicy.js";
import { insideGeometry, nearestCoveredArea } from "./coverage/territoryGeometry.js";
import { zoneGeometryInput } from "./coverage/zoneInput.js";
import { activeRecruitmentProvinces, resolveRecruitmentSelection } from "./recruitmentAreas.js";
import { dispatchVehicleInputForOrder } from "./dispatchVehiclePolicy.js";
import { evaluateDispatchVehicleEligibility } from "./dispatch.js";
const byName = (name: string) => OPERATIONAL_AREAS.find((area) => area.name === name)!;

test("ten executable areas include all nine requested places and have valid municipal/operational geometry", () => {
  assert.equal(OPERATIONAL_AREAS.length, 10);
  for (const area of OPERATIONAL_AREAS) {
    assert.ok(zoneGeometryInput.safeParse(area.geometry).success, area.name);
    assert.ok(insideGeometry(area.center, area.geometry), area.name);
    const decision = evaluateXativaCoverage(area.center);
    assert.equal(decision.covered, true, area.name);
    assert.equal(decision.municipalityCode, area.municipalityCode, area.name);
    assert.equal(decision.deliveryFeeCents, 299, "opening new zones does not invent a new delivery tariff");
    assert.equal(decision.serviceFeeCents, 79);
  }
  assert.equal(evaluateXativaCoverage([-0.3763, 39.4699]).covered, false, "Valencia city is not enabled by a province label");
  assert.equal(evaluateXativaCoverage([NaN, 39]).covered, false);
});
test("holes and separate municipal components are respected rather than joined by a fake rectangle", () => {
  const geometry = { type: "MultiPolygon" as const, coordinates: [
    [[[0,0],[4,0],[4,4],[0,4],[0,0]], [[1,1],[2,1],[2,2],[1,2],[1,1]]],
    [[[5,5],[6,5],[6,6],[5,6],[5,5]]],
  ] };
  assert.equal(insideGeometry([0.5,0.5], geometry), true);
  assert.equal(insideGeometry([1.5,1.5], geometry), false);
  assert.equal(insideGeometry([5.5,5.5], geometry), true);
  assert.equal(insideGeometry([4.5,4.5], geometry), false);
});
test("light vehicles cannot cross towns even when road distance is shorter than 1.5 km", () => {
  const origin = byName("Cerdà").center, destination = byName("Torrella").center;
  assert.equal(withinSameOperationalCity(origin, destination), false);
  const input = dispatchVehicleInputForOrder({ routeDistanceKm: 0.7, withinMunicipality: true, pickupLocation: { coordinates: origin }, deliveryLocation: { coordinates: destination } });
  assert.equal(input.withinMunicipality, false);
  assert.equal(evaluateDispatchVehicleEligibility("bike", input).eligible, false);
  assert.equal(evaluateDispatchVehicleEligibility("electric_bike", input).eligible, false);
  assert.equal(evaluateDispatchVehicleEligibility("electric_scooter", input).eligible, false);
});
test("Alboi is not treated as El Genovés city centre; rural Bixquert never becomes an urban light-vehicle core", () => {
  assert.equal(withinSameOperationalCity(byName("Alboi").center, byName("El Genovés").center), false);
  assert.equal(withinSameOperationalCity(byName("Bixquert").center, byName("Bixquert").center), false);
  assert.equal(nearestCoveredArea(byName("Alboi").center, OPERATIONAL_AREAS)?.name, "Alboi");
});
test("genuine short urban trip is eligible but a legacy boolean without a pickup snapshot cannot bypass the geofence", () => {
  const origin = byName("Xàtiva").center;
  const destination: [number,number] = [origin[0] + 0.001, origin[1] + 0.001];
  assert.equal(withinSameOperationalCity(origin, destination), true);
  const input = dispatchVehicleInputForOrder({ routeDistanceKm: 1.499, pickupLocation: { coordinates: origin }, deliveryLocation: { coordinates: destination } });
  assert.equal(evaluateDispatchVehicleEligibility("bike", input).eligible, true);
  assert.equal(evaluateDispatchVehicleEligibility("bike", { ...input, routeDistanceKm: 1.5 }).eligible, false);
  assert.equal(evaluateDispatchVehicleEligibility("bike", dispatchVehicleInputForOrder({ routeDistanceKm: 1, withinMunicipality: true, deliveryLocation: { coordinates: destination } })).eligible, false);
});
test("recruitment publishes verified localities and uses code plus zone for shared municipal codes", () => {
  const province = activeRecruitmentProvinces()[0];
  assert.equal(province.code, "46");
  assert.equal(province.localities.length, 10);
  assert.equal(province.localities.every((place) => place.priorityRecruitment && place.acceptingRiders && place.acceptingPartners), true);
  for (const name of ["Alboi", "Bixquert"]) {
    const area = byName(name);
    assert.equal(resolveRecruitmentSelection({ localityCode: area.municipalityCode, provinceCode: "46", requestedZoneSlug: area.slug, city: name })?.localityName, name);
  }
  assert.equal(resolveRecruitmentSelection({ city: "Alboy" })?.localityName, "Alboi");
  assert.equal(resolveRecruitmentSelection({ city: "Valencia" }), null);
  assert.equal(resolveRecruitmentSelection({ city: "Bixquert", localityCode: "46145", provinceCode: "46", requestedZoneSlug: "xativa-casco-urbano-fase-1" }), null);
});
test("zone validation preserves legacy Polygon input but rejects open rings and invalid coordinates", () => {
  assert.equal(zoneGeometryInput.safeParse({ coordinates: [[[0,0],[1,0],[1,1],[0,0]]] }).success, true);
  assert.equal(zoneGeometryInput.safeParse({ type: "Polygon", coordinates: [[[0,0],[1,0],[1,1],[0,1]]] }).success, false);
  assert.equal(zoneGeometryInput.safeParse({ type: "Polygon", coordinates: [[[200,0],[1,0],[1,1],[200,0]]] }).success, false);
});
