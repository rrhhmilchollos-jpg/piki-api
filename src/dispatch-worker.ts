import "dotenv/config";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { ensureIndexes } from "./models.js";
import { processDispatchOutboxBatch, type DispatchOutboxEvent } from "./dispatchOutbox.js";

const databaseName = process.env.MONGODB_DB || "piki";
const pollMs = Math.max(250, Number(process.env.PIKI_DISPATCH_WORKER_POLL_MS || 1_000));
const batchSize = Math.max(1, Math.min(100, Number(process.env.PIKI_DISPATCH_WORKER_BATCH_SIZE || 25)));
const workerId = String(process.env.PIKI_DISPATCH_WORKER_ID || `dispatch-${process.pid}-${randomUUID()}`);
let stopping = false;

function retryableDispatchState(state: unknown) {
  return ["no_eligible_rider", "reservation_race", "database_unavailable", "in_progress"].includes(String(state));
}

async function start() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is required for the dispatch worker");
  // server.ts exports the existing offer/expiry behavior. Setting this before
  // the dynamic import guarantees this worker never binds an HTTP listener.
  process.env.PIKI_NO_LISTEN = "true";
  const dispatch = await import("./server.js");
  await mongoose.connect(uri, { dbName: databaseName, serverSelectionTimeoutMS: 10_000, socketTimeoutMS: 45_000, maxPoolSize: 20, minPoolSize: 2, retryWrites: true });
  await ensureIndexes();
  console.log(JSON.stringify({ event: "dispatch_worker_started", workerId, pollMs, batchSize }));

  const handle = async (event: DispatchOutboxEvent) => {
    const preferredRiderId = event.payload?.preferredRiderId;
    const result = await dispatch.queueAutomaticDispatch(new mongoose.Types.ObjectId(String(event.orderId)), preferredRiderId && mongoose.isValidObjectId(preferredRiderId) ? new mongoose.Types.ObjectId(preferredRiderId) : undefined);
    if (retryableDispatchState(result.state)) throw new Error(`DISPATCH_${String(result.state).toUpperCase()}`);
  };

  const poll = async () => {
    if (stopping) return;
    try {
      // Expiry and late-pickup recovery are executed in this dedicated worker,
      // never by a web API interval. Each recovery writes a new outbox event.
      await dispatch.runDispatchMaintenance();
      const result = await processDispatchOutboxBatch(workerId, handle, { batchSize });
      if (result.processed || result.deadLettered) console.log(JSON.stringify({ event: "dispatch_outbox_batch", workerId, ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: "dispatch_worker_error", workerId, error: error instanceof Error ? error.message : String(error) }));
    }
    if (!stopping) setTimeout(poll, pollMs).unref();
  };
  await poll();
}

function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ event: "dispatch_worker_stopping", workerId, signal }));
  setTimeout(() => { void mongoose.disconnect().finally(() => process.exit(0)); }, 0).unref();
  setTimeout(() => process.exit(1), 25_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
start().catch((error) => { console.error("Unable to start dispatch worker", error); process.exit(1); });
