import { CUSTOMER_ORDERABLE_RESTAURANT_FILTER } from "./customerCatalogPolicy.js";

type PartnerLocationRecord = {
  _id?: unknown;
  address?: unknown;
  locality?: unknown;
  location?: { coordinates?: unknown } | null;
  partnerProfile?: { operatingAddress?: unknown; city?: unknown; postalCode?: unknown } | null;
};

type GeocodeRequest = { address: string; locality: string; postalCode?: string };
type PhotonAddress = {
  city?: unknown;
  town?: unknown;
  village?: unknown;
  locality?: unknown;
  district?: unknown;
  street?: unknown;
  name?: unknown;
  housenumber?: unknown;
  postcode?: unknown;
};
type PhotonGeocodeCandidate = { latitude: unknown; longitude: unknown; address?: PhotonAddress };
type ParsedStreetAddress = { roadType: string | null; nameTokens: string[]; houseNumber: string | null };

function firstNonBlank(...values: unknown[]): string {
  return values.map((value) => String(value ?? "").trim()).find(Boolean) || "";
}

export function partnerOperationalAddress(value: unknown): string {
  const restaurant = value as PartnerLocationRecord | null | undefined;
  return firstNonBlank(restaurant?.address, restaurant?.partnerProfile?.operatingAddress);
}

export function partnerOperationalLocality(value: unknown): string {
  const restaurant = value as PartnerLocationRecord | null | undefined;
  return firstNonBlank(restaurant?.locality, restaurant?.partnerProfile?.city);
}

function validCoordinate(value: unknown, minimum: number, maximum: number): boolean {
  if (typeof value !== "number" && typeof value !== "string") return false;
  if (typeof value === "string" && !value.trim()) return false;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum;
}

export function validOperationalCoordinates(value: unknown): boolean {
  if (!Array.isArray(value) || value.length < 2) return false;
  if (!validCoordinate(value[0], -180, 180) || !validCoordinate(value[1], -90, 90)) return false;
  // Mongoose's GeoJSON schema defaults to [0,0]; that is a placeholder, not a Spanish pickup point.
  return Number(value[0]) !== 0 || Number(value[1]) !== 0;
}

/** Only customer-orderable partners need operational coordinates for dispatch. */
export function buildPartnerLocationBackfillFilter(): Record<string, unknown> {
  return { ...CUSTOMER_ORDERABLE_RESTAURANT_FILTER };
}

/** Snapshot guard: only persist coordinates if their source fields have not changed. */
export function buildPartnerLocationUpdateFilter(value: unknown): Record<string, unknown> {
  const restaurant = value as PartnerLocationRecord | null | undefined;
  return {
    _id: restaurant?._id,
    address: restaurant?.address ?? null,
    locality: restaurant?.locality ?? null,
    "partnerProfile.operatingAddress": restaurant?.partnerProfile?.operatingAddress ?? null,
    "partnerProfile.city": restaurant?.partnerProfile?.city ?? null,
    "partnerProfile.postalCode": restaurant?.partnerProfile?.postalCode ?? null,
    "location.coordinates": restaurant?.location?.coordinates ?? null,
  };
}

function normalizedText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-ES")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseStreetAddress(value: unknown): ParsedStreetAddress {
  const addressParts = String(value ?? "").split(",");
  let firstAddressPart = addressParts[0].trim();
  const commaHouseNumber = addressParts[1]?.trim();
  if (commaHouseNumber && /^\d+[a-z]?(?:\s*bis)?$/i.test(commaHouseNumber)) {
    firstAddressPart = `${firstAddressPart} ${commaHouseNumber}`;
  }
  firstAddressPart = firstAddressPart
    .replace(/^\s*c\s*\/\s*/i, "calle ")
    .replace(/^\s*av(?:da)?\.\s*/i, "avenida ")
    .replace(/\s+(?:bajo|bajos|entresuelo|principal|planta\s*\w*|piso\s*\w*|puerta\s*\w*|pta\.?\s*\w*)$/i, "")
    .trim();

  const houseMatch = /\s+(\d+[a-z]?(?:\s*bis)?)$/i.exec(firstAddressPart);
  const houseNumber = houseMatch ? normalizedText(houseMatch[1]).replace(/\s+/g, "") : null;
  if (houseMatch) firstAddressPart = firstAddressPart.slice(0, houseMatch.index).trim();

  const aliases: Record<string, string> = {
    c: "calle", calle: "calle", carrer: "calle",
    av: "avenida", avda: "avenida", avenida: "avenida", avinguda: "avenida",
    plaza: "plaza", placa: "plaza",
    paseo: "paseo", passeig: "paseo",
    camino: "camino", cami: "camino",
    carretera: "carretera", rua: "rua",
  };
  const articles = new Set(["de", "del", "la", "el", "los", "las", "y"]);
  const tokens = normalizedText(firstAddressPart).split(" ").filter(Boolean);
  const roadType = aliases[tokens[0]] || null;
  const nameTokens = tokens.slice(1).filter((token) => !articles.has(token));
  return { roadType, nameTokens, houseNumber };
}

function localityFromPhoton(address: PhotonAddress): string {
  return firstNonBlank(address.city, address.town, address.village, address.locality, address.district);
}

function normalizedPostcode(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

/** Reject uncertain Photon results rather than persisting a wrong pickup point. */
export function isValidPartnerGeocodeMatch(request: GeocodeRequest, result: PhotonAddress | undefined): boolean {
  if (!result) return false;
  const requestedLocality = normalizedText(request.locality);
  const resolvedLocality = normalizedText(localityFromPhoton(result));
  if (!requestedLocality || !resolvedLocality || requestedLocality !== resolvedLocality) return false;

  const requestedPostcode = normalizedPostcode(request.postalCode);
  if (requestedPostcode && normalizedPostcode(result.postcode) !== requestedPostcode) return false;

  const requestedStreet = parseStreetAddress(request.address);
  const resolvedStreet = parseStreetAddress(firstNonBlank(result.street, result.name));
  if (!requestedStreet.roadType || !resolvedStreet.roadType || requestedStreet.roadType !== resolvedStreet.roadType) return false;
  if (!requestedStreet.nameTokens.length || requestedStreet.nameTokens.join(" ") !== resolvedStreet.nameTokens.join(" ")) return false;
  if (!requestedStreet.houseNumber) return false;

  const resolvedHouseNumber = normalizedText(result.housenumber || resolvedStreet.houseNumber).replace(/\s+/g, "");
  return Boolean(resolvedHouseNumber) && requestedStreet.houseNumber === resolvedHouseNumber;
}

/** Return a point only when every matching result resolves to the same coordinates. */
export function uniquePartnerGeocodePoint(
  request: GeocodeRequest,
  results: readonly PhotonGeocodeCandidate[],
): [number, number] | null {
  const points = new Map<string, [number, number]>();
  for (const result of results) {
    const longitude = result.longitude;
    const latitude = result.latitude;
    if (typeof longitude !== "number" || typeof latitude !== "number") continue;
    if (!validOperationalCoordinates([longitude, latitude]) || !isValidPartnerGeocodeMatch(request, result.address)) continue;
    points.set(`${longitude},${latitude}`, [longitude, latitude]);
  }
  return points.size === 1 ? points.values().next().value || null : null;
}
