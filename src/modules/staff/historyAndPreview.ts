// Assignment history (BP §13.3 Staff "assignment history", from bus_staff_assignments) and the
// parent-visibility preview (BP §13.3 "parent-visibility preview"): exactly the card a parent of a
// child on this staff member's bus would see under the school's current matrix, plus why fields
// or documents are hidden and whether parents see the card at all right now.
import type { ParentStaffHiddenReason, ParentStaffPreview, StaffAssignmentItem, StaffType } from '@wimb/shared';
import type { Request, Response } from 'express';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import * as assignmentsRepo from './assignmentsRepository.js';
import * as documentsRepo from './documentsRepository.js';
import { toAssignmentItem } from './dto.js';
import * as repo from './repository.js';
import type { StaffAssignmentHistoryQuery } from './schemas.js';
import { buildParentCard, hiddenDocumentReason, loadStaffMatrix, parentProfile } from './visibility.js';

const SORT = {
  allowed: { validFrom: 'a.valid_from', validTo: 'a.valid_to', busCode: 'b.code', role: 'a.assignment_role', createdAt: 'a.created_at' },
  defaultSort: '-validFrom',
  tiebreaker: 'a.id',
};

const CSV_COLUMNS: CsvColumn<StaffAssignmentItem>[] = [
  { header: 'Bus', key: 'busCode' },
  { header: 'Bus name', key: 'busName' },
  { header: 'Registration', key: 'registrationNo' },
  { header: 'Role', key: 'role' },
  { header: 'From (UTC)', key: 'validFrom' },
  { header: 'To (UTC)', key: 'validTo' },
  { header: 'Current', value: (r) => (r.isCurrent ? 'yes' : 'no') },
  { header: 'Assigned by', key: 'createdByName' },
];

/** GET /school/staff/:id/assignment-history — JSON page or CSV. */
export async function history(req: Request, res: Response, staffId: string, q: StaffAssignmentHistoryQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter: assignmentsRepo.HistoryFilter = { roles: q.role, busId: q.busId, current: q.current };
  if (q.format === 'csv') {
    const rows = await withRequestTenant(
      req,
      async (tx) => {
        if (!(await repo.exists(tx, staffId))) throw notFound('Staff member not found.');
        return assignmentsRepo.historyExport(tx, staffId, filter, orderBy);
      },
      { readOnly: true },
    );
    const csv = createCsvWriter<StaffAssignmentItem>(res, { fileName: 'staff-assignment-history.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map(toAssignmentItem));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(
    req,
    async (tx) => {
      if (!(await repo.exists(tx, staffId))) throw notFound('Staff member not found.');
      return assignmentsRepo.historyPage(tx, staffId, filter, { orderBy, limit, offset });
    },
    { readOnly: true },
  );
  sendList(res, (rows as assignmentsRepo.StaffAssignmentRow[]).map(toAssignmentItem), listMeta({ page, limit, total }));
}

/** GET /school/staff/:id/parent-preview */
export async function parentPreview(req: Request, staffId: string): Promise<ParentStaffPreview> {
  const data = await withRequestTenant(
    req,
    async (tx) => {
      const profile = await parentProfile(tx, staffId);
      if (!profile) throw notFound('Staff member not found.');
      return {
        profile,
        matrix: await loadStaffMatrix(tx, profile.staff_type as StaffType),
        documents: await documentsRepo.listForStaff(tx, staffId),
        assignments: await assignmentsRepo.currentAssignments(tx, staffId),
      };
    },
    { readOnly: true },
  );
  const { profile, matrix, documents, assignments } = data;
  const hiddenReasons: ParentStaffHiddenReason[] = [];
  if (!profile.is_active) hiddenReasons.push('INACTIVE');
  if (!assignments.length) hiddenReasons.push('NOT_ASSIGNED');
  const hiddenDocuments = documents.flatMap((d) => {
    const reason = hiddenDocumentReason(matrix, d);
    return reason ? [{ documentId: d.id, docType: d.doc_type as ParentStaffPreview['hiddenDocuments'][number]['docType'], reason }] : [];
  });
  return {
    staffId,
    staffType: profile.staff_type as StaffType,
    visibleToParents: hiddenReasons.length === 0,
    hiddenReasons,
    buses: assignments.map((a) => ({ busId: a.bus_id, busCode: a.bus_code, role: a.assignment_role as ParentStaffPreview['buses'][number]['role'] })),
    matrix,
    hiddenFields: Object.entries(matrix)
      .filter(([, v]) => !v)
      .map(([k]) => k),
    hiddenDocuments,
    card: await buildParentCard(req, profile, matrix, documents),
  };
}
