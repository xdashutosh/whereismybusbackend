// Bus assignments of a staff member (BP §6.2 bus_staff_assignments, written by the buses module's
// assign-staff endpoint): history with half-open windows [valid_from, valid_to). The staff module
// reads the history and closes open windows when a staff member leaves service.
import type { Tx } from '../../db/tenant.js';
import { MAX_EXPORT_ROWS, pagedQuery } from '../../shared/pagination.js';

export interface StaffAssignmentRow extends Record<string, unknown> {
  id: string;
  bus_id: string;
  bus_code: string;
  bus_name: string | null;
  registration_no: string;
  assignment_role: string;
  valid_from: string;
  valid_to: string | null;
  is_current: boolean;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

const CURRENT = '(a.valid_from <= now() and (a.valid_to is null or a.valid_to > now()))';
const SELECT = `a.id, a.bus_id, b.code as bus_code, b.display_name as bus_name, b.registration_no, a.assignment_role,
  a.valid_from, a.valid_to, ${CURRENT} as is_current, a.created_by, u.full_name as created_by_name, a.created_at`;
const FROM = `from bus_staff_assignments a
  join buses b on b.id = a.bus_id
  left join users u on u.id = a.created_by`;

export function currentAssignments(tx: Tx, staffId: string): Promise<StaffAssignmentRow[]> {
  return tx.many<StaffAssignmentRow>(
    `select ${SELECT} ${FROM} where a.staff_id = $1 and ${CURRENT} and b.deleted_at is null order by b.code, a.assignment_role`,
    [staffId],
  );
}

export interface HistoryFilter {
  roles?: string[];
  busId?: string;
  current?: boolean;
}

function where(staffId: string, f: HistoryFilter) {
  return {
    sql: `a.staff_id = $1
      and ($2::text[] is null or a.assignment_role = any ($2))
      and ($3::uuid is null or a.bus_id = $3)
      and ($4::boolean is null or ${CURRENT} = $4)`,
    params: [staffId, f.roles ?? null, f.busId ?? null, f.current ?? null],
  };
}

export function historyPage(tx: Tx, staffId: string, f: HistoryFilter, o: { orderBy: string; limit: number; offset: number }) {
  const w = where(staffId, f);
  return pagedQuery<StaffAssignmentRow>(tx, { select: SELECT, from: FROM, where: w.sql, params: w.params, ...o });
}

export function historyExport(tx: Tx, staffId: string, f: HistoryFilter, orderBy: string): Promise<StaffAssignmentRow[]> {
  const w = where(staffId, f);
  return tx.many<StaffAssignmentRow>(`select ${SELECT} ${FROM} where ${w.sql} ${orderBy} limit ${MAX_EXPORT_ROWS}`, w.params);
}

/**
 * Ends every open or future assignment of the staff member now (future ones become empty windows,
 * kept as history) → number of rows closed.
 */
export async function closeOpenAssignments(tx: Tx, staffId: string): Promise<number> {
  const res = await tx.query(
    'update bus_staff_assignments set valid_to = greatest(now(), valid_from) where staff_id = $1 and (valid_to is null or valid_to > now())',
    [staffId],
  );
  return res.rowCount ?? 0;
}
