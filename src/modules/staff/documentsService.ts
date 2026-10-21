// Staff documents (BP §8.3 Staff documents CRUD + verify, §12, §13.3 Staff): list with expiry
// badges, create, replace (new current version; the old one stays as history with is_current =
// false and replaced_by → new), metadata corrections, parent-visibility flags, verification and
// soft delete. Files are uploaded first through the files module (category staff_document) and
// linked by id. Identity documents are admin-only (never parent-visible) and keep at most the last
// 4 characters of their number; licence documents exist for drivers only. Verifying the identity
// document or a licence side also sets the profile's id/licence verification status; replacing or
// deleting the current one resets that status to pending (the verdict was on the old version).
import { DRIVER_ONLY_DOCUMENT_TYPES, STAFF_MULTI_DOCUMENT_TYPES, type StaffDocumentDto, type StaffDocumentType } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { registerConstraintError } from '../../middleware/errorHandler.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { conflict, fieldError, invalidState, notFound } from '../../shared/errors.js';
import * as documentsRepo from './documentsRepository.js';
import type { StaffDocumentRow } from './documentsRepository.js';
import { documentAuditView, toDocumentDto } from './dto.js';
import * as repo from './repository.js';
import type {
  CreateStaffDocumentBody,
  ReplaceStaffDocumentBody,
  StaffDocumentsQuery,
  StaffDocumentVisibilityBody,
  UpdateStaffDocumentBody,
  VerifyStaffDocumentBody,
} from './schemas.js';
import { assertAttachableFile } from './service.js';

registerConstraintError('staff_documents_one_current', 'CONFLICT', 'The staff member already has a current document of this type. Replace it instead.');
registerConstraintError('staff_documents_identity_private_ck', 'VALIDATION_ERROR', 'Identity documents can never be shown to parents.');
registerConstraintError('staff_documents_dates_ck', 'VALIDATION_ERROR', 'The expiry date cannot be before the issue date.');

const NOT_FOUND = 'Document not found.';

/** Identity numbers: last 4 characters only; identity documents are never parent-visible. */
function identityRules(docType: string, v: { docNumber?: string | null; visibleToParentsStatus?: boolean; visibleToParentsFile?: boolean }): void {
  if (docType !== 'identity') return;
  if (v.docNumber && !/^[A-Za-z0-9]{4}$/.test(v.docNumber)) throw fieldError('docNumber', 'Identity documents keep only the last 4 characters of the number');
  if (v.visibleToParentsStatus) throw fieldError('visibleToParentsStatus', 'Identity documents are never shown to parents');
  if (v.visibleToParentsFile) throw fieldError('visibleToParentsFile', 'Identity documents are never shown to parents');
}

async function locked(tx: Tx, docId: string): Promise<StaffDocumentRow> {
  const doc = await documentsRepo.lockDocument(tx, docId);
  if (!doc) throw notFound(NOT_FOUND);
  return doc;
}

async function reload(tx: Tx, docId: string): Promise<StaffDocumentRow> {
  return (await documentsRepo.findDocument(tx, docId))!;
}

/** GET /school/staff/:id/documents */
export function list(req: Request, staffId: string, q: StaffDocumentsQuery): Promise<StaffDocumentDto[]> {
  return withRequestTenant(
    req,
    async (tx) => {
      if (!(await repo.exists(tx, staffId))) throw notFound('Staff member not found.');
      return (await documentsRepo.listForStaff(tx, staffId, { docTypes: q.docType, includeHistory: q.includeHistory })).map(toDocumentDto);
    },
    { readOnly: true },
  );
}

/** GET /school/staff-documents/:docId — the document and every version of it (newest first). */
export function get(req: Request, docId: string): Promise<StaffDocumentDto & { versions: StaffDocumentDto[] }> {
  return withRequestTenant(
    req,
    async (tx) => {
      const doc = await documentsRepo.findDocument(tx, docId);
      if (!doc) throw notFound(NOT_FOUND);
      return { ...toDocumentDto(doc), versions: (await documentsRepo.versions(tx, docId)).map(toDocumentDto) };
    },
    { readOnly: true },
  );
}

/** POST /school/staff/:id/documents */
export function create(req: Request, staffId: string, body: CreateStaffDocumentBody): Promise<StaffDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const staff = await repo.lock(tx, staffId);
    if (!staff) throw notFound('Staff member not found.');
    if (staff.staff_type !== 'driver' && DRIVER_ONLY_DOCUMENT_TYPES.includes(body.docType)) throw fieldError('docType', 'Licence documents apply to drivers only');
    identityRules(body.docType, body);
    if (!STAFF_MULTI_DOCUMENT_TYPES.includes(body.docType)) {
      const current = await documentsRepo.listForStaff(tx, staffId, { docTypes: [body.docType] });
      if (current.length) throw conflict('The staff member already has a current document of this type. Replace it instead.', { documentId: current[0]!.id });
    }
    if (body.fileId) await assertAttachableFile(tx, body.fileId, staffId, 'staff_document');
    const values = body.docType === 'identity' ? { ...body, visibleToParentsStatus: false, visibleToParentsFile: false } : body;
    const id = await documentsRepo.insertDocument(tx, staffId, body.docType, values);
    const row = await reload(tx, id);
    await audit.log(tx, { action: 'staff_document.create', entityType: 'staff_document', entityId: id, new: documentAuditView(row) });
    return toDocumentDto(row);
  });
}

