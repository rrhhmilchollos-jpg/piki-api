export type RiderVehicle = "bike" | "electric_bike" | "electric_scooter" | "motorcycle" | "scooter" | "car";

export const REQUIRED_PARTNER_DOCUMENT_TYPES = [
  "tax_id",
  "bank_certificate",
  "activity_license",
  "insurance",
  "food_sanitary_authorization",
] as const;

export function requiredRiderDocumentTypes(vehicle: RiderVehicle): string[] {
  const required = ["bank_certificate"];
  // Identity/residence permit is an alternative and is validated separately.
  if (["motorcycle", "scooter", "car"].includes(vehicle)) {
    required.push("driving_license", "insurance", "vehicle_registration", "vehicle_technical_sheet");
  }
  if (vehicle === "electric_scooter") {
    required.push("scooter_responsible_declaration", "dgt_mvp_homologation");
  }
  return required;
}

export function missingRiderDocumentTypes(vehicle: RiderVehicle, submittedTypes: Iterable<string>): string[] {
  const types = new Set(submittedTypes);
  const missing = requiredRiderDocumentTypes(vehicle).filter((type) => !types.has(type));
  if (!types.has("identity") && !types.has("residence_permit")) missing.unshift("identity or residence_permit");
  if (types.size < 3) missing.push("at least 3 documents");
  return missing;
}

export function missingPartnerDocumentTypes(submittedTypes: Iterable<string>): string[] {
  const types = new Set(submittedTypes);
  return REQUIRED_PARTNER_DOCUMENT_TYPES.filter((type) => !types.has(type));
}
