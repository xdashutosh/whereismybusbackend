// Bus documents (BP §8.3 Bus documents, §12, §13.3 documents tab): list with expiry badges,
// create, replace (new current version; the old one stays as history with is_current = false and
// replaced_by → new), metadata corrections, parent-visibility flags, verification and soft delete.
// Files are uploaded first through the files module (category bus_document) and linked by id.
import { BUS_DOCUMENT_TYPES, type BusDocumentDto } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { withRequestTenant } from '../../middleware/resolveTenant.js';
import { audit, changedFields } from '../../shared/audit.js';
import { conflict, invalidState, notFound } from '../../shared/errors.js';
import * as documentsRepo from './documentsRepository.js';
import { documentAuditView, toDocumentDto, type BusDocumentRow } from './dto.js';
import { assertAttachableFile } from './imagesService.js';
import * as repo from './repository.js';
import type {
  BusDocumentsQuery,
  BusDocumentVisibilityBody,
  CreateBusDocumentBody,
  ReplaceBusDocumentBody,
  UpdateBusDocumentBody,
  VerifyBusDocumentBody,
} from './schemas.js';

/** Document types that allow one current version per bus (all but 'other'). */
const SINGLE_CURRENT = new Set<string>(BUS_DOCUMENT_TYPES.filter((t) => t !== 'other'));

async function locked(tx: Tx, docId: string): Promise<BusDocumentRow> {
  const doc = await documentsRepo.lockDocument(tx, docId);
  if (!doc) throw notFound('Document not found.');
  return doc;
}

async function reload(tx: Tx, docId: string): Promise<BusDocumentDto> {
  return toDocumentDto((await documentsRepo.findDocument(tx, docId))!);
}

/** GET /school/buses/:id/documents */
export async function list(req: Request, busId: string, q: BusDocumentsQuery): Promise<BusDocumentDto[]> {
  return withRequestTenant(
    req,
    async (tx) => {
      if (!(await repo.busExists(tx, busId))) throw notFound('Bus not found.');
      return (await documentsRepo.listForBus(tx, busId, { docTypes: q.docType, includeHistory: q.includeHistory })).map(toDocumentDto);
    },
    { readOnly: true },
  );
}

/** GET /school/bus-documents/:docId — the document and every version of it (newest first). */
export async function get(req: Request, docId: string): Promise<BusDocumentDto & { versions: BusDocumentDto[] }> {
  return withRequestTenant(
    req,
    async (tx) => {
      const doc = await documentsRepo.findDocument(tx, docId);
      if (!doc) throw notFound('Document not found.');
      return { ...toDocumentDto(doc), versions: (await documentsRepo.versions(tx, docId)).map(toDocumentDto) };
    },
    { readOnly: true },
  );
}

/** POST /school/buses/:id/documents */
export async function create(req: Request, busId: string, body: CreateBusDocumentBody): Promise<BusDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    if (!(await repo.lockBus(tx, busId))) throw notFound('Bus not found.');
    if (SINGLE_CURRENT.has(body.docType)) {
      const current = await documentsRepo.listForBus(tx, busId, { docTypes: [body.docType] });
      if (current.length) throw conflict('The bus already has a current document of this type. Replace it instead.', { documentId: current[0]!.id });
    }
    if (body.fileId) await assertAttachableFile(tx, body.fileId, busId, 'bus_document');
    const id = await documentsRepo.insertDocument(tx, busId, body.docType, body);
    const row = (await documentsRepo.findDocument(tx, id))!;
    await audit.log(tx, { action: 'bus_document.create', entityType: 'bus_document', entityId: id, new: documentAuditView(row) });
    return toDocumentDto(row);
  });
}

