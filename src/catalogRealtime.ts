import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import mongoose from "mongoose";
import { Restaurant } from "./models.js";
import { COMING_SOON_SLUGS, CUSTOMER_HIDDEN_TEST_SLUGS } from "./customerCatalogPolicy.js";

export type CatalogUpdate = {
  type: "catalog.updated";
  payload: { restaurantId?: string; slug?: string; reason: string };
};

// Whitelist public identifiers only, never Restaurant documents, contacts,
// change-stream updateDescription or authenticated operational events.
export function publicCatalogUpdate(restaurant: any, reason = "restaurant.updated"): CatalogUpdate {
  const slug = typeof restaurant?.slug === "string" ? restaurant.slug : "";
  const publicRestaurant = restaurant?.internalDemo !== true
    && !(CUSTOMER_HIDDEN_TEST_SLUGS as readonly string[]).includes(slug)
    && ((restaurant?.isActive === true && restaurant?.onboardingStatus === "approved" && restaurant?.availabilityStatus === "available" && restaurant?.menu?.length > 0)
      || ((COMING_SOON_SLUGS as readonly string[]).includes(slug) && restaurant?.availabilityStatus === "coming_soon" && restaurant?.onboardingStatus !== "rejected"));
  return {
    type: "catalog.updated",
    payload: publicRestaurant && restaurant?._id
      ? { restaurantId: String(restaurant._id), slug, reason }
      : { reason },
  };
}

export class CatalogEventStream {
  private events = new EventEmitter();
  private connections = new Map<string, number>();
  private totalConnections = 0;

  constructor(private maxConnections = 2_000, private maxConnectionsPerIp = 50) {
    this.events.setMaxListeners(0);
  }

  publish(event: CatalogUpdate) { this.events.emit("update", event); }

  serve(request: Request, response: Response) {
    const ip = request.ip || request.socket?.remoteAddress || "unknown";
    const connectionsForIp = this.connections.get(ip) || 0;
    if (this.totalConnections >= this.maxConnections || connectionsForIp >= this.maxConnectionsPerIp) {
      response.setHeader("Retry-After", "20");
      return response.status(429).json({ error: "CATALOG_STREAM_LIMIT" });
    }
    this.connections.set(ip, connectionsForIp + 1);
    this.totalConnections += 1;
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    const listener = (event: CatalogUpdate) => {
      if (!response.destroyed && !response.writableEnded) {
        // Do not accumulate an unbounded buffer for a stalled receiver.
        if (!response.write(`event: catalog.updated\ndata: ${JSON.stringify(event)}\n\n`)) response.end();
      }
    };
    this.events.on("update", listener);
    const heartbeat = setInterval(() => {
      if (!response.destroyed && !response.writableEnded && !response.write(": heartbeat\n\n")) response.end();
    }, 20_000);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      this.events.off("update", listener);
      this.totalConnections -= 1;
      const remaining = (this.connections.get(ip) || 1) - 1;
      if (remaining > 0) this.connections.set(ip, remaining);
      else this.connections.delete(ip);
    };
    request.once("close", close);
    response.once("close", close);
    response.flushHeaders();
    // Subscribe before ready; re-fetch on every ready recovers all missed
    // updates without opening the authenticated order outbox to visitors.
    response.write('event: ready\ndata: {"type":"ready","payload":{}}\n\n');
  }
}

const catalogStream = new CatalogEventStream();
export const serveCatalogEvents = (request: Request, response: Response) => catalogStream.serve(request, response);

export async function publishCatalogUpdate(_restaurantId: unknown, reason: string) {
  // A generic local invalidation needs no extra DB read and cannot leak ids
  // when the update pauses/hides the restaurant. The relay adds public ids.
  catalogStream.publish(publicCatalogUpdate(null, reason));
}

let activeWatch: ReturnType<typeof Restaurant.watch> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let stopped = false;

export function startCatalogRelay() {
  if (activeWatch || mongoose.connection.readyState !== 1) return;
  stopped = false;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  const scheduleRetry = () => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => { retryTimer = undefined; startCatalogRelay(); }, 5_000);
    retryTimer.unref();
  };
  try {
    const changes = Restaurant.watch([], { fullDocument: "updateLookup" });
    activeWatch = changes;
    const recover = () => {
      // Old streams can fire close more than once. Only the active generation
      // may close/retry, and it is explicitly closed before replacement.
      if (activeWatch !== changes) return;
      activeWatch = undefined;
      void changes.close().catch(() => undefined);
      scheduleRetry();
    };
    changes.on("change", (change: any) => {
      if (activeWatch === changes && ["insert", "update", "replace", "delete"].includes(change.operationType)) {
        catalogStream.publish(publicCatalogUpdate(change.fullDocument, `restaurant.${change.operationType}`));
      }
    });
    changes.on("error", () => {
      if (activeWatch !== changes) return;
      console.warn("Catalog change-stream unavailable; local events and Customer revalidation remain active");
      recover();
    });
    changes.on("close", recover);
  } catch { scheduleRetry(); }
}

export function stopCatalogRelay() {
  stopped = true;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = undefined; }
  const previous = activeWatch;
  activeWatch = undefined;
  if (previous) void previous.close().catch(() => undefined);
}
