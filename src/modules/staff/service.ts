// Staff service (BP §8.3 Staff, §5.4, §13.3 Staff; contract §5): drivers and conductors — list with
// filters/sort/pagination/CSV, detail, create, edit (photo via an uploaded staff_photo), activate,
// deactivate and soft delete. Deactivation/deletion never delete history: they end the open bus
// assignments, disable the app login and revoke its sessions in the same transaction, then
// disconnect its sockets after commit (BP §5.2/§5.4). Both are refused while the staff member is on
// an in-progress trip. Every write is audited in its transaction.
import type { StaffDetail, StaffListItem } from '@wimb/shared';
import type { Request, Response } from 'express';
import type { Tx } from '../../db/tenant.js';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { createCsvWriter, type CsvColumn } from '../../shared/csv.js';
import { list as sendList } from '../../shared/envelope.js';
import { conflict, fieldError, invalidState, notFound } from '../../shared/errors.js';
import { listMeta, parsePagination, parseSort } from '../../shared/pagination.js';
import { realtime } from '../../shared/realtime.js';
import { revokeAllSessions } from '../auth/index.js';
import { optionalSignedUrl } from '../files/urls.js';
import * as assignmentsRepo from './assignmentsRepository.js';
import * as documentsRepo from './documentsRepository.js';
import { profileAuditView, toDetail, toListItem } from './dto.js';
import * as loginRepo from './loginRepository.js';
import * as repo from './repository.js';
import { LICENCE_FIELDS, type CreateStaffBody, type DeactivateBody, type StaffListQuery, type UpdateStaffBody } from './schemas.js';

registerConstraintError('staff_profiles_licence_ck', 'VALIDATION_ERROR', 'The licence expiry date cannot be before the issue date.');

const SORT = {
  allowed: {
    fullName: 'sp.full_name',
    staffType: 'sp.staff_type',
    joiningDate: 'sp.joining_date',
    experienceYears: 'sp.experience_years',
    licenceExpiryDate: 'sp.licence_expiry_date',
    isActive: 'sp.is_active',
    createdAt: 'sp.created_at',
    updatedAt: 'sp.updated_at',
  },
  defaultSort: 'fullName',
  tiebreaker: 'sp.id',
};

const CSV_COLUMNS: CsvColumn<StaffListItem>[] = [
  { header: 'Name', key: 'fullName' },
  { header: 'Type', key: 'staffType' },
  { header: 'Phone', key: 'phone' },
  { header: 'E-mail', key: 'email' },
  { header: 'Status', value: (r) => (r.isActive ? 'active' : 'inactive') },
  { header: 'Joining date', key: 'joiningDate' },
  { header: 'Experience (years)', key: 'experienceYears' },
  { header: 'ID proof', value: (r) => (r.idProofType ? `${r.idProofType} ${r.idProofMasked ?? ''}`.trim() : '') },
  { header: 'ID verification', key: 'idVerificationStatus' },
  { header: 'Licence no.', key: 'licenceNo' },
  { header: 'Licence expiry', key: 'licenceExpiryDate' },
  { header: 'Licence status', key: 'licenceStatus' },
  { header: 'Licence verification', key: 'licenceVerificationStatus' },
  { header: 'App login', value: (r) => (r.hasLogin ? (r.loginUsername ?? r.loginPhone ?? 'yes') : 'no') },
  { header: 'Buses', value: (r) => r.currentBuses.map((b) => `${b.busCode} (${b.role})`).join('; ') },
  { header: 'Expired documents', key: 'expiredDocuments' },
  { header: 'Expiring documents', key: 'expiringDocuments' },
  { header: 'Created (UTC)', key: 'createdAt' },
];

const NOT_FOUND = 'Staff member not found.';

function filterOf(q: StaffListQuery): repo.StaffFilter {
  return { types: q.type, status: q.status, q: q.q, licenceStatus: q.licenceStatus, documentStatus: q.documentStatus, hasLogin: q.hasLogin, assigned: q.assigned };
}

