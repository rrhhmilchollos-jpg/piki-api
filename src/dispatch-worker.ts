import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import mongoose from "mongoose";
import { ensureIndexes } from "./models.js";
import { processDispatchOutboxBatch, type DispatchOutboxEvent } from "./dispatchOutbox.js";

const databaseName = process.env.MONGODB_DB || "piki";
const pollMs = Math.max(250, Number(process.env.PIKI_DISPATCH_WORKER_POLL_MS || 1_000));
const batchSize = Math.max(1, Math.min(100, Number(process.env.PIKI_DISPATCH_WORKER_BATCH_SIZE || 25)));
const workerId = String(process.env.PIKI_DISPATCH_WORKER_ID || `dispatch-${process.pid}-${randomUUID()}`);
let stopping = false;
let healthServer: Server | null = null;
const workerStartedAt = new Date().toISOString();
const workerStats = { polls: 0, pollErrors: 0, processed: 0, retried: 0, deadLettered: 0, lastPollAt: null as string | null, lastSuccessAt: null as string | null, lastError: null as string | null };

function workerHealth() {
  return { service: "piki-dispatch-worker", status: stopping ? "stopping" : "ready", workerId, startedAt: workerStartedAt, pollMs, batchSize, ...workerStats };
}

function metricsText() {
  const health = workerHealth();
  return [
    "# HELP piki_dispatch_worker_ready Whether the dispatch worker is running.",
    "# TYPE piki_dispatch_worker_ready gauge",
    `piki_dispatch_worker_ready ${stopping ? 0 : 1}`,
    "# TYPE piki_dispatch_worker_polls_total counter",
    `piki_dispatch_worker_polls_total ${health.polls}`,
    "# TYPE piki_dispatch_worker_poll_errors_total counter",
    `piki_dispatch_worker_poll_errors_total ${health.pollErrors}`,
    "# TYPE piki_dispatch_worker_events_processed_total counter",
    `piki_dispatch_worker_events_processed_total ${health.processed}`,
    "# TYPE piki_dispatch_worker_events_retried_total counter",
    `piki_dispatch_worker_events_retried_total ${health.retried}`,
    "# TYPE piki_dispatch_worker_events_dead_lettered_total counter",
    `piki_dispatch_worker_events_dead_lettered_total ${health.deadLettered}`,
  ].join("\n") + "\n";
}

function startHealthServer() {
  const port = Math.max(0, Number(process.env.PIKI_DISPATCH_HEALTH_PORT || process.env.PORT || 0));
  if (!port) return;
  const host = process.env.PIKI_DISPATCH_HEALTH_HOST || "0.0.0.0";
  healthServer = createServer((req, res) => {
    if (req.url === "/health" || req.url === "/ready") {
      res.writeHead(stopping ? 503 : 200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(workerHealth()));
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
      res.end(metricsText());
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "NOT_FOUND" }));
  });
  healthServer.listen(port, host, () => console.log(JSON.stringify({ event: "dispatch_worker_health_listening", host, port })));
}

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
  startHealthServer();
  console.log(JSON.stringify({ event: "dispatch_worker_started", workerId, pollMs, batchSize }));

  const handle = async (event: DispatchOutboxEvent) => {
    const preferredRiderId = event.payload?.preferredRiderId;
    const result = await dispatch.queueAutomaticDispatch(new mongoose.Types.ObjectId(String(event.orderId)), preferredRiderId && mongoose.isValidObjectId(preferredRiderId) ? new mongoose.Types.ObjectId(preferredRiderId) : undefined);
    if (retryableDispatchState(result.state)) throw new Error(`DISPATCH_${String(result.state).toUpperCase()}`);
  };

  const poll = async () => {
    if (stopping) return;
    workerStats.polls += 1;
    workerStats.lastPollAt = new Date().toISOString();
    try {
      // Expiry and late-pickup recovery are executed in this dedicated worker,
      // never by a web API interval. Each recovery writes a new outbox event.
      await dispatch.runDispatchMaintenance();
      const result = await processDispatchOutboxBatch(workerId, handle, { batchSize });
      workerStats.processed += result.processed;
      workerStats.deadLettered += result.deadLettered;
      workerStats.lastSuccessAt = new Date().toISOString();
      workerStats.lastError = null;
      if (result.processed || result.deadLettered) console.log(JSON.stringify({ event: "dispatch_outbox_batch", workerId, ...result }));
    } catch (error) {
      workerStats.pollErrors += 1;
      workerStats.lastError = error instanceof Error ? error.message : String(error);
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
  healthServer?.close();
  setTimeout(() => { void mongoose.disconnect().finally(() => process.exit(0)); }, 0).unref();
  setTimeout(() => process.exit(1), 25_000).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
start().catch((error) => { console.error("Unable to start dispatch worker", error); process.exit(1); });
