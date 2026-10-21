// Students service (BP §8.3 Students, §13.3; contract §5, §9): list with filters (class, section,
// bus, route, stop, direction, unassigned, parents) / sort / pagination / CSV export, detail with
// parents and assignments, create (plan limit, admission number unique per school), edit (photo via
// the files module), soft delete. Every write is audited in its transaction.
import type { StudentDetail, StudentListItem } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { fieldError, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { optionalSignedUrl } from '../files/urls.js';
import { assertSubscriptionCapacity } from '../platform/index.js';
import * as assignmentsRepo from './assignmentsRepository.js';
import { byDirection, studentAuditView, toAssignmentDto, toParentLinkDto, toStudentListItem, type StudentListRow } from './dto.js';
import { disconnectParentSockets } from './parentSessions.js';
import * as parentsRepo from './parentsRepository.js';
import * as repo from './repository.js';
import type { CreateStudentBody, StudentListQuery, UpdateStudentBody } from './schemas.js';

const SORT = {
  allowed: {
    fullName: 'lower(s.full_name)',
    admissionNo: 's.admission_no',
    className: 's.class_name',
    section: 's.section',
    rollNo: 's.roll_no',
    isActive: 's.is_active',
    createdAt: 's.created_at',
    updatedAt: 's.updated_at',
  },
  defaultSort: 'className,section,fullName',
  tiebreaker: 's.id',
};

const assignmentCell = (d: 'morning' | 'afternoon', part: 'bus' | 'route' | 'stop') => (r: StudentListItem) => {
  const a = r.assignments[d];
  if (!a) return '';
  if (part === 'bus') return a.busCode;
  if (part === 'route') return a.routeCode;
  return a.stopName;
};

const CSV_COLUMNS: CsvColumn<StudentListItem>[] = [
  { header: 'Admission no', key: 'admissionNo' },
  { header: 'Name', key: 'fullName' },
  { header: 'Class', key: 'className' },
  { header: 'Section', key: 'section' },
  { header: 'Roll no', key: 'rollNo' },
  { header: 'Active', value: (r) => (r.isActive ? 'yes' : 'no') },
  { header: 'Morning bus', value: assignmentCell('morning', 'bus') },
  { header: 'Morning route', value: assignmentCell('morning', 'route') },
  { header: 'Morning stop', value: assignmentCell('morning', 'stop') },
  { header: 'Afternoon bus', value: assignmentCell('afternoon', 'bus') },
  { header: 'Afternoon route', value: assignmentCell('afternoon', 'route') },
  { header: 'Afternoon stop', value: assignmentCell('afternoon', 'stop') },
  { header: 'Primary parent', value: (r) => r.primaryParent?.fullName ?? '' },
  { header: 'Primary parent phone', value: (r) => r.primaryParent?.phone ?? '' },
  { header: 'Parents', key: 'parentCount' },
  { header: 'Created (UTC)', key: 'createdAt' },
];

function filterOf(q: StudentListQuery): repo.StudentFilter {
  return {
    q: q.q,
    className: q.className,
    section: q.section,
    busId: q.busId,
    routeId: q.routeId,
    stopId: q.stopId,
    direction: q.direction,
    unassigned: q.unassigned,
    isActive: q.isActive,
    hasParents: q.hasParents,
  };
}

async function listItems(req: Request, rows: StudentListRow[]): Promise<StudentListItem[]> {
  return Promise.all(rows.map(async (r) => toStudentListItem(r, await optionalSignedUrl(req, r.photo_thumb_key ?? r.photo_key))));
}

/** GET /school/students — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: StudentListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<StudentListItem>(res, { fileName: 'students.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map((r) => toStudentListItem(r, null)));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  sendList(res, await listItems(req, rows as StudentListRow[]), listMeta({ page, limit, total }));
}

export async function listRow(tx: Tx, id: string): Promise<StudentListRow> {
  const row = await repo.findListRow(tx, id);
  if (!row) throw notFound('Student not found.');
  return row;
}

/** Detail of a student read inside `tx` (no signed URLs). */
export async function loadDetail(tx: Tx, id: string) {
  const row = await listRow(tx, id);
  const [parents, effective] = [await parentsRepo.linksOfStudent(tx, id), await assignmentsRepo.effectiveForStudent(tx, id)];
  return { row, parents, effective };
}

/** GET /school/students/:id — student, parents, current and upcoming assignments. */
export async function get(req: Request, id: string): Promise<StudentDetail> {
  const { row, parents, effective } = await withRequestTenant(req, (tx) => loadDetail(tx, id), { readOnly: true });
  const assignments = effective.map(toAssignmentDto);
  return {
    ...toStudentListItem(row, await optionalSignedUrl(req, row.photo_thumb_key ?? row.photo_key)),
    assignments: byDirection(assignments),
    notes: row.notes,
    photoUrl: await optionalSignedUrl(req, row.photo_key),
    parents: parents.map(toParentLinkDto),
    effectiveAssignments: assignments,
  };
}

/** Plan limit for active students (contract §9 subscription limits). */
export async function assertPlanCapacity(tx: Tx, adding = 1): Promise<void> {
  // One rule and one lock with the platform module (403 FORBIDDEN, details.reason SUBSCRIPTION_LIMIT).
  await assertSubscriptionCapacity(tx, 'students', adding);
}

/** A photo must be an uploaded student_photo of this very student (POST /files/upload). */
async function assertPhotoUsable(tx: Tx, fileId: string, studentId: string): Promise<void> {
  const file = await repo.findPhotoFile(tx, fileId);
  if (!file) throw notFound('File not found.', { field: 'photoFileId' });
  if (file.category !== 'student_photo' || file.entity_type !== 'student' || file.entity_id !== studentId) {
    throw fieldError('photoFileId', 'Upload the photo for this student (POST /files/upload, category student_photo, entityId = the student).');
  }
  if (file.status !== 'uploaded') throw invalidState('The photo upload is not complete.', { field: 'photoFileId' });
}

/** POST /school/students */
export async function create(req: Request, body: CreateStudentBody): Promise<StudentListItem> {
  return withRequestTenant(req, async (tx) => {
    if (body.isActive !== false) await assertPlanCapacity(tx);
    const student = await repo.insertStudent(tx, body);
    await audit.log(tx, { action: 'student.create', entityType: 'student', entityId: student.id, new: studentAuditView(student) });
    return toStudentListItem(await listRow(tx, student.id), null);
  });
}

/** PATCH /school/students/:id */
export async function update(req: Request, id: string, body: UpdateStudentBody): Promise<StudentListItem> {
  const result = await withRequestTenant(req, async (tx) => {
    const before = await repo.lockStudent(tx, id);
    if (!before) throw notFound('Student not found.');
    if (body.photoFileId && body.photoFileId !== before.photo_file_id) await assertPhotoUsable(tx, body.photoFileId, id);
    if (body.isActive === true && !before.is_active) await assertPlanCapacity(tx);
    const after = await repo.updateStudent(tx, id, body);
    const diff = changedFields(studentAuditView(before), studentAuditView(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'student.update', entityType: 'student', entityId: id, ...diff });
    const deactivated = before.is_active && !after.is_active;
    return {
      item: toStudentListItem(await listRow(tx, id), null),
      parents: deactivated ? await repo.linkedParentAccounts(tx, id) : [],
    };
  });
  if (result.parents.length) await disconnectParentSockets(result.parents);
  return result.item;
}

/** DELETE /school/students/:id — soft delete; assignment history is kept, links are removed. */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true }> {
  const parents = await withRequestTenant(req, async (tx) => {
    const student = await repo.lockStudent(tx, id);
    if (!student) throw notFound('Student not found.');
    const linked = await repo.linkedParentAccounts(tx, id);
    const effects = await repo.softDelete(tx, id);
    await audit.log(tx, {
      action: 'student.delete',
      entityType: 'student',
      entityId: id,
      old: studentAuditView(student),
      new: { assignmentsEnded: effects.assignments_ended, parentLinksRemoved: effects.links_removed },
    });
    return linked;
  });
  if (parents.length) await disconnectParentSockets(parents);
  return { id, deleted: true as const };
}
