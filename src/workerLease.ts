import mongoose from "mongoose";

/**
 * Lease compartido en MongoDB para que solo una instancia ejecute un barrido.
 *
 * Render puede servir la API con varias instancias y cada una arranca sus
 * workers. Sin lease, dos instancias procesan el mismo turno y el rider recibe
 * el aviso dos veces. El lease es la barrera: quien lo consigue trabaja, el
 * resto registra que se ha saltado la pasada.
 */

export type WorkerLease = { name: string; owner: string; until: Date };

function leases() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("WORKER_LEASE_NO_DATABASE");
  return db.collection<{ _id: string; owner: string; until: Date; updatedAt: Date }>("worker_leases");
}

export async function acquireWorkerLease(name: string, ttlMs: number, owner: string): Promise<boolean> {
  const now = new Date();
  const until = new Date(now.getTime() + Math.max(30_000, ttlMs));
  try {
    const collection = leases();
    const renewed = await collection.updateOne(
      { _id: name, until: { $lte: now } },
      { $set: { owner, until, updatedAt: now } },
    );
    if (renewed.modifiedCount > 0) return true;
    const existing = await collection.findOne({ _id: name });
    if (existing) return false;
    await collection.insertOne({ _id: name, owner, until, updatedAt: now });
    return true;
  } catch (error: any) {
    // Carrera entre dos instancias al insertar: la otra se quedó el lease.
    if (error?.code === 11000) return false;
    throw error;
  }
}

export async function releaseWorkerLease(name: string, owner: string): Promise<void> {
  try {
    await leases().updateOne({ _id: name, owner }, { $set: { until: new Date(0), updatedAt: new Date() } });
  } catch {
    // Liberar es best-effort: si falla, el lease caduca solo.
  }
}

export async function withWorkerLease<T>(name: string, ttlMs: number, owner: string, work: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
  const acquired = await acquireWorkerLease(name, ttlMs, owner);
  if (!acquired) return { acquired: false };
  try {
    return { acquired: true, result: await work() };
  } finally {
    await releaseWorkerLease(name, owner);
  }
}
