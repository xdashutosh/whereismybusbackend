// SQL of the parent module. Every function runs inside the parent's tenant context (X-School-Id
// resolved → withRequestTenant / withTenant with role 'parent'): RLS + the restrictive parent_scope
// policies (migration 011) limit every table to the parent's linked children, their CURRENT
// assignments (school-local today), the assigned buses/routes/stops and those buses' trips. The
// explicit link/validity predicates below repeat those rules (defence in depth, BP §4.1).
import type { Direction, TripStatus } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';

const ACTOR = `nullif(current_setting('app.actor_id', true), '')::uuid`;

/** One row per (linked child × current assignment direction); direction columns are null without one. */
export interface ChildRow extends Record<string, unknown> {
  student_id: string;
  full_name: string;
  class_name: string | null;
  section: string | null;
  photo_key: string | null;
  direction: Direction | null;
  bus_id: string | null;
  bus_code: string | null;
  route_id: string | null;
  route_code: string | null;
  route_name: string | null;
  stop_id: string | null;
  stop_name: string | null;
  stop_sequence: number | null;
  stop_lat: number | null;
  stop_lng: number | null;
  stop_expected_time: string | null;
  stop_radius_m: number | null;
  /** Today's school trip of the bus in this direction (the running one first). */
  trip_id: string | null;
  trip_status: TripStatus | null;
  trip_date: string | null;
  planned_start_at: string | null;
  started_at: string | null;
  ended_at: string | null;
  /** The running trip was marked interrupted (breakdown). */
  interrupted_at: string | null;
  /** The driver's breakdown reason (close_reason of an interrupted trip) and the school's cancel reason. */
  interruption_reason: string | null;
  cancel_reason: string | null;
  /** Timetable instant of the child's stop on today's trip (null when the stop has no expected time). */
  stop_planned_at: string | null;
  /** Next school day served by an active schedule of this bus/direction after today (holidays skipped). */
  next_day: string | null;
  next_at: string | null;
}

const CHILD_SQL = `
  with today as (select app_local_date() as day, sc.timezone as tz
                   from schools sc where sc.id = nullif(current_setting('app.school_id', true), '')::uuid)
  select s.id as student_id, s.full_name, s.class_name, s.section, pf.key as photo_key,
         sa.trip_direction as direction, sa.bus_id, b.code as bus_code, sa.route_id, r.code as route_code, r.name as route_name,
         st.id as stop_id, st.name as stop_name, st.sequence as stop_sequence, st.latitude::float8 as stop_lat,
         st.longitude::float8 as stop_lng, st.expected_time::text as stop_expected_time, st.arrival_radius_m as stop_radius_m,
         t.id as trip_id, t.status as trip_status, t.trip_date::text as trip_date, t.planned_start_at, t.started_at, t.ended_at, t.interrupted_at,
         case when t.interrupted_at is not null then t.close_reason end as interruption_reason, t.cancel_reason,
         case when t.id is null or st.expected_time is null then null
              else ((t.trip_date + st.expected_time) at time zone today.tz) end as stop_planned_at,
         nx.day::text as next_day,
         case when nx.day is null then null
              else ((nx.day + coalesce(st.expected_time, nx.planned_start_time)) at time zone today.tz) end as next_at
    from today
    join students s on s.deleted_at is null and s.is_active
    join student_parents l on l.student_id = s.id and l.parent_account_id = ${ACTOR}
    left join files pf on pf.id = s.photo_file_id and pf.status = 'uploaded'
    left join student_assignments sa on sa.student_id = s.id and sa.valid_from <= today.day
                                     and (sa.valid_to is null or sa.valid_to > today.day)
    left join buses b on b.id = sa.bus_id and b.deleted_at is null
    left join routes r on r.id = sa.route_id and r.deleted_at is null
    left join stops st on st.id = sa.stop_id and st.deleted_at is null
    left join lateral (
      select t.* from trips t
       where t.bus_id = sa.bus_id and t.direction = sa.trip_direction and t.trip_type = 'school' and t.trip_date = today.day
       order by (t.status = 'in_progress') desc, (t.status = 'scheduled') desc, t.planned_start_at nulls last, t.id
       limit 1) t on sa.id is not null
    left join lateral (
      select d::date as day, ts.planned_start_time
        from generate_series(today.day + 1, today.day + 14, interval '1 day') d
        join trip_schedules ts on ts.bus_id = sa.bus_id and ts.direction = sa.trip_direction and ts.is_active and ts.deleted_at is null
                              and extract(isodow from d)::smallint = any (ts.days_of_week)
                              and (ts.valid_from is null or ts.valid_from <= d::date) and (ts.valid_to is null or ts.valid_to >= d::date)
       where (sa.valid_to is null or sa.valid_to > d::date)
         and not exists (select 1 from school_holidays h
                          where d::date between h.start_date and h.end_date and h.applies_to in ('all', sa.trip_direction))
       order by d, ts.planned_start_time
       limit 1) nx on sa.id is not null`;

