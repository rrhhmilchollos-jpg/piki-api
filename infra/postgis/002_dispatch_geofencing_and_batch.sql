-- PIKI Delivery · Dispatch, batch matching and atomic bundle acceptance for Xàtiva
-- Depends on: 001_geofencing_xativa.sql
--
-- Target-state migration for a dedicated PostgreSQL/PostGIS operational store.
-- Do NOT apply this file to an unrelated Render PostgreSQL database. Provision a
-- PIKI-owned PostGIS instance first, back it up, and apply through a controlled release.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE delivery.dispatch_state AS ENUM ('queued', 'matching', 'offered', 'assigned', 'expired', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE delivery.offer_state AS ENUM ('offered', 'accepted', 'rejected', 'expired', 'superseded');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE delivery.geofence_event_type AS ENUM ('entered', 'exited', 'zone_changed', 'out_of_service_area');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE delivery.delivery_zones
  ADD COLUMN IF NOT EXISTS source_reference text,
  ADD COLUMN IF NOT EXISTS source_retrieved_at timestamptz,
  ADD COLUMN IF NOT EXISTS geometry_sha256 text,
  ADD COLUMN IF NOT EXISTS operational_priority smallint NOT NULL DEFAULT 100 CHECK (operational_priority BETWEEN 1 AND 1000),
  ADD COLUMN IF NOT EXISTS effective_from timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS effective_until timestamptz;

ALTER TABLE delivery.rider_locations
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'piki',
  ADD COLUMN IF NOT EXISTS dispatch_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_geofence_at timestamptz,
  ADD COLUMN IF NOT EXISTS app_backgrounded boolean NOT NULL DEFAULT false;

ALTER TABLE delivery.orders_geo
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'piki',
  ADD COLUMN IF NOT EXISTS dispatch_state delivery.dispatch_state NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS dispatch_batch_id uuid,
  ADD COLUMN IF NOT EXISTS dispatch_lock_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS assigned_rider_id text REFERENCES delivery.rider_locations(rider_id),
  ADD COLUMN IF NOT EXISTS assignment_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bundle_group_id uuid,
  ADD COLUMN IF NOT EXISTS pickup_ready_at timestamptz,
  ADD COLUMN IF NOT EXISTS route_distance_meters integer CHECK (route_distance_meters IS NULL OR route_distance_meters >= 0),
  ADD COLUMN IF NOT EXISTS route_duration_seconds integer CHECK (route_duration_seconds IS NULL OR route_duration_seconds >= 0);

CREATE TABLE IF NOT EXISTS delivery.dispatch_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'piki',
  zone_id uuid NOT NULL REFERENCES delivery.delivery_zones(id),
  window_opened_at timestamptz NOT NULL,
  window_closed_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'closed', 'failed')),
  algorithm_version text NOT NULL,
  input_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CHECK (window_closed_at >= window_opened_at)
);
CREATE INDEX IF NOT EXISTS dispatch_batches_zone_window_idx
  ON delivery.dispatch_batches (tenant_id, zone_id, window_opened_at DESC);

-- A bundle is the indivisible unit that a Rider accepts. A batch may contain
-- singles and two-or-more order bundles; dispatch_offers references its primary
-- order only for backwards-compatible offer lookups.
CREATE TABLE IF NOT EXISTS delivery.dispatch_bundles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES delivery.dispatch_batches(id) ON DELETE CASCADE,
  tenant_id text NOT NULL DEFAULT 'piki',
  zone_id uuid NOT NULL REFERENCES delivery.delivery_zones(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'offered', 'assigned', 'expired', 'cancelled')),
  total_units integer NOT NULL CHECK (total_units > 0),
  pickup_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery_plan jsonb NOT NULL DEFAULT '[]'::jsonb,
  route_distance_meters integer CHECK (route_distance_meters IS NULL OR route_distance_meters >= 0),
  route_duration_seconds integer CHECK (route_duration_seconds IS NULL OR route_duration_seconds >= 0),
  detour_seconds integer CHECK (detour_seconds IS NULL OR detour_seconds >= 0),
  score numeric(12,5) NOT NULL,
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  assigned_at timestamptz
);
CREATE INDEX IF NOT EXISTS dispatch_bundles_batch_status_idx
  ON delivery.dispatch_bundles (batch_id, status);

