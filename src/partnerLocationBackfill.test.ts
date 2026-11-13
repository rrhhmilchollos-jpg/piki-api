import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPartnerLocationBackfillFilter,
  buildPartnerLocationUpdateFilter,
  isValidPartnerGeocodeMatch,
  partnerOperationalAddress,
  partnerOperationalLocality,
  uniquePartnerGeocodePoint,
  validOperationalCoordinates,
} from "./partnerLocationBackfill.js";

test("el backfill solo escanea comercios realmente publicables y operativos", () => {
  const filter = buildPartnerLocationBackfillFilter() as Record<string, any>;

  assert.equal(filter.isActive, true);
  assert.equal(filter.onboardingStatus, "approved");
  assert.equal(filter.availabilityStatus, "available");
  assert.equal(filter["menu.0"].$exists, true);
  assert.equal(filter.fulfillmentMode.$ne, "assisted_purchase");
});

test("el backfill detecta ubicaciones ausentes, inválidas o incompletas sin convertir null/vacío a cero", () => {
  assert.equal(validOperationalCoordinates([-0.52, 38.99]), true);
  assert.equal(validOperationalCoordinates(["-0.52", "38.99"]), true);
  assert.equal(validOperationalCoordinates(undefined), false);
  assert.equal(validOperationalCoordinates(null), false);
  assert.equal(validOperationalCoordinates([]), false);
  assert.equal(validOperationalCoordinates([1]), false);
  assert.equal(validOperationalCoordinates([181, 0]), false);
  assert.equal(validOperationalCoordinates([0, 91]), false);
  assert.equal(validOperationalCoordinates([Number.NaN, 0]), false);
  assert.equal(validOperationalCoordinates([null, null]), false);
  assert.equal(validOperationalCoordinates(["", ""]), false);
  assert.equal(validOperationalCoordinates([true, 1]), false);
  assert.equal(validOperationalCoordinates([0, 0]), false);
});

test("los valores superiores en blanco no bloquean la dirección o localidad legacy", () => {
  const restaurant = {
    address: "   ",
    locality: "  ",
    partnerProfile: { operatingAddress: "Carrer de la Reina 12", city: "Xàtiva" },
  };

  assert.equal(partnerOperationalAddress(restaurant), "Carrer de la Reina 12");
  assert.equal(partnerOperationalLocality(restaurant), "Xàtiva");
});

test("la persistencia condicional compara dirección, localidad, CP y coordenadas originales", () => {
  const filter = buildPartnerLocationUpdateFilter({
    _id: "partner-id",
    address: "Carrer de la Reina 12",
    locality: "Xàtiva",
    partnerProfile: { operatingAddress: "Carrer de la Reina 12", city: "Xàtiva", postalCode: "46800" },
    location: { type: "Point", coordinates: [0, 0] },
  });

  assert.deepEqual(filter, {
    _id: "partner-id",
    address: "Carrer de la Reina 12",
    locality: "Xàtiva",
    "partnerProfile.operatingAddress": "Carrer de la Reina 12",
    "partnerProfile.city": "Xàtiva",
    "partnerProfile.postalCode": "46800",
    "location.coordinates": [0, 0],
  });
});

test("Photon requiere calle/tipo/número/municipio y código postal coherentes", () => {
  const request = { address: "Carrer de la Reina 12", locality: "Xàtiva", postalCode: "46800" };
  const matching = { street: "Carrer de la Reina", housenumber: "12", city: "Xàtiva", postcode: "46800" };

  assert.equal(isValidPartnerGeocodeMatch(request, matching), true);
  assert.equal(isValidPartnerGeocodeMatch({ ...request, address: "Carrer de la Reina, 12" }, matching), true);
  assert.equal(isValidPartnerGeocodeMatch(request, { ...matching, street: "Avinguda de la Reina" }), false);
  assert.equal(isValidPartnerGeocodeMatch(request, { ...matching, housenumber: "99" }), false);
  assert.equal(isValidPartnerGeocodeMatch(request, { ...matching, city: "Valencia" }), false);
  assert.equal(isValidPartnerGeocodeMatch(request, { ...matching, postcode: "46001" }), false);
  assert.equal(isValidPartnerGeocodeMatch(request, { street: "Carrer de la Reina", city: "Xàtiva", postcode: "46800" }), false);
  assert.equal(isValidPartnerGeocodeMatch({ address: "Carrer de la Reina", locality: "Xàtiva" }, matching), false);
});

test("el geocoder rechaza coordenadas ambiguas y acepta duplicados en el mismo punto", () => {
  const request = { address: "Carrer de la Reina 12", locality: "Xàtiva", postalCode: "46800" };
  const candidate = {
    longitude: -0.52,
    latitude: 38.99,
    address: { street: "Carrer de la Reina", housenumber: "12", city: "Xàtiva", postcode: "46800" },
  };

  assert.deepEqual(uniquePartnerGeocodePoint(request, [candidate, candidate]), [-0.52, 38.99]);
  assert.equal(uniquePartnerGeocodePoint(request, [candidate, { ...candidate, longitude: -0.53 }]), null);
  assert.equal(uniquePartnerGeocodePoint(request, [{ ...candidate, longitude: null }]), null);
  assert.equal(uniquePartnerGeocodePoint(request, [{ ...candidate, latitude: "" }]), null);
});