/** GET /school/staff — JSON page or CSV export. */
export async function list(req: Request, res: Response, q: StaffListQuery): Promise<void> {
  const { orderBy } = parseSort(q.sort, SORT);
  const filter = filterOf(q);
  if (q.format === 'csv') {
    const rows = await withRequestTenant(req, (tx) => repo.exportRows(tx, filter, orderBy), { readOnly: true });
    const csv = createCsvWriter<StaffListItem>(res, { fileName: 'staff.csv', columns: CSV_COLUMNS });
    await csv.writeAll(rows.map((r) => toListItem(r, null)));
    await csv.end();
    return;
  }
  const { page, limit, offset } = parsePagination(q);
  const { rows, total } = await withRequestTenant(req, (tx) => repo.page(tx, filter, { orderBy, limit, offset }), { readOnly: true });
  const items = await Promise.all((rows as repo.StaffListRow[]).map(async (r) => toListItem(r, await optionalSignedUrl(req, r.photo_thumb_key ?? r.photo_key))));
  sendList(res, items, listMeta({ page, limit, total }));
}

export interface DetailRows {
  row: repo.StaffDetailRow;
  assignments: assignmentsRepo.StaffAssignmentRow[];
  documents: documentsRepo.StaffDocumentRow[];
}

/** Everything the detail view needs, read in the caller's transaction (404 for unknown/other-school ids). */
export async function detailRows(tx: Tx, id: string): Promise<DetailRows> {
  const row = await repo.findDetail(tx, id);
  if (!row) throw notFound(NOT_FOUND);
  return { row, assignments: await assignmentsRepo.currentAssignments(tx, id), documents: await documentsRepo.listForStaff(tx, id) };
}

/** Detail DTO with signed photo URLs (signed after the transaction). */
export async function toDetailDto(req: Request, d: DetailRows): Promise<StaffDetail> {
  const photo = d.row.photo_file_id
    ? { fileId: d.row.photo_file_id, url: await optionalSignedUrl(req, d.row.photo_key), thumbnailUrl: await optionalSignedUrl(req, d.row.photo_thumb_key) }
    : null;
  return toDetail(d.row, { photo, assignments: d.assignments, documents: d.documents });
}

/** Audit snapshot of the detail rows (no signed URLs needed). */
const auditOf = (d: DetailRows) => profileAuditView(toDetail(d.row, { photo: null, assignments: [], documents: [] }));

/** GET /school/staff/:id */
export async function get(req: Request, id: string): Promise<StaffDetail> {
  return toDetailDto(req, await withRequestTenant(req, (tx) => detailRows(tx, id), { readOnly: true }));
}

/** POST /school/staff */
export async function create(req: Request, body: CreateStaffBody): Promise<StaffDetail> {
  const rows = await withRequestTenant(req, async (tx) => {
    const { staffType, ...values } = body;
    const id = await repo.insert(tx, staffType, values);
    const d = await detailRows(tx, id);
    await audit.log(tx, { action: 'staff.create', entityType: 'staff', entityId: id, new: auditOf(d) });
    return d;
  });
  return toDetailDto(req, rows);
}

/** A staff_photo uploaded for this staff member and not attached elsewhere. */
export async function assertAttachableFile(tx: Tx, fileId: string, staffId: string, category: 'staff_photo' | 'staff_document', field = 'fileId'): Promise<void> {
  const f = await documentsRepo.findFileLink(tx, fileId);
  if (!f) throw notFound('File not found.');
  if (f.category !== category) throw fieldError(field, `Upload the file with category ${category}.`);
  if (f.entity_type !== 'staff' || f.entity_id !== staffId) throw fieldError(field, 'The file was uploaded for another record.');
  if (f.status !== 'uploaded') throw invalidState('The file upload is not complete.');
  if (f.in_use) throw conflict('This file is already attached.');
}

/** PATCH /school/staff/:id */
export async function update(req: Request, id: string, body: UpdateStaffBody): Promise<StaffDetail> {
  const rows = await withRequestTenant(req, async (tx) => {
    const locked = await repo.lock(tx, id);
    if (!locked) throw notFound(NOT_FOUND);
    const beforeRows = await detailRows(tx, id);
    const before = toDetail(beforeRows.row, { photo: null, assignments: [], documents: [] });
    const { staffType: _immutable, ...values } = body;
    if (locked.staff_type === 'conductor') {
      for (const k of LICENCE_FIELDS) if (values[k] !== undefined && values[k] !== null) throw fieldError(k, 'Licence details apply to drivers only');
    }
    const idType = values.idProofType === undefined ? before.idProofType : values.idProofType;
    const last4 = values.idProofLast4 === undefined ? before.idProofLast4 : values.idProofLast4;
    if (last4 && !idType) throw fieldError('idProofType', 'Select the identity proof type for the last 4 characters');
    const issue = values.licenceIssueDate === undefined ? before.licenceIssueDate : values.licenceIssueDate;
    const expiry = values.licenceExpiryDate === undefined ? before.licenceExpiryDate : values.licenceExpiryDate;
    if (issue && expiry && expiry < issue) throw fieldError('licenceExpiryDate', 'The expiry date cannot be before the issue date');
    if (values.photoFileId && values.photoFileId !== locked.photo_file_id) await assertAttachableFile(tx, values.photoFileId, id, 'staff_photo', 'photoFileId');

    await repo.update(tx, id, values);
    if (values.fullName && locked.user_id) await loginRepo.syncName(tx, locked.user_id, values.fullName);
    const d = await detailRows(tx, id);
    const diff = changedFields(auditOf(beforeRows), auditOf(d));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'staff.update', entityType: 'staff', entityId: id, ...diff });
    return d;
  });
  return toDetailDto(req, rows);
}

