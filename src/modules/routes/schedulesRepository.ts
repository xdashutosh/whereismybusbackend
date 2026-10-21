// Trip schedule SQL (BP §6.2 trip_schedules: bus + route + direction + planned start + ISO weekdays +
// inclusive validity dates). The estimated duration of a route (overlap window) is computed live from
// its stops: max(span of the stops' expected times, computed driving time + STOP_DWELL_S per stop),
// DEFAULT_TRIP_DURATION_MIN when neither is known, clamped to [MIN, MAX]_TRIP_DURATION_MIN.
import { DEFAULT_TRIP_DURATION_MIN, MAX_TRIP_DURATION_MIN, MIN_TRIP_DURATION_MIN, STOP_DWELL_S } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { escapeLike, MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import type { ScheduleRow } from './dto.js';

/** Lateral join `rs` + expression for the estimated duration (minutes) of route alias `r`. */
const DURATION_JOIN = `left join lateral (
    select count(*)::int as n, extract(epoch from (max(s.expected_time) - min(s.expected_time)))::int as span_s
      from stops s where s.route_id = r.id and s.deleted_at is null) rs on true`;
const DURATION_EXPR = `greatest(${MIN_TRIP_DURATION_MIN}, least(${MAX_TRIP_DURATION_MIN}, ceil(coalesce(
    nullif(greatest(coalesce(rs.span_s, 0), coalesce(r.duration_s + ${STOP_DWELL_S} * rs.n, 0)), 0), ${DEFAULT_TRIP_DURATION_MIN * 60}) / 60.0)))::int`;

const SELECT = `ts.id, ts.name, ts.bus_id, b.code as bus_code, b.display_name as bus_name, ts.route_id, r.code as route_code,
  r.name as route_name, ts.direction, ts.planned_start_time, ts.days_of_week, ts.valid_from, ts.valid_to, ts.is_active,
  ${DURATION_EXPR} as estimated_duration_min, ts.created_at, ts.updated_at`;
const FROM = `from trip_schedules ts
  join buses b on b.id = ts.bus_id
  join routes r on r.id = ts.route_id
  ${DURATION_JOIN}`;

export interface ScheduleFilter {
  busId?: string;
  routeId?: string;
  directions?: string[];
  isActive?: boolean;
  day?: number;
  validOn?: string;
  q?: string;
}

function where(f: ScheduleFilter) {
  const q = f.q?.trim() ? escapeLike(f.q.trim()) : null;
  return {
    sql: `ts.deleted_at is null
      and ($1::uuid is null or ts.bus_id = $1)
      and ($2::uuid is null or ts.route_id = $2)
      and ($3::text[] is null or ts.direction = any ($3))
      and ($4::boolean is null or ts.is_active = $4)
      and ($5::smallint is null or $5 = any (ts.days_of_week))
      and ($6::date is null or ((ts.valid_from is null or ts.valid_from <= $6) and (ts.valid_to is null or ts.valid_to >= $6)))
      and ($7::text is null or ts.name ilike '%' || $7 || '%' or b.code ilike '%' || $7 || '%' or r.code ilike '%' || $7 || '%'
           or r.name ilike '%' || $7 || '%')`,
    params: [f.busId ?? null, f.routeId ?? null, f.directions ?? null, f.isActive ?? null, f.day ?? null, f.validOn ?? null, q],
  };
}

export function page(tx: Tx, f: ScheduleFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<ScheduleRow>(tx, { select: SELECT, from: FROM, where: w.sql, params: w.params, ...o });
}

export function exportRows(tx: Tx, f: ScheduleFilter, orderBy: string): Promise<ScheduleRow[]> {
  const w = where(f);
  return tx.many<ScheduleRow>(`select ${SELECT} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

export function findSchedule(tx: Tx, id: string): Promise<ScheduleRow | null> {
  return tx.maybeOne<ScheduleRow>(`select ${SELECT} ${FROM} where ts.id = $1 and ts.deleted_at is null`, [id]);
}

export interface ScheduleBaseRow extends Record<string, unknown> {
  id: string;
  name: string | null;
  bus_id: string;
  route_id: string;
  direction: string;
  planned_start_time: string;
  days_of_week: number[];
  valid_from: string | null;
  valid_to: string | null;
  is_active: boolean;
}

/** Locks a live schedule for a write. */
export function lockSchedule(tx: Tx, id: string): Promise<ScheduleBaseRow | null> {
  return tx.maybeOne<ScheduleBaseRow>(
    `select id, name, bus_id, route_id, direction, planned_start_time, days_of_week, valid_from, valid_to, is_active
       from trip_schedules where id = $1 and deleted_at is null for update`,
    [id],
  );
}

/** Serialises schedule writes per bus (transaction-level advisory lock — PgBouncer-safe). */
export async function lockBusSchedules(tx: Tx, busId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('wimb:bus-schedules:' || $1::text, 0))`, [busId]);
}

export interface ScheduleRouteRow extends Record<string, unknown> {
  id: string;
  code: string;
  direction: string;
  is_active: boolean;
  estimated_duration_min: number;
}

/** A live route with its estimated duration. */
export function findRouteForSchedule(tx: Tx, routeId: string): Promise<ScheduleRouteRow | null> {
  return tx.maybeOne<ScheduleRouteRow>(
    `select r.id, r.code, r.direction, r.is_active, ${DURATION_EXPR} as estimated_duration_min
       from routes r ${DURATION_JOIN} where r.id = $1 and r.deleted_at is null`,
    [routeId],
  );
}

/** Other active schedules of the bus whose validity intersects [validFrom, validTo] (inclusive, null = open). */
export function sameBusSchedules(tx: Tx, busId: string, exceptId: string | null, validFrom: string | null, validTo: string | null): Promise<ScheduleRow[]> {
  return tx.many<ScheduleRow>(
    `select ${SELECT} ${FROM}
      where ts.bus_id = $1 and ts.deleted_at is null and ts.is_active and ($2::uuid is null or ts.id <> $2)
        and daterange(coalesce(ts.valid_from, '-infinity'::date), coalesce(ts.valid_to, 'infinity'::date), '[]')
            && daterange(coalesce($3::date, '-infinity'::date), coalesce($4::date, 'infinity'::date), '[]')
      order by ts.planned_start_time, ts.id`,
    [busId, exceptId, validFrom, validTo],
  );
}

export const SCHEDULE_FIELD_COLUMNS = {
  busId: 'bus_id',
  routeId: 'route_id',
  direction: 'direction',
  name: 'name',
  plannedStartTime: 'planned_start_time',
  daysOfWeek: 'days_of_week',
  validFrom: 'valid_from',
  validTo: 'valid_to',
  isActive: 'is_active',
} as const;
export type ScheduleField = keyof typeof SCHEDULE_FIELD_COLUMNS;

const cast = (c: string) => (c === 'days_of_week' ? '::smallint[]' : '');
function entriesOf(values: Partial<Record<ScheduleField, unknown>>) {
  return (Object.keys(SCHEDULE_FIELD_COLUMNS) as ScheduleField[]).filter((k) => values[k] !== undefined).map((k) => [SCHEDULE_FIELD_COLUMNS[k], values[k]] as const);
}

export async function insertSchedule(tx: Tx, values: Partial<Record<ScheduleField, unknown>>): Promise<string> {
  const entries = entriesOf(values);
  const row = await tx.one<{ id: string }>(
    `insert into trip_schedules (school_id, created_by, ${entries.map(([c]) => c).join(', ')})
     values (nullif(current_setting('app.school_id', true), '')::uuid, nullif(current_setting('app.actor_id', true), '')::uuid,
             ${entries.map(([c], i) => `$${i + 1}${cast(c)}`).join(', ')})
     returning id`,
    entries.map(([, v]) => v),
  );
  return row.id;
}

export async function updateSchedule(tx: Tx, id: string, values: Partial<Record<ScheduleField, unknown>>): Promise<void> {
  const entries = entriesOf(values);
  if (!entries.length) return;
  await tx.query(
    `update trip_schedules set ${entries.map(([c], i) => `${c} = $${i + 2}${cast(c)}`).join(', ')}, updated_at = now()
      where id = $1 and deleted_at is null`,
    [id, ...entries.map(([, v]) => v)],
  );
}

export async function softDeleteSchedule(tx: Tx, id: string): Promise<void> {
  await tx.query('update trip_schedules set deleted_at = now(), is_active = false, updated_at = now() where id = $1 and deleted_at is null', [id]);
}
