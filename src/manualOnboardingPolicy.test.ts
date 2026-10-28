import assert from "node:assert/strict";
import test from "node:test";
import { missingPartnerDocumentTypes, missingRiderDocumentTypes, requiredRiderDocumentTypes } from "./manualOnboardingPolicy.js";

test("manual onboarding requires identity, bank certificate and at least three documents for a bicycle rider", () => {
  assert.deepEqual(requiredRiderDocumentTypes("bike"), ["bank_certificate"]);
  assert.deepEqual(missingRiderDocumentTypes("bike", ["identity", "bank_certificate", "profile_photo"]), []);
  assert.deepEqual(missingRiderDocumentTypes("bike", ["bank_certificate"]), ["identity or residence_permit", "at least 3 documents"]);
});

test("residence permit replaces identity and motor vehicles need their supporting papers", () => {
  assert.deepEqual(missingRiderDocumentTypes("motorcycle", [
    "residence_permit", "bank_certificate", "profile_photo", "driving_license", "insurance", "vehicle_registration", "vehicle_technical_sheet",
  ]), []);
});

test("electric scooters need a responsible declaration and DGT homologation", () => {
  assert.deepEqual(missingRiderDocumentTypes("electric_scooter", ["identity", "bank_certificate", "profile_photo"]), ["scooter_responsible_declaration", "dgt_mvp_homologation"]);
});

test("Partners need all five documents before their expediente can be stored", () => {
  assert.deepEqual(missingPartnerDocumentTypes(["tax_id", "bank_certificate", "activity_license", "insurance", "food_sanitary_authorization"]), []);
  assert.deepEqual(missingPartnerDocumentTypes(["tax_id", "insurance"]), ["bank_certificate", "activity_license", "food_sanitary_authorization"]);
});
