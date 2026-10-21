// Bus ↔ staff assignments (BP §6.2 bus_staff_assignments: history with half-open windows
// [valid_from, valid_to), at most one open primary driver per bus, no overlapping windows for the
// same staff member on the same bus). RLS-scoped via the caller's tx.
import type { Tx } from '../../db/tenant.js';
import { MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';
import type { AssignmentRow } from './dto.js';

const SELECT = `a.id, a.assignment_role, a.staff_id, sp.full_name as staff_name, sp.phone as staff_phone, sp.staff_type,
  a.valid_from, a.valid_to, (a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())) as is_current,
  a.created_by, u.full_name as created_by_name, a.created_at`;
const FROM = `from bus_staff_assignments a
  join staff_profiles sp on sp.id = a.staff_id
  left join users u on u.id = a.created_by`;

/** Assignments that are open now or start later (the ones a change may close). */
export function openAssignments(tx: Tx, busId: string): Promise<AssignmentRow[]> {
  return tx.many<AssignmentRow>(
    `select ${SELECT} ${FROM} where a.bus_id = $1 and (a.valid_to is null or a.valid_to > now()) order by a.valid_from, a.id`,
    [busId],
  );
}

/** Current assignments of a bus (one row per role at most for primary driver). */
export function currentAssignments(tx: Tx, busId: string): Promise<AssignmentRow[]> {
  return tx.many<AssignmentRow>(
    `select ${SELECT} ${FROM} where a.bus_id = $1 and a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())
      order by a.valid_from desc, a.id`,
    [busId],
  );
}

export interface StaffCandidate extends Record<string, unknown> {
  id: string;
  staff_type: string;
  full_name: string;
  is_active: boolean;
}

/** Live staff profiles of the current school among `ids`. */
export function staffCandidates(tx: Tx, ids: string[]): Promise<StaffCandidate[]> {
  return tx.many<StaffCandidate>('select id, staff_type, full_name, is_active from staff_profiles where id = any ($1::uuid[]) and deleted_at is null', [ids]);
}

/** Closes assignments at `at` (never before their start). */
export async function closeAssignments(tx: Tx, ids: string[], at: string): Promise<void> {
  if (!ids.length) return;
  await tx.query('update bus_staff_assignments set valid_to = greatest($2::timestamptz, valid_from) where id = any ($1::uuid[])', [ids, at]);
}

/** Opens assignments for (role, staff) pairs from `at` in one statement. */
export async function insertAssignments(tx: Tx, busId: string, rows: { role: string; staffId: string }[], at: string): Promise<void> {
  if (!rows.length) return;
  await tx.query(
    `insert into bus_staff_assignments (school_id, bus_id, staff_id, assignment_role, valid_from, created_by)
     select nullif(current_setting('app.school_id', true), '')::uuid, $1, x.staff_id, x.role, $4::timestamptz,
            nullif(current_setting('app.actor_id', true), '')::uuid
       from unnest($2::uuid[], $3::text[]) as x(staff_id, role)`,
    [busId, rows.map((r) => r.staffId), rows.map((r) => r.role), at],
  );
}

export interface HistoryFilter {
  roles?: string[];
  staffId?: string;
  current?: boolean;
}

function where(busId: string, f: HistoryFilter) {
  return {
    sql: `a.bus_id = $1
      and ($2::text[] is null or a.assignment_role = any ($2))
      and ($3::uuid is null or a.staff_id = $3)
      and ($4::boolean is null or (a.valid_from <= now() and (a.valid_to is null or a.valid_to > now())) = $4)`,
    params: [busId, f.roles ?? null, f.staffId ?? null, f.current ?? null],
  };
}

export function historyPage(tx: Tx, busId: string, f: HistoryFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(busId, f);
  return pagedQuery<AssignmentRow>(tx, { select: SELECT, from: FROM, where: w.sql, params: w.params, ...o });
}

export function historyExport(tx: Tx, busId: string, f: HistoryFilter, orderBy: string): Promise<AssignmentRow[]> {
  const w = where(busId, f);
  return tx.many<AssignmentRow>(`select ${SELECT} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}