/** PUT /school/bus-documents/:docId — replaces the current version (history kept). */
export async function replace(req: Request, docId: string, body: ReplaceBusDocumentBody): Promise<BusDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const old = await locked(tx, docId);
    if (!old.is_current) throw invalidState('Only the current version of a document can be replaced.', { replacedBy: old.replaced_by });
    // fileId omitted → the new version keeps the previous file; null → no file.
    const fileId = body.fileId === undefined ? old.file_id : body.fileId;
    if (fileId && fileId !== old.file_id) await assertAttachableFile(tx, fileId, old.bus_id, 'bus_document');
    const newId = await documentsRepo.retireForReplacement(tx, docId);
    await documentsRepo.insertDocument(
      tx,
      old.bus_id,
      old.doc_type,
      {
        ...body,
        fileId,
        visibleToParentsStatus: body.visibleToParentsStatus ?? old.visible_to_parents_status,
        visibleToParentsFile: body.visibleToParentsFile ?? old.visible_to_parents_file,
      },
      newId,
    );
    const fresh = (await documentsRepo.findDocument(tx, newId))!;
    await audit.log(tx, {
      action: 'bus_document.replace',
      entityType: 'bus_document',
      entityId: newId,
      old: { documentId: docId, ...documentAuditView(old) },
      new: { documentId: newId, ...documentAuditView(fresh) },
    });
    return toDocumentDto(fresh);
  });
}

/** PATCH /school/bus-documents/:docId — corrects metadata of this version. */
export async function update(req: Request, docId: string, body: UpdateBusDocumentBody): Promise<BusDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    const startDate = body.startDate === undefined ? before.start_date : body.startDate;
    const expiryDate = body.expiryDate === undefined ? before.expiry_date : body.expiryDate;
    if (startDate && expiryDate && expiryDate < startDate) throw invalidState('The expiry date cannot be before the start date.');
    await documentsRepo.updateMetadata(tx, docId, body);
    const after = (await documentsRepo.findDocument(tx, docId))!;
    const diff = changedFields(documentAuditView(before), documentAuditView(after));
    if (Object.keys(diff.new).length) await audit.log(tx, { action: 'bus_document.update', entityType: 'bus_document', entityId: docId, ...diff });
    return toDocumentDto(after);
  });
}

/** PATCH /school/bus-documents/:docId/visibility */
export async function setVisibility(req: Request, docId: string, body: BusDocumentVisibilityBody): Promise<BusDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    await documentsRepo.setVisibility(tx, docId, body);
    const after = await reload(tx, docId);
    await audit.log(tx, {
      action: 'bus_document.visibility',
      entityType: 'bus_document',
      entityId: docId,
      old: { visibleToParentsStatus: before.visible_to_parents_status, visibleToParentsFile: before.visible_to_parents_file },
      new: { visibleToParentsStatus: after.visibleToParentsStatus, visibleToParentsFile: after.visibleToParentsFile },
    });
    return after;
  });
}

/** PATCH /school/bus-documents/:docId/verify */
export async function verify(req: Request, docId: string, body: VerifyBusDocumentBody): Promise<BusDocumentDto> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    await documentsRepo.setVerification(tx, docId, body.status, body.note ?? null);
    const after = await reload(tx, docId);
    await audit.log(tx, {
      action: 'bus_document.verify',
      entityType: 'bus_document',
      entityId: docId,
      old: { verificationStatus: before.verification_status, verificationNote: before.verification_note },
      new: { verificationStatus: after.verificationStatus, verificationNote: after.verificationNote },
    });
    return after;
  });
}

/** DELETE /school/bus-documents/:docId — soft delete (the file is kept for audit, BP §12). */
export async function remove(req: Request, docId: string): Promise<{ id: string; deleted: true }> {
  return withRequestTenant(req, async (tx) => {
    const before = await locked(tx, docId);
    await documentsRepo.softDeleteDocument(tx, docId);
    await audit.log(tx, { action: 'bus_document.delete', entityType: 'bus_document', entityId: docId, old: documentAuditView(before) });
    return { id: docId, deleted: true as const };
  });
}