/** Every linked child of the current school with its current assignments (one round trip). */
export function childRows(tx: Tx): Promise<ChildRow[]> {
  return tx.many<ChildRow>(`${CHILD_SQL} order by s.full_name, s.id, sa.trip_direction`);
}

/** One linked child (empty when the student is not linked to the caller in this school). */
export function childRowsFor(tx: Tx, studentId: string): Promise<ChildRow[]> {
  return tx.many<ChildRow>(`${CHILD_SQL} where s.id = $1 order by sa.trip_direction`, [studentId]);
}

export interface SchoolBrandRow extends Record<string, unknown> {
  id: string;
  name: string;
  institution_type: string;
  brand_color: string | null;
  timezone: string;
  latitude: number | null;
  longitude: number | null;
  logo_key: string | null;
}

/** The current school's public branding (schools policy: own school). */
export function schoolBrand(tx: Tx): Promise<SchoolBrandRow | null> {
  return tx.maybeOne<SchoolBrandRow>(
    `select sc.id, sc.name, sc.institution_type, sc.brand_color, sc.timezone, sc.latitude::float8 as latitude, sc.longitude::float8 as longitude,
            lf.key as logo_key
       from schools sc
       left join files lf on lf.id = sc.logo_file_id and lf.status = 'uploaded'
      where sc.id = nullif(current_setting('app.school_id', true), '')::uuid`,
  );
}

/** Does the caller have a CURRENT assignment of a linked child to this trip's bus and direction? */
export async function parentMayWatchTrip(tx: Tx, studentId: string, tripId: string): Promise<boolean> {
  const row = await tx.maybeOne(
    `select 1 from trips t
       join student_assignments sa on sa.bus_id = t.bus_id and sa.trip_direction = t.direction and sa.student_id = $1
                                  and sa.valid_from <= app_local_date() and (sa.valid_to is null or sa.valid_to > app_local_date())
       join student_parents l on l.student_id = sa.student_id and l.parent_account_id = ${ACTOR}
      where t.id = $2 and t.trip_type = 'school'`,
    [studentId, tripId],
  );
  return row !== null;
}

export interface RouteGeometryRow extends Record<string, unknown> {
  polyline_encoded: string | null;
  polyline_source: 'google' | 'straight' | null;
  stops: { id: string; sequence: number; name: string; latitude: number; longitude: number }[];
}

/** Planned polyline and live stops of the child's assigned route (parent_scope: assigned routes only). */
export function routeGeometry(tx: Tx, routeId: string): Promise<RouteGeometryRow | null> {
  return tx.maybeOne<RouteGeometryRow>(
    `select r.polyline_encoded, r.polyline_source,
            coalesce((select json_agg(json_build_object('id', st.id, 'sequence', st.sequence, 'name', st.name,
                                                        'latitude', st.latitude::float8, 'longitude', st.longitude::float8)
                                      order by st.sequence)
                        from stops st where st.route_id = r.id and st.deleted_at is null), '[]'::json) as stops
       from routes r
      where r.id = $1 and r.deleted_at is null`,
    [routeId],
  );
}

/** Students currently assigned to a trip's bus + direction on the trip date, with their stop (system/job context). */
export interface TripAudienceRow extends Record<string, unknown> {
  student_id: string;
  stop_id: string;
  stop_planned_at: string | null;
  trip_status: TripStatus;
  planned_start_at: string | null;
  interrupted_at: string | null;
  interruption_reason: string | null;
  cancel_reason: string | null;
  direction: Direction | null;
  bus_id: string;
}

export function tripAudience(tx: Tx, tripId: string): Promise<TripAudienceRow[]> {
  return tx.many<TripAudienceRow>(
    `select sa.student_id, sa.stop_id, t.status as trip_status, t.planned_start_at, t.interrupted_at, t.direction, t.bus_id,
            case when t.interrupted_at is not null then t.close_reason end as interruption_reason, t.cancel_reason,
            case when st.expected_time is null then null
                 else ((t.trip_date + st.expected_time) at time zone sc.timezone) end as stop_planned_at
       from trips t
       join schools sc on sc.id = t.school_id
       join student_assignments sa on sa.bus_id = t.bus_id and sa.trip_direction = t.direction
                                  and sa.valid_from <= t.trip_date and (sa.valid_to is null or sa.valid_to > t.trip_date)
       join students s on s.id = sa.student_id and s.deleted_at is null and s.is_active
       left join stops st on st.id = sa.stop_id
      where t.id = $1 and t.trip_type = 'school'`,
    [tripId],
  );
}
