/**
 * Seguimiento en vivo del rider.
 *
 * El rider emite su posición cada pocos segundos mientras lleva un pedido. La
 * API guarda solo la última posición (no un histórico) con caducidad, y el
 * cliente, flota y soporte la leen. Si la posición deja de llegar, el cliente
 * ve "sin señal" en lugar de un punto congelado.
 *
 * Este módulo contiene la lógica pura: validación, frescura y estimación de
 * llegada. El transporte (endpoints) y el mapa se apoyan en esto.
 */

export type RiderPing = {
  orderId: string;
  riderId: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  headingDegrees?: number;
  speedMps?: number;
  at: Date;
};

/** Más de 90 s sin señal y el cliente no debe ver el punto como fiable. */
export const STALE_AFTER_SECONDS = 90;

/** Solo guardamos la última posición de cada pedido. */
export const RETENTION_HOURS = 12;

export function isValidCoordinate(latitude: number, longitude: number): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180 &&
    !(latitude === 0 && longitude === 0)
  );
}

/** Un ping con precisión peor de 150 m no sirve para guiar a nadie. */
export function isValidAccuracy(accuracyMeters?: number): boolean {
  if (accuracyMeters === undefined) return true;
  return Number.isFinite(accuracyMeters) && accuracyMeters >= 0 && accuracyMeters <= 150;
}

export function sanitizePing(input: {
  orderId?: unknown;
  riderId?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  accuracyMeters?: unknown;
  headingDegrees?: unknown;
  speedMps?: unknown;
  now?: Date;
}): { ok: true; ping: RiderPing } | { ok: false; reason: string } {
  const orderId = typeof input.orderId === "string" ? input.orderId.trim() : "";
  const riderId = typeof input.riderId === "string" ? input.riderId.trim() : "";
  const latitude = Number(input.latitude);
  const longitude = Number(input.longitude);
  const accuracy = input.accuracyMeters === undefined ? undefined : Number(input.accuracyMeters);
  if (!orderId) return { ok: false, reason: "sin_pedido" };
  if (!riderId) return { ok: false, reason: "sin_rider" };
  if (!isValidCoordinate(latitude, longitude)) return { ok: false, reason: "coordenadas_invalidas" };
  if (!isValidAccuracy(accuracy)) return { ok: false, reason: "precision_insuficiente" };
  return {
    ok: true,
    ping: {
      orderId,
      riderId,
      latitude,
      longitude,
      accuracyMeters: accuracy,
      headingDegrees: Number.isFinite(Number(input.headingDegrees)) ? Number(input.headingDegrees) : undefined,
      speedMps: Number.isFinite(Number(input.speedMps)) ? Number(input.speedMps) : undefined,
      at: input.now ?? new Date(),
    },
  };
}

export function isFresh(pingAt: Date, now = new Date()): boolean {
  const seconds = (now.getTime() - pingAt.getTime()) / 1000;
  return seconds >= 0 && seconds <= STALE_AFTER_SECONDS;
}

/** Distancia en metros entre dos puntos (haversine). */
export function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
): number {
  const R = 6371000;
  const toRad = (value: number) => (value * Math.PI) / 180;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/**
 * Estimación de llegada. Usa la velocidad real del rider si es creíble
 * (entre 3 y 14 m/s); si no, asume 6 m/s de media urbana.
 */
export function estimateArrival(input: {
  from: { latitude: number; longitude: number };
  to: { latitude: number; longitude: number };
  speedMps?: number;
}): { distanceMeters: number; etaMinutes: number } {
  const meters = distanceMeters(input.from, input.to);
  const speed = input.speedMps && input.speedMps >= 3 && input.speedMps <= 14 ? input.speedMps : 6;
  const minutes = Math.max(1, Math.round(meters / speed / 60));
  return { distanceMeters: meters, etaMinutes: minutes };
}

/** Lo que ve el cliente: nunca una posición vieja sin avisar. */
export function presentForCustomer(
  ping: RiderPing | null,
  destination: { latitude: number; longitude: number },
  now = new Date()
): { visible: boolean; status: "sin_senal" | "en_camino" | "llegando"; etaMinutes?: number; distanceMeters?: number } {
  if (!ping || !isFresh(ping.at, now)) return { visible: false, status: "sin_senal" };
  const { distanceMeters: meters, etaMinutes } = estimateArrival({ from: ping, to: destination, speedMps: ping.speedMps });
  return { visible: true, status: meters <= 250 ? "llegando" : "en_camino", etaMinutes, distanceMeters: meters };
}