/** PUT /school/staff-documents/:docId — replaces the current version (history kept). */
export function replace(req: Request, docId: string, body: ReplaceStaffDocumentBody): Promise<StaffDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const old = await locked(tx, docId);
    if (!old.is_current) throw invalidState('Only the current version of a document can be replaced.', { replacedBy: old.replaced_by });
    identityRules(old.doc_type, body);
    // fileId omitted → the new version keeps the previous file; null → no file.
    const fileId = body.fileId === undefined ? old.file_id : body.fileId;
    if (fileId && fileId !== old.file_id) await assertAttachableFile(tx, fileId, old.staff_id, 'staff_document');
    const identity = old.doc_type === 'identity';
    const newId = await documentsRepo.retireForReplacement(tx, docId);
    await documentsRepo.insertDocument(
      tx,
      old.staff_id,
      old.doc_type,
      {
        ...body,
        fileId,
        visibleToParentsStatus: identity ? false : (body.visibleToParentsStatus ?? old.visible_to_parents_status),
        visibleToParentsFile: identity ? false : (body.visibleToParentsFile ?? old.visible_to_parents_file),
      },
      newId,
    );
    // The profile verdict belonged to the replaced version: back to pending until the new one is verified.
    const profileStatus = await resetProfileVerification(tx, old);
    const fresh = await reload(tx, newId);
    await audit.log(tx, {
      action: 'staff_document.replace',
      entityType: 'staff_document',
      entityId: newId,
      old: { documentId: docId, ...documentAuditView(old) },
      new: { documentId: newId, ...documentAuditView(fresh), ...(profileStatus ? { profileStatus } : {}) },
    });
    return toDocumentDto(fresh);
  });
}

/** PATCH /school/staff-documents/:docId — corrects metadata of this version. */
export function update(req: Request, docId: string, body: UpdateStaffDocumentBody): Promise<StaffDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    identityRules(before.doc_type, body);
    const issueDate = body.issueDate === undefined ? before.issue_date : body.issueDate;
    const expiryDate = body.expiryDate === undefined ? before.expiry_date : body.expiryDate;
    if (issueDate && expiryDate && expiryDate < issueDate) throw fieldError('expiryDate', 'The expiry date cannot be before the issue date');
    await documentsRepo.updateMetadata(tx, docId, body);
    const after = await reload(tx, docId);
    const diff = changedFields(documentAuditView(before), documentAuditView(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'staff_document.update', entityType: 'staff_document', entityId: docId, ...diff });
    return toDocumentDto(after);
  });
}

/** PATCH /school/staff-documents/:docId/visibility */
export function setVisibility(req: Request, docId: string, body: StaffDocumentVisibilityBody): Promise<StaffDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    identityRules(before.doc_type, body);
    await documentsRepo.setVisibility(tx, docId, body);
    const after = await reload(tx, docId);
    await audit.log(tx, {
      action: 'staff_document.visibility',
      entityType: 'staff_document',
      entityId: docId,
      old: { visibleToParentsStatus: before.visible_to_parents_status, visibleToParentsFile: before.visible_to_parents_file },
      new: { visibleToParentsStatus: after.visible_to_parents_status, visibleToParentsFile: after.visible_to_parents_file },
    });
    return toDocumentDto(after);
  });
}

const PROFILE_STATUS: Partial<Record<StaffDocumentType, 'id_verification_status' | 'licence_verification_status'>> = {
  identity: 'id_verification_status',
  licence_front: 'licence_verification_status',
  licence_back: 'licence_verification_status',
};

/**
 * A current identity/licence version leaves (replaced or deleted) → the profile status it set no
 * longer describes a current document, so it returns to pending. Returns the reset column.
 */
async function resetProfileVerification(tx: Tx, doc: StaffDocumentRow): Promise<string | undefined> {
  const column = doc.is_current ? PROFILE_STATUS[doc.doc_type as StaffDocumentType] : undefined;
  if (column) await repo.setIdentityVerification(tx, doc.staff_id, column, 'pending');
  return column;
}

/** PATCH /school/staff-documents/:docId/verify */
export function verify(req: Request, docId: string, body: VerifyStaffDocumentBody): Promise<StaffDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    await documentsRepo.setVerification(tx, docId, body.status, body.note ?? null);
    const column = before.is_current ? PROFILE_STATUS[before.doc_type as StaffDocumentType] : undefined;
    if (column) await repo.setIdentityVerification(tx, before.staff_id, column, body.status);
    const after = await reload(tx, docId);
    await audit.log(tx, {
      action: 'staff_document.verify',
      entityType: 'staff_document',
      entityId: docId,
      old: { verificationStatus: before.verification_status, verificationNote: before.verification_note },
      new: { verificationStatus: after.verification_status, verificationNote: after.verification_note, ...(column ? { profileStatus: column } : {}) },
    });
    return toDocumentDto(after);
  });
}

/** DELETE /school/staff-documents/:docId — soft delete (the file is kept for audit, BP §12). */
export function remove(req: Request, docId: string): Promise<{ id: string; deleted: true }> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    await documentsRepo.softDeleteDocument(tx, docId);
    const profileStatus = await resetProfileVerification(tx, before);
    await audit.log(tx, {
      action: 'staff_document.delete',
      entityType: 'staff_document',
      entityId: docId,
      old: documentAuditView(before),
      ...(profileStatus ? { new: { profileStatus } } : {}),
    });
    return { id: docId, deleted: true as const };
  });
}
