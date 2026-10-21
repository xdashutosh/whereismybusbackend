// Staff assignment of a bus (BP §8.3 POST /school/buses/:id/assign-staff, GET /:id/assignment-history).
// One request may set any of the four roles: an id replaces the open assignment of that role
// (closing the previous one at the effective time — history is kept), null unassigns it, an
// unchanged id is a no-op. A staff member moved from another role on the same bus has that
// assignment closed too. The bus row is locked, so concurrent changes serialise; the
// one_primary_driver index is the database backstop for "one open primary driver".
import { ASSIGNMENT_ROLE_KEYS, type AssignmentRole, type AssignmentRoleKey, type BusAssignmentHistoryItem, type BusCurrentStaff } from '@wimb/shared';
import type { Request, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { fieldError, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as assignmentsRepo from './assignmentsRepository.js';
import { toCurrentStaff, toHistoryItem, type AssignmentRow } from './dto.js';
import * as repo from './repository.js';
import type { AssignmentHistoryQuery, AssignStaffBody } from './schemas.js';

/** Clock skew tolerated for a client-supplied effectiveFrom (ms). */
const FUTURE_TOLERANCE_MS = 60_000;

const ROLE_STAFF_TYPE: Record<AssignmentRole, 'driver' | 'conductor'> = {
  primary_driver: 'driver',
  backup_driver: 'driver',
  conductor: 'conductor',
  backup_conductor: 'conductor',
};

export type AssignmentChange = {
  role: AssignmentRole;
  action: 'assigned' | 'unassigned' | 'unchanged' | 'moved_out';
  staffId: string | null;
  previousStaffIds: string[];
};

export interface AssignStaffResult {
  staff: BusCurrentStaff;
  changes: AssignmentChange[];
  effectiveFrom: string | null;
}

const snapshot = (rows: AssignmentRow[]) => Object.fromEntries(rows.filter((r) => r.is_current).map((r) => [r.assignment_role, r.staff_id]));

/** POST /school/buses/:id/assign-staff */
export async function assign(req: Request, busId: string, body: AssignStaffBody): Promise<AssignStaffResult> {
  if (body.effectiveFrom && Date.parse(body.effectiveFrom) > Date.now() + FUTURE_TOLERANCE_MS) {
    throw fieldError('effectiveFrom', 'Cannot be in the future');
  }
  // 'now' is PostgreSQL's input literal for the transaction start time (= now()).
  const at = body.effectiveFrom ?? 'now';
  return withRequestTenant(req, async (tx) => {
    const bus = await repo.lockBus(tx, busId);
    if (!bus) throw notFound('Bus not found.');
    const requested = (Object.keys(ASSIGNMENT_ROLE_KEYS) as AssignmentRoleKey[])
      .filter((k) => body[k] !== undefined)
      .map((k) => ({ key: k, role: ASSIGNMENT_ROLE_KEYS[k], staffId: body[k] ?? null }));
    const ids = requested.map((r) => r.staffId).filter((x): x is string => x !== null);
    if (ids.length && bus.status === 'retired') throw invalidState('A retired bus cannot get new staff assignments.');

    const candidates = new Map((ids.length ? await assignmentsRepo.staffCandidates(tx, ids) : []).map((c) => [c.id, c]));
    for (const r of requested) {
      if (!r.staffId) continue;
      const c = candidates.get(r.staffId);
      if (!c) throw notFound('Staff member not found.', { field: r.key });
      if (!c.is_active) throw invalidState(`${c.full_name} is inactive and cannot be assigned.`, { field: r.key });
      if (c.staff_type !== ROLE_STAFF_TYPE[r.role]) throw fieldError(r.key, `Must be a ${ROLE_STAFF_TYPE[r.role]}`);
    }

    const open = await assignmentsRepo.openAssignments(tx, busId);
    const before = snapshot(open);
    const close = new Map<string, AssignmentRow>();
    const insert: { role: AssignmentRole; staffId: string }[] = [];
    const changes: AssignmentChange[] = [];
    for (const r of requested) {
      const holders = open.filter((a) => a.assignment_role === r.role);
      if (r.staffId && holders.length === 1 && holders[0]!.staff_id === r.staffId) {
        changes.push({ role: r.role, action: 'unchanged', staffId: r.staffId, previousStaffIds: [] });
        continue;
      }
      for (const h of holders) close.set(h.id, h);
      if (r.staffId) insert.push({ role: r.role, staffId: r.staffId });
      changes.push({ role: r.role, action: r.staffId ? 'assigned' : 'unassigned', staffId: r.staffId, previousStaffIds: holders.map((h) => h.staff_id) });
    }
    // A staff member moving between roles on this bus leaves the old role.
    for (const ins of insert) {
      for (const a of open) {
        if (a.staff_id === ins.staffId && !close.has(a.id)) {
          close.set(a.id, a);
          changes.push({ role: a.assignment_role as AssignmentRole, action: 'moved_out', staffId: null, previousStaffIds: [a.staff_id] });
        }
      }
    }
    if (body.effectiveFrom) {
      const effective = Date.parse(body.effectiveFrom);
      for (const a of close.values()) {
        if (Date.parse(a.valid_from) > effective) throw fieldError('effectiveFrom', `Must not be before the current assignment started (${a.valid_from})`);
      }
    }

    await assignmentsRepo.closeAssignments(tx, [...close.keys()], at);
    await assignmentsRepo.insertAssignments(tx, busId, insert, at);
    const current = await assignmentsRepo.currentAssignments(tx, busId);
    if (close.size || insert.length) {
      await audit.log(tx, {
        action: 'bus.assign_staff',
        entityType: 'bus',
        entityId: busId,
        old: before,
        new: { ...snapshot(current), effectiveFrom: body.effectiveFrom ?? null, note: body.note ?? null },
      });
    }
    return { staff: toCurrentStaff(current), changes, effectiveFrom: body.effectiveFrom ?? null };
  });
}

const HISTORY_SORT = {
  allowed: { validFrom: 'a.valid_from', validTo: 'a.valid_to', role: 'a.assignment_role', staffName: 'sp.full_name', createdAt: 'a.created_at' },
  defaultSort: '-validFrom',
  tiebreaker: 'a.id',
};

const HISTORY_CSV: CsvColumn<BusAssignmentHistoryItem>[] = [
  { header: 'Role', key: 'role' },
  { header: 'Staff', key: 'staffName' },
  { header: 'Staff type', key: 'staffType' },
  { header: 'From (UTC)', key: 'validFrom' },
  { header: 'To (UTC)', key: 'validTo' },
  { header: 'Current', value: (r) => (r.isCurrent ? 'yes' : 'no') },
  { header: 'Assigned by', key: 'createdByName' },
];

/** GET /school/buses/:id/assignment-history — JSON page or CSV. */
export async function history(req: Request, res: Response, busId: string, q: AssignmentHistoryQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, HISTORY_SORT);
  const filter = { roles: q.role, staffId: q.staffId, current: q.current };
  if (q.format === 'csv') {
    const rows = await withRequestTenant(
      req,
      async (tx) => {
        if (!(await repo.busExists(tx, busId))) throw notFound('Bus not found.');
        return assignmentsRepo.historyExport(tx, busId, filter, orderBy);
      },
      { readOnly: true },
    );
    const csv = createCsvWriter<BusAssignmentHistoryItem>(res, { fileName: 'bus-assignment-history.csv', columns: HISTORY_CSV });
    await csv.writeAll(rows.map(toHistoryItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(
    req,
    async (tx) => {
      if (!(await repo.busExists(tx, busId))) throw notFound('Bus not found.');
      return assignmentsRepo.historyPage(tx, busId, filter, { orderBy, limit, offset });
    },
    { readOnly: true },
  );
  sendList(res, rows.map((r) => toHistoryItem(r as AssignmentRow)), listMeta({ page, limit, total }));
}
