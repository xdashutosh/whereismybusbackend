// Bus ↔ route assignments (BP §6.2 bus_route_assignments: history with half-open windows
// [valid_from, valid_to); bus_route_assignments_no_overlap keeps one window per bus+route at a time).
import type { Tx } from '../../db/tenant.js';
import { MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import type { AssignmentRow } from './dto.js';

const CURRENT = '(a.valid_from <= now() and (a.valid_to is null or a.valid_to > now()))';
const SELECT = `a.id, a.bus_id, b.code as bus_code, b.display_name as bus_name, a.route_id, r.code as route_code, r.name as route_name,
  r.direction, a.valid_from, a.valid_to, ${CURRENT} as is_current, u.full_name as created_by_name, a.created_at`;
const FROM = `from bus_route_assignments a
  join buses b on b.id = a.bus_id
  join routes r on r.id = a.route_id
  left join users u on u.id = a.created_by`;

export interface BusCandidate extends Record<string, unknown> {
  id: string;
  code: string;
  status: string;
}

/** A live bus of the current school. */
export function findBus(tx: Tx, busId: string): Promise<BusCandidate | null> {
  return tx.maybeOne<BusCandidate>('select id, code, status from buses where id = $1 and deleted_at is null', [busId]);
}

/** Assignments of bus+route that are open now or start later (newest first). */
export function openAssignments(tx: Tx, routeId: string, busId: string): Promise<AssignmentRow[]> {
  return tx.many<AssignmentRow>(
    `select ${SELECT} ${FROM} where a.route_id = $1 and a.bus_id = $2 and (a.valid_to is null or a.valid_to > now()) order by a.valid_from desc, a.id`,
    [routeId, busId],
  );
}

export function findAssignment(tx: Tx, id: string): Promise<AssignmentRow> {
  return tx.one<AssignmentRow>(`select ${SELECT} ${FROM} where a.id = $1`, [id]);
}

export async function insertAssignment(tx: Tx, routeId: string, busId: string, at: string): Promise<string> {
  const row = await tx.one<{ id: string }>(
    `insert into bus_route_assignments (school_id, bus_id, route_id, valid_from, created_by)
     values (nullif(current_setting('app.school_id', true), '')::uuid, $2, $1, $3::timestamptz, nullif(current_setting('app.actor_id', true), '')::uuid)
     returning id`,
    [routeId, busId, at],
  );
  return row.id;
}

/** Closes an assignment at `at` (never before its start). */
export async function closeAssignment(tx: Tx, id: string, at: string): Promise<void> {
  await tx.query('update bus_route_assignments set valid_to = greatest($2::timestamptz, valid_from) where id = $1', [id, at]);
}

/** Live, active schedules of bus+route still running today or later (block an unassign). */
export async function liveSchedules(tx: Tx, routeId: string, busId: string): Promise<number> {
  const row = await tx.one<{ n: number }>(
    `select count(*)::int as n from trip_schedules
      where route_id = $1 and bus_id = $2 and deleted_at is null and is_active and (valid_to is null or valid_to >= app_local_date())`,
    [routeId, busId],
  );
  return row.n;
}

export interface AssignmentFilter {
  routeId?: string;
  busId?: string;
  directions?: string[];
  current?: boolean;
}

function where(f: AssignmentFilter) {
  return {
    sql: `($1::uuid is null or a.route_id = $1)
      and ($2::uuid is null or a.bus_id = $2)
      and ($3::text[] is null or r.direction = any ($3))
      and ($4::boolean is null or ${CURRENT} = $4)`,
    params: [f.routeId ?? null, f.busId ?? null, f.directions ?? null, f.current ?? null],
  };
}

export function historyPage(tx: Tx, f: AssignmentFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(f);
  return pagedQuery<AssignmentRow>(tx, { select: SELECT, from: FROM, where: w.sql, params: w.params, ...o });
}

export function historyExport(tx: Tx, f: AssignmentFilter, orderBy: string): Promise<AssignmentRow[]> {
  const w = where(f);
  return tx.many<AssignmentRow>(`select ${SELECT} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}
