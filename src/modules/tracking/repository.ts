// Tracking SQL: ingest authorization, route geometry, batched point persistence and stop events.
// Every function receives the caller's `tx` (RLS applies); nothing here touches a pool.
import type { Direction, TripStatus } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import type { ParsedPoint } from './motion.js';

export interface IngestTripRow extends Record<string, unknown> {
  id: string;
  status: TripStatus;
  bus_id: string;
  route_id: string | null;
  direction: Direction | null;
  trip_type: string;
  device_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** Close instant of a completed / auto-closed / cancelled-while-running trip (migration 500). */
  closed_at: string | null;
  last_point_at: string | null;
  bus_code_snapshot: string | null;
  driver_staff_id: string | null;
  /**
   * The caller started the trip (holds the start phone — it stays bound to the trip after an admin
   * reassignment) or is its driver or conductor (via staff_profiles.user_id). Same rule as the trips
   * module's isParticipant().
   */
  is_crew: boolean;
}

/** The trip as seen by the calling driver/conductor (RLS: own school only). */
export function ingestTrip(tx: Tx, tripId: string, userId: string): Promise<IngestTripRow | null> {
  return tx.maybeOne<IngestTripRow>(
    `select t.id, t.status, t.bus_id, t.route_id, t.direction, t.trip_type, t.device_id, t.started_at, t.ended_at, t.closed_at, t.last_point_at,
            t.bus_code_snapshot, t.driver_staff_id,
            (t.started_by = $2
             or exists (select 1 from staff_profiles sp
                         where sp.user_id = $2 and sp.deleted_at is null
                           and sp.id in (t.driver_staff_id, t.conductor_staff_id))) as is_crew
       from trips t
      where t.id = $1`,
    [tripId, userId],
  );
}

export interface GeometryRow extends Record<string, unknown> {
  trip_id: string;
  route_id: string | null;
  direction: Direction | null;
  trip_date: string;
  polyline_encoded: string | null;
  polyline_source: 'google' | 'straight' | null;
  school_lat: number | null;
  school_lng: number | null;
  /** schools.geofence_radius_m (Settings → Profile, 20–5000 m). */
  school_radius_m: number | null;
  timezone: string;
  stops: {
    id: string;
    sequence: number;
    name: string;
    latitude: number;
    longitude: number;
    expected_time: string | null;
    arrival_radius_m: number;
    planned_at: string | null;
  }[];
}

/** Planned geometry of a trip's route in one statement (stops with their timetable instants). */
export function tripGeometry(tx: Tx, tripId: string): Promise<GeometryRow | null> {
  return tx.maybeOne<GeometryRow>(
    `select t.id as trip_id, t.route_id, coalesce(t.direction, r.direction) as direction, t.trip_date,
            r.polyline_encoded, r.polyline_source,
            s.latitude::float8 as school_lat, s.longitude::float8 as school_lng, s.geofence_radius_m as school_radius_m,
            s.timezone,
            coalesce((
              select json_agg(json_build_object(
                       'id', st.id, 'sequence', st.sequence, 'name', st.name,
                       'latitude', st.latitude::float8, 'longitude', st.longitude::float8,
                       'expected_time', st.expected_time, 'arrival_radius_m', st.arrival_radius_m,
                       'planned_at', case when st.expected_time is null then null
                                          else ((t.trip_date + st.expected_time) at time zone s.timezone) end)
                     order by st.sequence)
                from stops st
               where st.route_id = t.route_id and st.deleted_at is null), '[]'::json) as stops
       from trips t
       join schools s on s.id = t.school_id
       left join routes r on r.id = t.route_id
      where t.id = $1`,
    [tripId],
  );
}

/** Trips of the school whose geometry may be cached (running, or scheduled around today). */
export async function openTripIds(tx: Tx): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    `select id from trips
      where status in ('scheduled', 'in_progress') and trip_date between current_date - 1 and current_date + 1`,
  );
  return rows.map((r) => r.id);
}

/** Minimum spacing of stored points of one trip (BP §9.1: 10 s minus clock jitter), in seconds. */
export const STORAGE_FLOOR_S = 9;

/**
 * Batched multi-row insert of accepted points into the monthly partitions (one statement);
 * retries are idempotent (PK trip_id + recorded_at, ON CONFLICT DO NOTHING). The 10-s floor is also
 * enforced against the points ALREADY STORED (a point closer than STORAGE_FLOOR_S to a stored point
 * of the trip is skipped), so re-sent or shifted backfill windows can never add rows beyond the
 * floor; a transaction-scoped advisory lock per trip serialises concurrent batches of one trip.
 * Also advances the trip's last_point_at (never beyond now()) / points_count. Returns the new rows.
 */
