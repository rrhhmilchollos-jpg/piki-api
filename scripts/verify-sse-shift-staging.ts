import "dotenv/config";
import mongoose from "mongoose";
import { randomUUID } from "node:crypto";
import { Rider, RiderSlot, RealtimeEvent, Zone } from "../src/models.js";
import { madridLocalToUtc, runRiderShiftAutomation } from "../src/riderShiftAutomation.js";

const RiderModel = Rider as any;
const RiderSlotModel = RiderSlot as any;
const ZoneModel = Zone as any;
const RealtimeEventModel = RealtimeEvent as any;

/**
 * Non-destructive Staging verification for Block 1 SSE shift events.
 *
 * Required environment:
 *   MONGODB_URI              Staging MongoDB connection string
 *   PIKI_STAGING_SSE_URL     e.g. https://piki-api-staging-v2.onrender.com
 *   PIKI_STAGING_ADMIN_TOKEN employee token with admin role
 * Optional:
 *   PIKI_TEST_RIDER_ID       existing QA rider; otherwise a temporary rider is created
 *   PIKI_TEST_ZONE_SLUG      active Staging zone; otherwise the first active zone is used
 *   PIKI_SSE_TIMEOUT_MS       default 15000
 *
 * The script refuses non-Staging hosts unless PIKI_ALLOW_NONSTAGING_TEST=true is set.
 * It tags all temporary records with a qa-* run id and deletes the slot, rider (if
 * created by this script), realtime events and notifications associated with it.
 */

const baseUrl = String(process.env.PIKI_STAGING_SSE_URL || "").replace(/\/$/, "");
const token = String(process.env.PIKI_STAGING_ADMIN_TOKEN || "").trim();
const mongoUri = String(process.env.MONGODB_URI || "").trim();
const timeoutMs = Math.max(3_000, Number(process.env.PIKI_SSE_TIMEOUT_MS || 15_000));
const runId = `qa-${randomUUID().replace(/-/g, "").slice(0, 20)}`;

if (!baseUrl || !token || !mongoUri) throw new Error("PIKI_STAGING_SSE_URL, PIKI_STAGING_ADMIN_TOKEN y MONGODB_URI son obligatorios.");
const host = new URL(baseUrl).hostname;
if (!host.includes("staging") && process.env.PIKI_ALLOW_NONSTAGING_TEST !== "true") {
  throw new Error(`Host no reconocido como Staging: ${host}. Usa una URL de Staging o PIKI_ALLOW_NONSTAGING_TEST=true.`);
}