CREATE TABLE IF NOT EXISTS delivery.dispatch_bundle_members (
  bundle_id uuid NOT NULL REFERENCES delivery.dispatch_bundles(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES delivery.orders_geo(order_id) ON DELETE CASCADE,
  pickup_sequence smallint NOT NULL CHECK (pickup_sequence > 0),
  delivery_sequence smallint NOT NULL CHECK (delivery_sequence > 0),
  PRIMARY KEY (bundle_id, order_id),
  UNIQUE (order_id)
);
CREATE INDEX IF NOT EXISTS dispatch_bundle_members_order_idx
  ON delivery.dispatch_bundle_members (order_id);

CREATE TABLE IF NOT EXISTS delivery.dispatch_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES delivery.dispatch_batches(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES delivery.orders_geo(order_id) ON DELETE CASCADE,
  bundle_id uuid REFERENCES delivery.dispatch_bundles(id) ON DELETE CASCADE,
  rider_id text NOT NULL REFERENCES delivery.rider_locations(rider_id),
  state delivery.offer_state NOT NULL DEFAULT 'offered',
  score numeric(12,5) NOT NULL,
  score_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  offered_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  responded_at timestamptz,
  UNIQUE (batch_id, order_id, rider_id),
  CHECK (expires_at > offered_at)
);
ALTER TABLE delivery.dispatch_offers
  ADD COLUMN IF NOT EXISTS bundle_id uuid REFERENCES delivery.dispatch_bundles(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS dispatch_offers_rider_open_idx
  ON delivery.dispatch_offers (rider_id, state, expires_at)
  WHERE state = 'offered';
CREATE INDEX IF NOT EXISTS dispatch_offers_order_open_idx
  ON delivery.dispatch_offers (order_id, state, expires_at)
  WHERE state = 'offered';
CREATE INDEX IF NOT EXISTS dispatch_offers_bundle_open_idx
  ON delivery.dispatch_offers (bundle_id, state, expires_at)
  WHERE bundle_id IS NOT NULL AND state = 'offered';

-- Transactional outbox: the API relay publishes these events to the Mongo/SSE
-- world only after its own successful delivery. The matching worker never has to
-- write directly into the public API database.
CREATE TABLE IF NOT EXISTS delivery.dispatch_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL DEFAULT 'piki',
  topic text NOT NULL,
  aggregate_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  delivery_attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS dispatch_outbox_pending_idx
  ON delivery.dispatch_outbox (created_at)
  WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS delivery.rider_geofence_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rider_id text NOT NULL REFERENCES delivery.rider_locations(rider_id),
  prior_zone_id uuid REFERENCES delivery.delivery_zones(id),
  zone_id uuid REFERENCES delivery.delivery_zones(id),
  event_type delivery.geofence_event_type NOT NULL,
  position geography(Point, 4326) NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  location_age_seconds integer CHECK (location_age_seconds IS NULL OR location_age_seconds >= 0),
  source text NOT NULL DEFAULT 'rider_app'
);
CREATE INDEX IF NOT EXISTS rider_geofence_events_rider_time_idx
  ON delivery.rider_geofence_events (rider_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS rider_geofence_events_position_gist
  ON delivery.rider_geofence_events USING GIST (position);

CREATE INDEX IF NOT EXISTS rider_locations_available_gist
  ON delivery.rider_locations USING GIST (location)
  WHERE availability = 'available';
CREATE INDEX IF NOT EXISTS rider_locations_eligible_idx
  ON delivery.rider_locations (tenant_id, zone_id, availability, location_fresh_at DESC);
CREATE INDEX IF NOT EXISTS orders_geo_matching_idx
  ON delivery.orders_geo (tenant_id, zone_id, dispatch_state, pickup_ready_at, promised_at);

-- Boundary-inclusive zone lookup. Polygon boundaries remain geometry(4326) for
-- precise municipal areas; live locations use geography for metres-based radii.
CREATE OR REPLACE FUNCTION delivery.assign_zone(point geography)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT z.id
  FROM delivery.delivery_zones z
  WHERE z.status = 'active'
    AND (z.effective_until IS NULL OR z.effective_until > now())
    AND z.effective_from <= now()
    AND ST_Covers(z.service_area, point::geometry)
  ORDER BY z.operational_priority ASC, ST_Area(z.service_area::geography) ASC
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION delivery.is_serviceable(point geography)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM delivery.delivery_zones z
    WHERE z.status = 'active'
      AND (z.effective_until IS NULL OR z.effective_until > now())
      AND z.effective_from <= now()
      AND ST_Covers(z.service_area, point::geometry)
  );
$$;

CREATE OR REPLACE FUNCTION delivery.replace_zone_geometry(
  p_zone_id uuid,
  p_geojson jsonb,
  p_source_reference text,
  p_source_retrieved_at timestamptz,
  p_geometry_sha256 text
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  candidate geometry;
  raw_geometry jsonb;
BEGIN
  raw_geometry := CASE WHEN p_geojson ? 'geometry' THEN p_geojson -> 'geometry' ELSE p_geojson END;
  candidate := ST_Multi(ST_Force2D(ST_SetSRID(ST_GeomFromGeoJSON(raw_geometry::text), 4326)));
  IF candidate IS NULL OR ST_IsEmpty(candidate) OR NOT ST_IsValid(candidate) THEN
    RAISE EXCEPTION 'Invalid zone geometry for %', p_zone_id USING ERRCODE = '22023';
  END IF;
  UPDATE delivery.delivery_zones
  SET service_area = candidate,
      source_reference = p_source_reference,
      source_retrieved_at = p_source_retrieved_at,
      geometry_sha256 = p_geometry_sha256,
      updated_at = now()
  WHERE id = p_zone_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown delivery zone %', p_zone_id USING ERRCODE = 'P0002'; END IF;
END;
$$;

-- Radial search: GiST KNN cheaply prunes candidates, ST_DWithin keeps the query
-- index-backed, and ST_Distance performs the exact final ordering in metres.
CREATE OR REPLACE FUNCTION delivery.nearest_eligible_riders(
  p_tenant_id text,
  p_pickup geography,
  p_zone_id uuid,
  p_requested_units integer DEFAULT 1,
  p_radius_meters integer DEFAULT 5000,
  p_freshness_seconds integer DEFAULT 90,
  p_limit integer DEFAULT 20
)
RETURNS TABLE (
  rider_id text,
  distance_meters double precision,
  vehicle text,
  capacity_units integer,
  active_load_units integer,
  battery_percent integer,
  location_fresh_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  WITH knn AS (
    SELECT r.rider_id, r.location, r.vehicle, r.capacity_units, r.active_load_units, r.battery_percent, r.location_fresh_at
    FROM delivery.rider_locations r
    WHERE r.tenant_id = p_tenant_id
      AND r.availability = 'available'
      AND r.zone_id = p_zone_id
      AND r.active_load_units + p_requested_units <= r.capacity_units
      AND r.location_fresh_at >= now() - make_interval(secs => GREATEST(15, p_freshness_seconds))
      AND (r.battery_percent IS NULL OR r.battery_percent >= 12)
      AND ST_DWithin(r.location, p_pickup, GREATEST(250, p_radius_meters))
    ORDER BY r.location <-> p_pickup
    LIMIT LEAST(200, GREATEST(15, p_limit * 3))
  )
  SELECT rider_id, ST_Distance(location, p_pickup), vehicle, capacity_units, active_load_units, battery_percent, location_fresh_at
  FROM knn
  ORDER BY ST_Distance(location, p_pickup), rider_id
  LIMIT LEAST(100, GREATEST(1, p_limit));
$$;

-- Workers claim a bounded set without blocking a parallel zone worker.
CREATE OR REPLACE FUNCTION delivery.lock_orders_for_dispatch_batch(
  p_tenant_id text,
  p_zone_id uuid,
  p_batch_id uuid,
  p_limit integer DEFAULT 24,
  p_lock_seconds integer DEFAULT 45
)
RETURNS TABLE (order_id text)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT o.order_id
    FROM delivery.orders_geo o
    WHERE o.tenant_id = p_tenant_id
      AND o.zone_id = p_zone_id
      AND o.status = 'ready'
      AND o.dispatch_state IN ('queued', 'expired')
      AND (o.dispatch_lock_expires_at IS NULL OR o.dispatch_lock_expires_at < now())
    ORDER BY o.promised_at NULLS LAST, COALESCE(o.pickup_ready_at, o.ready_at) NULLS LAST, o.created_at
    LIMIT LEAST(100, GREATEST(1, p_limit))
    FOR UPDATE SKIP LOCKED
  )
  UPDATE delivery.orders_geo o
  SET dispatch_state = 'matching',
      dispatch_batch_id = p_batch_id,
      dispatch_lock_expires_at = now() + make_interval(secs => GREATEST(10, p_lock_seconds)),
      assignment_version = o.assignment_version + 1,
      updated_at = now()
  FROM candidate c
  WHERE o.order_id = c.order_id
  RETURNING o.order_id;
END;
$$;

-- Compare-and-set acceptance for either a single order or every member of a
-- bundle. It locks the offer, rider and all orders first; no partial acceptance
-- can survive a concurrent rider action or a capacity change.
CREATE OR REPLACE FUNCTION delivery.accept_dispatch_offer(p_offer_id uuid, p_rider_id text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
  claimed_bundle_id uuid;
  claimed_order_id text;
  expected_orders integer;
  available_orders integer;
  requested_units integer;
  rider_capacity integer;
  rider_load integer;
  rider_available delivery.rider_availability;
BEGIN
  SELECT bundle_id, order_id INTO claimed_bundle_id, claimed_order_id
  FROM delivery.dispatch_offers
  WHERE id = p_offer_id AND rider_id = p_rider_id AND state = 'offered' AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT capacity_units, active_load_units, availability INTO rider_capacity, rider_load, rider_available
  FROM delivery.rider_locations WHERE rider_id = p_rider_id FOR UPDATE;
  IF NOT FOUND OR rider_available <> 'available' THEN RETURN false; END IF;

  IF claimed_bundle_id IS NULL THEN
    PERFORM 1 FROM delivery.orders_geo WHERE order_id = claimed_order_id FOR UPDATE;
    SELECT count(*), COALESCE(sum(item_units), 0) INTO expected_orders, requested_units
    FROM delivery.orders_geo WHERE order_id = claimed_order_id;
    SELECT count(*) INTO available_orders
    FROM delivery.orders_geo WHERE order_id = claimed_order_id AND dispatch_state IN ('matching', 'offered');
  ELSE
    PERFORM 1 FROM delivery.orders_geo o
      JOIN delivery.dispatch_bundle_members m ON m.order_id = o.order_id
      WHERE m.bundle_id = claimed_bundle_id FOR UPDATE OF o;
    SELECT count(*), COALESCE(sum(o.item_units), 0) INTO expected_orders, requested_units
    FROM delivery.orders_geo o JOIN delivery.dispatch_bundle_members m ON m.order_id = o.order_id
    WHERE m.bundle_id = claimed_bundle_id;
    SELECT count(*) INTO available_orders
    FROM delivery.orders_geo o JOIN delivery.dispatch_bundle_members m ON m.order_id = o.order_id
    WHERE m.bundle_id = claimed_bundle_id AND o.dispatch_state IN ('matching', 'offered');
  END IF;

  IF expected_orders = 0 OR available_orders <> expected_orders OR rider_load + requested_units > rider_capacity THEN RETURN false; END IF;

  UPDATE delivery.dispatch_offers SET state = 'accepted', responded_at = now() WHERE id = p_offer_id;
  UPDATE delivery.orders_geo o
  SET dispatch_state = 'assigned', assigned_rider_id = p_rider_id, dispatch_lock_expires_at = NULL,
      bundle_group_id = claimed_bundle_id, assignment_version = assignment_version + 1, updated_at = now()
  WHERE (claimed_bundle_id IS NULL AND o.order_id = claimed_order_id)
     OR (claimed_bundle_id IS NOT NULL AND EXISTS (SELECT 1 FROM delivery.dispatch_bundle_members m WHERE m.bundle_id = claimed_bundle_id AND m.order_id = o.order_id));

  UPDATE delivery.dispatch_offers offer
  SET state = 'superseded', responded_at = now()
  WHERE offer.id <> p_offer_id AND offer.state = 'offered'
    AND ((claimed_bundle_id IS NOT NULL AND offer.bundle_id = claimed_bundle_id)
      OR offer.order_id IN (SELECT order_id FROM delivery.dispatch_bundle_members WHERE bundle_id = claimed_bundle_id)
      OR (claimed_bundle_id IS NULL AND offer.order_id = claimed_order_id));

  UPDATE delivery.rider_locations
  SET availability = 'busy', active_load_units = active_load_units + requested_units,
      dispatch_version = dispatch_version + 1, updated_at = now()
  WHERE rider_id = p_rider_id;

  IF claimed_bundle_id IS NOT NULL THEN
    UPDATE delivery.dispatch_bundles SET status = 'assigned', assigned_at = now() WHERE id = claimed_bundle_id;
  END IF;
  RETURN true;
END;
$$;

COMMIT;