export async function insertPoints(tx: Tx, tripId: string, points: readonly ParsedPoint[]): Promise<number> {
  if (!points.length) return 0;
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('location-points:' || $1::text, 0))`, [tripId]);
  const row = await tx.one<{ inserted: number }>(
    `with ins as (
       insert into location_points (school_id, trip_id, recorded_at, latitude, longitude, speed_kmh, heading, accuracy_m,
                                    battery_pct, network_type, is_moving, is_backfilled)
       select nullif(current_setting('app.school_id', true), '')::uuid, $1, p.t, p.lat, p.lng, p.spd, p.hdg, p.acc, p.bat, p.net, p.mv, p.bf
         from unnest($2::timestamptz[], $3::float8[], $4::float8[], $5::real[], $6::real[], $7::real[], $8::smallint[],
                     $9::text[], $10::boolean[], $11::boolean[]) as p(t, lat, lng, spd, hdg, acc, bat, net, mv, bf)
        where not exists (select 1 from location_points q
                           where q.trip_id = $1
                             and q.recorded_at > p.t - make_interval(secs => $12)
                             and q.recorded_at < p.t + make_interval(secs => $12))
       on conflict (trip_id, recorded_at) do nothing
       returning recorded_at
     ), upd as (
       update trips t
          set last_point_at = greatest(coalesce(t.last_point_at, '-infinity'::timestamptz), least((select max(recorded_at) from ins), now())),
              points_count = t.points_count + (select count(*) from ins)
        where t.id = $1 and exists (select 1 from ins)
       returning 1
     )
     select (select count(*) from ins)::int as inserted`,
    [
      tripId,
      points.map((p) => p.t),
      points.map((p) => p.lat),
      points.map((p) => p.lng),
      points.map((p) => p.spd),
      points.map((p) => p.hdg),
      points.map((p) => p.acc),
      points.map((p) => p.bat),
      points.map((p) => p.net),
      points.map((p) => p.mv),
      points.map((p) => p.backfilled),
      STORAGE_FLOOR_S,
    ],
  );
  return row.inserted;
}

/**
 * Indexes (0-based) of candidate recorded_at instants that already have a stored point of the trip
 * within STORAGE_FLOOR_S (ingest drops those backfill points synchronously so the response counts
 * stay exact; insertPoints enforces the same rule at write time).
 */
export async function storedNeighbours(tx: Tx, tripId: string, instants: readonly string[]): Promise<Set<number>> {
  if (!instants.length) return new Set();
  const rows = await tx.many<{ i: number }>(
    `select (c.i - 1)::int as i
       from unnest($2::timestamptz[]) with ordinality as c(t, i)
      where exists (select 1 from location_points q
                     where q.trip_id = $1
                       and q.recorded_at > c.t - make_interval(secs => $3)
                       and q.recorded_at < c.t + make_interval(secs => $3))`,
    [tripId, instants, STORAGE_FLOOR_S],
  );
  return new Set(rows.map((r) => r.i));
}

/** Arrival at a stop (first entry into its geofence wins; later duplicates are ignored). */
export async function recordArrival(tx: Tx, tripId: string, stopId: string, arrivedAt: string, distanceM: number, source: 'live' | 'finalizer' = 'live'): Promise<boolean> {
  const r = await tx.query(
    `insert into trip_stop_events (school_id, trip_id, stop_id, arrived_at, distance_m, source)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $1, $2, $3, $4, $5)
     on conflict (trip_id, stop_id) do nothing`,
    [tripId, stopId, arrivedAt, distanceM, source],
  );
  return (r.rowCount ?? 0) > 0;
}

/** Departure from a stop: departed_at, dwell and the closest approach (never overrides manual rows). */
export async function recordDeparture(tx: Tx, tripId: string, stopId: string, departedAt: string, minDistanceM: number | null): Promise<void> {
  await tx.query(
    `update trip_stop_events
        set departed_at = $3,
            dwell_s = greatest(0, extract(epoch from ($3::timestamptz - arrived_at)))::int,
            distance_m = case when $4::real is null then distance_m else least(coalesce(distance_m, $4::real), $4::real) end,
            updated_at = now()
      where trip_id = $1 and stop_id = $2 and source <> 'manual' and departed_at is null
        and arrived_at is not null and arrived_at <= $3::timestamptz`,
    [tripId, stopId, departedAt, minDistanceM],
  );
}

export interface StopEventRow extends Record<string, unknown> {
  stop_id: string;
  stop_name: string | null;
  sequence: number | null;
  arrived_at: string | null;
  departed_at: string | null;
  dwell_s: number | null;
  distance_m: number | null;
  source: 'live' | 'finalizer' | 'manual';
}

export function stopEvents(tx: Tx, tripId: string): Promise<StopEventRow[]> {
  return tx.many<StopEventRow>(
    `select e.stop_id, s.name as stop_name, s.sequence, e.arrived_at, e.departed_at, e.dwell_s, e.distance_m, e.source
       from trip_stop_events e
       left join stops s on s.id = e.stop_id
      where e.trip_id = $1
      order by e.arrived_at nulls last, s.sequence`,
    [tripId],
  );
}

export interface StoredPointRow extends Record<string, unknown> {
  recorded_at: string;
  latitude: number;
  longitude: number;
  speed_kmh: number | null;
  heading: number | null;
  accuracy_m: number | null;
  battery_pct: number | null;
  network_type: string | null;
  is_moving: boolean | null;
}

/**
 * Stored points of a trip in time order (bounded). `from`/`to` (the trip window) let the planner
 * prune the monthly partitions.
 */
export function tripPoints(tx: Tx, tripId: string, window: { from: string | null; to: string | null } = { from: null, to: null }, limit = 50_000): Promise<StoredPointRow[]> {
  return tx.many<StoredPointRow>(
    `select recorded_at, latitude, longitude, speed_kmh, heading, accuracy_m, battery_pct, network_type, is_moving
       from location_points
      where trip_id = $1
        and ($2::timestamptz is null or recorded_at >= $2::timestamptz - interval '1 day')
        and ($3::timestamptz is null or recorded_at <= $3::timestamptz + interval '1 day')
      order by recorded_at
      limit $4`,
    [tripId, window.from, window.to, limit],
  );
}
