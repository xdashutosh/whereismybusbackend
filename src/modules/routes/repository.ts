// Route SQL (BP §6.2 routes). Runs in the caller's tenant transaction: RLS limits every statement to
// the current school; school_id is written from the transaction context, never from input.
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import type { RouteListRow, RouteRow } from './dto.js';

/** timestamptz → JS-style ISO string inside JSON aggregates (top-level columns are parsed by pg). */
export const isoJson = (expr: string) => `to_char(${expr} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const ROUTE_COLUMNS = `r.id, r.code, r.name, r.direction, r.description, r.is_active, r.polyline_encoded, r.polyline_source,
  r.polyline_computed_at, r.distance_m, r.duration_s, r.created_at, r.updated_at`;

const LIST_SELECT = `${ROUTE_COLUMNS}, st.stop_count, st.first_stop_time, st.last_stop_time, bs.buses,
  sch.active_schedule_count, stu.student_count, act.id as active_trip_id`;

const LIST_FROM = `from routes r
  cross join (select app_local_date() as d) today
  left join lateral (
    select count(*)::int as stop_count,
           (array_agg(s.expected_time order by s.sequence) filter (where s.expected_time is not null))[1] as first_stop_time,
           (array_agg(s.expected_time order by s.sequence desc) filter (where s.expected_time is not null))[1] as last_stop_time
      from stops s where s.route_id = r.id and s.deleted_at is null) st on true
  left join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('bus_id', b.id, 'bus_code', b.code, 'bus_name', b.display_name,
                    'registration_no', b.registration_no, 'assignment_id', a.id, 'valid_from', ${isoJson('a.valid_from')})
                    order by b.code), '[]'::jsonb) as buses
      from bus_route_assignments a join buses b on b.id = a.bus_id and b.deleted_at is null
     where a.route_id = r.id and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())) bs on true
  left join lateral (
    select count(*)::int as active_schedule_count from trip_schedules ts
     where ts.route_id = r.id and ts.deleted_at is null and ts.is_active and (ts.valid_to is null or ts.valid_to >= today.d)) sch on true
  left join lateral (
    select count(*)::int as student_count from student_assignments sa
     where sa.route_id = r.id and sa.valid_from <= today.d and (sa.valid_to is null or sa.valid_to > today.d)) stu on true
  left join lateral (select t.id from trips t where t.route_id = r.id and t.status = 'in_progress' limit 1) act on true`;

export interface RouteFilter {
  directions?: string[];
  isActive?: boolean;
  hasBus?: boolean;
  busId?: string;
  q?: string;
}

function where(f: RouteFilter): { sql: string; params: unknown[] } {
  const q = f.q?.trim() ? escapeLike(f.q.trim()) : null;
  return {
    sql: `r.deleted_at is null
      and ($1::text[] is null or r.direction = any ($1))
      and ($2::boolean is null or r.is_active = $2)
      and ($3::boolean is null or (jsonb_array_length(bs.buses) > 0) = $3)
      and ($4::uuid is null or exists (select 1 from bus_route_assignments x where x.route_id = r.id and x.bus_id = $4
                                         and x.valid_from <= now() and (x.valid_to is null or x.valid_to > now())))
      and ($5::text is null or r.code ilike '%' || $5 || '%' or r.name ilike '%' || $5 || '%' or r.description ilike '%' || $5 || '%')`,
    params: [f.directions ?? null, f.isActive ?? null, f.hasBus ?? null, f.busId ?? null, q],
  };
}

export function page(tx: Tx, f: RouteFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<RouteListRow>(tx, { select: LIST_SELECT, from: LIST_FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: RouteFilter, orderBy: string): Promise<RouteListRow[]> {
  const w = where(f);
  return tx.many<RouteListRow>(`select ${LIST_SELECT} ${LIST_FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

/** One live route with its counters (null when missing, deleted or in another school). */
export function findListRow(tx: Tx, id: string): Promise<RouteListRow | null> {
  return tx.maybeOne<RouteListRow>(`select ${LIST_SELECT} ${LIST_FROM} where r.id = $1 and r.deleted_at is null`, [id]);
}

/** Locks a live route for a write (serialises route edits, stop changes, assignments and deletes per route). */
export function lockRoute(tx: Tx, id: string): Promise<RouteRow | null> {
  return tx.maybeOne<RouteRow>(`select ${ROUTE_COLUMNS} from routes r where r.id = $1 and r.deleted_at is null for update`, [id]);
}

/** A live route without a lock. */
export function findRoute(tx: Tx, id: string): Promise<RouteRow | null> {
  return tx.maybeOne<RouteRow>(`select ${ROUTE_COLUMNS} from routes r where r.id = $1 and r.deleted_at is null`, [id]);
}

/** School location of the current school (route end/start point), null when not set. */
export async function schoolLocation(tx: Tx): Promise<{ latitude: number; longitude: number } | null> {
  const row = await tx.maybeOne<{ latitude: number | null; longitude: number | null }>(
    `select latitude, longitude from schools where id = nullif(current_setting('app.school_id', true), '')::uuid`,
  );
  return row && row.latitude !== null && row.longitude !== null ? { latitude: Number(row.latitude), longitude: Number(row.longitude) } : null;
}

/** API field → column (whitelist for inserts and partial updates). */
export const ROUTE_FIELD_COLUMNS = {
  code: 'code',
  name: 'name',
  direction: 'direction',
  description: 'description',
  isActive: 'is_active',
} as const;
export type RouteField = keyof typeof ROUTE_FIELD_COLUMNS;

function entriesOf(values: Partial<Record<RouteField, unknown>>) {
  return (Object.keys(ROUTE_FIELD_COLUMNS) as RouteField[]).filter((k) => values[k] !== undefined).map((k) => [ROUTE_FIELD_COLUMNS[k], values[k]] as const);
}

export function insertRoute(tx: Tx, values: Partial<Record<RouteField, unknown>>): Promise<RouteRow> {
  const entries = entriesOf(values);
  return tx.one<RouteRow>(
    `insert into routes (school_id, created_by, ${entries.map(([c]) => c).join(', ')})
     values (nullif(current_setting('app.school_id', true), '')::uuid, nullif(current_setting('app.actor_id', true), '')::uuid,
             ${entries.map((_, i) => `$${i + 1}`).join(', ')})
     returning *`,
    entries.map(([, v]) => v),
  );
}

export function updateRoute(tx: Tx, id: string, values: Partial<Record<RouteField, unknown>>): Promise<RouteRow> {
  const entries = entriesOf(values);
  const sets = entries.map(([c], i) => `${c} = $${i + 2}`);
  return tx.one<RouteRow>(`update routes set ${sets.join(', ')}, updated_at = now() where id = $1 and deleted_at is null returning *`, [id, ...entries.map(([, v]) => v)]);
}

/** Stores a computed planned path (null polyline clears it — fewer than two points). */
export async function savePolyline(tx: Tx, id: string, p: { polyline: string | null; source: string | null; distanceM: number | null; durationS: number | null }): Promise<void> {
  await tx.query(
    `update routes set polyline_encoded = $2, polyline_source = $3, distance_m = $4, duration_s = $5,
            polyline_computed_at = case when $2::text is null then null else now() end
      where id = $1 and deleted_at is null`,
    [id, p.polyline, p.source, p.distanceM, p.durationS],
  );
}

/** What still references a route (blocks direction changes, deactivation and deletes). */
export function routeUsage(tx: Tx, id: string) {
  return tx.one<{ active_trip_id: string | null; student_assignments: number; live_schedules: number; any_schedules: number; any_student_assignments: number }>(
    `select (select t.id from trips t where t.route_id = $1 and t.status = 'in_progress' limit 1) as active_trip_id,
            (select count(*)::int from student_assignments sa
              where sa.route_id = $1 and (sa.valid_to is null or sa.valid_to > app_local_date())) as student_assignments,
            (select count(*)::int from trip_schedules ts
              where ts.route_id = $1 and ts.deleted_at is null and ts.is_active
                and (ts.valid_to is null or ts.valid_to >= app_local_date())) as live_schedules,
            (select count(*)::int from trip_schedules ts where ts.route_id = $1) as any_schedules,
            (select count(*)::int from student_assignments sa where sa.route_id = $1) as any_student_assignments`,
    [id],
  );
}

/**
 * Soft delete in one statement: marks the route deleted, closes its open bus assignments, retires its
 * remaining (inactive or expired) schedules and cancels its not-yet-started trips from today on.
 */
export function softDelete(tx: Tx, id: string, reason: string) {
  return tx.one<{ buses_closed: number; schedules_deleted: number; trips_cancelled: number }>(
    `with del as (
       update routes set deleted_at = now(), updated_at = now() where id = $1 and deleted_at is null returning id
     ), buses as (
       update bus_route_assignments set valid_to = greatest(now(), valid_from)
        where route_id in (select id from del) and (valid_to is null or valid_to > now()) returning 1
     ), schedules as (
       update trip_schedules set deleted_at = now(), is_active = false, updated_at = now()
        where route_id in (select id from del) and deleted_at is null returning 1
     ), trips_cancelled as (
       update trips set status = 'cancelled', cancel_reason = $2,
              cancelled_by = nullif(current_setting('app.actor_id', true), '')::uuid, updated_at = now()
        where route_id in (select id from del) and status = 'scheduled' and trip_date >= app_local_date() returning 1
     )
     select (select count(*)::int from buses) as buses_closed, (select count(*)::int from schedules) as schedules_deleted,
            (select count(*)::int from trips_cancelled) as trips_cancelled`,
    [id, reason],
  );
}
