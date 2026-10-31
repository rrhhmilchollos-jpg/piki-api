import { XATIVA_COVERAGE_POLICY, requiredVehiclesForRoute, type VehicleClass } from "./xativaPolicy.js";

export type DeliveryRouteQuote = {
  routeDistanceKm: number | null;
  routeDurationMinutes: number | null;
  routeProvider: "google_maps" | "osrm" | "unavailable";
  routingDegraded: boolean;
  requiredVehicleClasses: VehicleClass[];
};

const cache = new Map<string, { expiresAt: number; value: DeliveryRouteQuote }>();
const timeoutMs = 4_500;

function cacheKey(origin: [number, number], destination: [number, number]) {
  return `${origin.map((value) => value.toFixed(5)).join(",")}:${destination.map((value) => value.toFixed(5)).join(",")}`;
}

function degradedQuote(): DeliveryRouteQuote {
  return {
    routeDistanceKm: null,
    routeDurationMinutes: null,
    routeProvider: "unavailable",
    routingDegraded: true,
    requiredVehicleClasses: requiredVehiclesForRoute(null),
  };
}

/**
 * Resolves restaurant → customer road distance once when the order is created.
 * The result is persisted in the order and is never recalculated at dispatch.
 * OSRM is configurable so production can move to a contracted routing provider
 * without changing policy semantics.
 */
export async function quoteDeliveryRoute(origin: [number, number], destination: [number, number]): Promise<DeliveryRouteQuote> {
  const key = cacheKey(origin, destination);
  const existing = cache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.value;

  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const googleKey = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
    if (googleKey) {
      try {
        const googleUrl = new URL("https://maps.googleapis.com/maps/api/directions/json");
        googleUrl.searchParams.set("origin", `${origin[1]},${origin[0]}`);
        googleUrl.searchParams.set("destination", `${destination[1]},${destination[0]}`);
        googleUrl.searchParams.set("mode", "driving");
        googleUrl.searchParams.set("language", "es");
        googleUrl.searchParams.set("region", "es");
        googleUrl.searchParams.set("key", googleKey);
        const response = await fetch(googleUrl, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "PIKI-Delivery/0.2 routing" } });
        const payload = await response.json().catch(() => null) as { status?: string; routes?: Array<{ legs?: Array<{ distance?: { value?: number }; duration?: { value?: number } }> }> } | null;
        const leg = response.ok && payload?.status === "OK" ? payload.routes?.[0]?.legs?.[0] : undefined;
        const distanceMeters = leg?.distance?.value;
        const durationSeconds = leg?.duration?.value;
        if (typeof distanceMeters === "number" && Number.isFinite(distanceMeters) && distanceMeters > 0 && typeof durationSeconds === "number" && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
          const routeDistanceKm = Math.round((distanceMeters / 1000) * 1000) / 1000;
          const value: DeliveryRouteQuote = { routeDistanceKm, routeDurationMinutes: Math.max(1, Math.ceil(durationSeconds / 60)), routeProvider: "google_maps", routingDegraded: false, requiredVehicleClasses: requiredVehiclesForRoute(routeDistanceKm) };
          cache.set(key, { expiresAt: Date.now() + 10 * 60_000, value });
          return value;
        }
        console.warn("Google Maps route unavailable; falling back to OSRM", payload?.status || `http_${response.status}`);
      } catch (error) {
        // Do not log the exception: a fetch error can contain the URL and API key.
        console.warn("Google Maps route request failed; falling back to OSRM", error instanceof Error ? error.name : "unknown_error");
      }
    }
    clearTimeout(timer);
    controller = new AbortController();
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const base = String(process.env.ROUTING_OSRM_URL || "https://router.project-osrm.org").replace(/\/$/, "");
    const url = `${base}/route/v1/driving/${origin[0]},${origin[1]};${destination[0]},${destination[1]}?overview=false&alternatives=false&steps=false`;
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "PIKI-Delivery/0.2 routing" } });
    const payload = await response.json().catch(() => null) as { code?: string; routes?: Array<{ distance?: number; duration?: number }> } | null;
    const route = response.ok && payload?.code === "Ok" ? payload.routes?.[0] : undefined;
    const distanceMeters = route?.distance;
    const durationSeconds = route?.duration;
    if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters <= 0 || typeof durationSeconds !== "number" || !Number.isFinite(durationSeconds) || durationSeconds < 0) throw new Error("ROUTING_RESPONSE_INVALID");
    const routeDistanceKm = Math.round((distanceMeters / 1000) * 1000) / 1000;
    const value: DeliveryRouteQuote = { routeDistanceKm, routeDurationMinutes: Math.max(1, Math.ceil(durationSeconds / 60)), routeProvider: "osrm", routingDegraded: false, requiredVehicleClasses: requiredVehiclesForRoute(routeDistanceKm) };
    cache.set(key, { expiresAt: Date.now() + 10 * 60_000, value });
    return value;
  } catch (error) {
    console.warn("Delivery routing unavailable; applying conservative vehicle restriction", error instanceof Error ? error.message : error);
    const value = degradedQuote();
    cache.set(key, { expiresAt: Date.now() + 30_000, value });
    return value;
  } finally {
    clearTimeout(timer);
  }
}

export const routeVehicleThresholdKm = XATIVA_COVERAGE_POLICY.routeVehicleThresholdKm;
