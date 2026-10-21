// Parent visibility of bus data (BP §13.3 parent-visibility matrix, §15 bus details, §12 files).
// school_settings.parent_visibility.bus = { capacity, images, plate, insurance_status,
// insurance_file, fitness_status, fitness_file }. Insurance/fitness need the school flag AND the
// document's own flag; other document types follow the document's flags alone. On top of the
// flags, parents only ever see a document that is current, not deleted and VERIFIED: a pending or
// rejected document (e.g. a renewal waiting for verification) and a replaced version are left out
// of the parent view and their files are refused — the parent DTO has no verification field, so an
// unverified document is never rendered as "valid until …". The RLS parent_scope policies are the
// backstop (a parent only ever sees its children's buses).
import type { BusDocumentExpiryStatus, BusDocumentType, VehicleType } from '@wimb/shared';
import type { Request } from 'express';
import type { Tx } from '../../db/tenant.js';
import { optionalSignedUrl } from '../files/urls.js';
import * as documentsRepo from './documentsRepository.js';
import type { BusDocumentRow } from './dto.js';
import * as imagesRepo from './imagesRepository.js';

export interface BusVisibility {
  capacity: boolean;
  images: boolean;
  plate: boolean;
  insurance_status: boolean;
  insurance_file: boolean;
  fitness_status: boolean;
  fitness_file: boolean;
}

/** Mirrors the column default of school_settings.parent_visibility (migration 003). */
export const DEFAULT_BUS_VISIBILITY: Readonly<BusVisibility> = Object.freeze({
  capacity: false,
  images: true,
  plate: true,
  insurance_status: true,
  insurance_file: false,
  fitness_status: true,
  fitness_file: false,
});

/** parent_visibility JSON → bus flags (missing or non-boolean keys fall back to the defaults). */
export function busVisibilityOf(parentVisibility: unknown): BusVisibility {
  const bus = (parentVisibility as { bus?: Record<string, unknown> } | null)?.bus ?? {};
  const out = { ...DEFAULT_BUS_VISIBILITY };
  for (const k of Object.keys(out) as (keyof BusVisibility)[]) if (typeof bus[k] === 'boolean') out[k] = bus[k];
  return out;
}

/** The current school's bus visibility (school_settings is readable by every school member). */
export async function loadBusVisibility(tx: Tx): Promise<BusVisibility> {
  const row = await tx.maybeOne<{ parent_visibility: unknown }>(
    `select parent_visibility from school_settings where school_id = nullif(current_setting('app.school_id', true), '')::uuid`,
  );
  return busVisibilityOf(row?.parent_visibility);
}

const SCHOOL_FLAGS: Partial<Record<BusDocumentType, { status: keyof BusVisibility; file: keyof BusVisibility }>> = {
  insurance: { status: 'insurance_status', file: 'insurance_file' },
  fitness: { status: 'fitness_status', file: 'fitness_file' },
};

/** What the parent rules read from a document row (repository rows never carry deleted documents). */
type DocFlags = Pick<BusDocumentRow, 'doc_type' | 'visible_to_parents_status' | 'visible_to_parents_file' | 'file_id' | 'verification_status' | 'is_current'> & {
  deleted_at?: string | null;
};

/** Only a current, not deleted, verified document is ever shown to parents (never pending, rejected or replaced). */
export function isParentPresentableDocument(d: Pick<DocFlags, 'verification_status' | 'is_current' | 'deleted_at'>): boolean {
  return d.is_current && !d.deleted_at && d.verification_status === 'verified';
}

/** May a parent see this document's validity? */
export function parentSeesDocumentStatus(v: BusVisibility, d: DocFlags): boolean {
  const flags = SCHOOL_FLAGS[d.doc_type as BusDocumentType];
  return isParentPresentableDocument(d) && d.visible_to_parents_status && (!flags || v[flags.status]);
}

/** May a parent open this document's file? */
export function parentSeesDocumentFile(v: BusVisibility, d: DocFlags): boolean {
  const flags = SCHOOL_FLAGS[d.doc_type as BusDocumentType];
  return isParentPresentableDocument(d) && d.file_id !== null && d.visible_to_parents_file && (!flags || v[flags.file]);
}

export interface ParentBusView {
  id: string;
  code: string;
  displayName: string | null;
  vehicleType: VehicleType | null;
  makeModel: string | null;
  color: string | null;
  /** null when the school hides it. */
  capacity: number | null;
  registrationNo: string | null;
  images: { fileId: string; caption: string | null; url: string | null; thumbnailUrl: string | null }[];
  documents: { docType: BusDocumentType; title: string | null; expiryDate: string | null; expiryStatus: BusDocumentExpiryStatus; fileId: string | null }[];
}

interface ParentBusRow extends Record<string, unknown> {
  id: string;
  code: string;
  display_name: string | null;
  vehicle_type: string | null;
  make_model: string | null;
  color: string | null;
  capacity: number | null;
  registration_no: string;
}

/**
 * The bus as a parent may see it, filtered by the school's visibility settings and the document
 * flags (for the parent module's GET /parent/children/:studentId/bus). Documents that are not
 * verified are left out. Must run in the parent's tenant context (X-School-Id resolved): RLS
 * returns null for a bus the parent may not see.
 */
export async function parentBusView(req: Request, tx: Tx, busId: string): Promise<ParentBusView | null> {
  const bus = await tx.maybeOne<ParentBusRow>(
    'select id, code, display_name, vehicle_type, make_model, color, capacity, registration_no from buses where id = $1 and deleted_at is null',
    [busId],
  );
  if (!bus) return null;
  const v = await loadBusVisibility(tx);
  const images = v.images ? await imagesRepo.listImages(tx, busId) : [];
  const documents = (await documentsRepo.listForBus(tx, busId)).filter((d) => parentSeesDocumentStatus(v, d) || parentSeesDocumentFile(v, d));
  return {
    id: bus.id,
    code: bus.code,
    displayName: bus.display_name,
    vehicleType: bus.vehicle_type as VehicleType | null,
    makeModel: bus.make_model,
    color: bus.color,
    capacity: v.capacity ? bus.capacity : null,
    registrationNo: v.plate ? bus.registration_no : null,
    images: await Promise.all(
      images.map(async (i) => ({ fileId: i.file_id, caption: i.caption, url: await optionalSignedUrl(req, i.file_key), thumbnailUrl: await optionalSignedUrl(req, i.file_thumb_key) })),
    ),
    documents: documents.map((d) => {
      const status = parentSeesDocumentStatus(v, d);
      return {
        docType: d.doc_type as BusDocumentType,
        title: d.title,
        expiryDate: status ? d.expiry_date : null,
        expiryStatus: (status ? d.expiry_status : 'none') as BusDocumentExpiryStatus,
        fileId: parentSeesDocumentFile(v, d) ? d.file_id : null,
      };
    }),
  };
}
