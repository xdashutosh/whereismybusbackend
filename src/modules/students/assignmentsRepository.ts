// Student assignment SQL (BP §6.2 student_assignments, §19 #8): per direction a bus → route → stop
// with a half-open validity window [valid_from, valid_to) of school-local dates (NULL = open).
// Changes never rewrite history: the rows that have not ended by the effective date are closed at
// that date (upcoming rows collapse to an empty window) and a new open row starts on it, so the
// one_open_assignment index and the student_assignments_no_overlap exclusion always hold.
import type { Direction } from '@wimb/shared';
import type { Tx } from '../../db/tenant.js';
import { pagedQuery } from '../../shared/pagination.js';
import type { AssignmentJson } from './dto.js';
import { ASSIGNMENT_JOINS, ASSIGNMENT_JSON } from './repository.js';

/** Everything needed to check an assignment target in one statement. */
export interface TargetCheckRow extends Record<string, unknown> {
  bus_id: string | null;
  bus_code: string | null;
  bus_status: string | null;
  bus_capacity: number | null;
  route_id: string | null;
  route_direction: string | null;
  route_active: boolean | null;
  stop_id: string | null;
  stop_route_id: string | null;
  bus_serves_route: boolean;
}

/**
 * Bus, route and stop of a target (each null when missing, deleted or in another school) and
 * whether the bus serves the route on the effective date: an open bus ↔ route assignment, or a
 * live schedule of that bus on that route still valid then.
 */
export function checkTarget(tx: Tx, t: { busId: string; routeId: string; stopId: string }, effectiveFrom: string): Promise<TargetCheckRow> {
  return tx.one<TargetCheckRow>(
    `select b.id as bus_id, b.code as bus_code, b.status as bus_status, b.capacity as bus_capacity,
            r.id as route_id, r.direction as route_direction, r.is_active as route_active,
            st.id as stop_id, st.route_id as stop_route_id,
            (exists (select 1 from bus_route_assignments bra
                      where bra.bus_id = $1 and bra.route_id = $2 and (bra.valid_to is null or bra.valid_to > now()))
             or exists (select 1 from trip_schedules ts
                         where ts.bus_id = $1 and ts.route_id = $2 and ts.deleted_at is null and ts.is_active
                           and (ts.valid_to is null or ts.valid_to >= $4::date))) as bus_serves_route
       from (select 1) one
       left join buses b on b.id = $1 and b.deleted_at is null
       left join routes r on r.id = $2 and r.deleted_at is null
       left join stops st on st.id = $3 and st.deleted_at is null`,
    [t.busId, t.routeId, t.stopId, effectiveFrom],
  );
}

export interface OpenAssignmentRow extends Record<string, unknown> {
  id: string;
  student_id: string;
  trip_direction: Direction;
  bus_id: string;
  route_id: string;
  stop_id: string;
  valid_from: string;
  valid_to: string | null;
}

/** Rows of the students not ended by `date` (current and upcoming) for a direction. */
export function effectiveRows(tx: Tx, studentIds: readonly string[], direction: Direction, date: string): Promise<OpenAssignmentRow[]> {
  return tx.many<OpenAssignmentRow>(
    `select id, student_id, trip_direction, bus_id, route_id, stop_id, valid_from, valid_to
       from student_assignments
      where student_id = any ($1::uuid[]) and trip_direction = $2 and (valid_to is null or valid_to > $3::date)
        and valid_to is distinct from valid_from
      order by student_id, valid_from`,
    [studentIds, direction, date],
  );
}

/** Ends every row of the students not ended by `date` (upcoming rows collapse to empty windows). */
export async function closeFrom(tx: Tx, studentIds: readonly string[], direction: Direction, date: string): Promise<number> {
  const res = await tx.query(
    `update student_assignments set valid_to = greatest(valid_from, $3::date)
      where student_id = any ($1::uuid[]) and trip_direction = $2 and (valid_to is null or valid_to > $3::date)
        and valid_to is distinct from valid_from`,
    [studentIds, direction, date],
  );
  return res.rowCount ?? 0;
}

/** Opens one assignment row per student starting on `date` (one multi-row statement). */
export async function openFrom(tx: Tx, studentIds: readonly string[], direction: Direction, t: { busId: string; routeId: string; stopId: string }, date: string): Promise<number> {
  if (!studentIds.length) return 0;
  const res = await tx.query(
    `insert into student_assignments (school_id, student_id, trip_direction, bus_id, route_id, stop_id, valid_from, created_by)
     select nullif(current_setting('app.school_id', true), '')::uuid, x.id, $2, $3, $4, $5, $6::date,
            nullif(current_setting('app.actor_id', true), '')::uuid
       from unnest($1::uuid[]) as x(id)`,
    [studentIds, direction, t.busId, t.routeId, t.stopId, date],
  );
  return res.rowCount ?? 0;
}

/** Current and upcoming rows of one student with display names. */
export async function effectiveForStudent(tx: Tx, studentId: string): Promise<AssignmentJson[]> {
  const rows = await tx.many<{ a: AssignmentJson }>(
    `select ${ASSIGNMENT_JSON} as a
       from student_assignments sa ${ASSIGNMENT_JOINS}
      cross join (select app_local_date() as d) today
      where sa.student_id = $1 and (sa.valid_to is null or sa.valid_to > today.d) and sa.valid_to is distinct from sa.valid_from
      order by sa.trip_direction, sa.valid_from`,
    [studentId],
  );
  return rows.map((r) => r.a);
}

/** Full history (newest first), optionally for one direction. */
export function history(tx: Tx, studentId: string, o: { direction?: Direction; limit: number; offset: number }) {
  return pagedQuery<{ a: AssignmentJson }>(tx, {
    select: `${ASSIGNMENT_JSON} as a, sa.valid_from, sa.created_at, sa.id`,
    from: `from student_assignments sa ${ASSIGNMENT_JOINS} cross join (select app_local_date() as d) today`,
    where: 'sa.student_id = $1 and ($2::text is null or sa.trip_direction = $2)',
    params: [studentId, o.direction ?? null],
    orderBy: 'ORDER BY sa.valid_from DESC, sa.created_at DESC, sa.id DESC',
    limit: o.limit,
    offset: o.offset,
  });
}

/** Students assigned to the bus in that direction on `date` vs its capacity (over-capacity only). */
export function capacityOverflow(tx: Tx, busId: string, direction: Direction, date: string) {
  return tx.maybeOne<{ bus_id: string; code: string; capacity: number; assigned: number }>(
    `select b.id as bus_id, b.code, b.capacity, count(sa.id)::int as assigned
       from buses b
       join student_assignments sa on sa.bus_id = b.id and sa.trip_direction = $2
                                  and sa.valid_from <= $3::date and (sa.valid_to is null or sa.valid_to > $3::date)
       join students s on s.id = sa.student_id and s.deleted_at is null and s.is_active
      where b.id = $1 and b.capacity is not null
      group by b.id, b.code, b.capacity
     having count(sa.id) > b.capacity`,
    [busId, direction, date],
  );
}

/** Today in the school's timezone (YYYY-MM-DD). */
export async function localToday(tx: Tx): Promise<string> {
  return (await tx.one<{ d: string }>('select app_local_date()::text as d')).d;
}

/** Parent accounts linked to the students (their live-tracking rooms depend on the assignments). */
export async function linkedParentIds(tx: Tx, studentIds: readonly string[]): Promise<string[]> {
  if (!studentIds.length) return [];
  const rows = await tx.many<{ id: string }>('select distinct parent_account_id as id from student_parents where student_id = any($1::uuid[])', [studentIds]);
  return rows.map((r) => r.id);
}