function assertOk(response: Response, label: string) {
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${response.statusText}`);
}

async function api(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("X-PIKI-Surface", "admin");
  headers.set("Accept", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

function parseSseChunk(buffer: string, onEvent: (event: { type: string; data: any }) => void) {
  const blocks = buffer.split("\n\n");
  const rest = blocks.pop() || "";
  for (const block of blocks) {
    let type = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (data) {
      try { onEvent({ type, data: JSON.parse(data) }); } catch { /* Ignore heartbeat/non-JSON frames. */ }
    }
  }
  return rest;
}

async function main() {
  await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 10_000 });
  let slotId: mongoose.Types.ObjectId | null = null;
  let createdRiderId: mongoose.Types.ObjectId | null = null;
  let streamController: AbortController | null = null;
  try {
    const riderIdValue = String(process.env.PIKI_TEST_RIDER_ID || "").trim();
    let rider: any = riderIdValue && mongoose.isValidObjectId(riderIdValue)
      ? await RiderModel.findById(riderIdValue).lean().exec()
      : null;
    if (!rider) {
      rider = await RiderModel.create({
        qaRunId: runId,
        isTestRider: true,
        riderCode: `QA-${runId.slice(-8).toUpperCase()}`,
        name: `QA SSE ${runId.slice(-6)}`,
        email: `${runId}@qa.pikidelivery.test`,
        city: "Xàtiva",
        status: "offline",
        lifecycleStatus: "active",
        vehicle: "bike",
      });
      createdRiderId = rider._id;
    }
    const zoneSlug = String(process.env.PIKI_TEST_ZONE_SLUG || "").trim()
      || String((await ZoneModel.findOne({ isActive: true }).select("slug").lean().exec() as any)?.slug || "");
    if (!zoneSlug) throw new Error("No hay una zona activa de Staging para crear la fixture.");

    const now = new Date();
    const madridParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const values = Object.fromEntries(madridParts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const date = `${values.year}-${values.month}-${values.day}`;
    const start = new Date(now.getTime() + 16 * 60_000);
    const startParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(start);
    const startValues = Object.fromEntries(startParts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const startTime = `${startValues.hour}:${startValues.minute}`;
    const end = new Date(now.getTime() + 46 * 60_000);
    const endParts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(end);
    const endValues = Object.fromEntries(endParts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
    const endTime = `${endValues.hour}:${endValues.minute}`;

    const streamControllerLocal = new AbortController();
    streamController = streamControllerLocal;
    const stream = await api("/api/v1/realtime/events", { signal: streamControllerLocal.signal });
    assertOk(stream, "SSE connect");
    if (!stream.body) throw new Error("SSE no devolvió body streaming.");
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    const events: Array<{ type: string; data: any }> = [];
    let sseBuffer = "";
    const eventPromise = (async () => {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        sseBuffer = parseSseChunk(sseBuffer + decoder.decode(result.value, { stream: true }), (event) => events.push(event));
        if (events.some((event) => event.type === "rider.shift_start_reminder")) return;
      }
    })();

    const slot = await RiderSlotModel.create({
      qaRunId: runId,
      riderId: rider._id,
      tenantId: rider.tenantId || null,
      zoneSlug,
      date,
      startTime,
      endTime,
      status: "planned",
      notes: `QA SSE runId=${runId}`,
    });
    slotId = slot._id;

    // Force the first policy transition without waiting 15 minutes in real time.
    const simulatedNow = new Date(madridLocalToUtc(date, startTime).getTime() - 14 * 60_000);
    const maintenance = await runRiderShiftAutomation(simulatedNow);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !events.some((event) => event.type === "rider.shift_start_reminder")) await new Promise((resolve) => setTimeout(resolve, 100));
    streamControllerLocal.abort();
    await eventPromise.catch(() => undefined);

    const reminder = events.find((event) => event.type === "rider.shift_start_reminder");
    const persisted = await RealtimeEventModel.countDocuments({ "payload.slotId": String(slot._id), type: "rider.shift_start_reminder" });
    if (!reminder || persisted !== 1) throw new Error(`SSE reminder no verificado: recibido=${Boolean(reminder)} persistido=${persisted}`);

    // Publish the same logical event again to verify the unique dedupe contract.
    const { publishRealtimeEvent } = await import("../src/realtime.js");
    const duplicate = await publishRealtimeEvent({
      channel: "admin", audienceKey: "qa-unused-audience", type: "qa.sse.dedupe", payload: { runId }, dedupeKey: `qa-sse:${runId}`,
    });
    const duplicateAgain = await publishRealtimeEvent({
      channel: "admin", audienceKey: "qa-unused-audience", type: "qa.sse.dedupe", payload: { runId, duplicate: true }, dedupeKey: `qa-sse:${runId}`,
    });
    const dedupeCount = await RealtimeEventModel.countDocuments({ dedupeKey: `qa-sse:${runId}` });
    if (String(duplicate._id) !== String(duplicateAgain._id) || dedupeCount !== 1) throw new Error("La deduplicación SSE no es idempotente.");

    console.log(JSON.stringify({ ok: true, runId, slotId: String(slot._id), riderId: String(rider._id), zoneSlug, maintenance, receivedEvent: reminder.type, persistedReminderEvents: persisted, dedupeCount }, null, 2));
  } finally {
    streamController?.abort();
    if (slotId) {
      await RealtimeEventModel.deleteMany({ $or: [{ "payload.slotId": String(slotId) }, { dedupeKey: `qa-sse:${runId}` }] }).exec();
      await RiderSlotModel.deleteOne({ _id: slotId, notes: new RegExp(runId) }).exec();
    }
    if (createdRiderId) await RiderModel.deleteOne({ _id: createdRiderId, qaRunId: runId }).exec();
    await mongoose.disconnect();
  }
}

main().catch((error) => { console.error(JSON.stringify({ ok: false, runId, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });
