#!/usr/bin/env node
/**
 * PIKI Delivery — one dispatch window for one PostGIS zone.
 *
 * This worker is intentionally fail-closed for bundles: without a road-routing
 * provider it still offers single orders, but it does not claim that straight-line
 * distance is an optimised multi-stop route. Run it from a Render worker/cron with
 * PIKI_POSTGIS_URL, PIKI_DISPATCH_ZONE_ID and PIKI_ROUTING_URL configured.
 */
import process from "node:process";
import { Pool } from "pg";

const required = (name) => {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const integer = (name, fallback, minimum, maximum) => {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
};

const configuration = {
  databaseUrl: required("PIKI_POSTGIS_URL"),
  tenantId: process.env.PIKI_DISPATCH_TENANT_ID || "piki",
  zoneId: required("PIKI_DISPATCH_ZONE_ID"),
  algorithmVersion: process.env.PIKI_DISPATCH_ALGORITHM_VERSION || "xativa-batch-v1",
  maxOrders: integer("PIKI_DISPATCH_MAX_ORDERS", 24, 1, 100),
  offerSeconds: integer("PIKI_DISPATCH_OFFER_SECONDS", 45, 15, 180),
  riderRadiusMeters: integer("PIKI_DISPATCH_RIDER_RADIUS_METERS", 5_000, 250, 15_000),
  bundlePickupRadiusMeters: integer("PIKI_BUNDLE_PICKUP_RADIUS_METERS", 750, 50, 2_500),
  maxBundleDetourSeconds: integer("PIKI_BUNDLE_MAX_DETOUR_SECONDS", 480, 60, 1_200),
  routingUrl: String(process.env.PIKI_ROUTING_URL || "").replace(/\/$/, ""),
  routingToken: String(process.env.PIKI_ROUTING_TOKEN || ""),
};

const pool = new Pool({ connectionString: configuration.databaseUrl, max: 4, ssl: process.env.PIKI_POSTGIS_SSL === "false" ? false : { rejectUnauthorized: true } });

const metersBetween = (a, b) => {
  const earth = 6_371_000;
  const radians = (degrees) => (degrees * Math.PI) / 180;
  const latDistance = radians(b.lat - a.lat);
  const lonDistance = radians(b.lng - a.lng);
  const q = Math.sin(latDistance / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(lonDistance / 2) ** 2;
  return 2 * earth * Math.atan2(Math.sqrt(q), Math.sqrt(1 - q));
};

const vehicleMatches = (candidate, order) => !order.required_vehicle || candidate.vehicle === order.required_vehicle;
const candidateScore = (candidate, routeDurationSeconds = 0) => {
  const batteryPenalty = candidate.battery_percent == null ? 0.25 : Math.max(0, 60 - Number(candidate.battery_percent)) / 100;
  return Number((Number(candidate.distance_meters) / 1000 * 8 + Number(candidate.active_load_units) * 6 + batteryPenalty + routeDurationSeconds / 3600).toFixed(5));
};

async function routeBundle(candidate, orders) {
  if (!configuration.routingUrl) return null;
  const waypoints = [
    { kind: "rider", longitude: candidate.longitude, latitude: candidate.latitude },
    ...orders.map((order) => ({ kind: "pickup", orderId: order.order_id, longitude: order.pickup.lng, latitude: order.pickup.lat })),
    ...orders.map((order) => ({ kind: "dropoff", orderId: order.order_id, longitude: order.dropoff.lng, latitude: order.dropoff.lat })),
  ];
  const response = await fetch(`${configuration.routingUrl}/v1/route/multi-stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(configuration.routingToken ? { Authorization: `Bearer ${configuration.routingToken}` } : {}) },
    body: JSON.stringify({ vehicle: candidate.vehicle, waypoints }),
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`routing provider returned HTTP ${response.status}`);
  const payload = await response.json();
  const durationSeconds = Number(payload.durationSeconds);
  const distanceMeters = Number(payload.distanceMeters);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || !Number.isFinite(distanceMeters) || distanceMeters < 0) throw new Error("routing provider returned an invalid route");
  return { durationSeconds: Math.round(durationSeconds), distanceMeters: Math.round(distanceMeters), waypoints };
}

async function candidatesFor(client, order, requestedUnits) {
  const { rows } = await client.query(
    `SELECT rider_id, distance_meters, vehicle, capacity_units, active_load_units, battery_percent, location_fresh_at,
            ST_X(r.location::geometry) AS longitude, ST_Y(r.location::geometry) AS latitude
       FROM delivery.nearest_eligible_riders($1, ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography, $4::uuid, $5, $6, 90, 20) n
       JOIN delivery.rider_locations r ON r.rider_id = n.rider_id
      ORDER BY distance_meters, rider_id`,
    [configuration.tenantId, order.pickup.lng, order.pickup.lat, configuration.zoneId, requestedUnits, configuration.riderRadiusMeters],
  );
  return rows.filter((candidate) => vehicleMatches(candidate, order));
}

async function loadOrders(client, batchId) {
  const { rows } = await client.query(
    `SELECT order_id, partner_id, item_units, required_vehicle, COALESCE(pickup_ready_at, ready_at) AS pickup_ready_at, promised_at,
            ST_X(pickup_location::geometry) AS pickup_lng, ST_Y(pickup_location::geometry) AS pickup_lat,
            ST_X(dropoff_location::geometry) AS dropoff_lng, ST_Y(dropoff_location::geometry) AS dropoff_lat
       FROM delivery.orders_geo
      WHERE dispatch_batch_id = $1::uuid AND dispatch_state = 'matching'
      ORDER BY promised_at NULLS LAST, COALESCE(pickup_ready_at, ready_at) NULLS LAST, created_at`,
    [batchId],
  );
  return rows.map((row) => ({
    ...row,
    item_units: Number(row.item_units),
    pickup: { lng: Number(row.pickup_lng), lat: Number(row.pickup_lat) },
    dropoff: { lng: Number(row.dropoff_lng), lat: Number(row.dropoff_lat) },
  }));
}

function promisedWithinRoute(orders, durationSeconds) {
  const now = Date.now();
  return orders.every((order) => !order.promised_at || now + durationSeconds * 1000 <= new Date(order.promised_at).getTime());
}

async function createGroupDraft(client, orders) {
  const totalUnits = orders.reduce((sum, order) => sum + order.item_units, 0);
  const origin = orders[0];
  const candidates = await candidatesFor(client, origin, totalUnits);
  const suitable = candidates.filter((candidate) => orders.every((order) => vehicleMatches(candidate, order)));
  if (!suitable.length) return null;

  if (orders.length === 1) {
    return { orders, totalUnits, candidates: suitable.map((candidate) => ({ ...candidate, score: candidateScore(candidate) })), route: null, detourSeconds: 0 };
  }

  // Route calculation is mandatory before a multi-order offer can be persisted.
  const evaluated = [];
  for (const candidate of suitable.slice(0, 5)) {
    try {
      const route = await routeBundle(candidate, orders);
      if (!route || !promisedWithinRoute(orders, route.durationSeconds)) continue;
      const soloEstimate = orders.reduce((sum, order) => sum + Math.ceil(metersBetween(order.pickup, order.dropoff) / 8), 0);
      const detourSeconds = Math.max(0, route.durationSeconds - soloEstimate);
      if (detourSeconds > configuration.maxBundleDetourSeconds) continue;
      evaluated.push({ ...candidate, score: candidateScore(candidate, route.durationSeconds), route, detourSeconds });
    } catch (error) {
      console.warn(JSON.stringify({ event: "bundle_route_rejected", riderId: candidate.rider_id, orderIds: orders.map((order) => order.order_id), reason: error instanceof Error ? error.message : "unknown" }));
    }
  }
  if (!evaluated.length) return null;
  const bestRoute = evaluated[0].route;
  return { orders, totalUnits, candidates: evaluated, route: bestRoute, detourSeconds: evaluated[0].detourSeconds };
}

async function buildDrafts(client, orders) {
  const drafts = [];
  const reserved = new Set();
  for (let index = 0; index < orders.length; index += 1) {
    const first = orders[index];
    if (reserved.has(first.order_id)) continue;
    let selected = null;
    for (let next = index + 1; next < orders.length; next += 1) {
      const second = orders[next];
      if (reserved.has(second.order_id)) continue;
      const closePickups = first.partner_id === second.partner_id || metersBetween(first.pickup, second.pickup) <= configuration.bundlePickupRadiusMeters;
      if (!closePickups) continue;
      selected = await createGroupDraft(client, [first, second]);
      if (selected) break;
    }
    if (selected) {
      drafts.push(selected);
      selected.orders.forEach((order) => reserved.add(order.order_id));
      continue;
    }
    const single = await createGroupDraft(client, [first]);
    if (single) {
      drafts.push(single);
      reserved.add(first.order_id);
    }
  }
  return { drafts, unmatched: orders.filter((order) => !reserved.has(order.order_id)) };
}

async function persistDraft(client, batchId, draft) {
  const firstOffer = draft.candidates[0];
  let bundleId = null;
  if (draft.orders.length > 1) {
    const { rows } = await client.query(
      `INSERT INTO delivery.dispatch_bundles (batch_id, tenant_id, zone_id, status, total_units, pickup_plan, delivery_plan, route_distance_meters, route_duration_seconds, detour_seconds, score, score_breakdown)
       VALUES ($1::uuid, $2, $3::uuid, 'offered', $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10, $11::jsonb)
       RETURNING id`,
      [batchId, configuration.tenantId, configuration.zoneId, draft.totalUnits,
        JSON.stringify(draft.orders.map((order, index) => ({ orderId: order.order_id, sequence: index + 1, point: order.pickup }))),
        JSON.stringify(draft.orders.map((order, index) => ({ orderId: order.order_id, sequence: index + 1, point: order.dropoff }))),
        draft.route?.distanceMeters ?? null, draft.route?.durationSeconds ?? null, draft.detourSeconds, firstOffer.score,
        JSON.stringify({ algorithmVersion: configuration.algorithmVersion, candidateCount: draft.candidates.length, routingVerified: true })],
    );
    bundleId = rows[0].id;
    for (const [index, order] of draft.orders.entries()) {
      await client.query(
        `INSERT INTO delivery.dispatch_bundle_members (bundle_id, order_id, pickup_sequence, delivery_sequence) VALUES ($1::uuid, $2, $3, $3)`,
        [bundleId, order.order_id, index + 1],
      );
    }
  }

  const expiresAt = new Date(Date.now() + configuration.offerSeconds * 1_000).toISOString();
  for (const candidate of draft.candidates.slice(0, 3)) {
    await client.query(
      `INSERT INTO delivery.dispatch_offers (batch_id, order_id, bundle_id, rider_id, score, score_breakdown, expires_at)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6::jsonb, $7::timestamptz)`,
      [batchId, draft.orders[0].order_id, bundleId, candidate.rider_id, candidate.score,
        JSON.stringify({ algorithmVersion: configuration.algorithmVersion, pickupDistanceMeters: Number(candidate.distance_meters), vehicle: candidate.vehicle, activeLoadUnits: Number(candidate.active_load_units), batteryPercent: candidate.battery_percent, bundleOrderIds: draft.orders.map((order) => order.order_id), routeDurationSeconds: candidate.route?.durationSeconds ?? null }), expiresAt],
    );
  }
  const orderIds = draft.orders.map((order) => order.order_id);
  await client.query(
    `UPDATE delivery.orders_geo SET dispatch_state = 'offered', bundle_group_id = $1::uuid, updated_at = now() WHERE order_id = ANY($2::text[])`,
    [bundleId, orderIds],
  );
  await client.query(
    `INSERT INTO delivery.dispatch_outbox (tenant_id, topic, aggregate_key, payload)
     VALUES ($1, 'dispatch.offer.created', $2, $3::jsonb)`,
    [configuration.tenantId, bundleId || draft.orders[0].order_id, JSON.stringify({ batchId, bundleId, orderIds, riderIds: draft.candidates.slice(0, 3).map((candidate) => candidate.rider_id), expiresAt })],
  );
  return { bundleId, orderIds, offerCount: Math.min(3, draft.candidates.length) };
}

async function run() {
  const client = await pool.connect();
  const openedAt = new Date();
  let batchId = null;
  try {
    await client.query("BEGIN");
    const { rows: created } = await client.query(
      `INSERT INTO delivery.dispatch_batches (tenant_id, zone_id, window_opened_at, window_closed_at, algorithm_version, input_snapshot)
       VALUES ($1, $2::uuid, now(), now(), $3, $4::jsonb) RETURNING id`,
      [configuration.tenantId, configuration.zoneId, configuration.algorithmVersion, JSON.stringify({ maxOrders: configuration.maxOrders, riderRadiusMeters: configuration.riderRadiusMeters, bundlePickupRadiusMeters: configuration.bundlePickupRadiusMeters, routingConfigured: Boolean(configuration.routingUrl) })],
    );
    batchId = created[0].id;
    await client.query(`SELECT order_id FROM delivery.lock_orders_for_dispatch_batch($1, $2::uuid, $3::uuid, $4, 45)`, [configuration.tenantId, configuration.zoneId, batchId, configuration.maxOrders]);
    const orders = await loadOrders(client, batchId);
    const { drafts, unmatched } = await buildDrafts(client, orders);
    const persisted = [];
    for (const draft of drafts) persisted.push(await persistDraft(client, batchId, draft));
    if (unmatched.length) {
      await client.query(`UPDATE delivery.orders_geo SET dispatch_state = 'queued', dispatch_batch_id = NULL, dispatch_lock_expires_at = NULL, updated_at = now() WHERE order_id = ANY($1::text[])`, [unmatched.map((order) => order.order_id)]);
    }
    const result = { offeredOrderCount: persisted.flatMap((entry) => entry.orderIds).length, bundleCount: persisted.filter((entry) => entry.bundleId).length, singleCount: persisted.filter((entry) => !entry.bundleId).length, unmatchedOrderIds: unmatched.map((order) => order.order_id), routingConfigured: Boolean(configuration.routingUrl) };
    await client.query(`UPDATE delivery.dispatch_batches SET status = 'matched', window_closed_at = now(), result_snapshot = $2::jsonb, completed_at = now() WHERE id = $1::uuid`, [batchId, JSON.stringify(result)]);
    await client.query("COMMIT");
    console.log(JSON.stringify({ event: "dispatch_batch_completed", batchId, elapsedMs: Date.now() - openedAt.getTime(), ...result }));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    console.error(JSON.stringify({ event: "dispatch_batch_failed", batchId, error: error instanceof Error ? error.message : "unknown error" }));
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

void run();
