/**
 * PIKI weather engine.
 *
 * The only thing PIKI needs from the sky is a decision: does it rain or blow
 * hard enough that the Customer should see a longer ETA and nearby
 * restaurants first? So this module keeps a tiny, cached, fail-open contract
 * instead of a full meteorological model.
 *
 * Provider: Open-Meteo, no API key, no PII. If the provider is slow or down we
 * return `null` and the app behaves exactly as before; weather must never break
 * an order.
 */

export type WeatherCondition = "clear" | "cloudy" | "rain" | "storm";

export type WeatherSnapshot = {
  condition: WeatherCondition;
  label: string;
  precipitationMm: number;
  windKmh: number;
  temperatureC: number | null;
  severity: 0 | 1 | 2;
  etaExtraMinutes: number;
  preferNearby: boolean;
  banner: string | null;
  checkedAt: string;
  source: "open-meteo" | "unavailable";
};

export type DeliveryWeatherPolicy = Pick<WeatherSnapshot, "condition" | "severity" | "etaExtraMinutes" | "preferNearby" | "banner" | "label">;

const PROVIDER_URL = "https://api.open-meteo.com/v1/forecast";
const CACHE_TTL_MS = 10 * 60_000;
const FETCH_TIMEOUT_MS = 2_500;

type CacheEntry = { expiresAt: number; snapshot: WeatherSnapshot };
const cache = new Map<string, CacheEntry>();

/** WMO weather codes, grouped to the three states PIKI actually reacts to. */
export function conditionFromWeatherCode(code: number | null | undefined): WeatherCondition {
  const value = Number(code);
  if (!Number.isFinite(value)) return "clear";
  if (value >= 95) return "storm";
  if ((value >= 51 && value <= 67) || (value >= 80 && value <= 82)) return "rain";
  if (value >= 71 && value <= 77) return "rain";
  if (value === 45 || value === 48) return "cloudy";
  if (value >= 1 && value <= 3) return "cloudy";
  return "clear";
}

export const WEATHER_LABELS: Record<WeatherCondition, string> = {
  clear: "Despejado",
  cloudy: "Nublado",
  rain: "Lluvia",
  storm: "Tormenta",
};

/**
 * The operational policy. 15 minutes is the number agreed for rider safety in
 * rain and storm; 5 minutes covers wind and light rain that still slows the
 * scooter without changing the promise to the Customer.
 */
export function deliveryPolicyFor(condition: WeatherCondition, precipitationMm: number, windKmh: number): DeliveryWeatherPolicy {
  const precip = Math.max(0, Number(precipitationMm) || 0);
  const wind = Math.max(0, Number(windKmh) || 0);
  if (condition === "storm" || precip >= 4 || wind >= 60) {
    return {
      condition: condition === "storm" ? "storm" : "rain",
      severity: 2,
      etaExtraMinutes: 15,
      preferNearby: true,
      label: condition === "storm" ? WEATHER_LABELS.storm : WEATHER_LABELS.rain,
      banner: "Lluvia fuerte en la zona. Añadimos 15 minutos al tiempo estimado por seguridad de los riders y priorizamos los locales más cercanos.",
    };
  }
  if (condition === "rain" || precip >= 0.5 || wind >= 35) {
    return {
      condition: "rain",
      severity: 1,
      etaExtraMinutes: 10,
      preferNearby: true,
      label: WEATHER_LABELS.rain,
      banner: "Está lloviendo. El tiempo estimado sube unos 10 minutos para que los riders vayan con margen.",
    };
  }
  if (condition === "cloudy") {
    return { condition: "cloudy", severity: 0, etaExtraMinutes: 0, preferNearby: false, label: WEATHER_LABELS.cloudy, banner: null };
  }
  return { condition: "clear", severity: 0, etaExtraMinutes: 0, preferNearby: false, label: WEATHER_LABELS.clear, banner: null };
}

/** Normalises the provider payload (kept pure so it can be tested). */
export function snapshotFromProvider(payload: any, at: Date = new Date()): WeatherSnapshot {
  const current = payload?.current || payload?.current_weather || {};
  const condition = conditionFromWeatherCode(current.weather_code ?? current.weathercode);
  const precipitationMm = Number(current.precipitation ?? 0) || 0;
  const windKmh = Number(current.wind_speed_10m ?? current.windspeed_10m ?? 0) || 0;
  const temperature = Number(current.temperature_2m ?? current.temperature);
  const policy = deliveryPolicyFor(condition, precipitationMm, windKmh);
  return {
    ...policy,
    precipitationMm,
    windKmh,
    temperatureC: Number.isFinite(temperature) ? temperature : null,
    checkedAt: at.toISOString(),
    source: "open-meteo",
  };
}

function cacheKey(lat: number, lon: number) {
  return `${lat.toFixed(2)},${lon.toFixed(2)}`;
}

export function unavailableSnapshot(): WeatherSnapshot {
  const policy = deliveryPolicyFor("clear", 0, 0);
  return { ...policy, precipitationMm: 0, windKmh: 0, temperatureC: null, checkedAt: new Date().toISOString(), source: "unavailable" };
}

/**
 * Cached snapshot for a point. Never throws: a provider failure returns a
 * neutral snapshot marked `unavailable`, which the UI renders as "no banner".
 */
export async function currentWeather(lat: number, lon: number, options: { force?: boolean; now?: Date } = {}): Promise<WeatherSnapshot> {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return unavailableSnapshot();
  const now = options.now || new Date();
  const key = cacheKey(lat, lon);
  const cached = cache.get(key);
  if (!options.force && cached && cached.expiresAt > now.getTime()) return cached.snapshot;

  const url = `${PROVIDER_URL}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=Europe%2FMadrid`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`WEATHER_HTTP_${response.status}`);
    const payload = await response.json();
    const snapshot = snapshotFromProvider(payload, now);
    cache.set(key, { expiresAt: now.getTime() + CACHE_TTL_MS, snapshot });
    return snapshot;
  } catch (error) {
    console.warn(JSON.stringify({ event: "weather_unavailable", error: error instanceof Error ? error.message : String(error) }));
    const fallback = cached?.snapshot || unavailableSnapshot();
    cache.set(key, { expiresAt: now.getTime() + 60_000, snapshot: fallback });
    return { ...fallback, source: fallback.source };
  }
}

/** Straight-line distance in km, enough to reorder a feed by proximity. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radius = 6_371;
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Adds the safety margin to an "MM–MM min" range without breaking the string. */
export function adjustEtaLabel(label: string, extraMinutes: number): string {
  if (!extraMinutes) return label;
  const numbers = String(label).match(/\d+/g);
  if (!numbers || numbers.length < 1) return label;
  const shifted = numbers.map((value) => String(Number(value) + extraMinutes));
  if (shifted.length === 1) return `${shifted[0]} min`;
  return `${shifted[0]}–${shifted[1]} min`;
}
