/**
 * Almacén de la última posición conocida de cada pedido.
 *
 * Solo se guarda un documento por pedido (no un histórico): se sobrescribe en
 * cada ping. Mongo borra el documento solo a las 12 h mediante un índice TTL,
 * de modo que no hace falta ninguna tarea de limpieza.
 *
 * El acceso a la colección se inyecta para poder probar sin base de datos.
 */

import type { RiderPing } from "./riderLocation.js";
import { RETENTION_HOURS } from "./riderLocation.js";

export type LocationDoc = {
  orderId: string;
  riderId: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  headingDegrees?: number;
  speedMps?: number;
  at: Date;
  expiresAt: Date;
};

export type LocationCollection = {
  createIndex(spec: Record<string, 1 | -1>, options?: Record<string, unknown>): Promise<unknown>;
  updateOne(
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
    options?: Record<string, unknown>
  ): Promise<unknown>;
  findOne(filter: Record<string, unknown>): Promise<LocationDoc | null>;
};

export function toDoc(ping: RiderPing): LocationDoc {
  return {
    orderId: ping.orderId,
    riderId: ping.riderId,
    latitude: ping.latitude,
    longitude: ping.longitude,
    accuracyMeters: ping.accuracyMeters,
    headingDegrees: ping.headingDegrees,
    speedMps: ping.speedMps,
    at: ping.at,
    expiresAt: new Date(ping.at.getTime() + RETENTION_HOURS * 36e5),
  };
}

/** Índice único por pedido + TTL para que Mongo limpie solo. */
export async function ensureLocationIndexes(collection: LocationCollection): Promise<void> {
  await collection.createIndex({ orderId: 1 }, { unique: true });
  await collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
}

export async function savePing(collection: LocationCollection, ping: RiderPing): Promise<LocationDoc> {
  const doc = toDoc(ping);
  await collection.updateOne(
    { orderId: doc.orderId },
    {
      $set: doc,
    },
    { upsert: true }
  );
  return doc;
}

export async function readPing(collection: LocationCollection, orderId: string): Promise<LocationDoc | null> {
  if (!orderId) return null;
  return collection.findOne({ orderId });
}

/** El rider solo puede escribir posición de un pedido que lleva él. */
export function riderOwnsOrder(doc: { riderId: string } | null, riderId: string): boolean {
  if (!doc || !riderId) return true; // primer ping del pedido
  return doc.riderId === riderId;
}