async function refuseOnTrip(tx: Tx, id: string, what: string): Promise<void> {
  const tripId = await repo.activeTripOf(tx, id);
  if (tripId) throw invalidState(`The staff member is on a trip in progress. End the trip before you ${what} them.`, { reason: 'ACTIVE_TRIP', tripId });
}

export type DeactivateResult = StaffDetail & { revokedSessions: number; closedAssignments: number };

/** POST /school/staff/:id/deactivate */
export async function deactivate(req: Request, id: string, body: DeactivateBody): Promise<DeactivateResult> {
  const result = await withRequestTenant(req, async (tx) => {
    const locked = await repo.lock(tx, id);
    if (!locked) throw notFound(NOT_FOUND);
    if (!locked.is_active) return { rows: await detailRows(tx, id), ids: [] as string[], closed: 0 };
    await refuseOnTrip(tx, id, 'deactivate');
    await repo.setActive(tx, id, false);
    const closed = await assignmentsRepo.closeOpenAssignments(tx, id);
    let ids: string[] = [];
    if (locked.user_id) {
      await loginRepo.setLoginActive(tx, locked.user_id, false);
      ids = await revokeAllSessions(tx, 'user', locked.user_id, 'account_deactivated');
    }
    await audit.log(tx, {
      action: 'staff.deactivate',
      entityType: 'staff',
      entityId: id,
      old: { isActive: true },
      new: { isActive: false, reason: body.reason ?? null, closedAssignments: closed, revokedSessions: ids.length },
    });
    return { rows: await detailRows(tx, id), ids, closed };
  });
  if (result.ids.length) await realtime.disconnectSessions(result.ids);
  return { ...(await toDetailDto(req, result.rows)), revokedSessions: result.ids.length, closedAssignments: result.closed };
}

/** POST /school/staff/:id/activate — re-enables the profile and its login (assignments stay closed). */
export async function activate(req: Request, id: string): Promise<StaffDetail> {
  const rows = await withRequestTenant(req, async (tx) => {
    const locked = await repo.lock(tx, id);
    if (!locked) throw notFound(NOT_FOUND);
    if (locked.is_active) return detailRows(tx, id);
    await repo.setActive(tx, id, true);
    if (locked.user_id) await loginRepo.setLoginActive(tx, locked.user_id, true);
    await audit.log(tx, { action: 'staff.activate', entityType: 'staff', entityId: id, old: { isActive: false }, new: { isActive: true } });
    return detailRows(tx, id);
  });
  return toDetailDto(req, rows);
}

/** DELETE /school/staff/:id — soft delete (history kept; login removed so its phone/username are freed). */
export async function remove(req: Request, id: string): Promise<{ id: string; deleted: true; revokedSessions: number; closedAssignments: number }> {
  const result = await withRequestTenant(req, async (tx) => {
    const locked = await repo.lock(tx, id);
    if (!locked) throw notFound(NOT_FOUND);
    await refuseOnTrip(tx, id, 'delete');
    const before = auditOf(await detailRows(tx, id));
    const closed = await assignmentsRepo.closeOpenAssignments(tx, id);
    await repo.softDelete(tx, id);
    let ids: string[] = [];
    if (locked.user_id) {
      await loginRepo.softDeleteLogin(tx, locked.user_id);
      ids = await revokeAllSessions(tx, 'user', locked.user_id, 'account_deleted');
    }
    await audit.log(tx, { action: 'staff.delete', entityType: 'staff', entityId: id, old: before, new: { closedAssignments: closed, revokedSessions: ids.length } });
    return { ids, closed };
  });
  if (result.ids.length) await realtime.disconnectSessions(result.ids);
  return { id, deleted: true as const, revokedSessions: result.ids.length, closedAssignments: result.closed };
}
